#!/usr/bin/env bash
# Desktop launcher for ShareGPU.
#
#   launch.sh                        serve the VPN (compute + downloads on)
#   launch.sh --local                this machine only, loopback
#   launch.sh --chat-only            serve the VPN, no compute, no downloads
#   launch.sh --foreground [args]    run in this terminal instead of detaching
#
# Starting it when it is already up just reopens the dashboard, so a stray
# double-click never restarts the server underneath someone's request.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

PORT="${SHAREGPU_PORT:-8770}"
LOG="$ROOT/.sharegpu/app.log"
TOKEN_FILE="$ROOT/.sharegpu/compute.token"
mkdir -p "$ROOT/.sharegpu"
touch "$LOG"

notify() {
  if command -v kdialog >/dev/null 2>&1; then
    kdialog --title "ShareGPU" --passivepopup "$1" "${2:-6}" 2>/dev/null && return
  fi
  command -v notify-send >/dev/null 2>&1 && notify-send "ShareGPU" "$1" 2>/dev/null || true
}

fail() {
  notify "$1" 10
  command -v kdialog >/dev/null 2>&1 && kdialog --title "ShareGPU" --error "$1" 2>/dev/null
  exit 1
}

FOREGROUND=0
MODE="vpn"
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --foreground) FOREGROUND=1 ;;
    --local) MODE="local" ;;
    --chat-only) MODE="chat" ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

case "$MODE" in
  local) ARGS=("--model" "${SHAREGPU_MODEL:-hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M}") ;;
  chat)  ARGS=("--vpn" "--model" "${SHAREGPU_MODEL:-hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M}") ;;
  *)     ARGS=("--vpn" "--allow-compute" "--allow-pull" "--think-by-default" "--model" "${SHAREGPU_MODEL:-hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M}") ;;
esac
((${#PASSTHROUGH[@]})) && ARGS+=("${PASSTHROUGH[@]}")

# A token that survives restarts, so peers are not reconfigured after a bounce.
if printf '%s\n' "${ARGS[@]}" | grep -qx -- '--allow-compute'; then
  if ! printf '%s\n' "${ARGS[@]}" | grep -qx -- '--compute-token'; then
    if [[ ! -f "$TOKEN_FILE" ]]; then
      head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$TOKEN_FILE"
      chmod 600 "$TOKEN_FILE"
      echo "generated a new compute token at $TOKEN_FILE"
    fi
    # Via the environment, not argv: anything on the command line is readable
    # by every process on the machine through ps.
    export SHAREGPU_COMPUTE_TOKEN="$(cat "$TOKEN_FILE")"

  fi
fi

# The server may be bound to 0.0.0.0 rather than loopback, so follow the real
# binding rather than assuming where to probe.
current_host() {
  ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | sed 's/:[0-9]*$//' | head -1
}
probe_host() {
  local host; host="$(current_host)"
  [[ -z "$host" || "$host" == "0.0.0.0" || "$host" == "*" || "$host" == "[::]" ]] && host="127.0.0.1"
  echo "$host"
}
app_up() { curl -fsS --max-time 2 "http://$(probe_host):${PORT}/healthz" >/dev/null 2>&1; }

reach_url() {
  local ip
  if [[ "$(current_host)" == "127.0.0.1" ]]; then
    echo "http://127.0.0.1:${PORT}"; return
  fi
  ip="$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '^100\.' | head -1)"
  [[ -z "$ip" ]] && ip="127.0.0.1"
  echo "http://${ip}:${PORT}"
}

if ((FOREGROUND)); then
  exec node server.mjs "${ARGS[@]}"
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || fail "Node.js was not found on PATH, so ShareGPU cannot start."

if app_up; then
  notify "ShareGPU is already running." 4
else
  if ! curl -fsS --max-time 3 "${OLLAMA_URL:-http://127.0.0.1:11434}/api/version" >/dev/null 2>&1; then
    notify "Ollama is not answering; chat will fail until it starts." 8
  fi
  notify "Starting ShareGPU…"
  setsid nohup "$NODE" server.mjs "${ARGS[@]}" >>"$LOG" 2>&1 </dev/null &
  for _ in $(seq 1 60); do
    app_up && break
    sleep .5
  done
  app_up || fail "ShareGPU did not start. See $LOG"
fi

URL="$(reach_url)"
xdg-open "$URL" >/dev/null 2>&1 &
notify "ShareGPU is serving at $URL" 8
