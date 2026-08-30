#!/usr/bin/env bash
# stage4-dev-post-verify.sh <issue> — 4단계(개발) 종료 게이트.
# ─────────────────────────────────────────────────────────
# 검증 항목:
#   1. worktree 가 존재하는가
#   2. dev-written-files.txt 에 기록된 모든 파일이 staging(index) 혹은 HEAD tree 에 존재하는가
#   3. .gitignore 를 존중한 untracked 파일이 0인가
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

echo "MAKDOONG2-GATE OK: 2_implementation.dev_post"
