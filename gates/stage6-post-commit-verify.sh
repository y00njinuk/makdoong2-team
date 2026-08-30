#!/usr/bin/env bash
# stage6-post-commit-verify.sh <issue> — 6단계 커밋 완료 후 검증 게이트
# ─────────────────────────────────────────────────────────
# 검증 항목:
#   1. worktree 가 메인 repo 의 형제 디렉토리인지
#   2. base_sha 기록 + HEAD 조상 여부
#   3. base_sha..HEAD 커밋 수 > 0
#   4. 각 커밋이 정확히 1개 파일만 포함 (1 파일 = 1 commit 원칙)
#   5. 각 커밋 subject 에 결합어 (and / & / + / 및 / 그리고) 없음
#   6. 각 커밋 subject 가 Git Commit Guidelines 형식 준수
#      - 형식: <Type>: <이슈키> - <요약> (제목 50자 이내, 마침표 없음)
#      - Type: Feat/Fix/Chore/Refactor/Docs/Style/Test/Perf/Ci/Build/Revert
#      - 이슈키 = 인자로 받은 $ISSUE 와 정확히 일치
#   7. 각 커밋 본문에 이슈 참조 마커 ([RV] <이슈키>) 포함
#   8. atomic_review.all_atomic == true + one_file_per_commit == true
#   9. atomic_review.count_commits == 실제 커밋 수
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISSUE="${1:?usage: stage6-post-commit-verify.sh <issue>}"
P="$("$HERE/../scripts/state.sh" root)/.makdoong2-team/$ISSUE/state.json"
fail(){ echo "MAKDOONG2-GATE BLOCKED [3_delivery.commit_post]: $1" >&2; exit 2; }
[ -f "$P" ] || fail "state.json 없음 — planning phase부터 시작하라"
# state.sh get 은 실패해도 stdout 에 "null" 한 줄을 찍고 exit 1 한다 (게이트들이
# 의존하는 계약). 종전 `|| echo "__MISSING__"` 은 그 위에 한 줄을 **덧붙여**
# `null\\n__MISSING__` 두 줄을 만들었고, 그 값은 `= "null"` 에도 `= "__MISSING__"`
# 에도 걸리지 않아 **부재/손상이 "값이 있음" 으로 통과**했다. 실측 확인.
# if 형태로 성공 출력만 취하고, 실패 시에는 sentinel 하나만 낸다.
q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }

assert_worktree_sibling(){
  local wt="$1" main pwt pmain
  [ -d "$wt" ] || fail "worktree 경로가 존재하지 않음: $wt"
  main="$(git -C "$wt" worktree list --porcelain 2>/dev/null | sed -n 's|^worktree ||p' | head -1)"
  [ -n "$main" ] || fail "메인 repo 식별 실패"
  [ "$wt" != "$main" ] || fail "worktree가 메인 repo와 동일 경로 — 별도 worktree 필요"
  pwt="$(cd "$(dirname "$wt")" && pwd -P)"
  pmain="$(cd "$(dirname "$main")" && pwd -P)"
  [ "$pwt" = "$pmain" ] || fail "worktree가 메인 repo의 형제 디렉토리가 아님: $wt (메인: $main)"
}

WT="$(q '.worktree')"
assert_worktree_sibling "$WT"

# ─── §2. base_sha ───
BASE="$(q '.stages."3_delivery".substages."commit".base_sha')"
{ [ -n "$BASE" ] && [ "$BASE" != "null" ] && [ "$BASE" != "__MISSING__" ]; } || \
  fail "commit substage base_sha 미기록 — commit substage 시작 시 git rev-parse HEAD를 base_sha로 기록해야 함"
git -C "$WT" merge-base --is-ancestor "$BASE" HEAD 2>/dev/null || \
  fail "base_sha($BASE)가 현재 HEAD의 조상이 아님 — base_sha 또는 분기 상태 확인 필요"

# ─── §3. 커밋 수 > 0 ───
N=$(git -C "$WT" rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
[ "$N" -gt 0 ] || fail "base_sha와 HEAD가 동일 — commit substage에서 만든 커밋이 없음"

# ─── §4. 1 파일 = 1 commit 원칙 (hardrule) ───
MULTI_FILE_VIOLATIONS=""
for SHA in $(git -C "$WT" rev-list "$BASE..HEAD"); do
  NF=$(git -C "$WT" show --name-only --pretty="" "$SHA" | grep -c . || true)
  if [ "$NF" -ne 1 ]; then
    SUBJ=$(git -C "$WT" log -1 --format='%s' "$SHA")
    MULTI_FILE_VIOLATIONS="${MULTI_FILE_VIOLATIONS}
  - ${SHA:0:7} '${SUBJ}' 파일수=${NF} (기대: 1)"
  fi
done
[ -z "$MULTI_FILE_VIOLATIONS" ] || \
  fail "1 파일 = 1 commit 원칙 위반. 각 커밋은 정확히 1개 파일만 포함해야 함:${MULTI_FILE_VIOLATIONS}
  → 조치: 'bash <SCRIPTS_DIR>/rollback-commits.sh $ISSUE' 후 파일별로 재커밋"

# ─── §5. 결합어 검사 ───
BAD=$(git -C "$WT" log --format='%s' "$BASE..HEAD" | grep -cE ' and | & | \+ | 및 | 그리고 ' || true)
[ "$BAD" -eq 0 ] || \
  fail "커밋 subject에 결합어(and / & / + / 및 / 그리고) ${BAD}건 발견 — 1 commit = 1 change 위반 가능. git log로 확인 후 재구성하라"

# ─── §6. 커밋 메시지 형식 재검증 ───
# 형식: ^(Feat|Fix|Chore|Refactor|Docs|Style|Test|Perf|Ci|Build|Revert): <ISSUE> - <요약>$
# 제목 50자 이내, 마침표 없음
MSG_FMT_RE="^(Feat|Fix|Chore|Refactor|Docs|Style|Test|Perf|Ci|Build|Revert): ${ISSUE} - .+$"
MSG_VIOLATIONS=""
while IFS= read -r line; do
  # line 형식: <SHA_short><TAB><subject>
  SHA="${line%%$'\t'*}"
  SUBJ="${line#*$'\t'}"
  if ! [[ "$SUBJ" =~ $MSG_FMT_RE ]]; then
    MSG_VIOLATIONS="${MSG_VIOLATIONS}
  - ${SHA} '${SUBJ}' 형식 불일치 (기대: <Type>: ${ISSUE} - <요약>)"
    continue
  fi
  # 제목 길이는 **문자 수**로 센다. 세는 방법이 로케일·구현에 의존하면 안 된다:
  #   - bash ${#SUBJ} 는 UTF-8 바이트 수라 한글이 3배로 잡힌다.
  #   - `wc -m` 은 구현마다 다르다 (실측):
  #       · macOS(BSD wc)          : LC_ALL=C/POSIX 에서 바이트 수를 낸다 (22자 → 36)
  #       · Ubuntu 26.04(uutils wc): 모든 로케일에서 문자 수를 낸다 (22)
  #     즉 LANG 이 비면 개발기(macOS)에서만 한글 제목이 3배로 세어져, 17자만 넘어도
  #     "50자 초과" 로 차단된다. 배포 대상(Ubuntu)에서는 재현되지 않는 비대칭이라
  #     오히려 발견이 늦는 부류다.
  # 그래서 UTF-8 연속 바이트(0x80–0xBF)를 지우고 남은 바이트를 센다. 유효한 UTF-8
  # 에서 이것은 정확히 문자 수와 같고, 로케일에도 wc 구현에도 의존하지 않는다.
  SUBJ_LEN=$(printf '%s' "${SUBJ}" | LC_ALL=C tr -d '\200-\277' | LC_ALL=C wc -c | tr -d '[:space:]')
  if [ "$SUBJ_LEN" -gt 50 ]; then
    MSG_VIOLATIONS="${MSG_VIOLATIONS}
  - ${SHA} '${SUBJ}' 제목 ${SUBJ_LEN}자 초과 (최대 50자)"
  fi
  # 마침표 금지
  if [[ "$SUBJ" == *. ]]; then
    MSG_VIOLATIONS="${MSG_VIOLATIONS}
  - ${SHA} '${SUBJ}' 제목 끝에 마침표 금지"
  fi
done < <(git -C "$WT" log --format='%h%x09%s' "$BASE..HEAD")

[ -z "$MSG_VIOLATIONS" ] || \
  fail "커밋 메시지 형식 위반:${MSG_VIOLATIONS}
  → 조치: git commit --amend 로 수정하거나 rollback-commits.sh 후 재작성"

# ─── §7. 이슈 참조 마커 확인 ───
# 커밋 body 어딘가에 [RV] <이슈키> 마커가 포함되어야 한다.
# body 가 빈 커밋은 허용하되 (선택), body 가 있다면 마커 필수.
KW_RE='\[RV\][[:space:]]+[A-Z]+-[0-9]+'
KW_VIOLATIONS=""
for SHA in $(git -C "$WT" rev-list "$BASE..HEAD"); do
  BODY=$(git -C "$WT" log -1 --format='%b' "$SHA")
  if [ -n "$(printf '%s' "$BODY" | tr -d '[:space:]')" ]; then
    if ! printf '%s' "$BODY" | grep -qE "$KW_RE"; then
      SUBJ=$(git -C "$WT" log -1 --format='%s' "$SHA")
      KW_VIOLATIONS="${KW_VIOLATIONS}
  - ${SHA:0:7} '${SUBJ}' 본문에 이슈 참조 마커 없음 ([RV] ${ISSUE} 필요)"
    fi
  fi
done
[ -z "$KW_VIOLATIONS" ] || \
  fail "커밋 본문에 이슈 참조 마커 누락:${KW_VIOLATIONS}"

# ─── §8. atomic_review 마커 ───
A="$(q '.stages."3_delivery".substages."commit".atomic_review.all_atomic')"
[ "$A" = "true" ] || \
  fail "atomic_review.all_atomic 미기록 또는 false — 각 커밋이 단일 변경인지 검토 후 true로 기록해야 함"
OFPC="$(q '.stages."3_delivery".substages."commit".atomic_review.one_file_per_commit')"
[ "$OFPC" = "true" ] || \
  fail "atomic_review.one_file_per_commit 미기록 또는 false — 1 파일/commit 자체 검토 후 true로 기록해야 함"

# ─── §9. count_commits 일치 ───
C="$(q '.stages."3_delivery".substages."commit".atomic_review.count_commits')"
[ "$C" = "$N" ] || \
  fail "atomic_review.count_commits=$C 와 실제 커밋 수 $N 불일치 — 다시 기록하라"

echo "MAKDOONG2-GATE OK: 3_delivery.commit_post (${N}개 커밋 모두 1파일/commit + 메시지 형식 통과)"
