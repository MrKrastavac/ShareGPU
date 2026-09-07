#!/usr/bin/env bash
# Open the firewall so other devices can reach ShareGPU.
#
#   ./scripts/allow_firewall.sh            allow tailnet + LAN + WireGuard peers
#   ./scripts/allow_firewall.sh --remove   undo those rules
#
# Needs root, so it will prompt for your password. Every rule is idempotent --
# running it twice does nothing the second time.
#
# Subnets are derived from this machine's own interfaces unless you name them.
# Note that a router terminating WireGuard often puts its peers on a different
# subnet from the LAN -- if a phone on the tunnel cannot connect, find its
# address and pass that range explicitly.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SHAREGPU_PORT:-8770}"
SUBNETS=("${@:-}")
if [[ "${SUBNETS[0]:-}" == "--remove" || -z "${SUBNETS[0]:-}" ]]; then
  # Every directly-attached IPv4 network, as a /24.
  mapfile -t SUBNETS < <(ip -4 -o addr show scope global 2>/dev/null \
    | awk '{print $4}' | cut -d/ -f1 | grep -v '^100\.' \
    | awk -F. '{print $1"."$2"."$3".0/24"}' | sort -u)
  [[ ${#SUBNETS[@]} -eq 0 ]] && SUBNETS=("192.168.0.0/24")
fi

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw is not installed; nothing to do." >&2
  exit 1
fi

TS_IFACE=""
ip link show tailscale0 >/dev/null 2>&1 && TS_IFACE="tailscale0"

if [[ "${1:-}" == "--remove" ]]; then
  echo "==> Removing rules"
  for net in "${SUBNETS[@]}"; do
    sudo ufw delete allow from "$net" to any port "$PORT" proto tcp || true
  done
  [[ -n "$TS_IFACE" ]] && { sudo ufw delete allow in on "$TS_IFACE" to any port "$PORT" proto tcp || true; }
else
  for net in "${SUBNETS[@]}"; do
    echo "==> Allowing ${net} -> port ${PORT}/tcp"
    sudo ufw allow from "$net" to any port "$PORT" proto tcp comment "sharegpu"
  done
  if [[ -n "$TS_IFACE" ]]; then
    echo "==> Allowing the tailnet interface (${TS_IFACE}) -> port ${PORT}/tcp"
    sudo ufw allow in on "$TS_IFACE" to any port "$PORT" proto tcp comment "sharegpu tailnet"
  fi
fi

echo
echo "==> Rules for port ${PORT}"
sudo ufw status | grep -E "^(To|--|${PORT})" || echo "  (none)"

echo
echo "Addresses other devices can use:"
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [[ -n "$TS_IP" ]] && echo "  tailnet   : http://${TS_IP}:${PORT}"
fi
LAN_IP="$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '^100\.' | head -1 || true)"
[[ -n "$LAN_IP" ]] && echo "  LAN / VPN : http://${LAN_IP}:${PORT}"
echo
echo "On the router's WireGuard tunnel, use the LAN address above -- peers are"
echo "routed into this network, so ${LAN_IP:-this machine} is what they should type."
