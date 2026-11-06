#!/usr/bin/env bash
# Pack the extension for the Chrome Web Store and Edge Add-ons.
#
#   extension/pack.sh        -> dist/earful-extension-<version>.zip
#
# Only what Chrome loads goes in: no tests, no store texts, no tools. The zip
# is then unpacked and checked the way Chrome checks it at load time.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
OUT="../dist/earful-extension-$VERSION.zip"
mkdir -p ../dist
rm -f "$OUT"
zip -q -r -X "$OUT" . \
  -x 'test/*' 'store/*' 'node_modules/*' 'package.json' 'package-lock.json' \
     'check-manifest.py' 'pack.sh' '.*' '*/.*'

CHECK="$(mktemp -d)"
trap 'rm -rf "$CHECK"' EXIT
unzip -q "$OUT" -d "$CHECK"
python3 check-manifest.py "$CHECK"
echo "$(cd ..; pwd)/dist/$(basename "$OUT")"
unzip -l "$OUT" | tail -1
