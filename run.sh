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

# With Tailscale signed in, put it in front of the server. That does two
# things: it works from any network rather than this one, and it serves on the
# usual web port, so the phone address needs no port number. Failure here is
# fine — the plain address still works on this network.
if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    tailscale serve --bg --http=80 "$PORT" >/dev/null 2>&1 || true
    SHORT="$(tailscale status --json 2>/dev/null       | python3 -c 'import sys,json;d=json.load(sys.stdin);n=(d.get("Self") or {}).get("DNSName","").rstrip(".");s=(d.get("MagicDNSSuffix") or "").rstrip(".");print(n[:-len(s)-1] if s and n.endswith("."+s) else n)' 2>/dev/null || true)"
    [[ -n "$SHORT" ]] && echo "On your phone, open:  http://${SHORT}/go"
  fi
fi

( sleep 3; open "http://127.0.0.1:${PORT}" ) &
exec uv run uvicorn app.server:app --host "$HOST" --port "$PORT"
