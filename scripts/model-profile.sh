#!/usr/bin/env bash
# Switch the Ollama runner between configurations that suit different model
# sizes, and restart it.
#
#   model-profile.sh              show the current profile
#   model-profile.sh shared       4 slots, 16k ctx  -- everyday, concurrent
#   model-profile.sh big          1 slot,  16k ctx  -- 49B class (~28 GiB)
#   model-profile.sh huge         1 slot,   8k ctx, q4 KV -- 70B IQ3_M (~30 GiB)
#   model-profile.sh long         1 slot, 128k ctx -- long-context work
#
# Why this exists: slots, context length and KV precision are runner-wide
# settings, but the right values depend entirely on the size of the model you
# want resident. A 28 GiB model cannot share the card with three other KV
# caches; a 14 GiB one is wasted without them.
#
# Anything else using the same Ollama is briefly interrupted by a switch.
# Nothing is lost -- clients reconnect on their next request.
#
# Settings are written to a systemd drop-in, never to your unit file. The unit
# is found automatically; override with OLLAMA_UNIT=<name>.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/ollama-unit.sh"
ollama_unit_require || exit 1

show() {
  echo "  current ($OLLAMA_UNIT, $OLLAMA_UNIT_SCOPE unit):"
  local k
  for k in OLLAMA_NUM_PARALLEL OLLAMA_CONTEXT_LENGTH OLLAMA_KV_CACHE_TYPE OLLAMA_SCHED_SPREAD; do
    printf '    %s=%s\n' "$k" "$(ollama_env_get "$k")"
  done
}

case "${1:-}" in
  shared) PAR=4; CTX=16384;  KV=q8_0 ;;
  big)    PAR=1; CTX=16384;  KV=q8_0 ;;
  huge)   PAR=1; CTX=8192;   KV=q4_0 ;;
  long)   PAR=1; CTX=131072; KV=q8_0 ;;
  "")     show; echo; echo "  profiles: shared | big | huge | long"; exit 0 ;;
  *)      echo "  unknown profile '${1}'. Use: shared | big | huge | long"; exit 1 ;;
esac

echo "  applying profile '${1}': ${PAR} slot(s), ${CTX} ctx, ${KV} KV"
if ! ollama_env_set OLLAMA_NUM_PARALLEL "$PAR" OLLAMA_CONTEXT_LENGTH "$CTX" OLLAMA_KV_CACHE_TYPE "$KV"; then
  echo "  could not write $(ollama_dropin)"
  exit 1
fi
if ! ollama_restart; then
  echo "  Ollama did not come back. Check: $(ollama_status_hint)"
  exit 1
fi
echo "  Ollama restarted."
echo
show
echo
echo "  Clients that declare a context of their own should be re-synced,"
echo "  e.g. ./scripts/sync-pi-context.sh"
exit 0
