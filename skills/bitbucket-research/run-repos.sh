#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

. "$HERE/../_lib/load-secret.sh"

export NODE_TLS_REJECT_UNAUTHORIZED="0"

load_host_from_makdoong2_config \
  "run-repos" \
  "BITBUCKET_API_BASE_PATH" \
  "Example: https://bitbucket.example.com/rest (Bitbucket DC REST base URL)."
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi

load_secret_from_makdoong2_config \
  "run-repos" \
  "BITBUCKET_API_TOKEN" \
  "See your Bitbucket DC instance — profile → Manage account → HTTP access tokens."
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi

exec npx -y @atlassian-dc-mcp/bitbucket
