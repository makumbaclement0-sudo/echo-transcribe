#!/usr/bin/env bash
# Echo — start the app AND a public Cloudflare tunnel (macOS/Linux).
#   ./start-public.sh          # serves on the default port below
#   PORT=5300 ./start-public.sh # override the port
# Requires: node/npm and cloudflared on your PATH.
# Ctrl-C stops both the app and the tunnel.
set -euo pipefail

PORT="${PORT:-4300}"
cd "$(dirname "$0")"

cleanup() { kill "${APP_PID:-}" "${TUN_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting the Echo app on port ${PORT} ..."
npm run dev -- -p "${PORT}" &
APP_PID=$!

# Wait for the app to answer before opening the tunnel.
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:${PORT}/"; then break; fi
  sleep 1
done

echo "Starting the public Cloudflare tunnel ..."
echo "  Local:  http://localhost:${PORT}/funding"
echo "  Public: watch below for the https://<...>.trycloudflare.com link — add /funding to it."
cloudflared tunnel --url "http://localhost:${PORT}" &
TUN_PID=$!

wait
