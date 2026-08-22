# 6단계: Atomic Commit (Publisher 직접 실행)

**목적**: 변경을 논리적 단위로 쪼개 커밋한다. **1 파일 = 1 commit** 원칙을 절대적으로 준수한다.
**진입 게이트**: `verify.sh <이슈키> 3_delivery.commit` (단위·통합 테스트가 둘 다 **pass 또는 skip**이어야 함. 하나라도 **fail**이면 4단계로 복귀). major 이슈는 변경 보고서를 자동 생성하고 승인 없이 진행하며, HITL opt-in(`.policy.auto_approve."3_delivery.commit" == false`)인 경우에만 사람 승인이 추가로 요구된다 (§6-0).
> **PUBLISHER 전용 단계.** publisher 가 worktree 에서 **직접 `git add` / `git commit`** 을 실행한다. 부장님(team-leader) 은 git 명령 permission 이 deny 되어 있으므로 실행할 수 없다. publisher 는 permission 으로 `git commit*` / `git add*` 가 allow 되어 있으며, 훅이 발동해 state.json 자동 기록도 정상 수행된다.

## 6-0. 변경 보고서 생성 (major 이슈) + 사람 승인 (HITL opt-in 전용)

진입 조건에 따라 동작이 다르다. 두 조건 모두 해당 없으면(minor + auto_approve=true) 본 절을 건너뛰고 6-1로 직행한다.

- **major 이슈** (`.policy.category == "major"`): 변경 보고서를 아티팩트로 자동 생성. 사용자 승인 게이트 없이 §6-1로 자동 진행한다.
- **HITL opt-in** (`.policy.auto_approve."3_delivery.commit" == false`): 보고서 생성 후 사용자 명시적 승인이 추가로 필요하다.

> **역할 분담**: 보고서 작성은 **publisher(1차 dispatch)**가 수행하고, 사용자에게 제시·승인 수령·마커 기록은 **부장님(PRIMARY)**이 수행한다. 부장님은 Write 툴이 없으므로 보고서를 직접 작성하지 않는다.
>
> 흐름: `auto_advance_stage` → `needs_report:true` → 부장님이 `dispatch_stage(3_delivery.commit)` 호출 → publisher §1-0이 보고서 작성 + `verification_pending=true` 마킹 → 부장님이 보고서 제시 → 사용자 승인 → 부장님이 `approved_by_user=true` + `verification_pending=false` 마킹 → `auto_advance_stage` 재호출 → 게이트 통과 → `dispatch_stage` 재호출(2차) → publisher 가 §6-1 부터 직접 실행

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

### 6-0-1. 변경 보고서 작성 (publisher §1-0이 수행)

`git diff`(working tree, 아직 미커밋)와 5단계 테스트 결과로 보고서를 작성해 **다음 표준 경로**에 저장한다 (게이트가 이 경로의 파일 존재를 검사한다):

```
<worktree>/.makdoong2-team/<이슈키>/change-report.md      # 물리 파일 생성 위치 (publisher 는 worktree cwd 실행)
.makdoong2-team/<이슈키>/change-report.md                  # state.json 에 기록할 상대경로
```

보고서 필수 섹션 (한글):

```markdown
# 변경 보고서 — <이슈키> (HITL opt-in)

## 요구사항 요약
- <2단계 요구사항 명세 핵심 — 무엇을, 왜>

## 변경 내용
- <기능 단위별 변경 요지>          # 파일 나열이 아니라 기능 단위로
- 변경 파일 통계: `git diff --stat` 요약

## 테스트 결과
- 단위: <pass|skip> / 통합: <pass|skip> / 커버리지: <pct>% (<pass|exempt>)

## 위험 · 영향 범위
- criticality 근거(critical 사유) / 영향 모듈·하위 시스템
- 롤백 가능성 · 데이터 마이그레이션 여부

## 커밋 계획
- 1. <atomic 커밋 단위1>  2. <단위2> ...   # 6-3에서 그대로 실행
```

작성 후 경로와 검증-대기 마커를 기록한다 — **반드시 상대경로만 저장한다** (절대경로 저장 시 다른 cwd 에서 Read hang 유발):

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."3_delivery".substages."commit".report_path' '".makdoong2-team/<이슈키>/change-report.md"'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".verification_pending' 'true'
```

### 6-0-2. 사람에게 보고 + 승인 수령 (HITL opt-in 전용, 부장님이 수행)

> **major 이슈는 이 섹션 건너뜀**: publisher §1-0이 보고서를 아티팩트로 생성한 뒤 사용자 승인 없이 §6-1로 자동 진행한다. 아래 절차는 `auto_approve."3_delivery.commit" == false` 인 HITL opt-in 케이스에만 적용.

publisher §1-0의 결과로 받은 `change_report_path`를 읽어 보고서 전문(또는 핵심 요약 + 파일 경로)을 사용자에게 제시하고 **명시적 커밋 승인**을 받는다.

- 승인("이대로 커밋하세요" 등) → 6-1로 진행하며 아래 마커 기록.
- 보류·수정 요청 → 해당 단계(요구사항/범위/구현)로 복귀. **커밋하지 않는다.**

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".approved_by_user' 'true'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".approved_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".verification_pending' 'false'
```

> HITL opt-in에서 보고서 미작성 또는 미승인 상태로 커밋을 시도하면 `verify.sh 6_commit`(stage6-commit-verify.sh)이 차단한다. `change-report.md` 존재 **+** `approved_by_user == true` **+** `verification_pending != true` 셋을 모두 만족해야 통과한다.

## 6-1. base_sha 기록 (첫 커밋 전 필수 — publisher 가 실행)

publisher 가 worktree cd 로 진입한 뒤 **첫 커밋 전** base_sha 를 반드시 기록한다. 이후 atomicity 검증과 rollback 의 기준점이 된다.

```bash
cd <worktree 절대경로>
BASE_SHA=$(git rev-parse HEAD)
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".base_sha' "\"$BASE_SHA\""
```

## 6-2. 커밋 계획 수립 (1 파일 = 1 commit 원칙)

**절대 규칙**: 한 commit 에는 **정확히 1개 파일**만 포함한다. 예외 없음.

- 여러 파일이 논리적으로 하나의 변경이라도 각 파일마다 개별 커밋을 만든다.
- 커밋 순서는 의존성 (base → dependent) 을 고려해 정한다. 예: 새 함수 정의 → 그 함수 사용처.
- 결합어(`and`, `&`, `+`, `및`, `그리고`) 를 제목에 사용하면 post-commit 게이트가 REJECT.

```bash
CHANGED_FILES=$(git diff --name-only)
STAGED_FILES=$(git diff --cached --name-only)
ALL_FILES=$(printf '%s\n%s\n' "$CHANGED_FILES" "$STAGED_FILES" | sort -u | grep -v '^$')
echo "$ALL_FILES" | wc -l   # 총 파일 수 = 만들어야 할 commit 수
```

## 6-3. 커밋 메시지 규약 (`references/commit-convention.md` 전문 참조)

**언어**: 한글, 제목 명령조도 한글.
**포맷**:
```
<Type>: <이슈키> - <명령조 요약>

[본문: 왜·무엇 (선택)]

[RV] <이슈키>
[AI] 100%
```

- **Type** (허용값): `Feat`, `Fix`, `Chore`, `Refactor`, `Docs`, `Style`, `Test`, `Perf`, `Ci`, `Build`, `Revert`
- **제목**: 대문자로 시작, 50자 이내 (한글 25자 내외), 마침표 금지, 명령조 (한글도 "추가" 형태 유지), 결합어(`and`/`&`/`+`/`및`/`그리고`) 금지
- **빈 줄**: 제목과 본문 사이 반드시 빈 줄 1개
- **본문** (선택): "어떻게" 보다 "무엇을·왜" 중심. 한글 줄폭 ~40자
- **이슈 참조 마커**: `[RV] <이슈키>` — 이슈 번호 연결. 본문이 있을 때 필수
- **AI 기여도 마커**: `[AI] 100%` — AI 작성 비율 표기

**예시**:
```
Feat: PROJ-123 - 상품 캐시 조회 메서드 추가

기존에는 요청마다 DB 를 조회해 지연이 컸다.
캐시 계층을 도입해 응답 시간을 단축한다.

[RV] PROJ-123
[AI] 100%
```

## 6-4. 커밋 실행 (publisher 가 파일별 1개씩)

- **git command line 만** 사용 (GUI/IDE 단축키 금지).
- 매 커밋 전 `git diff --cached --name-only` 로 stage 된 파일이 정확히 1개인지 확인.
- **`git add .` / `git add -A` / `git add -u` 금지** — 여러 파일이 한꺼번에 stage 된다.

```bash
cd <worktree>
for FILE in $ALL_FILES; do
    git add -- "$FILE"                                       # 정확히 1개 파일만 stage
    STAGED=$(git diff --cached --name-only | wc -l)
    [ "$STAGED" -eq 1 ] || { echo "❌ stage 파일 수=$STAGED (기대: 1). abort"; exit 1; }
    git commit -m "<Type>: <이슈키> - <요약>" -m "<본문 (선택)>

[RV] <이슈키>
[AI] 100%"
done
```

**untracked 파일 취급**: 3_delivery.commit / 3_delivery.pr 게이트는 worktree 의 untracked 파일을 **자동으로 커밋 대상에서 제외**하고 진행한다. 사용자 확인 프롬프트를 띄우지 않는다. untracked 파일이 커밋에 필요하면 engineer 가 `2_implementation.dev` 단계에서 명시적으로 `git add` 했어야 한다.

## 6-5. Atomicity 자체 검토 및 기록

모든 커밋이 끝났으면 각 커밋을 다시 한 번 검토해 1 파일 = 1 commit 인지 자체 확인한다.

```bash
BASE=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."3_delivery".substages."commit".base_sha' | tr -d '"')
git log --format='%h  %s' $BASE..HEAD          # 이번 단계 커밋 목록
N=$(git rev-list --count $BASE..HEAD)

BAD=0
for SHA in $(git rev-list "$BASE..HEAD"); do
    NF=$(git show --name-only --pretty="" "$SHA" | grep -c .)
    if [ "$NF" -ne 1 ]; then
        SUBJ=$(git log -1 --format='%s' "$SHA")
        echo "❌ commit ${SHA:0:7} '$SUBJ' 파일 수=$NF (기대: 1)"
        BAD=$((BAD+1))
    fi
done
[ "$BAD" -eq 0 ] || { echo "1 파일/commit 위반 $BAD 건. 재커밋 필요"; exit 1; }
```

각 커밋이 단일 변경임을 확인했으면 그 사실을 기록한다 (자체 attestation):

```bash
HEAD_SHA=$(git rev-parse HEAD)
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".head_sha' "\"$HEAD_SHA\""
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".atomic_review' \
    "{\"all_atomic\": true, \"count_commits\": $N, \"one_file_per_commit\": true}"
```

## 6-6. 최종 자가 검증 (Pre-Completion Checklist)

`verify.sh 3_delivery.commit_post` 호출 전 자체 5체크. 하나라도 false 면 게이트 호출 금지 — 미충족 항목을 먼저 해소한다.

| 항목 | 확인 |
|---|---|
| 1 | `base_sha` 가 첫 커밋 전에 정확히 기록되었다 |
| 2 | 각 커밋이 정확히 1개 파일만 포함, 결합어(`and`/`&`/`+`/`및`/`그리고`) 없음 |
| 3 | 커밋 메시지가 `<Type>: <이슈키> - <요약>` + 한글 명령조 + 제목 50자 이내 + 마침표 없음 컨벤션 준수 |
| 4 | 매 커밋 전 `git diff --cached --name-only` 로 stage 파일 수 = 1 확인 |
| 5 | `.env` / secrets / API 키가 커밋 디프에 포함되지 않았다 (`git log -p $BASE..HEAD \| grep -iE '(secret\|password\|api[_-]?key\|token)'` 0건) |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".self_check' \
  '{"base_sha_recorded": true, "atomic_commits": true, "msg_convention": true, "one_file_per_commit": true, "no_secrets_in_diff": true}'
```

## 6-7. 검증 게이트 + 실패 시 rollback

```bash
bash <SCRIPTS_DIR>/../gates/verify.sh <이슈키> 3_delivery.commit_post
```

### 통과 (exit 0)
6_commit 완료를 기록한다.

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."commit".done' 'true'
```

### 차단 (exit 2) — 6단계 commit 작업을 모두 rollback 하고 다시 진행

verify 가 BLOCKED 를 출력하면, 다음 스크립트로 **이번 단계에서 만든 모든 커밋을 취소** 한다.
soft reset 이라 working tree·index 의 변경 내용은 그대로 보존되므로, 동일 변경을
1 파일 = 1 commit 에 맞게 다시 쪼개 재커밋할 수 있다. **rollback 은 publisher 가 직접 수행한다** — 부장님(team-leader) 은 git 명령 permission 이 deny 이므로 rollback 을 대신 하지 않는다.

```bash
bash <SCRIPTS_DIR>/rollback-commits.sh <이슈키>
```

이후 **6-2 부터 다시 진행한다** (base_sha 는 보존되어 동일 기준점으로 재커밋된다).
검증이 통과할 때까지 위 과정을 반복한다.

### REJECTED verdict 재작업 진입 시 (dispatch_stage 재-attempt)

dispatch_verifier 가 REJECTED 를 반환하면 부장님이 dispatch_stage 를 재호출하고, dispatch_stage 는 프롬프트에 `=== 이전 검증 실패 사유 (재작업 시 참고) ===` 블록을 자동 주입한다. 이 블록이 존재한 상태로 3_delivery.commit 재진입한 publisher 는 위 §6-7 rollback 을 **다른 어떤 작업보다 먼저** 실행해야 한다 (자세한 절차는 publisher.md 의 "이전 검증 실패 사유 재주입" §2 참조).
