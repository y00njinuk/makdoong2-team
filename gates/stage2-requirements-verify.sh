#!/usr/bin/env bash
# stage2-requirements-verify.sh <issue> — 2단계(요구사항) 진입 게이트
# 의존: jq
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage2-requirements-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [1_planning.requirements]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — jira substage부터 시작하라"
q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }
[ "$(q '.stages."1_planning".substages."requirements".done')" != "true" ] || fail "이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행"
[ "$(q '.stages."1_planning".substages."jira".done')" = "true" ] || fail "jira substage 미완료"
echo "MAKDOONG2-GATE OK: 1_planning.requirements"
