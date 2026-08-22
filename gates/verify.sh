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
    JIRA_DONE="$("$HERE/../scripts/state.sh" get "$ISSUE" '.stages."1_planning".substages."jira".done' 2>/dev/null || echo "false")"
    if [ "$JIRA_DONE" = "true" ]; then
      echo "MAKDOONG2-GATE BLOCKED [1_planning.jira]: 이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행" >&2
      exit 2
    fi
    echo "MAKDOONG2-GATE OK: $TARGET (jira validation handled by extension gate)" ;;
  1_planning.requirements)
    "$HERE/stage2-requirements-verify.sh" "$ISSUE" ;;
  1_planning.scope)
    "$HERE/stage3-scope-verify.sh" "$ISSUE" ;;
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
