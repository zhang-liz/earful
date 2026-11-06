#!/usr/bin/env bash
# Start or stop the server for the Earful Mac app.
#
#   earful.sh start   start the server if it is not running, then open the page
#   earful.sh stop    stop the server, but only if `start` started it
#   earful.sh serve   run the server here, in the foreground (for checks)
#
# Two kinds of app use this script:
#   - a self-contained app (build-app.sh --bundle): Python, the code and the
#     voices are inside the app, next to this script, and it needs no internet;
#   - an app for this clone (build-app.sh): it runs ./run.sh from REPO with uv.
# build-app.sh fills in REPO and TOOLS_PATH, because an app launched from the
# Dock does not get your shell's PATH.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="__REPO__"
export PATH="__TOOLS_PATH__:/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-8888}"
URL="http://127.0.0.1:${PORT}"
LOG="$HOME/Library/Logs/Earful.log"
PIDFILE="$HOME/Library/Caches/Earful.pid"

up() { curl -s -o /dev/null --max-time 1 "$URL/"; }

bundled() { [[ -x "$HERE/py/bin/python3" ]]; }

serve() {
  if bundled; then
    # Everything is read from inside the app, and nothing is fetched: the
    # app must work where Hugging Face cannot be reached. Nothing is written
    # inside the app either, since that would break its signature.
    export HF_HOME="$HERE/hf" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
    export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
    export EARFUL_OUTPUT_DIR="${EARFUL_OUTPUT_DIR:-$HOME/Library/Caches/Earful/output}"
    cd "$HERE/earful" || exit 1
    # A page following a reading holds a connection open; do not wait long.
    exec "$HERE/py/bin/python3" -m uvicorn app.server:app \
      --host 127.0.0.1 --port "$PORT" --timeout-graceful-shutdown 3
  fi
  cd "$REPO" || exit 1
  NO_OPEN=1 exec ./run.sh
}

start() {
  if ! up; then
    mkdir -p "$(dirname "$LOG")" "$(dirname "$PIDFILE")"
    nohup "$0" serve >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    # Loading the voice takes a little while, the first time most of all.
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
  # In a clone, run.sh hands over to uv, which runs the server as its child.
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  serve) serve ;;
  *) echo "usage: $0 start|stop|serve" >&2; exit 2 ;;
esac
