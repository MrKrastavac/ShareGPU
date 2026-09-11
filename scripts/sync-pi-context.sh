#!/usr/bin/env bash
# Match the pi harness's declared context to what the server actually serves.
#
# pi's model list is a static file, so it does not follow OLLAMA_CONTEXT_LENGTH.
# Declaring more than the server serves silently truncates the head of a long
# conversation; declaring less wastes the window you paid VRAM for. Re-run this
# after any ./scripts/model-profile.sh switch.
set -uo pipefail
CFG="$HOME/.pi/agent/models.json"
[[ -f "$CFG" ]] || { echo "no pi config at $CFG"; exit 1; }

. "$(dirname "${BASH_SOURCE[0]}")/lib/ollama-unit.sh"
CTX=""
ollama_unit_detect && CTX=$(ollama_env_get OLLAMA_CONTEXT_LENGTH)
[[ -n "$CTX" ]] || CTX=$(curl -fsS --max-time 5 http://127.0.0.1:11434/api/ps 2>/dev/null \
      | python3 -c "import sys,json;m=json.load(sys.stdin).get('models',[]);print(m[0].get('context_length','') if m else '')")
[[ -n "$CTX" ]] || { echo "could not determine the server's context length"; exit 1; }

cp -a "$CFG" "${CFG}.bak-$(date +%Y%m%d-%H%M%S)"
CTX="$CTX" python3 - "$CFG" <<'PY'
import json, os, sys
ctx = int(os.environ["CTX"]); path = sys.argv[1]
d = json.load(open(path)); changed = []
for m in d["providers"]["ollama"]["models"]:
    if m.get("contextWindow") != ctx:
        changed.append((m["name"], m.get("contextWindow"), ctx))
        m["contextWindow"] = ctx
        m["maxTokens"] = min(m.get("maxTokens", 8192), max(1024, ctx // 2))
json.dump(d, open(path, "w"), indent=2); open(path, "a").write("\n")
for name, old, new in changed:
    print(f"  {name:<42} {old} -> {new}")
print(f"  {len(changed)} model(s) updated to {ctx}")
PY
echo "  Restart pi so it re-reads the file."
