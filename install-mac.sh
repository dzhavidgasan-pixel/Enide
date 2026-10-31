#!/bin/bash
# Enide — remove the old version, install this one, build Enide.app, put it in
# /Applications and on the Desktop, and open it.
#   bash install-mac.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Projects/enide"
step() { printf "\n\033[1;37m→ %s\033[0m\n" "$1"; }

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || { echo "Нужен Node.js 20+: https://nodejs.org"; open https://nodejs.org; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "Ставлю Xcode Command Line Tools (нужны для терминала в Enide)…"; xcode-select --install || true; }

step "Закрываю старый Enide"
osascript -e 'quit app "Enide"' >/dev/null 2>&1 || true
pkill -f "Electron.*enide" >/dev/null 2>&1 || true
sleep 1

step "Удаляю старую версию"
rm -rf /Applications/Enide.app "$HOME/Desktop/Enide.app" "$HOME/Desktop/Enide"
if [ "$SRC" != "$DEST" ]; then
  rm -rf "$DEST"
  mkdir -p "$HOME/Projects"
  cp -R "$SRC" "$DEST"
fi
cd "$DEST"
rm -rf release

step "Устанавливаю зависимости (1–3 мин)"
npm install --no-audit --no-fund

step "Собираю Enide.app"
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
npx electron-builder --mac dir --$ARCH -c.mac.identity=null
APP=$(find release -maxdepth 2 -name "Enide.app" -type d | head -1)
[ -n "$APP" ] || { echo "Сборка не нашла Enide.app — смотри ошибки выше"; exit 1; }

step "Кладу в Программы и на Рабочий стол"
cp -R "$APP" /Applications/
xattr -cr /Applications/Enide.app
codesign --force --deep --sign - /Applications/Enide.app >/dev/null 2>&1 || true
ln -sf /Applications/Enide.app "$HOME/Desktop/Enide.app"

# tidy up the unpacked update and archives
case "$SRC" in */enide-new/*) rm -rf "$(dirname "$SRC")" ;; esac
rm -f "$HOME/Projects/enide.zip" "$HOME/Projects/enide-update.zip" "$HOME/Projects/enide-new.zip" 2>/dev/null || true

step "Готово — открываю Enide"
open /Applications/Enide.app
