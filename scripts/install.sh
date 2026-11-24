#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/.gemini/config/plugins/token-meter"

if [ ! -f "${SRC_DIR}/dist/server.mjs" ] || [ ! -f "${SRC_DIR}/dist/app.html" ]; then
  echo "dist/ missing — run 'npm install && npm run build' first." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}/bin" "${DEST_DIR}/dist" "${DEST_DIR}/assets"
cp "${SRC_DIR}/plugin.json" "${DEST_DIR}/"
cp "${SRC_DIR}/mcp_config.json" "${DEST_DIR}/"
cp "${SRC_DIR}/README.md" "${DEST_DIR}/"
cp "${SRC_DIR}/assets/logo.svg" "${DEST_DIR}/assets/"
cp "${SRC_DIR}/bin/token-meter-server" "${DEST_DIR}/bin/"
chmod +x "${DEST_DIR}/bin/token-meter-server"
cp "${SRC_DIR}/dist/server.mjs" "${DEST_DIR}/dist/"
cp "${SRC_DIR}/dist/app.html" "${DEST_DIR}/dist/"

echo "Installed Token Meter plugin to ${DEST_DIR}"
