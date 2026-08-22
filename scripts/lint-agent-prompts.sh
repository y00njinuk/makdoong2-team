#!/usr/bin/env bash
# lint-agent-prompts.sh — agent 프롬프트 및 게이트 스크립트에서 state.json flat 표기 재유입 감지.
#
# 검증 대상: agents/*.md, gates/*.sh 파일
# 감지 패턴 (BUG):
#   .stages."<PHASE>.<SUBSTAGE>"                     예: .stages."1_planning.jira"
#
# 정상 패턴:
#   .stages."<PHASE>".substages."<SUBSTAGE>"         예: .stages."1_planning".substages."jira"
#
# 허용 예외 (의도적):
#   .policy.auto_approve."<PHASE>.<SUBSTAGE>"        (opencode-plugin.ts STAGE_ORDER 는 flat)
#   .policy.categorized_by = "<PHASE>.<SUBSTAGE>"    (policy 값)
#
# 발견 시 파일:라인 + 정확한 hierarchical 대체 경로를 출력하고 exit 1.
# CI/pre-commit 훅에서 호출한다.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="${REPO_ROOT}/agents"
GATES_DIR="${REPO_ROOT}/gates"

if [ ! -d "$AGENTS_DIR" ]; then
  echo "[lint-agent-prompts] agents/ directory not found at $AGENTS_DIR" >&2
  exit 2
fi

if [ ! -d "$GATES_DIR" ]; then
  echo "[lint-agent-prompts] gates/ directory not found at $GATES_DIR" >&2
  exit 2
fi

# grep -P (PCRE) 를 사용해 negative lookbehind 로 policy 예외를 제외한다.
# 매칭: `.stages."<phase>.<sub>"` (앞에 .policy 가 붙지 않은 경우만).
# 부수적으로 `.stages.\"<phase>.<sub>\"` (escape 형태) 도 잡는다.
PATTERN='(?<!policy)\.stages\.\\?"[0-9]+_[a-z_]+\.[a-z]+\\?"'

matches_agents=$(grep -rnP "$PATTERN" "$AGENTS_DIR" || true)
matches_gates=$(grep -rnP "$PATTERN" "$GATES_DIR" || true)
matches="${matches_agents}${matches_gates}"

if [ -z "$matches" ]; then
  echo "[lint-agent-prompts] OK — no flat stage notation found in agents/ or gates/"
  exit 0
fi

echo "[lint-agent-prompts] FAIL — flat stage notation detected in agent prompts:" >&2
echo "" >&2
echo "$matches" | while IFS=: read -r file line rest; do
  # 힌트: 발견된 flat path 에서 phase.substage 를 파싱해 대체안 제시.
  hint=$(echo "$rest" | grep -oP '\.stages\.\\?"([0-9]+_[a-z_]+)\.([a-z]+)\\?"' | head -n1 || true)
  suggest=""
  if [ -n "$hint" ]; then
    phase=$(echo "$hint" | sed -E 's|.*"([0-9]+_[a-z_]+)\.([a-z]+)".*|\1|')
    sub=$(echo "$hint" | sed -E 's|.*"([0-9]+_[a-z_]+)\.([a-z]+)".*|\2|')
    suggest=".stages.\"${phase}\".substages.\"${sub}\""
  fi
  echo "  ${file}:${line}" >&2
  echo "    line   : ${rest}" >&2
  [ -n "$suggest" ] && echo "    fix    : ${suggest}" >&2
  echo "" >&2
done

cat >&2 <<EOF
state.json 스키마 규약 (AGENTS.md "state.json 스키마 규약 (hardrule)" 참조):
  hierarchical : .stages."<PHASE>".substages."<SUBSTAGE>".<field>
  flat (금지)  : .stages."<PHASE>.<SUBSTAGE>".<field>

허용 예외:
  .policy.auto_approve."<PHASE>.<SUBSTAGE>" — opencode-plugin.ts STAGE_ORDER 매핑용 flat 키.
EOF

exit 1
