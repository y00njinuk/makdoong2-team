#!/usr/bin/env bash
# verify.sh <issue> <target_stage> — 단계별 검증 게이트 디스패처.
# 각 단계의 검증 로직은 stage{N}-*-verify.sh에 위임한다.
# 의존: jq, git (각 하위 스크립트에서 사용)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: verify.sh <issue> <stage>}"
TARGET="${2:?usage: verify.sh <issue> <stage>}"

case "$TARGET" in
  1_planning.jira)
    # state.sh get 은 실패해도 stdout 에 "null" 을 찍으므로 `|| echo` 는 덧붙이기가
    # 된다 (다른 게이트 q() 와 같은 결함 계열). if 형태로 성공 출력만 취한다 —
    # 실패(부재/손상)는 "false" 로 두어 first-entry 를 허용한다 (이 검사는 재-dispatch
    # 차단용이지 존재 검사가 아니다).
    if ! JIRA_DONE="$("$HERE/../scripts/state.sh" get "$ISSUE" '.stages."1_planning".substages."jira".done' 2>/dev/null)"; then
      JIRA_DONE="false"
    fi
    if [ "$JIRA_DONE" = "true" ]; then
      echo "MAKDOONG2-GATE BLOCKED [1_planning.jira]: 이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행" >&2
      exit 2
    fi
    echo "MAKDOONG2-GATE OK: $TARGET (jira validation handled by extension gate)" ;;
  1_planning.requirements)
    "$HERE/stage2-requirements-verify.sh" "$ISSUE" ;;
  2_implementation.analysis)
    "$HERE/stage-analysis-verify.sh" "$ISSUE" ;;
  2_implementation.dev)
    "$HERE/stage4-dev-verify.sh" "$ISSUE" ;;
  2_implementation.dev_post)
    "$HERE/stage4-dev-post-verify.sh" "$ISSUE" ;;
  2_implementation.test)
    "$HERE/stage5-test-verify.sh" "$ISSUE" ;;
  3_delivery.commit)
    "$HERE/stage6-commit-verify.sh" "$ISSUE" ;;
  3_delivery.commit_post | 6_commit_post)
    "$HERE/stage6-post-commit-verify.sh" "$ISSUE" ;;
  3_delivery.pr)
    "$HERE/stage7-pr-verify.sh" "$ISSUE" ;;
  3_delivery.pr_post)
    "$HERE/stage7-post-pr-verify.sh" "$ISSUE" ;;
  3_delivery.review)
    "$HERE/stage8-review-verify.sh" "$ISSUE" ;;
  3_delivery.review_post)
    "$HERE/stage8-post-review-verify.sh" "$ISSUE" ;;
  *)
    echo "MAKDOONG2-GATE OK: $TARGET" ;;
esac
