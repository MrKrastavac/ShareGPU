#!/usr/bin/env bash
# Switch the Ollama runner between configurations that suit different model
# sizes, and restart it.
#
#   model-profile.sh              show the current profile
#   model-profile.sh shared       4 slots, 16k ctx  -- everyday, concurrent
#   model-profile.sh big          1 slot,  16k ctx  -- 49B class (~28 GiB)
#   model-profile.sh huge         1 slot,   8k ctx, q4 KV -- 70B IQ3_M (~30 GiB)
#
# Why this exists: slots, context length and KV precision are runner-wide
# settings, but the right values depend entirely on the size of the model you
# want resident. A 28 GiB model cannot share the card with three other KV
# caches; a 14 GiB one is wasted without them.
#
# Ollama is shared with Local Media Gen and MusicGen, so a switch briefly
# interrupts them. Nothing is lost -- they reconnect on their next request.
set -uo pipefail

UNIT="$HOME/.config/systemd/user/local-llm-agent.service"
[[ -L "$UNIT" ]] && UNIT="$(readlink -f "$UNIT")"
[[ -f "$UNIT" ]] || { echo "cannot find the Ollama unit file"; exit 1; }

show() {
  echo "  current:"
  grep -E "^Environment=OLLAMA_(NUM_PARALLEL|CONTEXT_LENGTH|KV_CACHE_TYPE|SCHED_SPREAD)=" "$UNIT" \
    | sed 's/^Environment=/    /'
}

case "${1:-}" in
  shared) PAR=4; CTX=16384; KV=q8_0 ;;
  big)    PAR=1; CTX=16384; KV=q8_0 ;;
  huge)   PAR=1; CTX=8192;  KV=q4_0 ;;
  "")     show; echo; echo "  profiles: shared | big | huge"; exit 0 ;;
  *)      echo "  unknown profile '${1}'. Use: shared | big | huge"; exit 1 ;;
esac

cp -a "$UNIT" "${UNIT}.bak-$(date +%Y%m%d-%H%M%S)"

set_env() {  # key value -- replace in place, or insert before ExecStart
  local k="$1" v="$2"
  if grep -q "^Environment=${k}=" "$UNIT"; then
    sed -i "s|^Environment=${k}=.*|Environment=${k}=${v}|" "$UNIT"
  else
    sed -i "/^ExecStart=/i Environment=${k}=${v}" "$UNIT"
  fi
}

set_env OLLAMA_NUM_PARALLEL   "$PAR"
set_env OLLAMA_CONTEXT_LENGTH "$CTX"
set_env OLLAMA_KV_CACHE_TYPE  "$KV"

echo "  applying profile '${1}': ${PAR} slot(s), ${CTX} ctx, ${KV} KV"
systemctl --user daemon-reload
systemctl --user restart local-llm-agent
for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "${OLLAMA_URL:-http://127.0.0.1:11434}/api/version" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS --max-time 3 "${OLLAMA_URL:-http://127.0.0.1:11434}/api/version" >/dev/null 2>&1; then
  echo "  Ollama did not come back. Check: systemctl --user status local-llm-agent"
  exit 1
fi
echo "  Ollama restarted."
echo
show
echo
echo "  Note: the pi harness caps context at what the server serves."
if [[ "$CTX" != "16384" ]]; then
  echo "  ctx is now ${CTX} -- pi's models.json still says 16384 for most models."
fi
exit 0
