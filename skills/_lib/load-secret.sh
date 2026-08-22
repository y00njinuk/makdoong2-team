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
  jq_err=$(mktemp 2>/dev/null || echo "/tmp/load-secret.$$.err")
  token=$(jq -r --arg k "$var_name" '.secrets[$k] // empty' "$cfg_file" 2>"$jq_err")
  local jq_status=$?
  if [ "$jq_status" -ne 0 ]; then
    printf '[%s] makdoong2-team.json is not valid JSON: %s\n' "$tag" "$cfg_file" >&2
    if [ -s "$jq_err" ]; then sed -e "s/^/[$tag] jq: /" "$jq_err" >&2; fi
    rm -f "$jq_err"
    return 67
  fi
  rm -f "$jq_err"

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
