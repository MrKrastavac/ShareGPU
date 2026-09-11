# shellcheck shell=bash
# Shared by ShareGPU's scripts: find the systemd unit that runs Ollama, and
# change its environment without editing that unit.
#
# Detection, in order:
#   1. OLLAMA_UNIT (with OLLAMA_UNIT_SCOPE=user|system) if you set them
#   2. an active user unit whose command line runs `ollama serve`
#   3. an active system unit whose command line runs `ollama serve`
#   4. the stock `ollama.service` installed by Ollama's own script
#
# Changes go into a drop-in named sharegpu.conf beside the unit, never into the
# unit file: package upgrades leave it alone, your own settings stay yours, and
# deleting that one file undoes everything these scripts changed.

_ollama_systemctl() {        # reads need no privileges in either scope
  if [[ "${OLLAMA_UNIT_SCOPE:-user}" == user ]]; then systemctl --user "$@"; else systemctl "$@"; fi
}

_ollama_systemctl_write() {  # system units need root to reload and restart
  if [[ "${OLLAMA_UNIT_SCOPE:-user}" == user ]]; then systemctl --user "$@"; else sudo systemctl "$@"; fi
}

ollama_unit_detect() {
  if [[ -n "${OLLAMA_UNIT:-}" ]]; then
    OLLAMA_UNIT="${OLLAMA_UNIT%.service}"
    OLLAMA_UNIT_SCOPE="${OLLAMA_UNIT_SCOPE:-user}"
    return 0
  fi
  local scope found
  local -a flag units
  for scope in user system; do
    flag=(); [[ $scope == user ]] && flag=(--user)
    mapfile -t units < <(systemctl "${flag[@]}" list-units --type=service --state=active \
                           --no-legend --plain 2>/dev/null | awk '{print $1}')
    (( ${#units[@]} )) || continue
    # One batched `show`, parsed per unit: blocks are blank-line separated, and
    # properties do not come back in the order they were requested.
    found=$(systemctl "${flag[@]}" show -p Id -p ExecStart "${units[@]}" 2>/dev/null \
      | awk 'BEGIN { RS = "" }
             /argv\[\]=[^;]*ollama[^;]* serve/ {
               if (match($0, /Id=[^\n]*/)) { print substr($0, RSTART + 3, RLENGTH - 3); exit }
             }')
    if [[ -n "$found" ]]; then
      OLLAMA_UNIT="${found%.service}"; OLLAMA_UNIT_SCOPE=$scope
      return 0
    fi
  done
  if systemctl list-unit-files ollama.service --no-legend 2>/dev/null | grep -q '^ollama\.service'; then
    OLLAMA_UNIT=ollama; OLLAMA_UNIT_SCOPE=system
    return 0
  fi
  return 1
}

ollama_unit_require() {
  ollama_unit_detect && return 0
  echo "  Could not find a systemd unit running 'ollama serve'." >&2
  echo "  Name it explicitly, e.g.:  OLLAMA_UNIT=ollama OLLAMA_UNIT_SCOPE=system $0" >&2
  return 1
}

ollama_dropin() {
  if [[ "$OLLAMA_UNIT_SCOPE" == user ]]; then
    echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${OLLAMA_UNIT}.service.d/sharegpu.conf"
  else
    echo "/etc/systemd/system/${OLLAMA_UNIT}.service.d/sharegpu.conf"
  fi
}

# The effective value, after the unit file and every drop-in have been merged.
ollama_env_get() {
  _ollama_systemctl show "$OLLAMA_UNIT" -p Environment --value 2>/dev/null \
    | tr ' ' '\n' | tr -d '"' | sed -n "s/^$1=//p" | tail -1
}

# ollama_env_set KEY VALUE [KEY VALUE ...]
ollama_env_set() {
  local file; file="$(ollama_dropin)"
  local -A env=()
  local line key re='^Environment="?([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"?$'
  if [[ -f "$file" ]]; then
    while IFS= read -r line; do
      [[ $line =~ $re ]] && env["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
    done < "$file"
  fi
  while (( $# >= 2 )); do env["$1"]="$2"; shift 2; done

  local body
  body="# Managed by ShareGPU's scripts. Delete this file, then daemon-reload and"$'\n'
  body+="# restart the service, to undo every change they made."$'\n'
  body+="[Service]"$'\n'
  while IFS= read -r key; do
    [[ -n "$key" ]] && body+="Environment=\"${key}=${env[$key]}\""$'\n'
  done < <(printf '%s\n' "${!env[@]}" | sort)

  if [[ "$OLLAMA_UNIT_SCOPE" == user ]]; then
    mkdir -p "$(dirname "$file")" && printf '%s' "$body" > "$file"
  else
    sudo mkdir -p "$(dirname "$file")" && printf '%s' "$body" | sudo tee "$file" >/dev/null
  fi
}

ollama_restart() {
  _ollama_systemctl_write daemon-reload || return 1
  _ollama_systemctl_write restart "$OLLAMA_UNIT" || return 1
  local url="${OLLAMA_URL:-http://127.0.0.1:11434}" _i
  for _i in $(seq 1 30); do
    curl -fsS --max-time 2 "$url/api/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

ollama_status_hint() {
  if [[ "$OLLAMA_UNIT_SCOPE" == user ]]; then echo "systemctl --user status $OLLAMA_UNIT"
  else echo "systemctl status $OLLAMA_UNIT"; fi
}
