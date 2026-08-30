#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

. "$HERE/../_lib/load-secret.sh"

# TLS 설정은 공용 헬퍼가 결정한다 (사내 CA 번들 우선, 없으면 종전 동작 + 경고).
configure_tls_from_makdoong2_config "run-repos"

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
