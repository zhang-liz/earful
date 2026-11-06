#!/usr/bin/env bash
# Build Earful.app.
#
#   ./mac/build-app.sh            an app that runs this clone; put in /Applications
#   APP_DIR=~/Applications ./mac/build-app.sh
#   ./mac/build-app.sh --bundle   a self-contained app for anyone, in dist/:
#                                 Python, the code and the voices inside, no
#                                 internet needed (about 1.5 GB)
#
# Run it again after moving this folder: the clone's app remembers where it lives.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE=""
[[ "${1:-}" == "--bundle" ]] && BUNDLE=1
REPO="$(pwd)"
UV="$(command -v uv)" || { echo "uv not found. Install it first." >&2; exit 1; }
if [[ -n "$BUNDLE" ]]; then
  APP_DIR="${APP_DIR:-$REPO/dist}"
else
  APP_DIR="${APP_DIR:-/Applications}"
fi
APP="$APP_DIR/Earful.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The icon: one drawing, every size macOS asks for.
uv run --quiet --with pillow python mac/make_icon.py "$WORK/icon.png"
mkdir "$WORK/Earful.iconset"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$WORK/icon.png" --out "$WORK/Earful.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/Earful.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/Earful.iconset" -o "$WORK/Earful.icns"

# -s keeps the app open, so it has a Dock icon and a Quit that stops the server.
osacompile -s -o "$WORK/Earful.app" mac/Earful.applescript
RES="$WORK/Earful.app/Contents/Resources"
cp "$WORK/Earful.icns" "$RES/applet.icns"
# osacompile also ships the stock script icon in Assets.car, named by
# CFBundleIconName, and macOS prefers that over applet.icns. Drop both.
rm -f "$RES/Assets.car"
sed -e "s|__REPO__|$REPO|" -e "s|__TOOLS_PATH__|$(dirname "$UV")|" mac/earful.sh >"$RES/earful.sh"
chmod +x "$RES/earful.sh"
[[ -n "$BUNDLE" ]] && mac/bundle.sh "$RES"

PLIST="$WORK/Earful.app/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "local.earful" "$PLIST"
plutil -replace CFBundleName -string "Earful" "$PLIST"
plutil -remove CFBundleIconName "$PLIST" 2>/dev/null || true
if [[ -n "$BUNDLE" ]]; then
  VERSION="${VERSION:-$(git describe --tags --exact-match 2>/dev/null || echo 0.0.0)}"
  plutil -replace CFBundleShortVersionString -string "${VERSION#v}" "$PLIST"
  # The bundled Python and packages are built for Apple silicon only.
  plutil -replace LSArchitecturePriority -json '["arm64"]' "$PLIST"
  plutil -replace LSMinimumSystemVersion -string "13.0" "$PLIST"
fi

# Changing the bundle breaks osacompile's signature, so sign it again.
codesign --force --deep --sign - "$WORK/Earful.app"

rm -rf "$APP"
mkdir -p "$APP_DIR"
mv "$WORK/Earful.app" "$APP"
touch "$APP"   # make Finder and the Dock pick up the new icon
echo "Installed $APP"
