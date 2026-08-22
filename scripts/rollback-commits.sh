#!/usr/bin/env bash
# rollback-commits.sh <issue>
#   6단계 시작점(base_sha)으로 worktree HEAD를 soft reset 하여
#   이번 단계에서 만든 모든 커밋을 취소한다. working tree와 index의 변경 내용은 보존되므로
#   동일 변경을 다시 쪼개어 1 commit = 1 change로 재커밋할 수 있다.
# 사용: rollback-commits.sh <issue>
set -euo pipefail
ISSUE="${1:?usage: $0 <issue>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

WT="$("$HERE/state.sh" get "$ISSUE" '.worktree' 2>/dev/null | tr -d '"')"
[ -n "$WT" ] && [ -d "$WT" ] || { echo "[rollback] worktree 확인 실패: $WT" >&2; exit 1; }

BASE="$("$HERE/state.sh" get "$ISSUE" '.stages."3_delivery".substages."commit".base_sha' 2>/dev/null | tr -d '"')"
{ [ -n "$BASE" ] && [ "$BASE" != "null" ] && [ "$BASE" != "__MISSING__" ]; } || {
  echo "[rollback] base_sha 미기록 — rollback할 기준점이 없다. 3_delivery.commit 단계에서 base_sha를 먼저 기록하라." >&2
  exit 1
}

# 안전 확인: BASE가 HEAD의 조상이어야 함 (임의 sha로 reset되지 않게)
git -C "$WT" merge-base --is-ancestor "$BASE" HEAD 2>/dev/null || {
  echo "[rollback] base_sha($BASE)가 현재 HEAD의 조상이 아님 — 수동 확인 필요" >&2
  exit 1
}

# 커밋만 취소, 변경은 보존 (soft reset)
N=$(git -C "$WT" rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
git -C "$WT" reset --soft "$BASE"
# ${N} and ${BASE} must stay braced. Unbraced, bash reads the variable name with
# legal_variable_char() == isalnum() one byte at a time, and Darwin libc reports
# 0xEA — the lead byte of the Hangul counter suffix that follows — as alnum in
# UTF-8 locales. The name absorbs that byte, becomes unbound, and set -u aborts.
# glibc keeps high bytes non-alnum, so this only bites on macOS.
# Guarded by test/shell-portability.test.mjs.
echo "[rollback] HEAD를 ${BASE} 로 soft-reset 완료 (취소된 커밋 ${N}개, working tree/index 변경은 보존됨)"

# 3_delivery.commit 관련 state 초기화 (base_sha는 보존 — 동일 기준점으로 재커밋)
"$HERE/state.sh" set "$ISSUE" '.stages."3_delivery".substages."commit".done' 'false' >/dev/null
"$HERE/state.sh" set "$ISSUE" '.stages."3_delivery".substages."commit".atomic_review' 'null' >/dev/null
"$HERE/state.sh" set "$ISSUE" '.stages."3_delivery".substages."commit".head_sha' 'null' >/dev/null
echo "[rollback] 3_delivery.commit state 초기화 완료. commit 단계를 처음부터 다시 진행하라."
