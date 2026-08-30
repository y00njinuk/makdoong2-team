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

# ── PCRE 를 쓰지 않는다 ──
# 종전 구현은 negative lookbehind 를 위해 `grep -rnP` 를 썼다. BSD grep(macOS 기본)
# 에는 `-P` 가 없어 `grep: invalid option -- P` 로 실패하는데, 뒤의 `|| true` 가
# 그 실패를 삼켜 matches 가 비고 **"OK — no flat stage notation found"** 를 출력하며
# exit 0 했다. 이 스크립트는 `npm test` 의 첫 단계라, macOS 개발기에서는 flat 표기
# 회귀가 통째로 미검출 상태로 Linux 사용자에게 배포됐다. 실측 확인.
#
# lookbehind 대신 ERE 로 전부 잡은 뒤 `.policy.stages.` 예외를 빼는 2단 구성으로
# 바꾼다 (`.policy.auto_approve.*` 만 flat 표기를 유지하는 규약).
PATTERN='\.stages\.\\?"[0-9]+_[a-z_]+\.[a-z]+\\?"'

scan() { grep -rnE "$PATTERN" "$1" 2>/dev/null | grep -v 'policy\.stages\.' || true; }

# ── 자기 점검 ──
# "검사기가 아무것도 검사하지 못하는 상태" 를 구조적으로 불가능하게 만든다.
# 알려진 위반 샘플을 만들어 스스로 잡아내지 못하면 즉시 실패한다.
SELFTEST_DIR="$(mktemp -d)"
trap 'rm -rf "${SELFTEST_DIR}"' EXIT
printf 'state.sh get X %s.stages."1_planning.jira".done%s\n' "'" "'" > "${SELFTEST_DIR}/positive.md"
printf 'state.sh get X %s.stages."1_planning".substages."jira".done%s\n' "'" "'" > "${SELFTEST_DIR}/negative.md"
printf 'state.sh get X %s.policy.stages."1_planning.jira"%s\n' "'" "'" > "${SELFTEST_DIR}/exception.md"

if [ -z "$(scan "${SELFTEST_DIR}/positive.md")" ]; then
  echo "[lint-agent-prompts] SELFTEST FAIL — 알려진 flat 표기를 검출하지 못한다." >&2
  echo "  이 상태로는 통과 메시지가 아무것도 보장하지 않는다 (grep 구현 차이 의심)." >&2
  exit 2
fi
if [ -n "$(scan "${SELFTEST_DIR}/negative.md")" ]; then
  echo "[lint-agent-prompts] SELFTEST FAIL — 정상 hierarchical 표기를 위반으로 오검출한다." >&2
  exit 2
fi
if [ -n "$(scan "${SELFTEST_DIR}/exception.md")" ]; then
  echo "[lint-agent-prompts] SELFTEST FAIL — .policy 예외가 적용되지 않는다." >&2
  exit 2
fi

matches_agents=$(scan "$AGENTS_DIR")
matches_gates=$(scan "$GATES_DIR")
matches="${matches_agents}${matches_gates}"

if [ -z "$matches" ]; then
  echo "[lint-agent-prompts] OK — no flat stage notation found in agents/ or gates/"
  exit 0
fi

echo "[lint-agent-prompts] FAIL — flat stage notation detected in agent prompts:" >&2
echo "" >&2
echo "$matches" | while IFS=: read -r file line rest; do
  # 힌트: 발견된 flat path 에서 phase.substage 를 파싱해 대체안 제시.
  hint=$(echo "$rest" | grep -oE '\.stages\.\\?"[0-9]+_[a-z_]+\.[a-z]+\\?"' | head -n1 || true)
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
state.json 스키마 규약 (CLAUDE.md "state.json 스키마 규약 (hardrule)" 참조):
  hierarchical : .stages."<PHASE>".substages."<SUBSTAGE>".<field>
  flat (금지)  : .stages."<PHASE>.<SUBSTAGE>".<field>

허용 예외:
  .policy.auto_approve."<PHASE>.<SUBSTAGE>" — opencode-plugin.ts STAGE_ORDER 매핑용 flat 키.
EOF

exit 1
