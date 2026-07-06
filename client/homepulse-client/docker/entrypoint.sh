#!/bin/sh
set -eu

# Path inside the container where config.json is mounted.
CONFIG_PATH="${CONFIG_PATH:-/etc/homepulse/config.json}"

# Falls back to 15 minutes if the field is missing, matching config.json.example.
INTERVAL_MINUTES=$(jq -r '.interval_minutes // 15' "$CONFIG_PATH")

echo "homepulse-client: running every ${INTERVAL_MINUTES} minute(s) using ${CONFIG_PATH}"

while true; do
    homepulse-client --config "$CONFIG_PATH" || echo "homepulse-client: run failed, retrying next interval" >&2
    sleep "$((INTERVAL_MINUTES * 60))"
done