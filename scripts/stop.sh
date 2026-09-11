#!/usr/bin/env bash
# Shut down ShareGPU.
#
#   stop.sh              stop the gateway
#   stop.sh --free-gpu   also ask Ollama to unload its models, freeing VRAM
#
# Only this project's own server is touched. Ollama is often shared with other
# tools on the same machine, so it is left running unless --free-gpu is given,
# and even then only its weights are unloaded -- the service is never stopped.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

PORT="${SHAREGPU_PORT:-8770}"
FREE_GPU=0
[[ "${1:-}" == "--free-gpu" ]] && FREE_GPU=1

notify() {
  if command -v kdialog >/dev/null 2>&1; then
    kdialog --title "ShareGPU" --passivepopup "$1" "${2:-6}" 2>/dev/null && return
  fi
  command -v notify-send >/dev/null 2>&1 && notify-send "ShareGPU" "$1" 2>/dev/null || true
}

app_up() {
  local host
  host="$(ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | sed 's/:[0-9]*$//' | head -1)"
  [[ -z "$host" ]] && return 1
  [[ "$host" == "0.0.0.0" || "$host" == "*" || "$host" == "[::]" ]] && host="127.0.0.1"
  curl -fsS --max-time 2 "http://${host}:${PORT}/healthz" >/dev/null 2>&1
}

# Only ever stop a node process whose argv actually points at this checkout's
# server.mjs. Matching the command line alone would also catch an editor, a
# shell, or a grep that merely mentions the filename.
project_pids() {
  local pid exe cwd arg resolved
  local -a args
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ -r "/proc/$pid/cmdline" ]] || continue
    exe="$(basename "$(readlink -f "/proc/$pid/exe" 2>/dev/null || echo "")")"
    case "$exe" in
      node|node[0-9]*) ;;
      *) continue ;;
    esac
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    mapfile -d '' -t args < "/proc/$pid/cmdline" 2>/dev/null || continue
    for arg in "${args[@]:1}"; do
      [[ -n "$arg" ]] || continue
      resolved="$arg"
      [[ "$resolved" == /* ]] || resolved="$cwd/$arg"
      resolved="$(readlink -m "$resolved" 2>/dev/null || echo "$resolved")"
      if [[ "$resolved" == "$ROOT/server.mjs" ]]; then
        echo "$pid"
        break
      fi
    done
  done < <(pgrep -f 'server\.mjs' 2>/dev/null || true)
}

mapfile -t PIDS < <(project_pids)
if ((${#PIDS[@]} == 0)); then
  if app_up; then
    notify "Port $PORT is still answering, but no process from this folder owns it; nothing was stopped." 10
    exit 1
  fi
  notify "ShareGPU is not running."
  exit 0
fi

# A download runs inside this process, so stopping mid-pull kills it. Ollama
# resumes by digest on the next attempt, but silently losing an hour of
# progress is not something to do without saying so.
PULL="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/models/pull" 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('model') or '')+'|'+str(d.get('percent')) if d.get('active') else '')" 2>/dev/null)"
if [[ -n "$PULL" ]]; then
  MODEL="${PULL%%|*}"; PCT="${PULL#*|}"
  if [[ "${FORCE:-0}" != "1" ]]; then
    echo "A download is in progress: ${MODEL} (${PCT}%)."
    echo "Stopping now cancels it. Ollama resumes by digest on the next pull,"
    echo "but you lose the current transfer."
    echo "Stop anyway with: FORCE=1 $0"
    notify "Not stopping: ${MODEL} is ${PCT}% downloaded. Use FORCE=1 to override." 10
    exit 1
  fi
  notify "Stopping mid-download (${PCT}%) — the pull will resume next time." 8
fi

notify "Stopping ShareGPU…"
# SIGTERM lets the server release any compute lease and kill its jobs first.
kill -TERM "${PIDS[@]}" 2>/dev/null || true

for _ in $(seq 1 40); do
  mapfile -t PIDS < <(project_pids)
  ((${#PIDS[@]} == 0)) && break
  sleep .5
done

mapfile -t PIDS < <(project_pids)
if ((${#PIDS[@]})); then
  kill -KILL "${PIDS[@]}" 2>/dev/null || true
  sleep .5
fi

if app_up; then
  notify "Something is still serving port $PORT. Find it with: ss -ltnp sport = :$PORT" 10
  exit 1
fi

if ((FREE_GPU)); then
  # keep_alive 0 drops the weights; the service stays up for the other apps.
  mapfile -t LOADED < <(curl -fsS --max-time 5 "${OLLAMA_URL:-http://127.0.0.1:11434}/api/ps" 2>/dev/null \
    | python -c 'import sys,json;[print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null || true)
  for model in "${LOADED[@]}"; do
    [[ -n "$model" ]] || continue
    curl -fsS --max-time 30 -X POST "${OLLAMA_URL:-http://127.0.0.1:11434}/api/generate" \
      -d "{\"model\":\"$model\",\"prompt\":\"\",\"keep_alive\":0}" >/dev/null 2>&1 || true
    echo "unloaded $model"
  done
  notify "ShareGPU stopped and the GPU freed."
else
  notify "ShareGPU stopped. Ollama keeps its model in VRAM; use --free-gpu to unload it."
fi
