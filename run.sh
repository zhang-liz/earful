#!/usr/bin/env bash
# Start the Read It To Me server, then open it in your browser.
#
#   ./run.sh              this Mac only
#   ./run.sh --lan        also reachable from your phone on the same Wi-Fi
#
# Set a password (always do this when using --lan on Wi-Fi you do not control):
#   TTS_PASSWORD=yourpassword ./run.sh --lan
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8888}"
HOST="127.0.0.1"
LAN=""

if [[ "${1:-}" == "--lan" ]]; then
  HOST="0.0.0.0"
  # The address other devices on this network use to reach this Mac.
  LAN="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
fi

echo "Starting on http://127.0.0.1:${PORT} (first run downloads the voice model)"
if [[ -n "$LAN" ]]; then
  echo "On your phone, open:  http://${LAN}:${PORT}"
  if [[ -z "${TTS_PASSWORD:-}" ]]; then
    echo "WARNING: no password set. Anyone on this network can open it."
    echo "         Restart with: TTS_PASSWORD=yourpassword ./run.sh --lan"
  else
    echo "Password is on. Leave the username blank and enter your password."
  fi
elif [[ "${1:-}" == "--lan" ]]; then
  echo "WARNING: could not find this Mac's Wi-Fi address. Is Wi-Fi connected?"
fi

( sleep 3; open "http://127.0.0.1:${PORT}" ) &
exec uv run uvicorn app.server:app --host "$HOST" --port "$PORT"
