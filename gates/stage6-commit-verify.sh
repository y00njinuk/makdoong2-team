#!/usr/bin/env bash
# stage6-commit-verify.sh <issue> — 6단계(커밋) 진입 게이트
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage6-commit-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [3_delivery.commit]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — planning phase부터 시작하라"
q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }
U="$(q '.stages."2_implementation".substages."test".unit')"
case "$U" in
  pass|skip) : ;;
  fail) fail "단위 테스트 실패 — dev substage로 복귀해 수정하라" ;;
  *)    fail "단위 테스트 결과 미기록(unit=$U) — test substage 미완료" ;;
esac
I="$(q '.stages."2_implementation".substages."test".integration')"
case "$I" in
  pass|skip) : ;;
  fail) fail "통합 테스트 실패 — dev substage로 복귀해 수정하라" ;;
  *)    fail "통합 테스트 결과 미기록(integration=$I) — test substage 미완료" ;;
esac
"$HERE/stage5-coverage-verify.sh" "$ISSUE"

if [ "$(jq -r '.policy.auto_approve."3_delivery.commit"' "$P" 2>/dev/null)" = "false" ]; then
  # [Check 1] verification_pending=true: 보고서 생성 완료, 사용자 승인 대기 중 → BLOCK
  # (report 존재 여부보다 먼저 확인 — publisher가 보고서를 생성하고 pending을 세팅한 상태)
  if [ "$(q '.stages."3_delivery".substages."commit".verification_pending')" = "true" ]; then
    fail "major 이슈 — 커밋 승인 대기 중(verification_pending) — 사용자 승인 후 approved_by_user=true 기록 + verification_pending=false 해소"
  fi
  # [Check 2] 보고서가 있는데 미승인 → BLOCK
  # (report 없음 = 최초 dispatch 시점 → PASS하여 publisher가 보고서를 생성할 수 있도록 허용)
  REPORT="$(dirname "$P")/change-report.md"
  if [ -f "$REPORT" ]; then
    [ "$(q '.stages."3_delivery".substages."commit".approved_by_user')" = "true" ] \
      || fail "major 이슈 — 최종 커밋 사용자 미승인. 보고서 검토 후 .stages.\"3_delivery\".substages.\"commit\".approved_by_user=true를 기록하라"
  fi
  # [Check 3 — implicit] report 없음 + pending 없음 = 초기 상태 → PASS
  # publisher 첫 dispatch가 진입하여 change-report.md를 생성한다.
fi

echo "MAKDOONG2-GATE OK: 3_delivery.commit"
