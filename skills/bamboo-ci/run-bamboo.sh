#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

. "$HERE/../_lib/load-secret.sh"

export NODE_TLS_REJECT_UNAUTHORIZED="0"

load_host_from_makdoong2_config \
  "run-bamboo" \
  "BAMBOO_URL" \
  "Example: https://bamboo.example.com (Bamboo base URL)."
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi

load_secret_from_makdoong2_config \
  "run-bamboo" \
  "BAMBOO_TOKEN" \
  "See your Bamboo instance — profile → Personal Access Tokens."
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi

exec npx -y bamboo-mcp-server@latest
