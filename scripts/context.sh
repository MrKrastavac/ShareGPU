#!/usr/bin/env bash
# Change the context window in one step.
#
#   context.sh              show the current setting and what would fit
#   context.sh 32k          set it (accepts 8k, 32768, 128k ...)
#   context.sh max          the largest that fits the currently loaded model
#
# Adjusting context by hand means editing a systemd unit, remembering
# daemon-reload, restarting Ollama, reloading the model, and updating the pi
# harness's static model list to match. Missing the last one silently truncates
# long conversations. This does the whole chain.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

. scripts/lib/ollama-unit.sh
ollama_unit_require || exit 1
OLLAMA="${OLLAMA_URL:-http://127.0.0.1:11434}"

human() { python3 -c "
n=$1
print(f'{n//1024}k' if n%1024==0 and n>=1024 else str(n))"; }

parse() { python3 -c "
s='$1'.strip().lower().replace('_','')
print(int(float(s[:-1])*1024) if s.endswith('k') else int(s))" 2>/dev/null; }

current() { local v; v=$(ollama_env_get OLLAMA_CONTEXT_LENGTH); echo "${v:-0}"; }

# What the resident model costs per token of context, from its own metadata.
budget_report() {
  curl -fsS --max-time 10 "$OLLAMA/api/ps" 2>/dev/null | OLLAMA="$OLLAMA" python3 -c '
import json, os, subprocess, sys, urllib.request
ps = json.load(sys.stdin).get("models", [])
if not ps:
    print("  no model resident — load one to size the context against it"); raise SystemExit
m = ps[0]; name = m["name"]
req = urllib.request.Request(os.environ["OLLAMA"] + "/api/show",
      data=json.dumps({"model": name}).encode(), headers={"content-type": "application/json"})
mi = json.load(urllib.request.urlopen(req, timeout=15)).get("model_info", {})
g = lambda k: next((v for kk, v in mi.items() if kk.endswith(k)), None)
layers = g(".block_count") or 0
kvh    = g(".attention.head_count_kv") or 0
hd     = g(".attention.key_length") or ((g(".embedding_length") or 0) // max(1, g(".attention.head_count") or 1))
ctx    = m.get("context_length") or 0
resident = m.get("size_vram", 0) / 1024**3

free = sum(int(x) for x in subprocess.run(
    ["nvidia-smi","--query-gpu=memory.free","--format=csv,noheader,nounits"],
    capture_output=True, text=True).stdout.split()) / 1024

# bytes per token of KV at q8_0 (~1 byte per element), K and V
per_tok = 2 * layers * kvh * hd
weights = resident - (per_tok * ctx / 1024**3)
spare = free - 1.5                      # keep 1.5 GiB for desktop drift
maxctx = int(spare * 1024**3 / per_tok) + ctx if per_tok else 0

print(f"  resident : {name[-44:]}")
print(f"  weights  : ~{weights:.1f} GiB   KV at {ctx//1024}k: ~{per_tok*ctx/1024**3:.1f} GiB")
print(f"  free now : {free:.1f} GiB")
print(f"  headroom allows roughly {maxctx//1024}k context on this model")
print(f"  MAXCTX={min(maxctx, 1048576)//1024*1024}")
'
}

CUR=$(current)
if [[ $# -eq 0 ]]; then
  echo "  current: $(human "$CUR") ($CUR)"
  echo
  budget_report | grep -v MAXCTX=
  echo
  echo "  set with: $0 32k   |   $0 max"
  exit 0
fi

if [[ "$1" == "max" ]]; then
  WANT=$(budget_report | grep -oP 'MAXCTX=\K[0-9]+')
  [[ -n "$WANT" ]] || { echo "  cannot size it without a resident model"; exit 1; }
else
  WANT=$(parse "$1")
fi
[[ "$WANT" =~ ^[0-9]+$ ]] && (( WANT >= 512 )) || { echo "  '$1' is not a valid context size"; exit 1; }

echo "  $(human "$CUR") -> $(human "$WANT")"
PINNED=$(curl -fsS --max-time 5 "$OLLAMA/api/ps" 2>/dev/null \
  | python3 -c "import sys,json;m=json.load(sys.stdin).get('models',[]);print(m[0]['name'] if m else '')")

if ! ollama_env_set OLLAMA_CONTEXT_LENGTH "$WANT"; then
  echo "  could not write $(ollama_dropin)"
  exit 1
fi
if ! ollama_restart; then
  echo "  Ollama did not come back. Check: $(ollama_status_hint)"
  exit 1
fi
echo "  Ollama restarted at $(human "$WANT")"

if [[ -n "$PINNED" ]]; then
  echo "  reloading $PINNED ..."
  curl -fsS --max-time 900 -X POST "$OLLAMA/api/generate" \
    -d "{\"model\":\"${PINNED}\",\"prompt\":\"\",\"keep_alive\":\"30m\"}" >/dev/null 2>&1 \
    && echo "  reloaded" || echo "  reload failed — it may not fit at this context"
fi

[[ -x scripts/sync-pi-context.sh ]] && ./scripts/sync-pi-context.sh | tail -2

echo
python3 -c "
n=$WANT
# ~165 tok/s prompt eval measured on this pool
print(f'  a full {n//1024}k prompt will take roughly {n/165/60:.0f} min before the first token')"
