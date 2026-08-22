#!/usr/bin/env bash
# stage5-coverage-verify.sh <issue>
# 수정된 코드의 테스트 커버리지가 임계값 이상인지 검증한다.
# 임계값은 makdoong2-team.json 의 coverage.threshold 로 조정 (기본: 95).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage5-coverage-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
THRESHOLD="$("$HERE/../scripts/config.sh" get coverage.threshold 95)"
fail(){ echo "MAKDOONG2-GATE BLOCKED [2_implementation.coverage]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음"
q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }

COV="$(q '.stages."2_implementation".substages."test".coverage')"
ATTEMPT="$(q '.stages."2_implementation".substages."test".coverage_attempt')"
[ "$ATTEMPT" = "__MISSING__" ] && ATTEMPT=1

case "$COV" in
  pass)
    PCT="$(q '.stages."2_implementation".substages."test".coverage_pct')"
    echo "MAKDOONG2-GATE OK: 2_implementation.coverage (${PCT}% >= ${THRESHOLD}%, 시도 ${ATTEMPT}/2)"
    ;;
  exempt)
    echo "MAKDOONG2-GATE OK: 2_implementation.coverage (exempt — 사용자 승인됨, 시도 ${ATTEMPT}/2)"
    ;;
  fail)
    PCT="$(q '.stages."2_implementation".substages."test".coverage_pct')"
    fail "커버리지 미달 (${PCT}% < ${THRESHOLD}%, 시도 ${ATTEMPT}/2, 최대 2라운드) — 테스트를 추가하거나 사용자 승인 후 exempt 처리"
    ;;
  __MISSING__)
    fail "커버리지 미측정 — test substage에서 커버리지를 측정하고 state.json에 기록하라"
    ;;
  *)
    fail "coverage 상태 불명확 ($COV) — pass / fail / exempt 중 하나여야 함"
    ;;
esac
