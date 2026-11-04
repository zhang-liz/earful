#!/usr/bin/env bash
# Start or stop the server for the Earful Mac app.
#
#   earful.sh start   start the server if it is not running, then open the page
#   earful.sh stop    stop the server, but only if `start` started it
#
# build-app.sh fills in REPO and TOOLS_PATH, because an app launched from the
# Dock does not get your shell's PATH.
set -uo pipefail

REPO="__REPO__"
export PATH="__TOOLS_PATH__:/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-8888}"
URL="http://127.0.0.1:${PORT}"
LOG="$HOME/Library/Logs/Earful.log"
PIDFILE="$HOME/Library/Caches/Earful.pid"

up() { curl -s -o /dev/null --max-time 1 "$URL/"; }

start() {
  if ! up; then
    cd "$REPO" || exit 1
    NO_OPEN=1 nohup ./run.sh >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    # The first run downloads the voice model, so allow a few minutes.
    for _ in $(seq 1 300); do
      up && break
      sleep 1
    done
  fi
  open "$URL"
}

stop() {
  [[ -f "$PIDFILE" ]] || exit 0
  pid="$(cat "$PIDFILE")"
  rm -f "$PIDFILE"
  # run.sh hands over to uv, which runs the server as its child.
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
