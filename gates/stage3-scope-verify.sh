#!/usr/bin/env bash
# stage3-scope-verify.sh <issue> — 3단계(범위 확정) 진입 게이트
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage3-scope-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [1_planning.scope]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — jira substage부터 시작하라"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }
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
  # 마커 누락과 파일 부재를 구분해서 알린다. 종전에는 둘 다 "확정 명세 파일 없음" 으로
  # 뭉뚱그려서, 파일은 멀쩡히 있고 마커만 빠진 흔한 경우(issue #6-①)에 무엇을 해야
  # 하는지 알 수 없었다. 마커 기록은 team-leader 에게 허용된 state.sh set 경로다.
  DEFAULT_DRAFT=".makdoong2-team/${ISSUE}/requirements-draft.md"
  if [ "$DRAFT" = "__MISSING__" ] || [ "$DRAFT" = "null" ] || [ -z "$DRAFT" ]; then
    if [ -f "$ROOT/$DEFAULT_DRAFT" ]; then
      fail "spec_hash 는 기록됐는데 draft_path 마커가 없다 — 파일은 ${DEFAULT_DRAFT} 에 있다.
  복구: (1) sha256sum \"${ROOT}/${DEFAULT_DRAFT}\" 가 spec_hash(${SPEC_HASH}) 와 같은지 대조하고,
        (2) 같으면 state.sh set 으로 requirements.draft_path 에 \"${DEFAULT_DRAFT}\" 를 기록한다 (stages/02-requirements.md §2-0),
        (3) 다르면 명세가 동결 후 변경된 것이므로 requirements substage 를 재작업한다 (§2-4a)."
    fi
    fail "spec_hash 는 기록됐는데 draft_path 마커도 확정 명세 파일도 없다 — requirements substage 를 재작업하라 (stages/02-requirements.md §2-0, §2-5 9번)"
  fi
  # "생성된 적 없음" 을 안내에서 빼면 복구 방향을 잘못 잡는다 — 실제로 가장 흔한
  # 경우인데 종전 메시지는 동기화 누락·삭제만 언급해 리더가 동기화 문제부터
  # 의심했다 (issue #8).
  [ -f "$ROOT/$DRAFT" ] \
    || fail "draft_path=${DRAFT} 마커는 있으나 파일이 없다 (기준 경로 ${ROOT}). 가능한 원인 순서대로:
  (1) 애초에 생성된 적 없음 — planner 가 마커만 기록하고 파일 생성에 실패한 경우. requirements substage 를 재작업해 write 툴로 초안부터 생성하라 (stages/02-requirements.md §2-0b),
  (2) worktree 동기화 누락 — 다른 cwd(main repo/worktree)의 같은 상대경로에 파일이 있는지 확인,
  (3) 파일이 삭제됨 — 삭제 경위 확인 후 requirements 재작업"
  ACTUAL="$(sha256sum "$ROOT/$DRAFT" | cut -d' ' -f1)"
  [ "$ACTUAL" = "$SPEC_HASH" ] \
    || fail "확정 명세 무단 변경 감지 (spec drift) — 동결 후 변경은 사용자 재승인 + spec_hash 재기록 절차만 허용 (stages/02-requirements.md §2-4a)"
fi
echo "MAKDOONG2-GATE OK: 1_planning.scope"
