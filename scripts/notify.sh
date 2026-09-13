#!/usr/bin/env bash
# Send a plain-text message to the configured Telegram chat: scripts/notify.sh "text". Reads .env; never prints the token.
set -euo pipefail
cd "$(dirname "$0")/.."
token=$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '"'"'"' ')
chat=$(grep -E '^TELEGRAM_CHAT_ID=' .env | cut -d= -f2- | tr -d '"'"'"' ')
[ -n "$token" ] && [ -n "$chat" ] || { echo "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env" >&2; exit 1; }
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://api.telegram.org/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1"
