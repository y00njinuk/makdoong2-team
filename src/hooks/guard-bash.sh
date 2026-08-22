#!/usr/bin/env bash
# guard-bash.sh — PreToolUse(bash) hook 핸들러.
#   stdin으로 hook payload(JSON)를 받아 실행될 bash 명령을 검사한다.
#   - 파괴적 명령: 승인 마커가 없으면 exit 2(차단)
#   - git push: commit substage(3_delivery.commit) 완료 여부만 확인 후 허용
#   워크플로우 브랜치가 아니면 게이트를 적용하지 않는다.
#
# 의존: jq, git
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(dirname "$(dirname "$HERE")")"
# 입력: 인자(opencode 플러그인) 우선, 없으면 stdin JSON(Claude Code) — dual-mode
if [ -n "${1:-}" ]; then
  CMD="$1"
  ISSUE="${2:-}"
  # plugin 모드: ISSUE=""이면 이 세션에 makdoong2-team 워크플로우 없음 → 게이트 미적용.
  # standalone 모드와 달리 폴백 스캔 없이 즉시 종료한다.
  [ -n "$ISSUE" ] || exit 0
else
  IN="$(cat 2>/dev/null || true)"
  CMD="$(printf '%s' "$IN" | jq -r '.tool_input.command // .tool_input.cmd // .command // empty' 2>/dev/null || true)"
  ISSUE=""
fi
[ -n "$CMD" ] || exit 0

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
[ -n "$ISSUE" ] || exit 0
APPROVE="$ROOT/.makdoong2-team/$ISSUE/APPROVED_DESTRUCTIVE"

if printf '%s' "$CMD" | grep -qE 'git(\s+\S+)*\s+(push\s+--force(-with-lease)?|reset\s+--hard|branch\s+-D|worktree\s+(add|remove)\s+--force)|rm\s+-rf'; then
  if [ ! -f "$APPROVE" ]; then
    echo "MAKDOONG2-GATE BLOCKED: 파괴적 명령은 사용자 명시 승인 필요." >&2
    echo "  대상: $CMD" >&2
    echo "  승인하려면: touch \"$APPROVE\" 후 재시도" >&2
    exit 2
  fi
fi

if printf '%s' "$CMD" | grep -qE 'git(\s+\S+)*\s+push(\s|$)'; then
  # stage7-pr-verify.sh 전체를 재사용하면 "remote branch 없음 → push 불가" circular dependency가 발생한다.
  # (stage7은 remote branch 존재를 검증하지만, remote branch는 push해야 생긴다.)
  # guard에서는 commit substage 완료 여부만 확인한다.
  # remote branch 존재 확인은 auto_advance_stage → 3_delivery.pr 진입 게이트에서 수행한다.
  _commit_done="$("$_STATE" get "$ISSUE" '.stages."3_delivery".substages."commit".done' 2>/dev/null || echo '__MISSING__')"
  if [ "$_commit_done" != "true" ]; then
    echo "MAKDOONG2-GATE BLOCKED [git push]: 3_delivery.commit 미완료 — commit substage를 먼저 완료하라" >&2
    exit 2
  fi
fi
exit 0
