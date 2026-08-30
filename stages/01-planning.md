# 1–3단계 통합 Planning — `1_planning.{jira,requirements,scope}` 연속 처리

**목적**: Jira 조회 → 요구사항 확정 → 개발 범위 파악을 **단일 세션**에서 완료한다.  
**속도**: 3개 substage dispatch(모델 호출 3회)를 1회로 단축.  
**진입 게이트**: 없음 (첫 단계).

> `<SCRIPTS_DIR>` / `<STAGES_DIR>` 는 부장님이 주입한 절대경로다. 그대로 대입한다.

---

## 0. 재개 감지 (필수 — 첫 번째 행동)

세션 시작 즉시 state.json을 확인해 어디까지 완료됐는지 파악한다.

```bash
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."jira".done'
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."requirements".done'
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."scope".done'
```

- `jira.done=true` → Phase 1 건너뛰고 Phase 2로 직행
- `jira.done=true` + `requirements.done=true` → Phase 3으로 직행
- 셋 다 `true` → 모두 완료. 완료 메시지 출력 후 종료

---

## Phase 1: Jira 조회 및 검증 (`1_planning.jira`)

### 1-1. Jira 이슈 조회

`jira-research` 스킬의 MCP(`works`)를 사용해 조회한다. 수집 항목:
- summary, description, status, 담당자
- 코멘트 전체 이력
- 링크된 이슈와 서브태스크 (2단계 깊이)

이슈 핵심 내용을 3~5줄로 요약해 출력한다. 출처 URL 포함.

### 1-2. 템플릿 검증 (6항목)

| 항목 | 확인 방법 |
|---|---|
| `content_template_match` | 내용이 템플릿 구조를 따르는가 |
| `content_quality_adequate` | 내용이 구현 가능 수준으로 충분한가 |
| `priority_set` | Priority 필드가 설정되어 있는가 |
| `assignee_set` | Assignee가 지정되어 있는가 |
| `reporter_set` | Reporter가 설정되어 있는가 |
| `fix_version_handled` | Fix Version 처리 여부(없음도 의도면 OK) |

실패 항목이 있으면 해당 항목과 이유를 출력한다. Jira 메타데이터 수정 금지(RO 원칙).

### 1-3. Jira 마커 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."jira".template_validation' \
  '{"content_template_match":true,"content_quality_adequate":true,"priority_set":true,"assignee_set":true,"reporter_set":true,"fix_version_handled":true}'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."jira".validation_passed' 'true'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."jira".self_check' \
  '{"validations_recorded":true,"interview_handled":true,"validation_passed_legit":true,"ro_preserved":true,"summary_reported":true}'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."jira".done' 'true'
```

---

## Phase 2: 요구사항 구체화 (`1_planning.requirements`)

### 2-1. 복잡도 분류

Jira 조회 결과로 작업 의도를 분류한다:

| 유형 | 기준 |
|---|---|
| **Simple** | 단순 수정, 명확한 단일 변경, ≤1일 |
| **Standard** | 일반 Task/Improvement, 명확한 기능 단위 |
| **Complex** | 시스템 전반 영향, 아키텍처 변경, 성능 임계점 |
| **Ambiguous** | description이 추상적 ("개선"·"정리"만 있음) |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".intent_type' '"Standard"'
```

### 2-2. 요구사항 초안 파일 생성

```bash
# 상대경로 (repo/worktree root 기준) — cwd 독립적 접근 보장.
# planner 는 main repo cwd 에서 실행되므로 실제 물리 파일은 main repo 하위에 생성되고,
# 이후 dev 진입 시 wt-sync-ignored.sh 가 worktree 로 동일 상대경로에 복사한다.
mkdir -p .makdoong2-team/<이슈키>
```

파일 (repo/worktree root 기준 상대경로): `.makdoong2-team/<이슈키>/requirements-draft.md`

**초안 파일은 반드시 `write` 툴(filePath 인자)로 생성·갱신한다.** bash 리디렉션(`cat > …`, `printf > …` 등)과 `apply_patch` 는 같은 경로라도 훅이 차단한다 — planner 의 유일한 파일 쓰기 수단은 `write` 다. 이 경로의 `write` 는 planner READ-ONLY 원칙의 명시적 예외이며 훅이 허용한다 (issue #8).

초안 구조:
```markdown
# 요구사항 초안 — <이슈키>
## 복잡도 분류: <Simple|Standard|Complex|Ambiguous>
## 수집된 정보
## 수정 파일 후보
## 검증 기준 (Acceptance Criteria)
## 스코프 아웃
```

```bash
# state.json 에는 반드시 상대경로만 저장한다 (절대경로 저장 시 다른 cwd 에서 접근 불가 → Read hang 유발).
# 이 마커는 §2-5b 의 spec_hash 와 **한 쌍**이다 — spec_hash 만 기록되고 이것이 빠지면
# stage3-scope-verify.sh 가 1_planning.scope 진입을 하드 차단한다 (issue #6-①).
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."1_planning".substages."requirements".draft_path' '".makdoong2-team/<이슈키>/requirements-draft.md"'
```

### 2-3. 다출처 교차 조사 (병렬)

**`dispatch_research` 툴 1회 호출로 소스별 조사를 병렬 실행한다.** `skill_mcp` 를 직접 순차 호출하지 않는다 — 플러그인이 소스마다 별도 세션을 동시에 띄우므로 대기 시간이 가장 느린 소스 하나로 수렴하고, 각 소스의 원자료가 이 세션의 컨텍스트를 잠식하지 않는다. **outer-world 에이전트 위임 금지.**

```
dispatch_research(
  issue = "<이슈키>",
  worktree = "<Working directory 절대경로>",
  context = "<Phase 1 에서 요약한 Jira 핵심 3~5줄>",
  queries = [
    {source: "jira",       focus: "에픽/상위 이슈, 링크 이슈, 관련 코멘트에서 구체화된 요구"},
    {source: "confluence", focus: "관련 설계 문서, ADR, API 스펙, 운영 가이드"},
    {source: "bitbucket",  focus: "수정 대상 파일/클래스 현재 구현, 관련 PR 이력, 테스트 패턴"}
  ]
)
```

조사 세션은 서로를 보지 못한다. **한 focus 가 다른 조사 결과에 의존하면 안 된다** — 의존이 필요하면 라운드를 나눠 두 번 호출한다.

Simple 이슈는 조사 A + C만으로 축소 가능. 외부 라이브러리가 쟁점이면 `{source: "github-oss", ...}` 를 추가한다.

**결과 읽기**: 반환 JSON 의 `artifact_path` (`.makdoong2-team/<이슈키>/research-findings.json`) 를 Read 로 읽는다. `failed` 가 있어도 **부분 성공이 정상**이므로 나머지 결과로 진행하고, 실패 소스가 요구사항 확정에 필수인 경우에만 사유를 사용자에게 보고한다. 전 소스 실패(`ok: false`)면 추측으로 채우지 말고 보고한다.

### 2-4. 요구사항 체크리스트 확인

```
[ ] 기능적 요구사항 — 입력/출력 형식, 경계 케이스
[ ] 비기능적 요구사항 — 성능, 동시성, 보안
[ ] 호환성·마이그레이션 — 기존 API 호환, 데이터 마이그레이션
[ ] 검증 기준(Acceptance Criteria) — 완료 선언 가능한 객관적 조건
[ ] 범위 경계 — 이번 이슈에서 다루지 않는 것
```

조사 간 충돌이 있으면 state.json에 기록하고 출력에 명시한다.  
**인터뷰가 필요하다고 판단되면**: 미결 항목을 명시하고 `interview_required=true`를 기록 후 Phase 완료 마커는 설정하지 않고 즉시 출력한다. 부장님이 사용자 인터뷰를 수행한 뒤 재dispatch한다.

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_required' 'true'
# ↑ 인터뷰 필요 시에만 기록. 이후 종료 — 부장님이 인터뷰 후 재dispatch
```

인터뷰가 불필요한 경우:
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_required' 'false'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_completed' 'true'
```

### 2-5. 작업 범주화 (minor / major)

```
base     = (intent_type ∈ {Simple, Standard}) ? "minor" : "major"
category = (criticality == "critical" OR scope_size == "large") ? "major" : base
```

| 차원 | 값 |
|---|---|
| `change_type` | `feature` / `bugfix` / `refactor` / `other` |
| `scope_size` | `small` (단일~소수 파일) / `large` (다수 파일·모듈) |
| `criticality` | `normal` / `critical` (인증·결제·보안·마이그레이션) |

**auto_approve 맵** (minor/major 공통 — 전 단계 무인 진행이 기본):

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy' \
  '{"intent_type":"Standard","change_type":"bugfix","scope_size":"small","criticality":"normal","category":"minor","auto_approve":{"1_planning.requirements":true,"1_planning.scope":true,"3_delivery.commit":true,"3_delivery.pr":true},"rationale":"<한 줄 근거>","categorized_by":"1_planning.requirements"}'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.categorized_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
```

major 로 판정된 경우에도 `auto_approve` 맵은 **모두 true** 로 두고 `"category":"major"` 만 다르게 기록한다. HITL 을 강제해야 하는 이슈 유형별 opt-in 이 필요한 경우에만 특정 substage 를 명시적으로 `false` 로 설정한다.

### 2-5b. 요구사항 품질 마커 (ambiguity_score · spec_hash)

`stage3-scope-verify.sh` 의 요구사항 품질 게이트는 **이 두 마커가 있을 때만** 검사한다
(구형 state 호환을 위한 조건부 검사). 즉 여기서 기록하지 않으면 통합 경로에서는
품질 게이트가 통째로 사문화된다 — `02-requirements.md` 를 거치는 분리 경로에서는
검사되는데 이 경로에서만 안 되는 비대칭이 생긴다. 반드시 기록한다.

```bash
# 1) 모호성 점수. 미해소 항목 수 / 전체 요구 항목 수. 0.2 초과면 게이트가 차단하므로
#    초과 시에는 인터뷰로 해소한 뒤 재산정한다 (stages/02-requirements.md §2-3-2b).
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".ambiguity_score' '0.13'

# 2) 확정 명세 동결. 이후 무단 변경(spec drift)은 게이트가 해시 재계산으로 차단한다.
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".spec_hash' \
  "\"$(sha256sum .makdoong2-team/<이슈키>/requirements-draft.md | cut -d' ' -f1)\""
```

기록 후 **실제 값을 읽어 확인**한다 (자기선언 금지 — issue #6-① 의 직접 원인):

```bash
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."requirements".draft_path'
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."requirements".spec_hash'
```

### 2-6. Requirements 완료 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".self_check' \
  '{"checklist_complete":true,"conflicts_resolved":true,"user_confirmed":true,"scope_clean":true,"draft_synced":true,"categorized":true,"ambiguity_scored":true,"spec_frozen":true,"draft_recorded":true}'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".verification_pending' 'false'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".done' 'true'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".done_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
```

---

## Phase 3: 개발 범위 파악 (`1_planning.scope`)

2단계 조사 결과로 코드 수정 계획을 수립한다. 2단계 `bitbucket-research` 탐색을 이어서 사용한다.

### 3-1. 범위 출력

```
### 개발 범위
**수정 파일**: <path>: <변경 요지>
**추가 파일**: <path>: <목적>
**테스트 범위**: 단위(<대상 클래스/메서드>), 통합(<빌드 플랜명/시나리오>)
**영향 범위**: <모듈>: <영향 요지>
**예상 작업 단위(커밋 후보)**: 1. <단위1> 2. <단위2>
**스코프 아웃**: <이번 이슈에서 다루지 않는 것>
```

### 3-2. 범주 재평가 (escalation — 하향 금지)

실제 수정/추가 파일과 작업 단위가 확정된 뒤, `scope_size`·`criticality`를 재평가한다.

minor → major로 상향될 경우에만 아래 항목들을 갱신한다. `auto_approve` 맵은 건드리지 않고 **모두 true 로 유지**한다 — 상향은 위험도 라벨 정정에 그치며 흐름 자체는 무인 진행으로 유지된다:
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.category' '"major"'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.scope_size' '"large"'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.categorized_by' '"1_planning.scope"'
```

### 3-3. Scope 완료 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".self_check' \
  '{"paths_explicit":true,"test_scope_defined":true,"atomic_units":true,"scope_out_listed":true,"user_approved":true}'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".verification_pending' 'false'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".done' 'true'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".done_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
```

---

## 최종 출력

모든 Phase 완료 후:

```
[Planning 완료]
- 이슈: <요약>
- 범주: <minor|major> (<intent_type>, <change_type>)
- 수정 예정 파일: <목록>
- 커밋 단위: <목록>
- 스코프 아웃: <목록>
```

> **인터뷰 중단 경우**: `interview_required=true`를 기록하고 미결 항목을 출력한 뒤 즉시 종료. requirements.done은 기록하지 않는다. 부장님이 사용자 인터뷰 후 context에 답변을 포함해 재dispatch한다.
