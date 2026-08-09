#!/usr/bin/env bash
set -e
REPO="https://github.com/gashamorujov/WpFastMesenger.git"
DIR="WhatsAppBulkBot"
echo "=== WhatsApp Bulk Bot VPS Deployment (auto-update enabled) ==="
command -v docker >/dev/null 2>&1 || { echo "Docker required"; exit 1; }
if [ -d "$DIR" ]; then cd "$DIR" && git pull; else git clone "$REPO" && cd "$DIR"; fi
docker compose up -d --build
echo "✅ Done! Bot: http://localhost:3000"
echo "ℹ️  Bot auto-updates from GitHub every 5 minutes (git pull + restart)."
