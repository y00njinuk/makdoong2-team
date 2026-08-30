#!/usr/bin/env bash
# stage7-pr-verify.sh <issue> — 7단계(PR 생성) 진입 게이트
#
# 원칙: entry gate 는 substage 진입 "전제조건" 만 검사한다.
# 완료 조건(원격 push 여부, PR URL 존재, reviewer 등)은 publisher 가 substage 수행 후
# stage7-post-pr-verify.sh + verifier 에서 검증된다.
#
# 검사 항목 (전제조건):
#   1) state.json 존재
#   2) 3_delivery.commit substage 완료
#   3) worktree 가 메인 repo 의 형제 디렉토리로 존재
#   4) worktree 에 uncommitted 변경 없음 (tracked 파일 기준; untracked 는 무시)
#   5) 현재 브랜치 확인 가능
#
# 제거된 조건 (완료조건 → post-verify 로 이동):
#   * origin/<BR> 원격 브랜치 존재 여부 — publisher 가 §2-4 에서 git push 를 수행하므로
#     first-entry 시점에는 존재할 수 없음. chicken-and-egg 방지를 위해 post-verify 로 이관.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage7-pr-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [3_delivery.pr]: $1" >&2; exit 2; }
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
  [ "$wt" != "$main" ] || fail "worktree가 메인 repo와 동일 경로 — 별도 worktree 필요"
  pwt="$(cd "$(dirname "$wt")" && pwd -P)"
  pmain="$(cd "$(dirname "$main")" && pwd -P)"
  [ "$pwt" = "$pmain" ] || fail "worktree가 메인 repo의 형제 디렉토리가 아님: $wt (메인: $main)"
}
[ "$(q '.stages."3_delivery".substages."commit".done')" = "true" ] || fail "commit substage 미완료"
WT="$(q '.worktree')"
assert_worktree_sibling "$WT"

MODIFIED="$(git -C "$WT" status --porcelain | grep -v '^?? ' || true)"

if [ -n "$MODIFIED" ]; then
  fail "worktree에 uncommitted 변경(M/A/D/R)이 있음 — 커밋하거나 제거 필요"
fi

BR="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
[ -n "$BR" ] || fail "현재 브랜치 확인 불가"

echo "MAKDOONG2-GATE OK: 3_delivery.pr"
