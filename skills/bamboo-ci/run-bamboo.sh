#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

. "$HERE/../_lib/load-secret.sh"

# TLS 설정은 공용 헬퍼가 결정한다 (사내 CA 번들 우선, 없으면 종전 동작 + 경고).
configure_tls_from_makdoong2_config "run-bamboo"

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
