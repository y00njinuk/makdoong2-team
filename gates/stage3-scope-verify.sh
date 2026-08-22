#!/usr/bin/env bash
# stage3-scope-verify.sh <issue> — 3단계(범위 확정) 진입 게이트
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage3-scope-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [1_planning.scope]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — jira substage부터 시작하라"
q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }
[ "$(q '.stages."1_planning".substages."scope".done')" != "true" ] || fail "이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행"
[ "$(q '.stages."1_planning".substages."requirements".done')" = "true" ] || fail "requirements substage 미완료"

if [ "$(q '.policy.auto_approve."1_planning.requirements"')" != "true" ]; then
  [ "$(q '.stages."1_planning".substages."requirements".approved_by_user')" = "true" ] \
    || fail "requirements substage 사용자 승인 없음 (또는 .policy.auto_approve.\"1_planning.requirements\" 미설정)"
  if [ "$(q '.stages."1_planning".substages."requirements".verification_pending')" = "true" ]; then
    fail "requirements substage 검증 대기 중 (verification_pending) — 사용자 승인 후 approved_by_user를 기록하라"
  fi
fi

if [ "$(q '.stages."1_planning".substages."requirements".interview_required')" = "true" ]; then
  [ "$(q '.stages."1_planning".substages."requirements".interview_completed')" = "true" ] \
    || fail "requirements substage 인터뷰 미완료 — 모든 미결 항목 해소 후 interview_completed=true 기록 필요"
fi

# --- 요구사항 품질 게이트 (조건부 — 마커 존재 시에만 검사, 구형 state 호환) ---
# 1) Ambiguity Score 수렴: 기록된 값이 0.2 초과면 요구사항 미수렴 (stages/02-requirements.md §2-3-2b)
AMB="$(q '.stages."1_planning".substages."requirements".ambiguity_score')"
if [ "$AMB" != "__MISSING__" ] && [ "$AMB" != "null" ] && [ -n "$AMB" ]; then
  awk -v a="$AMB" 'BEGIN { exit (a + 0 <= 0.2) ? 0 : 1 }' \
    || fail "ambiguity_score=$AMB > 0.2 — 요구사항 미수렴. 인터뷰로 미결 항목 해소 후 재산정하라"
fi

# 2) 명세 동결(spec drift) 검증: spec_hash 기록 시 draft 파일 해시 재계산 일치 필요 (§2-4a)
SPEC_HASH="$(q '.stages."1_planning".substages."requirements".spec_hash')"
if [ "$SPEC_HASH" != "__MISSING__" ] && [ "$SPEC_HASH" != "null" ] && [ -n "$SPEC_HASH" ]; then
  DRAFT="$(q '.stages."1_planning".substages."requirements".draft_path')"
  ROOT="$("$HERE/../scripts/state.sh" root)"
  { [ "$DRAFT" != "__MISSING__" ] && [ "$DRAFT" != "null" ] && [ -f "$ROOT/$DRAFT" ]; } \
    || fail "spec_hash 기록됨 그러나 확정 명세 파일 없음 (draft_path=$DRAFT)"
  ACTUAL="$(sha256sum "$ROOT/$DRAFT" | cut -d' ' -f1)"
  [ "$ACTUAL" = "$SPEC_HASH" ] \
    || fail "확정 명세 무단 변경 감지 (spec drift) — 동결 후 변경은 사용자 재승인 + spec_hash 재기록 절차만 허용 (stages/02-requirements.md §2-4a)"
fi
echo "MAKDOONG2-GATE OK: 1_planning.scope"
