#!/usr/bin/env bash
# Swap the NVIDIA driver so BOTH GPUs work, then pool them for large models.
#
#   enable-second-gpu.sh            show what would change, change nothing
#   enable-second-gpu.sh --apply    do it
#   enable-second-gpu.sh --rollback go back to the open 610 driver
#
# WHY THIS IS NEEDED
#   The GTX 1080 Ti is Pascal. It cannot work on the current driver for two
#   independent reasons:
#     1. The *open* kernel module needs GSP firmware, which only exists on
#        Turing and newer. Pascal cannot bind to it at all.
#     2. Driver branch 610 dropped Pascal entirely. 580 is the last branch
#        that supports it -- hence the nvidia-580xx-* legacy packages.
#   So both cards can only coexist on the proprietary 580 branch, which still
#   supports Ampere (the 3090) and CUDA 13.
#
# THE RISK
#   This replaces the driver your desktop is running on. If it goes wrong you
#   get a black screen at the next boot. SSH is your way back in -- confirm you
#   can reach this machine over SSH from another device BEFORE rebooting.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

OPEN_PKGS=(linux-cachyos-nvidia-open linux-cachyos-lts-nvidia-open nvidia-utils
           nvidia-settings opencl-nvidia lib32-nvidia-utils lib32-opencl-nvidia)
LEGACY_PKGS=(nvidia-580xx-dkms nvidia-580xx-utils nvidia-580xx-settings
             opencl-nvidia-580xx lib32-nvidia-580xx-utils lib32-opencl-nvidia-580xx)

banner() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

banner "Current state"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/  driver sees: /'
lspci 2>/dev/null | grep -i vga | sed 's/^/  installed:   /'
echo
for slot in $(lspci 2>/dev/null | grep -i 'vga.*nvidia' | cut -d' ' -f1); do
  if lspci -k -s "$slot" 2>/dev/null | grep -q "Kernel driver in use"; then
    echo "  $slot -> driver bound"
  else
    echo "  $slot -> NO DRIVER BOUND"
  fi
done

case "${1:-}" in
  --apply)
    banner "Pre-flight"
    for k in linux-cachyos-headers linux-cachyos-lts-headers; do
      pacman -Q "$k" >/dev/null 2>&1 || { echo "  MISSING $k -- dkms cannot build. Install it first."; exit 1; }
      echo "  $k present"
    done
    systemctl is-active --quiet sshd && echo "  sshd is running (your way back in)" \
      || echo "  WARNING: sshd is NOT running. If the display fails you have no remote access."

    cat <<WARN

  This will replace the open 610 driver with the proprietary 580 driver.
  Removing : ${OPEN_PKGS[*]}
  Installing: ${LEGACY_PKGS[*]}

  Your desktop will keep running on the loaded module until you reboot.
  DO NOT REBOOT until you have confirmed SSH works from another device.

  Roll back at any time with:  $0 --rollback

WARN
    read -r -p "  Type EXACTLY 'swap driver' to proceed: " reply
    [[ "$reply" == "swap driver" ]] || { echo "  aborted"; exit 1; }

    banner "Swapping (single transaction -- it all lands or none of it does)"
    sudo pacman -Rdd --noconfirm "${OPEN_PKGS[@]}" 2>/dev/null
    if ! sudo pacman -S --needed "${LEGACY_PKGS[@]}"; then
      echo
      echo "  INSTALL FAILED. You may currently have no driver packages."
      echo "  Recover with: $0 --rollback"
      exit 1
    fi

    # DKMS builds only for the running kernel by default, and pacman does not
    # fail when a build is interrupted -- so the modules are verified here
    # rather than assumed. Skipping this check is what turns a driver swap into
    # an unbootable desktop.
    banner "Building the module for every installed kernel"
    DKMS_VER="$(dkms status 2>/dev/null | grep -m1 '^nvidia/' | cut -d/ -f2 | cut -d, -f1)"
    for k in $(ls -1 /usr/lib/modules 2>/dev/null | grep -E 'cachyos'); do
      [[ -d "/usr/lib/modules/$k/build" ]] || continue
      if [[ -f "/usr/lib/modules/$k/updates/dkms/nvidia.ko.zst" ]]; then
        echo "  $k already built"
      else
        echo "  building for $k..."
        sudo dkms install "nvidia/$DKMS_VER" -k "$k" --force 2>&1 | tail -2
      fi
      sudo depmod -a "$k"
    done

    banner "Verifying before touching the initramfs"
    SAFE=1
    for k in $(ls -1 /usr/lib/modules 2>/dev/null | grep -E 'cachyos'); do
      [[ -d "/usr/lib/modules/$k/build" ]] || continue
      for m in nvidia nvidia_modeset nvidia_uvm nvidia_drm; do
        modinfo -k "$k" "$m" >/dev/null 2>&1 || { echo "  $k cannot resolve $m"; SAFE=0; }
      done
      ((SAFE)) && echo "  $k resolves all modules"
    done
    if ((!SAFE)); then
      echo
      echo "  STOPPING. Modules are missing, so the initramfs would be built without"
      echo "  a driver and the machine would boot to a black screen."
      echo "  Run ./scripts/fix-driver-modules.sh, or roll back with:"
      echo "    $0 --rollback"
      exit 1
    fi

    banner "Rebuilding initramfs"
    if command -v limine-mkinitcpio >/dev/null 2>&1; then
      sudo limine-mkinitcpio || echo "  (reported a problem -- read it before rebooting)"
    else
      sudo mkinitcpio -P || echo "  (reported a problem -- read it before rebooting)"
    fi

    banner "Next steps"
    cat <<'NEXT'
  1. From ANOTHER device, confirm you can SSH in right now.
  2. Reboot.
  3. Run: nvidia-smi        -- both cards should be listed.
  4. Run: ./scripts/pool-gpus.sh --apply   to make Ollama use both.

  If the screen stays black after reboot: SSH in and run
    ./scripts/enable-second-gpu.sh --rollback && sudo reboot
NEXT
    ;;

  --rollback)
    banner "Restoring the open 610 driver"
    sudo pacman -Rdd --noconfirm "${LEGACY_PKGS[@]}" 2>/dev/null
    sudo pacman -S --needed "${OPEN_PKGS[@]}" || { echo "  rollback failed -- fix packages manually"; exit 1; }
    sudo mkinitcpio -P
    echo "  Rolled back. Reboot to load the open driver again."
    ;;

  *)
    banner "Dry run -- nothing changed"
    echo "  Would remove : ${OPEN_PKGS[*]}"
    echo "  Would install: ${LEGACY_PKGS[*]}"
    echo
    echo "  Run with --apply to do it, --rollback to undo it."
    ;;
esac
