#!/usr/bin/env bash
# Install the launcher and the stop shortcut onto the desktop and into the
# application menu. Safe to re-run; it also fixes the paths if the project moves.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
MENU_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR" "$MENU_DIR"

for template in desktop/*.desktop.in; do
  name="$(basename "$template" .in)"
  for target in "$DESKTOP_DIR/$name" "$MENU_DIR/$name"; do
    sed "s|__ROOT__|$ROOT|g" "$template" > "$target"
    chmod +x "$target"
    echo "installed $target"
  done
done

chmod +x scripts/*.sh

# KDE trusts a desktop file once it is executable; refresh the menu caches.
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$MENU_DIR" 2>/dev/null || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true

echo
echo "Done. Start it with the ShareGPU icon; stop it with Stop ShareGPU."
echo "Right-click the launcher for: chat-only mode, this-machine-only, stop and"
echo "free the GPU, the connection diagnostic, the firewall opener, and the log."
