#!/usr/bin/env bash
# stage2-requirements-verify.sh <issue> — 2단계(요구사항) 진입 게이트
# 의존: jq
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage2-requirements-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [1_planning.requirements]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — jira substage부터 시작하라"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }
[ "$(q '.stages."1_planning".substages."requirements".done')" != "true" ] || fail "이미 done=true 완료됨 — auto_advance_stage 로 다음 단계 진행"
[ "$(q '.stages."1_planning".substages."jira".done')" = "true" ] || fail "jira substage 미완료"
echo "MAKDOONG2-GATE OK: 1_planning.requirements"
