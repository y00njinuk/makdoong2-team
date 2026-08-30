#!/usr/bin/env bash
# stage7-post-pr-verify.sh <issue> — 7단계(PR 생성) post-execution 게이트
#
# 원칙: entry gate 는 전제조건, post-verify 는 완료 조건. publisher 가 §2-5 마지막에
# .done=true 를 기록하기 직전 본 스크립트를 호출한다. 실패 시 exit 2 로 publisher
# 재작업 loop 를 유도한다.
#
# 검사 항목 (완료조건):
#   1) origin/<current-branch> 원격 브랜치 존재 (git push 성공 여부)
#   2) .stages.3_delivery.substages.pr.draft_url 이 HTTPS URL 문자열
#   3) .stages.3_delivery.substages.pr.body_validation 3항목 모두 true
#   4) reviewer 마커 (reviewer_added=true XOR reviewer_self_skipped=true; 상호 배타)
#   5) .stages.3_delivery.substages.pr.done == true (publisher 자기선언)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage7-post-pr-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-POSTGATE BLOCKED [3_delivery.pr_post]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }

WT="$(q '.worktree')"
[ -d "$WT" ] || fail "worktree 경로 없음: $WT"

BR="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
[ -n "$BR" ] || fail "현재 브랜치 확인 불가"
git -C "$WT" rev-parse --verify "origin/$BR" >/dev/null 2>&1 \
  || fail "remote 에 push 되지 않음 (origin/$BR 없음) — publisher 가 §2-4 에서 git push -u origin HEAD 를 실행했는지 확인"

URL="$(q '.stages."3_delivery".substages."pr".draft_url')"
case "$URL" in
  http://*|https://*) : ;;
  *) fail "draft_url 이 유효한 HTTPS URL 문자열 아님: $URL" ;;
esac

for k in no_orphan_scenarios template_match section_content_match; do
  v="$(q ".stages.\"3_delivery\".substages.\"pr\".body_validation.$k")"
  [ "$v" = "true" ] || fail "body_validation.$k=$v — 3항목 모두 true 여야 함"
done

RA="$(q '.stages."3_delivery".substages."pr".reviewer_added')"
RS="$(q '.stages."3_delivery".substages."pr".reviewer_self_skipped')"
if [ "$RA" = "true" ] && [ "$RS" = "true" ]; then
  fail "reviewer 마커 상호 배타 위반 — reviewer_added 와 reviewer_self_skipped 가 동시에 true"
fi
if [ "$RA" != "true" ] && [ "$RS" != "true" ]; then
  fail "reviewer 마커 미기록 — reviewer_added=true 또는 reviewer_self_skipped=true 중 하나 필수"
fi

D="$(q '.stages."3_delivery".substages."pr".done')"
[ "$D" = "true" ] || fail "pr.done 이 true 아님(=$D) — publisher 가 §2-5 완료 마킹을 누락"

echo "MAKDOONG2-POSTGATE OK: 3_delivery.pr_post"
