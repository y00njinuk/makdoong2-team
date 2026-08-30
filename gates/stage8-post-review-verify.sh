#!/usr/bin/env bash
# stage8-post-review-verify.sh <issue> — 8단계(리뷰 코멘트) post-execution 게이트
#
# 원칙: entry gate 는 전제조건, post-verify 는 완료 조건. publisher 가 §3-2 마지막에
# .done=true 를 기록하기 직전 본 스크립트를 호출한다. 실패 시 exit 2 로 publisher
# 재작업 loop 를 유도한다 (Bitbucket 에 부족한 코멘트 재 posting).
#
# 검사 항목 (완료조건):
#   1) review-comment-plan.json 존재 (LLM 사전 설계 아티팩트)
#   2) plan.commit_count == atomic_review.count_commits (계획된 커밋 수 = 실제 커밋 수)
#   3) plan.plan[] 모든 항목의 comments 배열 길이 >= 1 (계획 단계에서 커밋당 최소 1개)
#   4) comments_per_commit 마커의 모든 값 >= 1 (실제 posting 결과가 커밋당 최소 1개)
#   5) comments 총합 == comments_per_commit 값들의 합 (합계 정합성)
#   6) all_comments_inline == true (인라인 앵커 자기선언 — verifier 가 Bitbucket 재조회로 교차검증)
#   7) .stages.3_delivery.substages.review.done == true
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage8-post-review-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-POSTGATE BLOCKED [3_delivery.review_post]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }

CC="$(q '.stages."3_delivery".substages."commit".atomic_review.count_commits')"
case "$CC" in
  ''|null|__MISSING__) fail "commit.atomic_review.count_commits 미기록 — commit substage 를 먼저 완료" ;;
esac
[ "$CC" -ge 1 ] 2>/dev/null || fail "count_commits 가 정수 아니거나 <1: $CC"

PLAN_REL_RAW="$(q '.stages."3_delivery".substages."review".plan_path')"
PLAN_REL="$(printf '%s' "$PLAN_REL_RAW" | tr -d '"')"
case "$PLAN_REL_RAW" in
  ''|null|__MISSING__) fail "review.plan_path 미기록 — publisher 가 review-comment-plan.json 을 먼저 산출해야 함" ;;
esac
if [[ "$PLAN_REL" == /* ]]; then
  PLAN_PATH="$PLAN_REL"
else
  PLAN_PATH="$("$HERE/../scripts/state.sh" root)/$PLAN_REL"
fi
[ -f "$PLAN_PATH" ] || fail "review-comment-plan.json 파일 없음: $PLAN_PATH"

jq -e . "$PLAN_PATH" >/dev/null 2>&1 || fail "review-comment-plan.json JSON parse 실패: $PLAN_PATH"

PLAN_CC="$(jq -r '.commit_count // empty' "$PLAN_PATH")"
[ -n "$PLAN_CC" ] || fail "plan.commit_count 필드 없음"
[ "$PLAN_CC" = "$CC" ] \
  || fail "plan.commit_count($PLAN_CC) != atomic_review.count_commits($CC) — 계획된 커밋 수 불일치"

PLAN_LEN="$(jq -r '.plan | length' "$PLAN_PATH")"
[ "$PLAN_LEN" = "$CC" ] || fail "plan.plan 배열 길이($PLAN_LEN) != count_commits($CC)"

UNDER_PLAN="$(jq -r '[.plan[] | select((.comments // [] | length) < 1)] | length' "$PLAN_PATH")"
[ "$UNDER_PLAN" = "0" ] || fail "계획 단계에서 $UNDER_PLAN 개 커밋에 코멘트가 0개 — 커밋당 최소 1개 필요"

CPC="$(q '.stages."3_delivery".substages."review".comments_per_commit')"
case "$CPC" in
  ''|null|__MISSING__|'{}') fail "comments_per_commit 마커 미기록 또는 빈 객체 — 실제 posting 결과를 커밋별로 집계해야 함" ;;
esac

CPC_LEN="$(printf '%s' "$CPC" | jq -r 'length' 2>/dev/null || echo 0)"
[ "$CPC_LEN" = "$CC" ] \
  || fail "comments_per_commit 항목 수($CPC_LEN) != count_commits($CC) — 모든 커밋에 코멘트 매핑 필요"

CPC_UNDER="$(printf '%s' "$CPC" | jq -r '[to_entries[] | select((.value|tonumber) < 1)] | length' 2>/dev/null || echo -1)"
[ "$CPC_UNDER" = "0" ] || fail "$CPC_UNDER 개 커밋의 실제 앵커 코멘트 수가 0개 — 재작성 필요"

CPC_SUM="$(printf '%s' "$CPC" | jq -r '[.[] | tonumber] | add' 2>/dev/null || echo -1)"
COMMENTS="$(q '.stages."3_delivery".substages."review".comments')"
[ "$COMMENTS" = "$CPC_SUM" ] \
  || fail "review.comments($COMMENTS) != Σcomments_per_commit($CPC_SUM) — 합계 불일치"

AI="$(q '.stages."3_delivery".substages."review".all_comments_inline')"
[ "$AI" = "true" ] \
  || fail "all_comments_inline=$AI — 모든 코멘트가 filePath+line 앵커를 가져야 함"

D="$(q '.stages."3_delivery".substages."review".done')"
[ "$D" = "true" ] || fail "review.done 이 true 아님(=$D) — publisher 가 완료 마킹을 누락"

# [comment.status 전수 검증] status 필드가 존재하는 plan 에서만 적용 (하위 호환)
NOT_POSTED="$(jq -r '[.plan[].comments[] | select(has("status") and .status != "posted")] | length' "$PLAN_PATH")"
[ "$NOT_POSTED" = "0" ] \
  || fail "plan.json 에 status가 \"posted\" 가 아닌 comment 가 ${NOT_POSTED}개 남아 있음 — 미완료 코멘트 posting 후 status 갱신 필요"

echo "MAKDOONG2-POSTGATE OK: 3_delivery.review_post"
