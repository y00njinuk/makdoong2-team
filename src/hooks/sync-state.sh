#!/usr/bin/env bash
# sync-state.sh — PostToolUse(bash) hook 핸들러.
#   bash 실행 후, 기계적으로 감지 가능한 완료 사실만 state.json에 반영한다(best-effort 보조).
#   의미적(semantic) 마커(요구사항 승인, PR URL 등)는
#   각 단계에서 에이전트가 state.sh set 으로 명시적으로 기록한다.
# 의존: jq, git
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(dirname "$(dirname "$HERE")")"
# 입력: 인자(opencode 플러그인) 우선, 없으면 stdin JSON(Claude Code) — dual-mode
if [ -n "${1:-}" ]; then
  CMD="$1"; OUT="${2:-}"; ISSUE="${3:-}"
  [ -n "$ISSUE" ] || exit 0  # plugin 모드, 워크플로우 없음 → sync 불필요
else
  IN="$(cat 2>/dev/null || true)"
  CMD="$(printf '%s' "$IN" | jq -r '.tool_input.command // .tool_input.cmd // .command // empty' 2>/dev/null || true)"
  OUT="$(printf '%s' "$IN" | jq -r '.tool_response.output // .tool_response // .tool_output // .output // empty' 2>/dev/null || true)"
  ISSUE=""
fi
_STATE="$PKG_ROOT/scripts/state.sh"
ROOT="$("$_STATE" root 2>/dev/null || pwd)"

# standalone 모드(plugin 외부 직접 실행) 폴백:
# state.json × 활성 git 워크트리 교집합으로 ISSUE를 추론한다.
# plugin 모드에서는 이 블록을 건너뛴다(ISSUE가 이미 설정됨).
if [ -z "$ISSUE" ] && [ -d "$ROOT/.makdoong2-team" ]; then
  _active="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null \
    | grep '^branch refs/heads/' | sed 's|^branch refs/heads/||' || true)"
  for _sdir in "$ROOT"/.makdoong2-team/*/; do
    [ -f "${_sdir}state.json" ] || continue
    _key="$(basename "$_sdir")"
    if printf '%s' "$_active" | grep -qE "(^|/)feature/$_key$"; then
      ISSUE="$_key"
      break
    fi
  done
fi

[ -n "$ISSUE" ] && [ -n "$CMD" ] || exit 0
S(){ "$_STATE" set "$ISSUE" "$1" "$2" >/dev/null 2>&1 || true; }

# (test 결과 자동감지는 제거됨 — 단위/통합 구분이 명령으로만 식별 불가하고,
#  SBT는 BUILD SUCCESSFUL 출력 패턴이 다름. 테스트 결과는 5단계에서
#  state.sh set으로 unit/integration 각각 명시적으로 기록한다.)
# 커밋 감지
if printf '%s' "$CMD" | grep -qE 'git(\s+\S+)*\s+commit(\s|$)'; then S '.stages."3_delivery".substages."commit".done' 'true'; fi
exit 0
