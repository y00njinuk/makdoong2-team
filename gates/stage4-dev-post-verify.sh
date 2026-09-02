#!/usr/bin/env bash
# stage4-dev-post-verify.sh <issue> — 4단계(개발) 종료 게이트.
# ─────────────────────────────────────────────────────────
# 검증 항목:
#   1. worktree 가 존재하는가
#   2. dev-written-files.txt 에 기록된 모든 파일이 staging(index) 혹은 HEAD tree 에 존재하는가
#   3. .gitignore 를 존중한 untracked 파일이 0인가
#   4. 테스트 동반 원칙이 1_planning.requirements 의 test_scope 선언과 일치하는가
#
# 불변식: 3_delivery.commit 는 untracked 를 자동 제외하므로,
#         본 게이트를 통과한 파일만이 커밋 대상에 진입한다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage4-dev-post-verify.sh <issue>}"

fail(){ echo "MAKDOONG2-GATE BLOCKED [2_implementation.dev_post]: $1" >&2; exit 2; }

# state.sh get 은 실패해도 stdout 에 "null" 을 찍는다 — 종전 `|| echo ""` 는 그
# 출력을 지우지 못해 WT 가 리터럴 "null" 이 됐다 (진단 메시지가 엉뚱해진다).
if ! WT="$("$HERE/../scripts/state.sh" get "$ISSUE" '.worktree' 2>/dev/null | tr -d '"')"; then
  WT=""
fi
[ "$WT" = "null" ] && WT=""
[ -n "$WT" ] && [ -d "$WT" ] || fail "worktree 경로 부재 또는 접근 불가 (state.json 의 .worktree=${WT:-미기록}) — 'state.sh status $ISSUE' 로 확인하라"

TRACK="$WT/.makdoong2-team/$ISSUE/dev-written-files.txt"

MISSING=""
if [ -f "$TRACK" ]; then
  while IFS= read -r F; do
    [ -z "$F" ] && continue
    if git -C "$WT" -c core.quotePath=false diff --cached --name-only | grep -qxF "$F"; then
      continue
    fi
    if git -C "$WT" -c core.quotePath=false ls-tree -r --name-only HEAD 2>/dev/null | grep -qxF "$F"; then
      continue
    fi
    if [ ! -e "$WT/$F" ]; then
      continue
    fi
    MISSING="${MISSING}
  - $F"
  done < <(sort -u "$TRACK")
fi

UNTRACKED="$(git -C "$WT" -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null || true)"

if [ -n "$MISSING" ] || [ -n "$UNTRACKED" ]; then
  MSG="Engineer 가 편집한 파일이 staging area 에 포함되지 않았다."
  MSG="${MSG}
Publisher(3_delivery.commit) 가 untracked 파일을 자동 제외하므로 여기서 통과하지 못하면 신규 소스코드가 커밋되지 않는다."
  if [ -n "$MISSING" ] && [ -f "$TRACK" ]; then
    MSG="${MSG}

[dev-written-files.txt 에 기록됐지만 staged 아님]${MISSING}"
  fi
  if [ -n "$UNTRACKED" ]; then
    MSG="${MSG}

[.gitignore 존중 untracked 파일 (안전망 감지)]
$(echo "$UNTRACKED" | sed 's/^/  - /')"
  fi
  MSG="${MSG}

→ 조치: worktree($WT) 에서 각 파일에 'git add -- <파일>' 실행 후 dev.done 재기록.
→ 자동화 필요: tool.execute.after 훅이 auto git add 를 수행해야 하는데 미동작. 훅 상태 점검 필요."
  fail "$MSG"
fi

# ── 4. 테스트 동반 원칙 — requirements 의 선언을 따른다 (issue #11) ──────────
#
# 종전에는 이 검사가 게이트에 없고 verifier 만 알고 있었으며, 그 verifier 기준은
# "sub-agent output 에 '테스트 추가' 명시" 라는 무조건 요구였다. requirements 가
# 테스트 범위 제외를 승인·동결해도 그 결정을 참조하는 경로가 없어서, 순수 설정·
# 인프라 전환 작업마다 REJECTED 가 반복되고 결국 engineer 가 승인된 스코프 밖의
# 테스트를 추가했다. 게이트·stage spec·verifier 세 곳이 같은 선언을 보게 한다.
#
# 판정 규칙 (fail-closed):
#   REQ = requirements.test_scope.new_tests_required — 부재/null = true 로 간주
#   REQ=true  → self_check.new_tests_added 는 true 여야 한다
#   REQ=false → new_tests_added 가 false 여도 되지만, 슬립과 구분하기 위해
#               dev.new_tests_waived=true 마커가 함께 있어야 한다
#
# self_check 자체가 없는 구형 state 는 검사하지 않는다 (기존 동작 보존).
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }

SELF_CHECK="$(q '.stages."2_implementation".substages."dev".self_check')"
if [ "${SELF_CHECK}" != "__MISSING__" ] && [ "${SELF_CHECK}" != "null" ] && [ -n "${SELF_CHECK}" ]; then
  NEW_TESTS_ADDED="$(q '.stages."2_implementation".substages."dev".self_check.new_tests_added')"
  if [ "${NEW_TESTS_ADDED}" != "true" ]; then
    REQ="$(q '.stages."1_planning".substages."requirements".test_scope.new_tests_required')"
    if [ "${REQ}" != "false" ]; then
      fail "테스트 동반 원칙 미충족: self_check.new_tests_added=${NEW_TESTS_ADDED} 인데
requirements 의 테스트 범위 선언이 테스트 추가를 요구한다 (test_scope.new_tests_required=${REQ}; 부재/null 은 true 로 간주).
→ 조치 A: 변경에 대한 테스트를 추가하고 new_tests_added=true 로 다시 기록한다.
→ 조치 B: 이 이슈가 테스트를 붙일 수 없는 성질이라면 임의로 면제하지 말고 부장님에게 보고한다 —
          테스트 범위 제외는 1_planning.requirements 에서만 승인·기록할 수 있다 (stages/02-requirements.md §2-6a)."
    fi
    WAIVED="$(q '.stages."2_implementation".substages."dev".new_tests_waived')"
    [ "${WAIVED}" = "true" ] || fail "테스트 면제 마커 누락: requirements 가 테스트 추가를 제외했지만(test_scope.new_tests_required=false)
dev.new_tests_waived 마커가 없다 — new_tests_added=false 가 의도된 면제인지 기록 누락인지 구분할 수 없다.
→ 조치: bash <SCRIPTS_DIR>/state.sh set ${ISSUE} '.stages.\"2_implementation\".substages.\"dev\".new_tests_waived' 'true'"
  fi
fi

echo "MAKDOONG2-GATE OK: 2_implementation.dev_post"
