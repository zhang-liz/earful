#!/usr/bin/env bash
# Pack Earful.app into a disk image people drag to Applications.
#
#   mac/make-dmg.sh dist/Earful.app dist/Earful.dmg
set -euo pipefail

APP="$1"
OUT="$2"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ditto "$APP" "$STAGE/Earful.app"
ln -s /Applications "$STAGE/Applications"
# macOS stops an app from an unregistered maker the first time; this says
# how to open it anyway, in Chinese and English.
cp "$(dirname "$0")/how-to-open.txt" "$STAGE/如何打开 How to open.txt"
rm -f "$OUT"
# lzfse compression: smaller than zlib, and every macOS Earful runs on reads it.
hdiutil create -quiet -volname Earful -srcfolder "$STAGE" -fs HFS+ -format ULFO "$OUT"
du -h "$OUT" | sed 's/^/  /'
