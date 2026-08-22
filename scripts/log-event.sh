#!/usr/bin/env bash
# log-event.sh — append a structured NDJSON event for an issue.
#
# 목적: state.json은 *현재 상태*만 보관한다. 단계 전이·폴백·게이트 차단 같은
# *이력*은 append-only `events.ndjson`으로 남겨 회고·디버깅·메트릭 산출에 사용한다.
#
# 사용:
#   log-event.sh <issue> <kind> [key=value ...]
# 예:
#   log-event.sh PROJ-1 stage_dispatched stage=4_dev agent=makdoong2-dev model=gpt-5.1-codex
#   log-event.sh PROJ-1 gate_blocked stage=2_requirements reason=jira_validation_failed
#   log-event.sh PROJ-1 fallback agent=makdoong2-dev from=gpt-5.1-codex to=claude-haiku-4.5
#
# 저장 위치: <git toplevel>/.makdoong2-team/<issue>/events.ndjson
# 의존: jq
set -euo pipefail

ISSUE="${1:?usage: log-event.sh <issue> <kind> [key=value ...]}"
KIND="${2:?usage: log-event.sh <issue> <kind> [key=value ...]}"
shift 2

_STATE="$(cd "$(dirname "$0")" && pwd)/state.sh"
ROOT="$("$_STATE" root)"
DIR="$ROOT/.makdoong2-team/$ISSUE"
mkdir -p "$DIR"
LOG="$DIR/events.ndjson"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Accumulate key=value pairs into a JSON object via jq.
ATTRS='{}'
for kv in "$@"; do
  if [[ "$kv" == *"="* ]]; then
    k="${kv%%=*}"
    v="${kv#*=}"
    ATTRS=$(printf '%s' "$ATTRS" | jq -c --arg k "$k" --arg v "$v" '. + {($k): $v}')
  fi
done

jq -nc \
  --arg ts "$TS" \
  --arg issue "$ISSUE" \
  --arg kind "$KIND" \
  --argjson attrs "$ATTRS" \
  '{ts:$ts, issue:$issue, kind:$kind} + $attrs' >> "$LOG"
