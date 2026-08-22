#!/usr/bin/env bash
# gate-policy-test.sh — 작업 범주화(.policy) 기반 조건부 auto-approve 게이트 단위 테스트.
#
# 2단계에서 결정한 `.policy.auto_approve.<stage>` 마커가 stage3/4/6/8 진입 게이트의
# 사람-승인 분기를 올바르게 제어하는지 임시 git repo + state.json 픽스처로 검증한다.
#   - minor (기본)            → 모든 게이트 무인 통과
#   - major (기본)            → 모든 게이트 무인 통과 (category 는 위험도 라벨/opt-in 훅용)
#   - HITL opt-in (auto_approve="false") → 해당 substage 만 변경 보고서 + 승인 요구
#   - 구형 state (.policy 미설정)         → 기존 사람-승인 동작 보존 (backward-compat)
#
# 의존: jq, git, bash.  실행: bash scripts/gate-policy-test.sh  (exit 0=all pass / 1=fail)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATES="$REPO_ROOT/gates"
ISSUE="TEST-1"

pass=0; fail=0

TMP="$(mktemp -d)"
cleanup(){ rm -rf "$TMP"; }
trap cleanup EXIT

git init -q "$TMP"
ROOT="$(cd "$TMP" && git rev-parse --show-toplevel)"
SDIR="$ROOT/.makdoong2-team/$ISSUE"
mkdir -p "$SDIR"
STATE="$SDIR/state.json"
REPORT="$SDIR/change-report.md"

# 격리된 설정 디렉토리 — config.sh(coverage.threshold)가 결정론적으로 읽도록 XDG를 고정.
XDGHOME="$TMP/xdg"; mkdir -p "$XDGHOME/opencode"
printf '{"coverage":{"threshold":95}}\n' > "$XDGHOME/opencode/makdoong2-team.json"

# 기준 state.json에 jq 필터를 적용해 시나리오별 픽스처 작성 (신 hierarchical 구조).
BASE='{"issue":"TEST-1","worktree":"'"$ROOT"'","stages":{"1_planning":{"done":false,"substages":{"jira":{"done":true,"validation_passed":true},"requirements":{"done":false},"scope":{"done":false}}},"2_implementation":{"done":false,"substages":{"dev":{"done":false},"test":{"unit":"none","integration":"none","coverage":"none"}}},"3_delivery":{"done":false,"substages":{"commit":{"done":false},"pr":{"draft_url":null},"review":{"comments":0}}}},"policy":null}'
mk(){ echo "$BASE" | jq "$1" > "$STATE"; }

# expect <name> <want: pass|block> <gate-script>
expect(){
  local name="$1" want="$2" script="$3" out rc got
  out="$(cd "$ROOT" && XDG_CONFIG_HOME="$XDGHOME" bash "$GATES/$script" "$ISSUE" 2>&1)"; rc=$?
  got=block; [ "$rc" -eq 0 ] && got=pass
  if [ "$got" = "$want" ]; then
    echo "  ✓ $name ($want)"; pass=$((pass+1))
  else
    echo "  ✗ $name: want=$want got=$got (rc=$rc)"; echo "$out" | head -1 | sed 's/^/      /'; fail=$((fail+1))
  fi
}

echo ""
echo "[gate-policy-test] 조건부 auto-approve 게이트 분기"
echo ""
echo "── stage3-scope-verify (2→3) ──"
rm -f "$REPORT"

# minor (기본): auto_approve true → 승인/pending 무시하고 통과
mk '.stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."requirements".verification_pending=true | .policy={category:"minor",auto_approve:{"1_planning.requirements":true}}'
expect "minor 기본 auto-approve (승인 없이 통과)" pass stage3-scope-verify.sh

# major (기본): auto_approve true → 통과 (minor 와 동일 흐름 — category 는 라벨용)
mk '.stages."1_planning".substages."requirements".done=true | .policy={category:"major",auto_approve:{"1_planning.requirements":true}}'
expect "major 기본도 요구사항 게이트는 무인 통과" pass stage3-scope-verify.sh

# legacy(no policy) + 미승인 → 차단
mk '.stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."requirements".approved_by_user=false'
expect "구형 state 미승인 → 차단" block stage3-scope-verify.sh

# legacy(no policy) + 승인 → 통과
mk '.stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."requirements".approved_by_user=true | .stages."1_planning".substages."requirements".verification_pending=false'
expect "구형 state 사용자 승인 → 통과" pass stage3-scope-verify.sh

# auto-approve여도 인터뷰 미완료면 차단 (정합성 게이트는 독립)
mk '.stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."requirements".interview_required=true | .stages."1_planning".substages."requirements".interview_completed=false | .policy={category:"minor",auto_approve:{"1_planning.requirements":true}}'
expect "인터뷰 미완료 → 차단 (auto와 무관)" block stage3-scope-verify.sh

echo ""
echo "── stage4-dev-verify (3→4) ──"
# worktree 경로 검증을 위해 실제 git worktree 생성 (메인 repo의 형제)
WT="$(dirname "$TMP")/$(basename "$TMP")-TEST-1"
(cd "$ROOT" && git worktree add "$WT" -b test-branch 2>/dev/null || true)
mk '.stages."1_planning".substages."scope".done=true | .stages."1_planning".substages."scope".verification_pending=true | .stages."2_implementation".substages."analysis".done=true | .policy={category:"minor",auto_approve:{"1_planning.scope":true}} | .worktree="'"$WT"'"'
expect "minor auto-approve → 통과" pass stage4-dev-verify.sh
mk '.stages."1_planning".substages."scope".done=true | .stages."1_planning".substages."scope".approved_by_user=false | .stages."2_implementation".substages."analysis".done=true | .worktree="'"$WT"'"'
expect "구형 state 미승인 → 차단" block stage4-dev-verify.sh
mk '.stages."1_planning".substages."scope".done=true | .stages."1_planning".substages."scope".approved_by_user=true | .stages."2_implementation".substages."analysis".done=true | .worktree="'"$WT"'"'
expect "구형 state 승인 → 통과" pass stage4-dev-verify.sh

echo ""
echo "── stage6-commit-verify (5→6) ──"
TESTS='.stages."1_planning".substages."jira".done=true | .stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."scope".done=true | .stages."2_implementation".substages."dev".done=true | .stages."2_implementation".substages."test".unit="pass" | .stages."2_implementation".substages."test".integration="skip" | .stages."2_implementation".substages."test".coverage="exempt"'

# minor (기본): commit auto_approve true → 보고서/승인 없이 통과
rm -f "$REPORT"
mk "$TESTS | .policy={category:\"minor\",auto_approve:{\"3_delivery.commit\":true}}"
expect "minor 기본 → 휴먼 게이트 없이 통과" pass stage6-commit-verify.sh

# major (기본): commit auto_approve true → 보고서/승인 없이 통과 (minor 와 동일 흐름)
rm -f "$REPORT"
mk "$TESTS | .policy={category:\"major\",auto_approve:{\"3_delivery.commit\":true}}"
expect "major 기본 (auto_approve=true) → 휴먼 게이트 없이 통과" pass stage6-commit-verify.sh

# HITL opt-in: 보고서 없음 + pending 없음 = 초기 상태 → 통과 (publisher 첫 dispatch 허용)
rm -f "$REPORT"
mk "$TESTS | .policy={category:\"major\",auto_approve:{\"3_delivery.commit\":false}}"
expect "HITL opt-in + 보고서 없음 (초기 상태) → 통과" pass stage6-commit-verify.sh

# HITL opt-in: 보고서 없음 + pending=true → 차단 (publisher가 보고서 생성 후 pending 세팅, 승인 대기)
rm -f "$REPORT"
mk "$TESTS | .policy={category:\"major\",auto_approve:{\"3_delivery.commit\":false}} | .stages.\"3_delivery\".substages.\"commit\".verification_pending=true"
expect "HITL opt-in + 보고서 없음 + pending=true → 차단" block stage6-commit-verify.sh

# HITL opt-in: 보고서 있으나 미승인 → 차단
echo "# 변경 보고서" > "$REPORT"
mk "$TESTS | .policy={category:\"major\",auto_approve:{\"3_delivery.commit\":false}} | .stages.\"3_delivery\".substages.\"commit\".approved_by_user=false"
expect "HITL opt-in + 보고서O + 미승인 → 차단" block stage6-commit-verify.sh

# HITL opt-in: 보고서 있고 승인 + pending=false → 통과
mk "$TESTS | .policy={category:\"major\",auto_approve:{\"3_delivery.commit\":false}} | .stages.\"3_delivery\".substages.\"commit\".approved_by_user=true | .stages.\"3_delivery\".substages.\"commit\".verification_pending=false"
expect "HITL opt-in + 보고서O + 승인 → 통과" pass stage6-commit-verify.sh

# HITL opt-in: 승인했으나 verification_pending=true → 차단
mk "$TESTS | .policy={category:\"major\",auto_approve:{\"3_delivery.commit\":false}} | .stages.\"3_delivery\".substages.\"commit\".approved_by_user=true | .stages.\"3_delivery\".substages.\"commit\".verification_pending=true"
expect "HITL opt-in + pending 잔류 → 차단" block stage6-commit-verify.sh

# legacy(no policy) → 휴먼 게이트 없이 통과 (backward-compat)
rm -f "$REPORT"
mk "$TESTS"
expect "구형 state → 휴먼 게이트 없이 통과" pass stage6-commit-verify.sh

echo ""
echo "── stage8-review-verify (7→8) ──"
BV='.stages."1_planning".substages."jira".done=true | .stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."scope".done=true | .stages."2_implementation".substages."dev".done=true | .stages."2_implementation".substages."test".unit="pass" | .stages."3_delivery".substages."commit".done=true | .stages."3_delivery".substages."pr".draft_url="http://pr/1" | .stages."3_delivery".substages."pr".body_validation={no_orphan_scenarios:true,template_match:true,section_content_match:true} | .stages."3_delivery".substages."pr".reviewer_added=true | .stages."3_delivery".substages."review".comments=1 | .stages."3_delivery".substages."review".all_comments_inline=true'
mk "$BV | .policy={category:\"minor\",auto_approve:{\"3_delivery.pr\":true}}"
expect "minor auto-approve → 통과" pass stage8-review-verify.sh
mk "$BV | .stages.\"3_delivery\".substages.\"pr\".approved_by_user=false"
expect "구형 state 미승인 → 차단" block stage8-review-verify.sh
mk "$BV | .stages.\"3_delivery\".substages.\"pr\".approved_by_user=true | .stages.\"3_delivery\".substages.\"pr\".verification_pending=false"
expect "구형 state 승인 → 통과" pass stage8-review-verify.sh
mk '.stages."1_planning".substages."jira".done=true | .stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."scope".done=true | .stages."2_implementation".substages."dev".done=true | .stages."2_implementation".substages."test".unit="pass" | .stages."3_delivery".substages."commit".done=true | .stages."3_delivery".substages."pr".draft_url="http://pr/1" | .stages."3_delivery".substages."pr".body_validation={no_orphan_scenarios:false,template_match:true,section_content_match:true} | .stages."3_delivery".substages."pr".reviewer_added=true | .stages."3_delivery".substages."review".comments=1 | .stages."3_delivery".substages."review".all_comments_inline=true | .policy={category:"minor",auto_approve:{"3_delivery.pr":true}}'
expect "body_validation false → 차단 (auto와 무관)" block stage8-review-verify.sh

BSS='.stages."1_planning".substages."jira".done=true | .stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."scope".done=true | .stages."2_implementation".substages."dev".done=true | .stages."2_implementation".substages."test".unit="pass" | .stages."3_delivery".substages."commit".done=true | .stages."3_delivery".substages."pr".draft_url="http://pr/1" | .stages."3_delivery".substages."pr".body_validation={no_orphan_scenarios:true,template_match:true,section_content_match:true} | .stages."3_delivery".substages."pr".reviewer_self_skipped=true | .stages."3_delivery".substages."review".comments=1 | .stages."3_delivery".substages."review".all_comments_inline=true'
mk "$BSS | .policy={category:\"minor\",auto_approve:{\"3_delivery.pr\":true}}"
expect "reviewer_self_skipped=true → reviewer 없어도 통과" pass stage8-review-verify.sh
mk '.stages."1_planning".substages."jira".done=true | .stages."1_planning".substages."requirements".done=true | .stages."1_planning".substages."scope".done=true | .stages."2_implementation".substages."dev".done=true | .stages."2_implementation".substages."test".unit="pass" | .stages."3_delivery".substages."commit".done=true | .stages."3_delivery".substages."pr".draft_url="http://pr/1" | .stages."3_delivery".substages."pr".body_validation={no_orphan_scenarios:true,template_match:true,section_content_match:true} | .stages."3_delivery".substages."review".comments=1 | .stages."3_delivery".substages."review".all_comments_inline=true | .policy={category:"minor",auto_approve:{"3_delivery.pr":true}}'
expect "reviewer_added·reviewer_self_skipped 모두 없음 → 차단" block stage8-review-verify.sh

echo ""
echo "[gate-policy-test] $pass passed, $fail failed"
echo ""
[ "$fail" -eq 0 ]
