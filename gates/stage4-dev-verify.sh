#!/usr/bin/env bash
# stage4-dev-verify.sh <issue> — 4단계(개발) 진입 게이트
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage4-dev-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [2_implementation.dev]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — planning phase부터 시작하라"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }
assert_worktree_sibling(){
  local wt="$1" main pwt pmain
  [ -d "$wt" ] || fail "worktree 경로가 존재하지 않음: $wt"
  main="$(git -C "$wt" worktree list --porcelain 2>/dev/null | sed -n 's|^worktree ||p' | head -1)"
  [ -n "$main" ] || fail "메인 repo 식별 실패"
  [ "$wt" != "$main" ] || fail "worktree가 메인 repo와 동일 경로 — dev 단계는 별도 worktree 필요 (메인: $main)"
  pwt="$(cd "$(dirname "$wt")" && pwd -P)"
  pmain="$(cd "$(dirname "$main")" && pwd -P)"
  [ "$pwt" = "$pmain" ] || fail "worktree가 메인 repo의 형제 디렉토리가 아님: $wt (메인: $main)"
}
[ "$(q '.stages."2_implementation".substages."dev".done')" != "true" ] || fail "이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행"
[ "$(q '.stages."1_planning".substages."scope".done')" = "true" ] || fail "scope substage 미완료"
# analysis substage 는 게이트가 SKIP 시 done=true 로 마킹하므로 skipped 여부와 무관하게 done=true 검사만 하면 된다.
[ "$(q '.stages."2_implementation".substages."analysis".done')" = "true" ] || fail "analysis substage 미완료 (skipped 도 done=true 로 처리됨)"

WT="$(q '.worktree')"
[ -n "$WT" ] && [ "$WT" != "__MISSING__" ] || fail "worktree 경로 미설정 — state.json의 .worktree 필드 확인"
assert_worktree_sibling "$WT"

if [ "$(q '.policy.auto_approve."1_planning.scope"')" != "true" ]; then
  [ "$(q '.stages."1_planning".substages."scope".approved_by_user')" = "true" ] \
    || fail "scope substage 사용자 승인 없음 (또는 .policy.auto_approve.\"1_planning.scope\" 미설정)"
  if [ "$(q '.stages."1_planning".substages."scope".verification_pending')" = "true" ]; then
    fail "scope substage 검증 대기 중 (verification_pending) — 사용자 승인 후 approved_by_user를 기록하라"
  fi
fi
echo "MAKDOONG2-GATE OK: 2_implementation.dev"
