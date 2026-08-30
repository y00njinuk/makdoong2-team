#!/usr/bin/env bash
# stage6-commit-verify.sh <issue> — 6단계(커밋) 진입 게이트
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage6-commit-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [3_delivery.commit]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — planning phase부터 시작하라"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }
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

# HITL 판정 방향은 다른 세 게이트(scope / dev / review)와 **같아야 한다**: 그쪽은
# 전부 `!= "true"` 로 "명시적으로 auto_approve 하지 않았으면 사람 승인이 필요하다"
# (fail-closed) 인데, 여기만 `= "false"` 였다. `state.sh init` 이 `"policy": null` 을
# 심으므로 기본 상태에서 `.policy.auto_approve."3_delivery.commit"` 는 null 이고,
# 그러면 이 블록 전체가 건너뛰어진다 — **가장 중대한 단계(커밋 생성)의 승인 게이트만
# 기본값에서 꺼져 있었다**. 방향을 맞춘다.
if [ "$(q '.policy.auto_approve."3_delivery.commit"')" != "true" ]; then
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
