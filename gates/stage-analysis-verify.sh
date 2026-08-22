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

q() {
  "$SCRIPTS/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo ""
}

# 1. state.json 존재 확인
[ -n "$(q '.issue')" ] || fail "state.json 없음. 1_planning 단계 먼저 완료 필요."

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
