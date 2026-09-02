#!/usr/bin/env bash
# Start the Read It To Me server, then open it in your browser.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8888}"
echo "Starting on http://127.0.0.1:${PORT} (first run downloads the voice model)"
( sleep 3; open "http://127.0.0.1:${PORT}" ) &
exec uv run uvicorn app.server:app --host 127.0.0.1 --port "${PORT}"
