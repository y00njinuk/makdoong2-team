#!/usr/bin/env bash
# stage-analysis-verify.sh — 2_implementation.analysis 진입 게이트 + SKIP 판정
#
# 사용: stage-analysis-verify.sh <issue>
#
# 진입 조건:
#   1. state.json 존재
#   2. 1_planning.scope substage done=true
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

# 3. scope substage 완료 확인
SCOPE_DONE="$(q '.stages."1_planning".substages."scope".done')"
[ "$SCOPE_DONE" = "true" ] || fail "1_planning.scope 미완료 (done=$SCOPE_DONE)"

# 3. SKIP 판정: worktree 루트에서 build tool 마커 파일 존재 여부
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
