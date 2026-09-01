#!/usr/bin/env bash
# session-start.sh — emit a context reminder when a session starts.
#
# 목적:
#   부장님 세션 재시작 시 state.json + events.ndjson에서 가장 중요한 신호를
#   stdout으로 다시 주입한다 — 부장님이 컨텍스트를 잃지 않도록.
#
# 보고 내용:
#   - 현재 issue (브랜치명에서 추출)
#   - 단계별 done / pending 요약
#   - verification_pending=true 인 단계 (사용자 승인 차단 중)
#   - 마지막 3개 이벤트
#
# 사용:
#   - Claude Code SessionStart hook 등록: settings.json `hooks.SessionStart`에
#     이 파일 경로 추가.
#   - 또는 부장님이 세션 시작 시 직접 호출: `bash $HOME/.config/opencode/plugins/makdoong2-team/src/hooks/session-start.sh`
#
# 의존: jq, git
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(dirname "$(dirname "$HOOK_DIR")")"
_STATE="$PKG_ROOT/scripts/state.sh"
ISSUE="$("$_STATE" issue 2>/dev/null || true)"

# 브랜치에 이슈키가 없으면 조용히 종료 (워크플로우 외부 작업)
[ -n "$ISSUE" ] || exit 0

ROOT="$("$_STATE" root)"
DIR="$ROOT/.makdoong2-team/$ISSUE"
STATE_FILE="$DIR/state.json"
EVENTS_FILE="$DIR/events.ndjson"

# state.json이 없으면 (아직 stage 1 초기화 전) 종료
[ -f "$STATE_FILE" ] || exit 0

echo "=== makdoong2-team SessionStart: $ISSUE ==="

CATEGORY="$(jq -r '.policy.category // "uncategorized"' "$STATE_FILE" 2>/dev/null || true)"
COMMIT_AUTO="$(jq -r '.policy.auto_approve."3_delivery.commit" // "unset"' "$STATE_FILE" 2>/dev/null || true)"
echo ""
echo "## 작업 범주: $CATEGORY"
if [ "$COMMIT_AUTO" = "false" ]; then
  echo "  → HITL opt-in: 6단계 커밋 직전 사람 승인 필요 (변경 보고서 + 승인 마커)"
fi

echo ""
echo "## 단계 진행 현황"
jq -r '
  .stages."1_planning" as $p1 |
  .stages."2_implementation" as $p2 |
  .stages."3_delivery" as $p3 |
  
  # Planning substages
  ($p1.substages.jira // {} | "  1_planning.jira: done=" + ((.done // false) | tostring) + (if .approved_by_user then " (approved)" else "" end)),
  ($p1.substages.requirements // {} | "  1_planning.requirements: done=" + ((.done // false) | tostring) + (if .approved_by_user then " (approved)" else "" end)),
  
  # Implementation substages
  ($p2.substages.analysis // {} | "  2_implementation.analysis: done=" + ((.done // false) | tostring) + (if .skipped then " (skipped)" else "" end)),
  ($p2.substages.dev // {} | "  2_implementation.dev: done=" + ((.done // false) | tostring) + (if .approved_by_user then " (approved)" else "" end)),
  ($p2.substages.test // {} | "  2_implementation.test: unit=" + (.unit // "none") + " / integration=" + (.integration // "none") + " / coverage=" + (.coverage // "none")),
  
  # Delivery substages
  ($p3.substages.commit // {} | "  3_delivery.commit: done=" + ((.done // false) | tostring) + (if .approved_by_user then " (approved)" else "" end)),
  ($p3.substages.pr // {} | "  3_delivery.pr: done=" + ((.done // false) | tostring) + " / draft_url=" + (if .draft_url then "set" else "null" end)),
  ($p3.substages.review // {} | "  3_delivery.review: comments=" + ((.comments // 0) | tostring))
' "$STATE_FILE"

echo ""
echo "## verification_pending=true (사용자 승인 대기 중)"
PENDING=$(jq -r '
  [
    (.stages."1_planning".substages // {} | to_entries[] | select(.value.verification_pending == true) | "1_planning." + .key),
    (.stages."2_implementation".substages // {} | to_entries[] | select(.value.verification_pending == true) | "2_implementation." + .key),
    (.stages."3_delivery".substages // {} | to_entries[] | select(.value.verification_pending == true) | "3_delivery." + .key)
  ] | .[]
' "$STATE_FILE" 2>/dev/null || true)
if [ -n "$PENDING" ]; then
  echo "$PENDING" | sed 's/^/  ⚠️  /'
  echo "  → 해소: state.sh set $ISSUE '.stages.\"<phase>\".substages.\"<substage>\".approved_by_user' 'true' + verification_pending=false"
else
  echo "  (없음)"
fi

echo ""
echo "## 최근 이벤트 (마지막 3개)"
if [ -f "$EVENTS_FILE" ]; then
  tail -3 "$EVENTS_FILE" 2>/dev/null | sed 's/^/  /' || echo "  (이벤트 로그 비어있음)"
else
  echo "  (events.ndjson 없음 — 첫 dispatch 후 자동 생성)"
fi

echo ""
echo "=== end SessionStart ==="
