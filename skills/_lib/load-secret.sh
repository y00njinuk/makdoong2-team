# Shared credential loader sourced by skills/*/run-*.sh.
#
# Contract: load_secret_from_makdoong2_config TAG VAR_NAME [HELP_HINT]
#   TAG        short caller label used in stderr prefix
#   VAR_NAME   .secrets.<VAR_NAME> lookup key AND exported env var name
#   HELP_HINT  optional trailing hint printed on the missing-token path
#
# Exit codes (propagated to opencode's MCP-spawn error surface):
#   65 jq missing   66 makdoong2-team.json missing
#   67 invalid JSON 68 .secrets.<VAR_NAME> null/empty

set -uo pipefail

load_secret_from_makdoong2_config() {
  local tag="${1:?load_secret: TAG missing}"
  local var_name="${2:?load_secret: VAR_NAME missing}"
  local help_hint="${3:-}"

  local cfg_dir="${MAKDOONG2_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
  local cfg_file="$cfg_dir/makdoong2-team.json"

  if ! command -v jq >/dev/null 2>&1; then
    printf '[%s] jq not found on PATH — install jq to load credentials from %s\n' \
      "$tag" "$cfg_file" >&2
    return 65
  fi

  if [ ! -f "$cfg_file" ]; then
    cat >&2 <<EOF
[$tag] makdoong2-team.json not found at $cfg_file

Run 'npx makdoong2-team install' to seed it, then edit the file and set:

  {
    "secrets": {
      "$var_name": "<your token>"
    }
  }
EOF
    return 66
  fi

  # `jq -e` fails when the file cannot be parsed; capture stderr for diagnostics.
  local token jq_err
  # 임시 파일은 **설정 파일과 같은 디렉토리**에 만든다. 종전 폴백은 `/tmp` 을
  # 명령문에 노출시켰는데, opencode 1.18 의 ShellTool 은 bash 명령이 참조하는
  # 디렉토리마다 external_directory 승인을 묻고, 서브에이전트 세션에서 그 요청은
  # 자동 거부 + 세션 abort 로 이어진다 (워크스페이스 밖 경로이므로).
  # mktemp 실패 시에도 워크스페이스 밖으로 새지 않게 한다.
  jq_err=""
  jq_err=$(mktemp "$(dirname "$cfg_file")/.load-secret.XXXXXX" 2>/dev/null) || jq_err=""
  # mktemp 실패 시 /dev/null 로 흘린다. 이때 `jq_err` 는 빈 문자열로 남으므로
  # 아래 정리 단계가 **실제로 만든 파일만** 지운다 — `rm -f /dev/null` 은
  # root 로 도는 환경(이슈 #8 로그의 /root/.nvm)에서 진짜로 장치 노드를 지운다.
  local jq_err_sink="${jq_err:-/dev/null}"
  token=$(jq -r --arg k "$var_name" '.secrets[$k] // empty' "$cfg_file" 2>"$jq_err_sink")
  local jq_status=$?
  if [ "$jq_status" -ne 0 ]; then
    printf '[%s] makdoong2-team.json is not valid JSON: %s\n' "$tag" "$cfg_file" >&2
    if [ -s "$jq_err_sink" ]; then sed -e "s/^/[$tag] jq: /" "$jq_err_sink" >&2; fi
    if [ -n "$jq_err" ]; then rm -f -- "$jq_err"; fi
    return 67
  fi
  if [ -n "$jq_err" ]; then rm -f -- "$jq_err"; fi

  if [ -z "$token" ] || [ "$token" = "null" ]; then
    cat >&2 <<EOF
[$tag] .secrets.$var_name is not set in $cfg_file

Edit the file and add:

  {
    "secrets": {
      "$var_name": "<your token>"
    }
  }

Then restart opencode so the skill re-spawns.
EOF
    if [ -n "$help_hint" ]; then printf '[%s] %s\n' "$tag" "$help_hint" >&2; fi
    return 68
  fi

  local existing_token
  eval "existing_token=\${$var_name:-}"
  
  if [ -n "$existing_token" ] && [ "$existing_token" != "$token" ]; then
    cat >&2 <<EOF
[$tag] WARNING: $var_name mismatch detected
  opencode.json (or pre-set env): ${existing_token:0:20}...
  makdoong2-team.json (SSoT):     ${token:0:20}...

makdoong2-team plugin enforces SSoT policy: using makdoong2-team.json value.
To avoid this warning, update opencode.json or ensure both files have identical tokens.
EOF
    unset "$var_name"
  fi

  # shellcheck disable=SC2163
  export "$var_name=$token"
  return 0
}

# Contract: load_host_from_makdoong2_config TAG VAR_NAME [HELP_HINT]
#   TAG        short caller label used in stderr prefix
#   VAR_NAME   .hosts.<VAR_NAME> lookup key AND exported env var name
#   HELP_HINT  optional trailing hint printed on the missing-host path
#
# Exit codes:
#   65 jq missing   66 makdoong2-team.json missing
#   67 invalid JSON 69 .hosts.<VAR_NAME> null/empty
load_host_from_makdoong2_config() {
  local tag="${1:?load_host: TAG missing}"
  local var_name="${2:?load_host: VAR_NAME missing}"
  local help_hint="${3:-}"

  local cfg_dir="${MAKDOONG2_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
  local cfg_file="$cfg_dir/makdoong2-team.json"

  if ! command -v jq >/dev/null 2>&1; then
    printf '[%s] jq not found on PATH — install jq to load hosts from %s\n' \
      "$tag" "$cfg_file" >&2
    return 65
  fi

  if [ ! -f "$cfg_file" ]; then
    printf '[%s] makdoong2-team.json not found at %s\n' "$tag" "$cfg_file" >&2
    return 66
  fi

  local host
  host=$(jq -r --arg k "$var_name" '.hosts[$k] // empty' "$cfg_file" 2>/dev/null)
  if [ $? -ne 0 ]; then
    printf '[%s] makdoong2-team.json is not valid JSON: %s\n' "$tag" "$cfg_file" >&2
    return 67
  fi

  if [ -z "$host" ] || [ "$host" = "null" ]; then
    cat >&2 <<EOF
[$tag] .hosts.$var_name is not set in $cfg_file

Edit the file and add your on-prem endpoint:

  {
    "hosts": {
      "$var_name": "<your host or base URL>"
    }
  }

Then restart opencode so the skill re-spawns.
EOF
    if [ -n "$help_hint" ]; then printf '[%s] %s\n' "$tag" "$help_hint" >&2; fi
    return 69
  fi

  # shellcheck disable=SC2163
  export "$var_name=$host"
  return 0
}

# ── TLS 검증 설정 ────────────────────────────────────────────────────────────
# configure_tls_from_makdoong2_config TAG
#
# 종전에는 4개 런처가 전부 무조건 `export NODE_TLS_REJECT_UNAUTHORIZED="0"` 을
# 했다. 그 프로세스는 사내 PAT 를 들고 사내 Jira/Confluence/Bitbucket/Bamboo 로
# 나가므로, **인증서 검증을 끈 채 자격증명을 전송**하는 상태였다 (중간자 공격에
# 무방비). 사내 사설 CA 때문에 넣은 것으로 보이지만, 그 경우의 올바른 해법은
# 검증을 끄는 것이 아니라 CA 번들을 알려주는 것이다.
#
# 우선순위:
#   1. `.network.ca_bundle` 이 있고 파일이 실재 → NODE_EXTRA_CA_CERTS 로 지정하고
#      **검증을 켠다**. 사내 사설 CA 의 정답.
#   2. `.network.tls_reject_unauthorized` 가 true → 검증을 켠다.
#   3. 그 외 → 종전 동작(검증 끔)을 유지하되 **매 기동마다 경고**한다.
#      동작을 깨지 않으면서 위험을 드러내고 고치는 법을 알려주기 위함이다.
configure_tls_from_makdoong2_config() {
  local tag="${1:?configure_tls: TAG missing}"

  local cfg_dir="${MAKDOONG2_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
  local cfg_file="$cfg_dir/makdoong2-team.json"

  local ca_bundle="" reject=""
  if command -v jq >/dev/null 2>&1 && [ -f "$cfg_file" ]; then
    ca_bundle=$(jq -r '.network.ca_bundle // empty' "$cfg_file" 2>/dev/null || true)
    reject=$(jq -r '.network.tls_reject_unauthorized // empty' "$cfg_file" 2>/dev/null || true)
  fi

  if [ -n "$ca_bundle" ] && [ -f "$ca_bundle" ]; then
    export NODE_EXTRA_CA_CERTS="$ca_bundle"
    unset NODE_TLS_REJECT_UNAUTHORIZED
    printf '[%s] TLS: 사내 CA 번들 사용 (%s) — 인증서 검증 켬\n' "$tag" "$ca_bundle" >&2
    return 0
  fi

  if [ -n "$ca_bundle" ]; then
    printf '[%s] TLS: .network.ca_bundle 파일을 찾을 수 없다: %s\n' "$tag" "$ca_bundle" >&2
  fi

  if [ "$reject" = "true" ]; then
    unset NODE_TLS_REJECT_UNAUTHORIZED
    printf '[%s] TLS: 인증서 검증 켬 (.network.tls_reject_unauthorized=true)\n' "$tag" >&2
    return 0
  fi

  export NODE_TLS_REJECT_UNAUTHORIZED="0"
  printf '[%s] %s\n' "$tag" "경고: TLS 인증서 검증이 꺼진 채로 사내 자격증명을 전송한다." >&2
  printf '  이 프로세스는 PAT 를 들고 사내 엔드포인트로 나가므로 중간자 공격에 무방비다.\n' >&2
  printf '  고치는 법 — %s 에 다음 중 하나를 추가:\n' "$cfg_file" >&2
  printf '    "network": { "ca_bundle": "/etc/ssl/certs/<사내-ca>.pem" }   <- 권장 (사설 CA)\n' >&2
  printf '    "network": { "tls_reject_unauthorized": true }               <- 공인 인증서라면\n' >&2
  return 0
}
