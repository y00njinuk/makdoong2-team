# 2단계: 요구사항 구체화 (다출처 교차 조사) — `1_planning.requirements` substage

**목적**: 구현 대상을 명확·구체적으로 확정한다. **워크플로우 전체에서 가장 많은 시간을 투입하는 단계.** 요구사항이 흐릿한 채 3단계로 넘어가면 이후 전 단계에서 되돌이표가 난다.
**진입 게이트**: `verify.sh <이슈키> 1_planning.requirements` (`1_planning.jira` 완료 필요).

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

## 2-0. 복잡도 분류 (필수 — 조사 전 먼저 수행)

1단계 이슈 요약과 Jira description을 읽고 작업 의도를 분류한다.

| 유형 | 판단 기준 | 조사 범위 | 인터뷰 전략 |
|---|---|---|---|
| **Simple** | 단순 수정, 명확한 단일 변경, ≤1일 작업 | Jira + 코드만 | 1-2개 핵심 질문 |
| **Standard** | 일반 Task/Improvement, 명확한 기능 단위 | 전체 조사 A/B/C | 전체 체크리스트 |
| **Complex** | 시스템 전반 영향, 아키텍처 변경, 성능 임계점 | A/B/C + D 필수 | 심층 인터뷰, 조사 근거 제시 |
| **Ambiguous** | description이 추상적 ("개선"·"정리"·"최적화"만 있음) | Jira + Confluence 우선 | 의도 확정 후 조사 |

분류 결과를 state.json에 기록:
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".intent_type' '"Standard"'
```

**Simple 이슈**: 2-1 전체 병렬 조사 생략 가능 — 핵심 출처(Jira + 코드)만 조회 후 2-2 체크리스트로 직행.

### 2-0a. 결정론적 복잡도 점수 (분류 보조 — 가중합)

표의 정성 판단만으로 유형이 애매하면 아래 가중합 점수로 결정한다. 각 요소를 0.0~1.0으로 정규화한 뒤 합산한다 (ouroboros PAL Router 방식).

| 요소 | 가중치 | 정규화 | 임계 기준 |
|---|---|---|---|
| 영향 모듈·파일 수 (추정) | 30% | `min(개수 / 5, 1.0)` | 5개 |
| 외부 통합 지점 수 (API/DB/타 시스템/프로토콜) | 30% | `min(개수 / 5, 1.0)` | 5개 |
| 요구 분해 깊이 (요구사항 → 하위 작업 계층 수) | 40% | `min(깊이 / 5, 1.0)` | 5단계 |

```
complexity = 0.30 * norm_modules + 0.30 * norm_integrations + 0.40 * norm_depth
```

| 점수 | 유형 |
|---|---|
| < 0.4 | Simple |
| 0.4 ~ < 0.7 | Standard |
| ≥ 0.7 | Complex |

- **Ambiguous 는 점수와 무관하게 우선한다**: description이 추상적이면 점수 산정 자체가 불가하므로 Ambiguous로 분류하고, 의도 확정(인터뷰) 후 재산정한다.
- 점수를 state.json에 기록 (감사·범주화 근거):
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".complexity_score' '0.46'
```

## 2-0b. 요구사항 초안 파일 생성 (첫 응답에서 즉시)

복잡도 분류 직후, 조사 시작 전에 초안 파일을 생성한다:

```bash
# 상대경로 (repo/worktree root 기준) — cwd 독립적 접근 보장.
# planner 는 main repo cwd 에서 실행되고 이후 dev 진입 시 wt-sync-ignored.sh 가
# worktree 로 동일 상대경로에 복사한다.
mkdir -p .makdoong2-team/<ISSUE_KEY>
```

파일 경로 (repo/worktree root 기준 상대경로): `.makdoong2-team/<ISSUE_KEY>/requirements-draft.md`

**초안 파일은 반드시 `write` 툴(filePath 인자)로 생성·갱신한다.** bash 리디렉션(`cat > …`, `printf > …` 등)과 `apply_patch` 는 같은 경로라도 훅이 차단한다 — planner 의 유일한 파일 쓰기 수단은 `write` 다. 이 경로의 `write` 는 planner READ-ONLY 원칙의 명시적 예외이며 훅이 허용한다 (issue #8).

초안 초기 구조:
```markdown
# 요구사항 초안 — <ISSUE_KEY>
> 작성 중. 인터뷰 진행에 따라 업데이트됨.

## 복잡도 분류
- 유형: <Simple|Standard|Complex|Ambiguous>

## 수집된 정보
(조사 결과 및 인터뷰 답변이 누적됨)

## 미결 사항
(아직 확인되지 않은 항목)
```

**매 교환 후 초안을 업데이트한다.** 사용자에게 파일 경로를 고지:
> "요구사항 초안을 `.makdoong2-team/<ISSUE_KEY>/requirements-draft.md`(현재 cwd 기준)에 기록 중입니다."

state.json에 초안 경로 기록 — **반드시 상대경로만 저장한다** (절대경로 저장 시 다른 cwd 에서 Read 시 hang 유발):
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."1_planning".substages."requirements".draft_path' '".makdoong2-team/<이슈키>/requirements-draft.md"'
```

## 2-1. 다출처 교차 조사

Jira 본문만 보고 판단하지 않는다. 세 출처를 **모두 교차 검증**한다.

**`dispatch_research` 툴 1회 호출로 소스별 조사를 병렬 실행한다.** 스스로 `skill_mcp` 를 순차 호출하지 않는다 — 플러그인이 소스마다 별도 세션을 동시에 띄우므로 (a) 대기 시간이 가장 느린 소스 하나로 수렴하고, (b) 각 소스의 원자료가 당신의 컨텍스트를 잠식하지 않는다. **outer-world 에이전트 위임(Sisyphus/Explore/Librarian, `task(subagent_type=...)`) 금지** — planner 에는 `Task` 툴이 없어 물리적으로도 불가하다.

```
dispatch_research(
  issue = "<이슈키>",
  worktree = "<Working directory 절대경로>",
  context = "<Jira 요약 3~5줄 — 모든 조사 세션에 공통 주입>",
  queries = [
    {source: "jira",       focus: "에픽/상위 이슈, 링크 이슈(blocks/relates/causes), 같은 컴포넌트·라벨의 최근 해결 이슈, 코멘트에서 명확해진 요구"},
    {source: "confluence", focus: "<시스템·모듈명> 설계 문서, 아키텍처/API 스펙/운영 가이드/회의록, ADR·기술선택 기록"},
    {source: "bitbucket",  focus: "<수정 대상 추정 파일/클래스>의 현재 구현, 유사 기능의 과거 구현, 관련 영역 최근 PR 의 변경 패턴·테스트 방식·리뷰 지적"}
  ]
)
```

- **조사 A — Jira 맥락 심화** (`source: "jira"`)
- **조사 B — 설계 문서** (`source: "confluence"`). 키워드는 description 명사구·시스템명·프로토콜 번호.
- **조사 C — 기존 코드·PR 이력** (`source: "bitbucket"`)
- **(필요 시) 조사 D — 오픈소스** (`source: "github-oss"`): 외부 라이브러리 공식 예제·이슈 트래커, 버전 호환성·알려진 버그.

`focus` 는 구체적일수록 좋다. 조사 세션은 서로를 보지 못하므로 **한 focus 가 다른 조사 결과에 의존하면 안 된다.** 의존이 필요하면 라운드를 나눠 두 번 호출한다.

조사 A/B/C 는 이슈 유형과 무관하게 모두 시도한다 (Simple 유형만 A/C 로 축소 가능).

### 결과 읽기

반환 JSON 의 `artifact_path` (기본 `.makdoong2-team/<이슈키>/research-findings.json`) 를 Read 로 읽어 종합한다.

- **부분 성공이 정상이다.** `failed` 배열에 실패 소스와 사유가 담긴다. 남은 소스의 결과는 그대로 유효하므로 실패 1건으로 조사를 통째로 다시 돌리지 않는다.
- 실패한 소스가 **요구사항 확정에 필수**라면 그 사유(인증 실패·권한 부족 등)를 사용자에게 보고한다. 없어도 되는 소스면 `gaps` 로만 남기고 진행한다.
- `deferred` 가 비어 있지 않으면 병렬 상한에 걸려 빠진 조사가 있다는 뜻이다. 필요하면 2차 호출한다.
- 모든 소스가 실패하면(`ok: false`) 체크리스트를 추측으로 채우지 말고 사용자에게 보고한다.
- **`status: "partial"` 은 그 자체로 정상 종료다.** 실패한 소스를 당신이 직접 조사해 메우려 하지 말 것 — `skill_mcp` 순차 호출로 결손을 메우려다 세션 예산을 전부 소진하고 **마커를 하나도 남기지 못한 채** 종료한 사고가 이틀 연속 재현됐다 (GitHub issue #9, 각 27분·17분 소모). 결손을 더 좁히고 싶으면 focus 를 좁혀 `dispatch_research` 를 **1회만** 다시 호출한다.
- **조사 완결성을 이유로 마커 기록을 미루지 않는다 (hardrule).** 조사가 부분적이면 `gaps` 에 미확인 항목을 남기고 그 상태 그대로 산출물과 substage 마커를 기록한 뒤 종료한다. 마커가 없는 종료는 상위에서 `completion: "incomplete"` 로 분류되어 substage 전체가 재실행된다 — 부분 결과까지 함께 버려진다.

## 2-2. 요구사항 체크리스트

조사 종합 후 아래를 하나씩 채운다. **비어 있는 항목이 있으면 3단계로 넘어가지 않는다.**

```
[ ] 기능적 요구사항 — 입력(형식/범위/제약), 출력(형식/에러 케이스), 정상 경로 1개+, 경계 케이스(빈 입력/최댓값/동시 요청)
[ ] 비기능적 요구사항 — 성능 목표, 동시성·재시도, 보안·권한, 로깅·모니터링
[ ] 호환성·마이그레이션 — 기존 API/프로토콜 호환, 데이터 마이그레이션 필요 여부, 롤백 가능성
[ ] 검증 기준(Acceptance Criteria) — "완료" 선언 가능한 객관적 조건 목록
[ ] 범위 경계 — 본 이슈에서 다루지 않는 것(스코프 아웃)
```

### AC 작성 원칙 — MECE 분해

검증 기준(AC)은 **MECE**(Mutually Exclusive, Collectively Exhaustive)로 작성한다:

- **상호 배제**: 각 AC는 서로 겹치지 않는다. 두 AC가 같은 행위를 다른 표현으로 반복하면 하나로 합친다.
- **전체 포괄**: AC 전체 합집합이 기능/비기능/호환성 요구 전부를 커버한다. 커버되지 않는 요구가 있으면 AC를 추가한다.
- **독립 검증 가능**: 각 AC는 다른 AC 결과와 무관하게 단독으로 pass/fail 판정할 수 있어야 한다.
- **객관적 판정**: "잘 동작한다" 같은 주관 표현 금지. 입력→기대 출력, 측정 가능한 임계값으로 서술한다.
- 큰 AC는 최대 2단계까지 하위 AC로 분해할 수 있다. 분해 시에도 leaf 단위가 위 조건을 만족해야 한다.

## 2-3. 인터뷰 모드 (Prometheus 패턴)

### 2-3-1. 인터뷰 필요 여부 판정

다음 중 하나라도 해당하면 `interview_required=true`로 기록하고 인터뷰를 수행한다:

| 트리거 | 예시 |
|---|---|
| 조사 A/B/C 간 정보 충돌 | Jira는 "비동기 처리", 코드는 동기 패턴 |
| description이 추상적 | "개선"·"정리"·"최적화"·"고도화"만 있음 |
| 경계 케이스 처리 방침 미언급 | 빈 입력, 최댓값, 동시 요청 처리 불명확 |
| 비기능 요구(성능/동시성/보안) 미언급 | 구현 선택에 영향을 미치는 비기능 조건 |
| 스코프 경계 불명확 | 어디까지 수정하는지 세 출처에 없음 |
| Complex/Ambiguous 유형 이슈 | 2-0 분류 결과 |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_required' 'true'
```

### 2-3-2. 인터뷰 수행 원칙

**조사 근거 먼저, 질문 나중 (Evidence-First)**:
```
"[조사 B - Confluence] 설계 문서에서 X 방식을 사용한다고 나와 있습니다.
그런데 [조사 C - 코드]에서는 Y 패턴이 적용되어 있습니다.
이번 이슈에서 어느 쪽을 따를까요?
  A) X 방식으로 통일
  B) Y 패턴 유지 (기존 코드와 일관성)
  C) 새로운 방식 — 구체적으로 알려주세요"
```

**진행 규칙**:
- 한 번에 하나씩 질문. 여러 질문을 몰아서 하지 않는다.
- 객관식 A/B/C(/D) 형태 필수. 조사 근거를 반드시 함께 제시한다.
- 사용자 답이 "알아서 해" 유형이면 임의 결정 금지 — 구체적 대안을 재질문한다.
- 스코프 아웃 항목은 **항상 명시적으로 확인**한다 ("이번 이슈에서 X는 다루지 않는 것이 맞나요?").

**스코프 인플레이션 안티패턴 — 절대 금지**:
- "인접 모듈 테스트도 추가" → 해당 모듈이 이슈 범위인지 먼저 확인
- "유사 코드도 함께 개선" → 명시적 사용자 승인 없이 범위 확장 금지
- "관련 문서도 업데이트" → 요청에 없으면 스코프 아웃으로 명시

### 2-3-2b. Ambiguity Score — 수렴 게이트 (매 교환 후 산정)

인터뷰 종료를 감각이 아닌 **정량 점수**로 판정한다 (ouroboros Big Bang 게이트 방식). 매 교환(질문→답변) 직후 아래 결정론 공식으로 산정하고 초안 파일·state.json에 동기화한다.

```
ambiguity = 0.40 * (빈 체크리스트 항목 수 / 5)                # 2-2의 5항목 기준
          + 0.30 * min(미해결 출처 충돌 수 / 3, 1.0)          # 조사 A/B/C 간 충돌
          + 0.30 * min(초안 "미결 사항" 항목 수 / 5, 1.0)
```

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".ambiguity_score' '0.13'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_rounds' '3'
```

**수렴 게이트 규칙**:
- **종료 조건**: `ambiguity_score ≤ 0.2` 일 때만 `interview_completed=true` 기록 가능. 0.2 초과 상태로 완료 기록 금지 (stage3 진입 게이트가 차단).
- **라운드 상한**: 최대 **7 라운드**. 상한 도달 시 추가 질문을 중단하고, 남은 미결 항목 전체를 한 번에 정리해 사용자에게 최종 결정을 요청한다. 그래도 해소되지 않으면 `done` 기록 없이 부장님에게 에스컬레이션한다 (임의 결정 금지).
- 인터뷰가 불필요한 경우(`interview_required=false`)에도 조사 종합 후 점수를 1회 산정·기록해 0.2 이하임을 확인한다 — 0.2 초과인데 인터뷰를 생략하는 것은 모순이므로 `interview_required=true`로 전환한다.

### 2-3-3. 인터뷰 완료 기록

모든 미결 항목이 해소되고 **ambiguity_score ≤ 0.2 확인 후**:
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_completed' 'true'
```

인터뷰가 불필요했던 경우에도 완료 마커를 기록한다 (게이트가 확인):
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_required' 'false'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".interview_completed' 'true'
```

## 2-4. 출력

**요구사항 명세서**를 번호 매긴 리스트로 작성한다. 2-2 전 항목이 포함돼야 한다. (이 명세의 승인 경로는 2-4b 범주화 결과의 auto-approve 정책이 결정한다 — 사용자 확인 또는 무인 자동 진행.)

## 2-4a. 명세 동결 (Crystallization — Seed 불변 원칙)

확정된 요구사항 명세는 이 워크플로우의 **Seed** 다 — 이후 모든 단계(scope/dev/test/delivery)의 판단 기준이며, `done=true` 이후 **불변**이다 (ouroboros Immutable Seed 원칙).

1. 확정 명세를 초안 파일 말미에 `## 확정 명세 (Crystallized)` 섹션으로 추가한다. 이 시점부터 초안 파일 수정 금지.
2. 파일 해시를 state.json에 기록한다:
```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".spec_hash' \
  "\"$(sha256sum .makdoong2-team/<이슈키>/requirements-draft.md | cut -d' ' -f1)\""
```
3. **동결 후 변경 절차**: `done` 이후 요구사항 변경이 필요해지면 파일을 몰래 수정하지 않는다. 부장님에게 에스컬레이션 → 사용자 재승인 → requirements substage 재작업(명세 갱신 + `spec_hash` 재기록) 순서만 허용된다. `stage3-scope-verify.sh` 진입 게이트가 해시를 재계산해 무단 변경(spec drift)을 차단한다.

## 2-4b. 작업 범주화 (minor / major) — auto-approve 정책 결정

요구사항 명세(2-4)가 확정된 **직후**, 이 작업의 **범위와 난이도를 범주화**해 이후 모든 단계의 사람 개입 여부(auto-approve)를 결정한다. 결과를 state.json 최상위 `.policy`에 기록한다. (요구사항 1·2 — 범주화는 모든 이슈에 대해 필수.)

### 분류 차원

| 차원 | 값 | 판단 근거 |
|---|---|---|
| `change_type` | `feature` / `bugfix` / `refactor` / `other` | 기능 변경·버그 수정·리팩토링 중 무엇인가 |
| `scope_size`  | `small` / `large` | 수정 파일 수·작업 단위·영향 모듈. 단일~소수 파일·국소 변경 = small |
| `criticality` | `normal` / `critical` | 인증·결제·보안·데이터 무결성·마이그레이션·대외 API 등 실패 시 파급이 큰 영역 = critical |

> `scope_size`는 2단계 시점엔 추정치다 — 3단계(범위 확정)에서 실제 변경 단위가 드러나면 minor→major로 **상향 조정(escalation)** 될 수 있다(하향은 금지). `03-scope.md` 참조.

### 범주 도출 규칙 (결정론)

```
base     = (intent_type ∈ {Simple, Standard}) ? "minor" : "major"      # 2-0 복잡도 분류 재사용
category = (criticality == "critical" OR scope_size == "large") ? "major" : base
```

- **minor**: feature/bugfix/refactor이고 범위가 작으며 critical 영역이 아님 → **전 단계 무인 자동 진행** (요구사항 3).
- **major**: critical 영역이거나 범위가 큼 → 위험도 분류만 상향하고 진행 흐름은 minor 와 동일하게 **테스트·커밋까지 무인 진행**한다. 사람 승인이 필요한 경우 사용자가 명시적으로 opt-in 하도록 `.policy.auto_approve."3_delivery.commit"` 를 `false` 로 재설정할 수 있다(추후 이슈 유형별 opt-in 훅 확장 예정 — 6단계 §6-0 참조).

### auto-approve 맵 (기본값 — 두 범주 공통 무인)

| category | 2_requirements | 3_scope | 6_commit | 7_pr |
|---|---|---|---|---|
| **minor** | true | true | **true** | true |
| **major** | true | true | **true** | true |

→ 두 범주 모두 기본값은 전 단계 `true` 로, 자동 진행한다. `.policy.category` 는 후속 감사·통계·이슈 유형별 훅 확장을 위한 위험도 라벨로만 유지된다. HITL 이 필요한 특수 상황에서는 planner 가 명시적으로 특정 substage 를 `false` 로 재설정하거나, 승인 마커(`approved_by_user`)를 요구하는 경로로 opt-in 한다.

### 기록 (필수 — done 직전)

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy' '{"intent_type":"Standard","change_type":"bugfix","scope_size":"small","criticality":"normal","category":"minor","auto_approve":{"1_planning.requirements":true,"1_planning.scope":true,"3_delivery.commit":true,"3_delivery.pr":true},"rationale":"<한 줄 근거 — 왜 이 범주인지>","categorized_by":"1_planning.requirements"}'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.categorized_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
```

major 로 판정되어도 `auto_approve` 맵은 **모두 true** 로 두고 `"category":"major"` 만 다르게 기록한다. HITL 을 명시적으로 요구해야 하는 예외 상황(예: 향후 확장될 이슈 유형별 opt-in 정책)에서만 특정 substage 를 `false` 로 재설정한다. (범주화 누락 시 게이트는 안전하게 사용자 승인 필요 경로로 폴백한다.)

## 2-5. 최종 자가 검증 (Pre-Completion Checklist)

`done=true` 직전, 다음 9항목을 자체 확인하고 state.json에 결과를 기록한다.
하나라도 false면 완료 기록 금지.

| 항목 | 확인 |
|---|---|
| 1 | 2-2 체크리스트 5항목(기능/비기능/호환성/AC/스코프) 모두 빈칸 없이 채워졌다 |
| 2 | 조사 A/B/C 간 충돌 항목은 인터뷰로 해소되었다 (또는 충돌 없음 확인) |
| 3 | 요구사항 명세서를 최종본으로 확정했다 (사용자 확인 또는 `.policy` auto-approve로 승인 경로 결정) |
| 4 | 스코프 인플레이션(인접 모듈/유사 코드/관련 문서 자동 추가)이 없다 |
| 5 | `requirements-draft.md` 파일이 최신 상태로 동기화되었다 |
| 6 | 작업 범주화(2-4b)가 끝나 `.policy.category`(minor\|major)와 `auto_approve` 맵이 기록되었다 |
| 7 | `ambiguity_score`가 산정·기록되었고 최종값 ≤ 0.2 이다 (2-3-2b) |
| 8 | 확정 명세가 동결되어 `spec_hash`가 기록되었다 (2-4a) |
| 9 | `draft_path` 마커가 state.json에 기록되었다 (2-0). **`spec_hash`와 한 쌍이다** — `stage3-scope-verify.sh`가 `spec_hash`만 있고 `draft_path`가 없으면 `1_planning.scope` 진입을 하드 차단한다 |

**9번은 자기선언이 아니라 실제 값을 읽어 확인한다** — `draft_synced`(파일 동기화)가 true 여도 마커는 빠질 수 있다. 실제로 `spec_hash`만 기록되고 `draft_path`가 누락된 채 8항목 전부 true 로 종료되어, 다음 게이트에서 워크플로우가 정지한 사례가 있다 (issue #6-①).

```bash
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."requirements".draft_path'
# → "null" 이면 2-0 의 set 명령으로 먼저 기록한 뒤 self_check 을 기록한다.
```

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".self_check' \
  '{"checklist_complete": true, "conflicts_resolved": true, "user_confirmed": true, "scope_clean": true, "draft_synced": true, "categorized": true, "ambiguity_converged": true, "spec_frozen": true, "draft_recorded": true}'
```

## 완료 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".done' 'true'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".done_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
```

**승인 경로** — 2-4b의 `.policy.auto_approve."1_planning.requirements"`를 따른다:

- **auto_approve == true** (정상 — minor/major 공통): 사람 대기 없이 자동 진행. `verification_pending`을 즉시 `false`로 둔다. 게이트(`stage3-scope-verify.sh`)가 정책을 보고 사용자 승인 없이 통과시킨다.
  ```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".verification_pending' 'false'
```

- **auto_approve 미설정**(구형 state — 범주화 폴백): 기존대로 사용자 승인 대기.
  ```bash
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".verification_pending' 'true'
  # 사용자 명시 승인 직후에만:
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".approved_by_user' 'true'
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".approved_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."requirements".verification_pending' 'false'
```

