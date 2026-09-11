#!/usr/bin/env bash
# Last check before rebooting into a swapped NVIDIA driver.
#
# Confirms the nvidia modules are actually inside the initramfs images -- the
# one thing that decides whether the machine comes back with a display.
set -uo pipefail
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "== initramfs contents =="
FOUND=0; GOOD=1
while read -r img; do
  [[ -f "$img" ]] || continue
  FOUND=1
  n=$(sudo lsinitcpio "$img" 2>/dev/null | grep -c "nvidia.*\.ko")
  if (( n > 0 )); then ok "$(basename "$img"): $n nvidia modules"
  else bad "$(basename "$img"): NO nvidia modules"; GOOD=0; fi
done < <(sudo find /boot -maxdepth 4 -name "*.img" 2>/dev/null | grep -viE "ucode|microcode")

(( FOUND )) || { echo "  (no .img found under /boot -- Limine may embed them elsewhere;"; echo "   the clean limine-mkinitcpio run is then your evidence)"; }

echo
echo "== driver state =="
grep -q "blacklist nouveau" /usr/lib/modprobe.d/*.conf /etc/modprobe.d/*.conf 2>/dev/null \
  && ok "nouveau blacklisted" || bad "nouveau NOT blacklisted"
for k in $(ls -1 /usr/lib/modules | grep -vE '^extramodules'); do
  [[ -d "/usr/lib/modules/$k/kernel" ]] || continue
  v=$(modinfo -k "$k" nvidia 2>/dev/null | awk '/^version/{print $2}')
  [[ -n "$v" ]] && ok "$k -> nvidia $v" || bad "$k -> no nvidia module"
done
modinfo -k "$(uname -r)" nvidia_drm 2>/dev/null | grep -q "1 = enable (default)" \
  && ok "kernel modesetting on by default (Wayland will start)" \
  || echo "  ! check nvidia_drm.modeset -- Wayland needs it"

echo
if (( GOOD )); then
  echo "  Reboot. If the screen stays black, SSH in from your phone and run:"
  echo "    cd $PWD && ./scripts/enable-second-gpu.sh --rollback && sudo limine-mkinitcpio && sudo reboot"
else
  echo "  Do NOT reboot. Re-run ./scripts/fix-driver-modules.sh first."
fi
