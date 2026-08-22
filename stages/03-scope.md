# 3단계: 개발 범위 파악

**목적**: 어떤 코드를 어떻게 고칠지 범위를 확정한다.
**진입 게이트**: `verify.sh <이슈키> 1_planning.scope` (2단계 완료 + 사용자 승인 필요).

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

2단계 조사 결과로 코드 수정 계획을 수립한다. 2단계에서 `bitbucket-research`로 코드 탐색을 이미 했으므로 본 단계는 **변경 단위 확정**에 집중한다.

## 출력 형식

```
### 개발 범위
**수정 파일**: <path>: <변경 요지> ...
**추가 파일**: <path>: <목적> ...
**테스트 범위**: 단위(대상 클래스/메서드), 통합(빌드 플랜명/시나리오)
**영향 범위**: <모듈/시스템>: <영향 요지> ...
**예상 작업 단위(커밋 후보)**: 1. <단위1> 2. <단위2> ...
**2단계에서 확정한 가정**: <가정1> ...
```

## 범주 재평가 (escalation — 하향 금지)

실제 수정/추가 파일과 작업 단위가 확정된 뒤, 2단계(§2-4b)가 추정으로 기록한 `.policy.scope_size`·`.policy.criticality`를 **재평가**한다. 2단계 추정은 명세 기준 추정치이므로, 본 단계에서 코드 변경 단위가 드러난 직후가 유일한 정정 시점이다.

| 차원 | 재평가 기준 |
|---|---|
| `scope_size` | 확정된 수정/추가 파일 수·작업 단위(커밋 후보)·영향 모듈이 다수에 걸치면 `large` |
| `criticality` | 인증·결제·보안·데이터 무결성·마이그레이션·대외 API 등 실패 시 파급이 큰 영역이 실제 변경에 포함되면 `critical` |

도출 규칙은 2-4b와 동일하다: `criticality == "critical" OR scope_size == "large"`이면 `category`는 **major**.

- 2단계에서 **minor**였으나 위 재평가로 `large` 또는 `critical`이 확정되면 **major로 상향(escalation)** 한다. 상향은 위험도 라벨 정정에 그치며 `auto_approve` 맵은 건드리지 않는다 — 흐름은 여전히 무인 진행이다:
  ```bash
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.category' '"major"'
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.scope_size' '"large"'   # 또는 criticality
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.policy.categorized_by' '"1_planning.scope"'
  ```
  `auto_approve` 는 그대로 두므로 게이트는 무인 통과한다. HITL 이 필요한 특수 상황(예: 이슈 유형별 opt-in 정책)에서만 별도 지시로 `auto_approve."3_delivery.commit"` 를 `false` 로 재설정할 수 있다. 이 경우 커밋 직전 변경 보고서(`change-report.md`) + 사용자 승인이 요구된다(6단계 §6-0).
- **상향만 허용한다. major → minor 하향은 절대 금지.** 이미 major면 그대로 둔다.
- 재평가 결과 변동이 없으면(여전히 minor·동일 범주) `.policy`를 건드리지 않는다.

## 최종 자가 검증 (Pre-Completion Checklist)

`done=true` 직전, 다음 5항목을 자체 확인하고 state.json에 결과를 기록한다.
하나라도 false면 완료 기록 금지.

| 항목 | 확인 |
|---|---|
| 1 | 수정/추가 파일이 모두 절대경로(또는 명확한 상대경로)로 명시되었다 |
| 2 | 테스트 범위(단위 클래스/메서드 + 통합 시나리오)가 함께 정의되었다 |
| 3 | 예상 작업 단위가 1 commit = 1 change 원칙에 맞게 쪼개졌다 |
| 4 | 스코프 아웃(이번 이슈에서 다루지 않는 것)이 명시적으로 적혔다 |
| 5 | 사용자 명시 승인("이대로 진행하세요" 등)을 받았다 |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".self_check' \
  '{"paths_explicit": true, "test_scope_defined": true, "atomic_units": true, "scope_out_listed": true, "user_approved": true}'
```

## 완료 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".done' 'true'
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".done_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
```

**승인 경로** — (위 escalation 반영 후) `.policy.auto_approve."1_planning.scope"`를 따른다:

- **auto_approve == true** (정상 — minor/major 공통): 사람 대기 없이 자동 진행한다. `verification_pending`을 즉시 `false`로 둔다. 게이트(`stage4-dev-verify.sh`)가 정책을 보고 사용자 승인 없이 4단계로 통과시킨다.
  ```bash
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".verification_pending' 'false'
  ```
- **auto_approve 미설정**(구형 state — 범주화 폴백): 기존대로 사용자가 "이대로 진행하세요" 같은 명시적 승인을 준 뒤에만 4단계로 넘어간다.
  ```bash
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".verification_pending' 'true'
  # 사용자 명시 승인 직후에만:
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".approved_by_user' 'true'
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".approved_at' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."scope".verification_pending' 'false'
  ```
