#!/usr/bin/env bash
# Check a self-contained Earful.app the way a new user's Mac would run it:
# no internet, an empty home folder, the app unable to write into itself, and
# run from a long hidden folder as macOS does with a downloaded app. It must
# read English and Chinese aloud.
#
#   mac/check-app.sh dist/Earful.app
set -euo pipefail

APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PORT="${PORT:-8977}"
URL="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
# Like macOS's App Translocation folder: /private/var/folders/../AppTranslocation/<id>/d/
FAR="$TMP/AppTranslocation/0F0B3C1A-1234-5678-9ABC-DEF012345678/d"
mkdir -p "$FAR" "$TMP/home"
mv "$APP" "$FAR/"
RUN="$FAR/$(basename "$APP")"
pid=""
finish() {
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  chmod -R u+w "$RUN" 2>/dev/null
  mv "$RUN" "$APP"
  rm -rf "$TMP"
}
trap finish EXIT
chmod -R a-w "$RUN"

# A proxy that goes nowhere: any attempt to reach the internet fails.
env -i HOME="$TMP/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin PORT="$PORT" \
  http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 \
  "$RUN/Contents/Resources/earful.sh" serve >"$TMP/server.log" 2>&1 &
pid=$!

fail() { echo "FAIL: $*"; tail -n 40 "$TMP/server.log"; exit 1; }
curl -s -o /dev/null --retry 90 --retry-delay 1 --retry-all-errors "$URL/voices" || fail "the server never answered"

read_aloud() {   # text, then what to call it
  local job state
  job="$(curl -s -X POST "$URL/speak" -H 'Content-Type: application/json' \
    -d "{\"text\": \"$1\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null)" \
    || fail "$2: /speak refused"
  for _ in $(seq 1 300); do
    state="$(curl -s "$URL/progress-once/$job" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])' 2>/dev/null)" \
      || state="gone: the server stopped answering"
    [[ "$state" != running ]] && break
    sleep 1
  done
  [[ "$state" == ready ]] || fail "$2: the reading ended as $state"
  local bytes
  bytes="$(curl -s "$URL/chunk/$job/0.wav" | wc -c | tr -d ' ')"
  (( bytes > 20000 )) || fail "$2: only $bytes bytes of sound"
  echo "ok: $2 ($bytes bytes of sound)"
}

read_aloud "Hello! This app works with no internet at all." "English"
read_aloud "你好！这个应用不用联网也能朗读，iPhone 也读得出来。" "Chinese"
grep -q "Error processing file" "$TMP/server.log" && fail "espeak could not find its data"
echo "OK: the app reads English and Chinese with no internet, from a long folder, without writing into itself."
