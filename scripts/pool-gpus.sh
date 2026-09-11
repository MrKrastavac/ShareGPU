#!/usr/bin/env bash
# Pool every visible GPU so Ollama can run models larger than one card.
#
#   pool-gpus.sh            show what would change
#   pool-gpus.sh --apply    write the settings and restart Ollama
#   pool-gpus.sh --revert   go back to a single-GPU configuration
#
# HOW POOLING ACTUALLY WORKS
#   llama.cpp (inside Ollama) splits a model's *layers* across GPUs -- a
#   pipeline, not tensor parallelism. Each layer lives wholly on one card, and
#   activations hop over PCIe between them. That traffic is small, so no NVLink
#   is needed and PCIe bandwidth is not the bottleneck.
#
#   The consequence: total VRAM adds up, but speed does not. Decode is memory
#   bandwidth bound, so the pool runs at roughly the weighted average of the
#   cards. Pooling is a win when a model does NOT fit on the big card alone,
#   and a loss when it does.
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/ollama-unit.sh"

banner() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

banner "GPUs the driver can see"
COUNT=$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | wc -l)
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/  /'
TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END {print s+0}')
echo "  pooled VRAM: ${TOTAL} MiB across ${COUNT} GPU(s)"

if (( COUNT < 2 )); then
  echo
  echo "  Only one GPU is visible, so there is nothing to pool yet."
  echo "  Run ./scripts/enable-second-gpu.sh first -- the 1080 Ti has no driver."
  exit 1
fi

banner "Settings"
cat <<'EXPLAIN'
  OLLAMA_SCHED_SPREAD=1
      Without this the scheduler prefers to fit a model on ONE card and only
      spills over when it must. With it, models are spread across every GPU --
      which is what you want when the goal is capacity rather than latency.

  OLLAMA_KV_CACHE_TYPE / OLLAMA_FLASH_ATTENTION
      Left as they are. Flash attention works on Pascal through llama.cpp's
      vector kernels (the tensor-core path needs compute capability 7.0+),
      so q8_0 KV cache keeps working -- just without tensor-core speedup.
EXPLAIN

case "${1:-}" in
  --apply|--revert)
    ollama_unit_require || exit 1
    if [[ "$1" == "--apply" ]]; then
      ollama_env_set OLLAMA_SCHED_SPREAD 1 || exit 1
      echo "  set OLLAMA_SCHED_SPREAD=1 in $(ollama_dropin)"
    else
      # 0 rather than removal: the unit file itself may also set it.
      ollama_env_set OLLAMA_SCHED_SPREAD 0 || exit 1
      echo "  set OLLAMA_SCHED_SPREAD=0 in $(ollama_dropin)"
    fi

    if ! ollama_restart; then
      echo "  Ollama failed to restart -- check: $(ollama_status_hint)"
      exit 1
    fi
    echo "  Ollama restarted"

    banner "Effective environment"
    for k in OLLAMA_SCHED_SPREAD OLLAMA_NUM_PARALLEL OLLAMA_CONTEXT_LENGTH OLLAMA_KV_CACHE_TYPE OLLAMA_FLASH_ATTENTION; do
      printf '  %s=%s\n' "$k" "$(ollama_env_get "$k")"
    done

    if [[ "$1" == "--apply" ]]; then
      banner "What now fits"
      python3 - "$TOTAL" <<'PY'
import sys
mib = int(sys.argv[1]); gb = mib/1024
usable = gb - 3   # desktop + context headroom
print(f"  ~{usable:.0f} GB usable after the desktop and KV cache")
for name, need in [("32B q6_K", 27), ("49B q4_K_M", 30), ("70B q3_K_S", 30),
                   ("70B q4_K_M", 42), ("27B q4 @ very long context", 22)]:
    print(f"    {name:<28} needs ~{need:>2} GB  {'fits' if need <= usable else 'does NOT fit'}")
PY
      echo
      echo "  Pull one with the dashboard's download box, then Load it."
    fi
    ;;
  *)
    echo
    echo "  Dry run. Use --apply to enable pooling, --revert to undo."
    ;;
esac
