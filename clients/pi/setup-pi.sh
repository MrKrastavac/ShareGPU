#!/usr/bin/env bash
# Point a coding harness on this machine at a ShareGPU server.
#
#   curl -fsSL http://<server>:8770/client/setup-pi.sh | bash
#   ./setup-pi.sh [server-url]
#
# Writes config for whichever harnesses are installed, picks a sensible default
# model from what the server actually has, and verifies the endpoint answers
# before claiming success. Re-runnable.
set -uo pipefail

CANDIDATES=()
[[ -n "${1:-}" ]] && CANDIDATES+=("$1")
[[ -n "${SHAREGPU_URL:-}" ]] && CANDIDATES+=("$SHAREGPU_URL")
# No addresses are baked in. Pass the server URL, set SHAREGPU_URL, or -- if you
# curl this script straight from the server -- it is taken from that URL.
[[ -n "${SHAREGPU_BOOTSTRAP_URL:-}" ]] && CANDIDATES+=("$SHAREGPU_BOOTSTRAP_URL")
CANDIDATES+=("http://127.0.0.1:8770")

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

echo "== finding the server =="
BASE=""
for url in "${CANDIDATES[@]}"; do
  if curl -fsS --max-time 4 "$url/healthz" >/dev/null 2>&1; then
    BASE="$url"; ok "reachable at $BASE"; break
  else
    info "no answer from $url"
  fi
done
if [[ -z "$BASE" ]]; then
  bad "Could not reach ShareGPU on any address."
  echo "     Check the Pi is on the same LAN or tailnet, then pass the URL:"
  echo "       ./setup-pi.sh http://<server-ip>:8770"
  exit 1
fi

echo
echo "== models the server has =="
MODELS_JSON="$(curl -fsS --max-time 10 "$BASE/v1/models" 2>/dev/null)"
[[ -n "$MODELS_JSON" ]] || { bad "could not list models"; exit 1; }
printf '%s' "$MODELS_JSON" > /tmp/.sharegpu-models.json

# Kept in its own file so no shell quoting can mangle it.
cat > /tmp/.sharegpu-pick.py <<'PICK'
import json, sys

data = json.load(open(sys.argv[1]))["data"]
for m in data:
    sg = m.get("sharegpu", {})
    tag = "  [loaded]" if sg.get("pinned") else ""
    print("    %-58s %5.1f GiB%s" % (m["id"][:58], sg.get("size_mb", 0) / 1024, tag),
          file=sys.stderr)

# A harness makes many sequential calls, so a coding model that is loaded and
# concurrent beats a bigger one that has to cold-load and serialise everyone.
def pick():
    keys = ("devstral", "coder", "codestral")
    for m in data:
        if any(k in m["id"].lower() for k in keys):
            return m["id"], "coding-specialised"
    for m in data:
        if m.get("sharegpu", {}).get("pinned"):
            return m["id"], "already resident, no cold load"
    return (data[0]["id"], "first available") if data else ("", "none")

name, why = pick()
print(name)
print(why)
PICK

MODEL="$(python3 /tmp/.sharegpu-pick.py /tmp/.sharegpu-models.json 2>/tmp/.sharegpu-list | head -1)"
REASON="$(python3 /tmp/.sharegpu-pick.py /tmp/.sharegpu-models.json 2>/dev/null | tail -1)"
cat /tmp/.sharegpu-list
rm -f /tmp/.sharegpu-pick.py /tmp/.sharegpu-models.json /tmp/.sharegpu-list

[[ -n "$MODEL" ]] || { bad "no models available on the server"; exit 1; }
echo
ok "default model: $MODEL  ($REASON)"

echo
echo "== writing config =="
mkdir -p "$HOME/.config/sharegpu" "$HOME/.local/bin"
# The whole catalogue, so the harness can offer a choice rather than one model.
printf '%s' "$MODELS_JSON" | python3 -c '
import json, sys
for m in json.load(sys.stdin)["data"]:
    sg = m.get("sharegpu", {})
    print("%s\t%.1f\t%s" % (m["id"], sg.get("size_mb", 0)/1024, "loaded" if sg.get("pinned") else ""))
' > "$HOME/.config/sharegpu/models.tsv" 2>/dev/null
ok "~/.config/sharegpu/models.tsv  ($(wc -l < "$HOME/.config/sharegpu/models.tsv" 2>/dev/null || echo 0) models)"

cat > "$HOME/.local/bin/sharegpu-models" <<'HELPER' 2>/dev/null || true
#!/usr/bin/env bash
# List the models the server currently has, live.
curl -fsS --max-time 10 "${SHAREGPU_URL:?run: . ~/.config/sharegpu/env}/v1/models" \
  | python3 -c '
import json, sys
for m in json.load(sys.stdin)["data"]:
    sg = m.get("sharegpu", {})
    print("%-60s %6.1f GiB %s" % (m["id"][:60], sg.get("size_mb", 0)/1024,
                                  "[loaded]" if sg.get("pinned") else ""))'
HELPER
chmod +x "$HOME/.local/bin/sharegpu-models" 2>/dev/null || true

cat > "$HOME/.config/sharegpu/env" <<ENV
# Source this, or let your shell rc do it:
#   . ~/.config/sharegpu/env
export OPENAI_BASE_URL="$BASE/v1"
export OPENAI_API_KEY="unused"          # reachability is the authorisation
export SHAREGPU_URL="$BASE"
export SHAREGPU_MODEL="$MODEL"
ENV
ok "~/.config/sharegpu/env"

if ! grep -q "config/sharegpu/env" "$HOME/.bashrc" 2>/dev/null; then
  echo '[ -f "$HOME/.config/sharegpu/env" ] && . "$HOME/.config/sharegpu/env"' >> "$HOME/.bashrc"
  ok "sourced it from ~/.bashrc"
fi

# --- aider
if command -v aider >/dev/null 2>&1; then
  cat > "$HOME/.aider.conf.yml" <<AIDER
openai-api-base: $BASE/v1
openai-api-key: unused
model: openai/$MODEL
# Thinking models spend their budget on a hidden scratchpad otherwise.
extra-params:
  reasoning_effort: none
AIDER
  ok "~/.aider.conf.yml  (switch per-run with: aider --model openai/<name>)"
else
  info "aider not installed (skipped)"
fi

# --- continue
if [[ -d "$HOME/.continue" ]]; then
  mkdir -p "$HOME/.continue"
  # One entry per model so they all appear in the picker, default first.
  printf '%s' "$MODELS_JSON" | BASE="$BASE" DEFAULT="$MODEL" python3 -c '
import json, os, sys
base, default = os.environ["BASE"], os.environ["DEFAULT"]
models = [m["id"] for m in json.load(sys.stdin)["data"]]
models.sort(key=lambda n: (n != default, n))
print(json.dumps({"models": [
    {"title": n, "provider": "openai", "model": n,
     "apiBase": base + "/v1", "apiKey": "unused",
     "completionOptions": {"reasoning_effort": "none"}}
    for n in models]}, indent=2))
' > "$HOME/.continue/config.json"
  ok "~/.continue/config.json"
else
  info "continue not installed (skipped)"
fi

# --- the python client, for scripted use
if curl -fsS --max-time 15 "$BASE/client/sharegpu.py" -o "$HOME/.config/sharegpu/sharegpu.py" 2>/dev/null; then
  ok "~/.config/sharegpu/sharegpu.py  (python client + CLI)"
fi

echo
echo "== verifying end to end =="
REPLY_TEXT="$(curl -fsS --max-time 120 "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' -H "x-sharegpu-client: $(hostname)" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: pi ok\"}],\"max_tokens\":20,\"reasoning_effort\":\"none\"}" \
  2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["choices"][0]["message"]["content"].strip())' 2>/dev/null)"

if [[ -n "$REPLY_TEXT" ]]; then
  ok "the GPU answered: \"$REPLY_TEXT\""
  echo
  echo "  Done. Open a new shell (or: . ~/.config/sharegpu/env) and your harness"
  echo "  will use the GPU pool on $BASE."
  echo "  List models any time:  sharegpu-models"
  echo "  Switch model:          export SHAREGPU_MODEL=<name>   (or aider --model openai/<name>)"
else
  bad "config written, but the test request failed"
  echo "     The model may be loading. Check $BASE in a browser."
  exit 1
fi
