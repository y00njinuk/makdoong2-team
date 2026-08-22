#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

. "$HERE/../_lib/load-secret.sh"

export NODE_TLS_REJECT_UNAUTHORIZED="0"

load_host_from_makdoong2_config \
  "run-docs" \
  "CONFLUENCE_HOST" \
  "Example: confluence.example.com (Confluence DC host, no scheme)."
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi

load_secret_from_makdoong2_config \
  "run-docs" \
  "CONFLUENCE_API_TOKEN" \
  "See your Confluence DC instance — profile → Personal Access Tokens."
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi

exec npx -y @atlassian-dc-mcp/confluence
