#!/usr/bin/env bash
# Repair a half-finished NVIDIA driver swap, then say whether it is safe to
# reboot.
#
# The failure this fixes: the DKMS modules built, but depmod was never re-run,
# so modinfo and mkinitcpio cannot find them ("module not found: nvidia").
# Separately the LTS kernel's build was interrupted, leaving the fallback
# kernel with no module at all.
#
# Run it, then read the verdict at the end. Do not reboot until it says so.
set -uo pipefail

banner() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()     { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()    { printf '  \033[31m✗\033[0m %s\n' "$1"; }

DKMS_VER="$(dkms status 2>/dev/null | grep -m1 '^nvidia/' | cut -d/ -f2 | cut -d, -f1)"
[[ -n "$DKMS_VER" ]] || { bad "no nvidia dkms module registered -- reinstall nvidia-580xx-dkms"; exit 1; }
echo "  dkms module: nvidia/$DKMS_VER"

# Every installed kernel, not just the running one: the fallback kernel needs a
# module too, or it is not a fallback.
mapfile -t KERNELS < <(ls -1 /usr/lib/modules 2>/dev/null | grep -E 'cachyos')

banner "Building for every installed kernel"
for k in "${KERNELS[@]}"; do
  [[ -d "/usr/lib/modules/$k/build" ]] || { bad "$k has no headers, skipping"; continue; }
  if [[ -f "/usr/lib/modules/$k/updates/dkms/nvidia.ko.zst" ]]; then
    ok "$k already has modules"
  else
    echo "  building for $k (this takes a minute)..."
    sudo dkms install "nvidia/$DKMS_VER" -k "$k" --force 2>&1 | tail -3
  fi
done

banner "Refreshing the module database"
# This is the step whose absence caused "module not found".
for k in "${KERNELS[@]}"; do
  sudo depmod -a "$k" && ok "depmod $k"
done

banner "Verifying each kernel can resolve the modules"
ALL_GOOD=1
for k in "${KERNELS[@]}"; do
  MISSING=""
  for m in nvidia nvidia_modeset nvidia_uvm nvidia_drm; do
    modinfo -k "$k" "$m" >/dev/null 2>&1 || MISSING="$MISSING $m"
  done
  if [[ -z "$MISSING" ]]; then ok "$k resolves all four modules"
  else bad "$k is MISSING:$MISSING"; ALL_GOOD=0; fi
done

banner "Rebuilding the initramfs"
if command -v limine-mkinitcpio >/dev/null 2>&1; then
  sudo limine-mkinitcpio 2>&1 | grep -E "ERROR|WARNING|Building|Creating" | sed 's/^/  /'
else
  sudo mkinitcpio -P 2>&1 | grep -E "ERROR|WARNING|Building|Creating" | sed 's/^/  /'
fi

banner "VERDICT"
if (( ALL_GOOD )); then
  cat <<'YES'
  Safe to reboot.

  Userspace is on 580 while the kernel still runs the old 610 module, so
  nvidia-smi will keep reporting a version mismatch until you reboot. That is
  expected and resolves itself on restart.

  After rebooting:
    nvidia-smi                      -- both cards should be listed
    ./scripts/pool-gpus.sh --apply  -- merge them for large models
YES
else
  cat <<'NO'
  DO NOT REBOOT YET. At least one kernel cannot resolve the nvidia modules,
  so it would boot without a display driver.

  Get back to a working desktop with:
    ./scripts/enable-second-gpu.sh --rollback
    sudo limine-mkinitcpio

  Then send me the output of:  sudo dkms install nvidia/VERSION -k KERNEL
NO
fi
