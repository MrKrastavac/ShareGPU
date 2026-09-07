#!/usr/bin/env bash
# Work out why a VPN peer cannot reach ShareGPU.
#
# The question this answers is binary: are the peer's packets arriving at all?
# If they are, ShareGPU logs a refusal naming the address, and the fix is the
# allow-list. If they are not, the block is below ShareGPU -- ufw or the route.
PORT="${SHAREGPU_PORT:-8770}"
BASE="http://127.0.0.1:${PORT}"

echo "== is ShareGPU listening =="
if ss -tlnH 2>/dev/null | grep -q ":${PORT}"; then
  ss -tlnH 2>/dev/null | grep ":${PORT}" | sed 's/^/  /'
  if ss -tlnH 2>/dev/null | grep ":${PORT}" | grep -q '127.0.0.1'; then
    echo "  PROBLEM: bound to loopback only. Restart with --vpn."
  fi
else
  echo "  PROBLEM: nothing is listening on ${PORT}. Start it with ./scripts/launch.sh --vpn"
  exit 1
fi

echo
echo "== this machine's addresses =="
ip -br addr 2>/dev/null | grep -v '^lo' | sed 's/^/  /'

echo
echo "== allow-list =="
curl -s --max-time 5 "${BASE}/api/status" \
  | python -c "import sys,json;print('  '+', '.join(json.load(sys.stdin)['server']['allowedNetworks']))" 2>/dev/null \
  || echo "  (could not read status)"

echo
echo "== peers refused by the allow-list =="
REJ=$(curl -s --max-time 5 "${BASE}/api/status" | python -c "
import sys,json
r=json.load(sys.stdin).get('rejected',[])
if not r: print('  none')
for x in r:
    p=str(x['id']).split('.')
    cidr='.'.join(p[:3])+'.0/24' if len(p)==4 else None
    print(f\"  {x['id']}  tried {x['count']}x\" + (f'  -> allow with: --allow {cidr}' if cidr else ''))
" 2>/dev/null)
echo "$REJ"

echo
echo "== tailnet =="
if command -v tailscale >/dev/null 2>&1 && ip link show tailscale0 >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  echo "  this machine: http://${TS_IP}:${PORT}   <- use this from a phone"
  echo "  peers that are up:"
  tailscale status 2>/dev/null | grep -v offline | awk '{printf "    %s  %s\n", $1, $2}' | sed 1d
else
  echo "  no tailscale0 interface"
fi

echo
echo "== firewall =="
if command -v ufw >/dev/null && systemctl is-active --quiet ufw; then
  echo "  ufw is ACTIVE -- the port must be opened explicitly:"
  sudo ufw status 2>/dev/null | grep -E "^(Status|${PORT})" | sed 's/^/    /' \
    || echo "    (run 'sudo ufw status' to inspect)"
  echo "    open it with: ./scripts/allow_firewall.sh"
else
  echo "  ufw is not active"
fi

echo
cat <<'HINT'
== how to read this ==
  Try to reach the dashboard from the phone, then re-run this script.

  * An address appears under "peers refused"
      -> packets ARE arriving and the allow-list is the problem. Restart with
         the --allow CIDR shown next to it.

  * Nothing appears, and the phone times out
      -> packets are NOT arriving, so the block is below ShareGPU. Run
         ./scripts/allow_firewall.sh and use the tailnet address above.

  Prefer the tailnet address (100.x) over the LAN one. It is how the other apps
  here are reached from a phone, it is encrypted, and it works away from home.
  A Tailscale peer always arrives as 100.x, never as a LAN address.
HINT
