#!/usr/bin/env bash
# stage-analysis-verify.sh — 2_implementation.analysis 진입 게이트 + SKIP 판정
#
# 사용: stage-analysis-verify.sh <issue>
#
# 진입 조건:
#   1. state.json 존재
#   2. 1_planning.requirements substage done=true + 승인 + 품질 게이트
#      (scope 흡수 전 stage3-scope-verify.sh 가 하던 검사를 그대로 이어받는다)
#
# SKIP 조건:
#   프로젝트 루트에 build tool 마커 파일이 하나도 없음
#   → state.json 에 skipped=true, skip_reason, done=true 마킹 후 exit 0
#
# 의존: jq, git (state.sh 내부에서 사용)
set -euo pipefail

ISSUE="${1:?usage: stage-analysis-verify.sh <issue>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$HERE/../scripts"

fail() { echo "MAKDOONG2-GATE BLOCKED [2_implementation.analysis]: $*" >&2; exit 2; }

# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다. 종전
# `|| echo ""` 은 그 뒤에 빈 줄을 덧붙일 뿐이라 결과가 "null" 이 되고, 아래
# `[ -n … ]` 존재 검사가 **항상 참**이었다 — state.json 이 없어도 통과한 뒤
# 3번에서 "scope 미완료 (done=null)" 라는 엉뚱한 진단으로 차단됐다. 실측 확인.
q() {
  local __v
  if __v="$("$SCRIPTS/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then
    printf "%s" "$__v"
  else
    printf "__MISSING__"
  fi
}

# 1. state.json 존재 확인
[ "$(q '.issue')" != "__MISSING__" ] || \
  fail "state.json 없음 또는 판독 불가. 'bash <SCRIPTS_DIR>/state.sh status ${ISSUE}' 로 확인하고, 없으면 1_planning 단계를 먼저 완료하라."

# 2. 이미 done=true 인 경우 재-dispatch 차단 (SKIP 마킹으로 done 이 이미 세팅되었을 수 있음)
ANALYSIS_DONE="$(q '.stages."2_implementation".substages."analysis".done')"
[ "$ANALYSIS_DONE" != "true" ] || fail "이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행"

# 3. requirements substage 완료 + 승인 + 품질 확인
#
# 종전에는 `1_planning.scope` substage 의 done 만 봤다. scope 가 requirements 로
# 흡수되면서(범위 확정은 요구사항 확정과 같은 판단의 연속이다) 그 자리를 지키던
# stage3-scope-verify.sh 의 검사가 통째로 이 게이트로 넘어왔다. 검사를 옮기지 않고
# 게이트만 지우면 승인·모호성·spec drift 검증이 파이프라인에서 사라진다.
REQ_DONE="$(q '.stages."1_planning".substages."requirements".done')"
[ "$REQ_DONE" = "true" ] || fail "1_planning.requirements 미완료 (done=$REQ_DONE)"

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
# 1) Ambiguity Score 수렴: 기록된 값이 0.2 초과면 요구사항 미수렴 (stages/02-requirements.md)
AMB="$(q '.stages."1_planning".substages."requirements".ambiguity_score')"
if [ "$AMB" != "__MISSING__" ] && [ "$AMB" != "null" ] && [ -n "$AMB" ]; then
  awk -v a="$AMB" 'BEGIN { exit (a + 0 <= 0.2) ? 0 : 1 }' \
    || fail "ambiguity_score=$AMB > 0.2 — 요구사항 미수렴. 인터뷰로 미결 항목 해소 후 재산정하라"
fi

# 2) 명세 동결(spec drift) 검증: spec_hash 기록 시 draft 파일 해시 재계산 일치 필요
SPEC_HASH="$(q '.stages."1_planning".substages."requirements".spec_hash')"
if [ "$SPEC_HASH" != "__MISSING__" ] && [ "$SPEC_HASH" != "null" ] && [ -n "$SPEC_HASH" ]; then
  DRAFT="$(q '.stages."1_planning".substages."requirements".draft_path')"
  ROOT="$("$SCRIPTS/state.sh" root)"
  # 마커 누락과 파일 부재를 구분해서 알린다. 둘 다 "확정 명세 파일 없음" 으로
  # 뭉뚱그리면 파일은 멀쩡하고 마커만 빠진 흔한 경우(issue #6-①)에 무엇을 해야
  # 하는지 알 수 없다.
  DEFAULT_DRAFT=".makdoong2-team/${ISSUE}/requirements-draft.md"
  if [ "$DRAFT" = "__MISSING__" ] || [ "$DRAFT" = "null" ] || [ -z "$DRAFT" ]; then
    if [ -f "$ROOT/$DEFAULT_DRAFT" ]; then
      fail "spec_hash 는 기록됐는데 draft_path 마커가 없다 — 파일은 ${DEFAULT_DRAFT} 에 있다.
  복구: (1) sha256sum \"${ROOT}/${DEFAULT_DRAFT}\" 가 spec_hash(${SPEC_HASH}) 와 같은지 대조하고,
        (2) 같으면 state.sh set 으로 requirements.draft_path 에 \"${DEFAULT_DRAFT}\" 를 기록한다,
        (3) 다르면 명세가 동결 후 변경된 것이므로 requirements substage 를 재작업한다."
    fi
    fail "spec_hash 는 기록됐는데 draft_path 마커도 확정 명세 파일도 없다 — requirements substage 를 재작업하라 (stages/02-requirements.md)"
  fi
  # "생성된 적 없음" 을 안내에서 빼면 복구 방향을 잘못 잡는다 — 실제로 가장 흔한
  # 경우인데 종전 메시지는 동기화 누락·삭제만 언급해 리더가 동기화 문제부터
  # 의심했다 (issue #8).
  [ -f "$ROOT/$DRAFT" ] \
    || fail "draft_path=${DRAFT} 마커는 있으나 파일이 없다 (기준 경로 ${ROOT}). 가능한 원인 순서대로:
  (1) 애초에 생성된 적 없음 — planner 가 마커만 기록하고 파일 생성에 실패한 경우. requirements substage 를 재작업해 쓰기 툴로 초안부터 생성하라 (stages/02-requirements.md),
  (2) worktree 동기화 누락 — 다른 cwd(main repo/worktree)의 같은 상대경로에 파일이 있는지 확인,
  (3) 파일이 삭제됨 — 삭제 경위 확인 후 requirements 재작업"
  ACTUAL="$(sha256sum "$ROOT/$DRAFT" | cut -d' ' -f1)"
  [ "$ACTUAL" = "$SPEC_HASH" ] \
    || fail "확정 명세 무단 변경 감지 (spec drift) — 동결 후 변경은 사용자 재승인 + spec_hash 재기록 절차만 허용 (stages/02-requirements.md)"
fi

# 4. SKIP 판정: worktree 루트에서 build tool 마커 파일 존재 여부
WT="$(q '.worktree' | tr -d '"')"
[ -d "$WT" ] || WT="$(pwd)"

MARKERS=(
  "package.json"
  "build.gradle"
  "build.gradle.kts"
  "pom.xml"
  "Cargo.toml"
  "go.mod"
  "pyproject.toml"
  "setup.py"
  "requirements.txt"
  "Gemfile"
  "mix.exs"
  "build.sbt"
  "composer.json"
  "Package.swift"
  "Makefile"
  "CMakeLists.txt"
)

FOUND=""
for m in "${MARKERS[@]}"; do
  if [ -f "$WT/$m" ]; then FOUND="$m"; break; fi
done

# .csproj 는 glob 확인
if [ -z "$FOUND" ]; then
  if compgen -G "$WT/*.csproj" > /dev/null 2>&1; then FOUND=".csproj"; fi
fi

if [ -z "$FOUND" ]; then
  # SKIP: state.json 마킹 후 exit 0
  "$SCRIPTS/state.sh" set "$ISSUE" \
    '.stages."2_implementation".substages."analysis".skipped' 'true' > /dev/null
  "$SCRIPTS/state.sh" set "$ISSUE" \
    '.stages."2_implementation".substages."analysis".skip_reason' \
    '"no_build_tool_marker"' > /dev/null
  "$SCRIPTS/state.sh" set "$ISSUE" \
    '.stages."2_implementation".substages."analysis".done' 'true' > /dev/null
  echo "MAKDOONG2-GATE SKIP: 2_implementation.analysis (no build tool marker in $WT)"
  exit 0
fi

echo "MAKDOONG2-GATE OK: 2_implementation.analysis (marker=$FOUND)"
