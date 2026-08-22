#!/usr/bin/env bash
# stage8-review-verify.sh <issue> — 8단계(리뷰 코멘트) 진입 게이트
#
# 원칙: entry gate 는 substage 진입 "전제조건" 만 검사한다.
# 완료 조건(코멘트 개수, per-commit 매핑, 인라인 앵커 여부 등)은 publisher 가 substage
# 수행 후 stage8-post-review-verify.sh + verifier 에서 검증된다.
#
# 검사 항목 (전제조건):
#   1) state.json 존재
#   2) pr substage 산출물: draft_url, body_validation 3항목, reviewer 마커
#   3) HITL: auto_approve 미설정 시 사용자 승인 완료
#
# 제거된 조건 (완료조건 → post-verify 로 이동):
#   * .stages.3_delivery.substages.review.comments >= 1
#   * .stages.3_delivery.substages.review.all_comments_inline == true
#   → 두 값 모두 publisher 가 §8-2 에서 인라인 코멘트를 작성한 뒤에 기록하는 완료 마커이므로
#     entry gate 에 두면 first-entry 자체가 불가능(chicken-and-egg).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage8-review-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [3_delivery.review]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — planning phase부터 시작하라"
q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }
U="$(q '.stages."3_delivery".substages."pr".draft_url')"
{ [ -n "$U" ] && [ "$U" != "null" ] && [ "$U" != "__MISSING__" ]; } || fail "pr substage (Draft PR) 미생성"
for k in no_orphan_scenarios template_match section_content_match; do
  v="$(q ".stages.\"3_delivery\".substages.\"pr\".body_validation.$k")"
  [ "$v" = "true" ] || fail "PR 본문 검증 미통과(body_validation.$k=$v) — PR substage 세 검증을 모두 통과 후 기록해야 함"
done

REVIEWER_ADDED="$(q '.stages."3_delivery".substages."pr".reviewer_added')"
REVIEWER_SELF_SKIPPED="$(q '.stages."3_delivery".substages."pr".reviewer_self_skipped')"
if [ "$REVIEWER_ADDED" != "true" ] && [ "$REVIEWER_SELF_SKIPPED" != "true" ]; then
  fail "PR에 reviewer 미추가(reviewer_added=$REVIEWER_ADDED, reviewer_self_skipped=$REVIEWER_SELF_SKIPPED) — 08-pr.md §7-4에 따라 토큰 소유자를 reviewer로 추가(reviewer_added=true)하거나, 토큰 소유자가 PR 작성자와 동일하여 추가가 불가한 경우 reviewer_self_skipped=true 를 기록해야 함"
fi

if [ "$(q '.policy.auto_approve."3_delivery.pr"')" != "true" ]; then
  [ "$(q '.stages."3_delivery".substages."pr".approved_by_user')" = "true" ] \
    || fail "pr substage 사용자 미승인 — Draft PR 검토 후 approved_by_user를 기록하라 (또는 .policy.auto_approve.\"3_delivery.pr\" 미설정)"
  if [ "$(q '.stages."3_delivery".substages."pr".verification_pending')" = "true" ]; then
    fail "pr substage 검증 대기 중(verification_pending) — 사용자 승인 후 approved_by_user를 기록하고 verification_pending을 false로 해소하라"
  fi
fi
echo "MAKDOONG2-GATE OK: 3_delivery.review"
