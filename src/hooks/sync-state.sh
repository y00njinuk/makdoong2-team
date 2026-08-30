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
# ── 커밋 감지 ──
#
# 종전 구현은 **명령 문자열만** 보고 `commit.done=true` 를 기록했다:
#     grep -qE 'git(\s+\S+)*\s+commit(\s|$)'
# 그래서 아래가 전부 done 을 세웠다 (실측 확인):
#   - 실패한 `git commit` (staged 없음 · 훅 거부 · 메시지 형식 위반)
#   - `git commit --dry-run`
#   - `echo "git commit 하는 법"` 처럼 **문자열 안의 언급**
#
# `3_delivery.commit.done=true` 는 dispatch_stage 의 "이미 done → 재-dispatch 차단"
# 가드를 발동시키므로, 실패한 커밋이 그 단계로의 재진입을 영구히 막는다.
#
# 그래서 두 조건을 모두 요구한다:
#   1. 명령이 실제로 세그먼트 선두의 `git … commit` 이고 `--dry-run` 이 아니다
#   2. 출력에 git 의 커밋 확인 줄이 있다 — `[<브랜치…> <sha>]` 형태.
#      브랜치 표기는 로케일에 따라 번역되지만(`(최상위-커밋)`) 대괄호와 짧은 SHA
#      구조는 번역되지 않는다. 실패 출력에는 이 줄이 없다.
#
# 출력이 비어 있으면 기록하지 않는다(fail-closed). 권위 있는 기록은 publisher 의
# 명시적 `state.sh set` 이고 stage6-post-commit-verify.sh 가 최종 검증한다 —
# 이 훅은 어디까지나 best-effort 보조다.
# 선두의 환경변수 대입(GIT_AUTHOR_DATE=… git commit)을 허용한다. 인용된 -C 경로
# ("‑C \"/path with space\"")는 감지하지 못하는 알려진 한계다 — 이 훅은 best-effort
# 보조이고 미탐은 무해하다(publisher 의 명시적 set 이 권위 있는 기록).
COMMIT_CMD_RE='(^|[;&|])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+commit([[:space:]]|$)'
# grep 은 줄 단위 매칭이므로 ^ 는 "어느 줄이든 그 줄의 시작" 이다 — 훅 출력이
# 커밋 확인 줄 앞에 다른 줄을 끼워 넣어도 매치된다.
COMMIT_OK_RE='^\[[^]]*[0-9a-f]{7,}\]'
if printf '%s' "$CMD" | grep -qE "$COMMIT_CMD_RE" \
   && ! printf '%s' "$CMD" | grep -qE '(^|[[:space:]])--dry-run([[:space:]]|=|$)' \
   && printf '%s' "$OUT" | grep -qE "$COMMIT_OK_RE"; then
  S '.stages."3_delivery".substages."commit".done' 'true'
fi
exit 0
