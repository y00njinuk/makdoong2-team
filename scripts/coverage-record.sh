#!/usr/bin/env bash
# coverage-record.sh <issue> <pct> [attempt]
#
# makdoong2-team.json 의 coverage.threshold 를 읽어 pct 와 숫자 비교 후
# state.json 에 pass/fail 을 결정론적으로 기록한다.
#
# LLM 이 임계값을 해석하거나 판단하지 않도록 비교 로직을 shell 로 위임.
# engineer 는 커버리지 숫자만 추출해서 이 스크립트에 넘기면 된다.
#
# 사용:
#   bash <SCRIPTS_DIR>/coverage-record.sh <이슈키> <pct> [attempt]
#
# 인수:
#   <이슈키>  — 예: PROJ-12345
#   <pct>     — 측정된 커버리지 퍼센트 (정수 또는 소수, 예: 87 / 87.3)
#   [attempt] — 라운드 번호. 미지정 시 state.json 의 기존 coverage_attempt+1 로
#               자동 증가한다 (초회 호출은 1). engineer 가 3회 재시도 흐름에서
#               라운드를 수동으로 관리하지 않도록 하는 안전장치.
#
# 종료코드:
#   0 → pass  (pct >= threshold)
#   1 → fail  (pct < threshold)
#
# 의존: awk, jq (config.sh 경유), state.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

ISSUE="${1:?usage: coverage-record.sh <issue> <pct> [attempt]}"
PCT="${2:?usage: coverage-record.sh <issue> <pct> [attempt]}"

if [[ $# -ge 3 && -n "$3" ]]; then
  ATTEMPT="$3"
else
  PREV_ATTEMPT="$("$HERE/state.sh" get "$ISSUE" \
    '.stages."2_implementation".substages."test".coverage_attempt' 2>/dev/null || echo "null")"
  case "$PREV_ATTEMPT" in
    ''|null|None) ATTEMPT=1 ;;
    *)
      if [[ "$PREV_ATTEMPT" =~ ^[0-9]+$ ]]; then
        ATTEMPT=$((PREV_ATTEMPT + 1))
      else
        ATTEMPT=1
      fi
      ;;
  esac
fi

THRESHOLD="$("$HERE/config.sh" get coverage.threshold 95)"

"$HERE/state.sh" set "$ISSUE" \
  '.stages."2_implementation".substages."test".coverage_pct' "$PCT"
"$HERE/state.sh" set "$ISSUE" \
  '.stages."2_implementation".substages."test".coverage_attempt' "$ATTEMPT"

# awk: shell 산술은 정수 전용이므로 소수점 비교는 awk 에 위임
if awk "BEGIN{exit !($PCT + 0 >= $THRESHOLD + 0)}"; then
  "$HERE/state.sh" set "$ISSUE" \
    '.stages."2_implementation".substages."test".coverage' '"pass"'
  echo "COVERAGE PASS: ${PCT}% >= ${THRESHOLD}% (라운드 ${ATTEMPT})"
  exit 0
else
  "$HERE/state.sh" set "$ISSUE" \
    '.stages."2_implementation".substages."test".coverage' '"fail"'
  echo "COVERAGE FAIL: ${PCT}% < ${THRESHOLD}% (라운드 ${ATTEMPT})"
  exit 1
fi
