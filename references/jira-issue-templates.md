# Jira Issue Templates — Team Standard

> makdoong2-jira 막내가 본 문서를 참조해서 Jira 본문 + 메타데이터를 검증한다.
> 6가지 검사 중 하나라도 실패하면 stage 2 진입 게이트가 차단되며, 인터뷰 완료 후
> `validation_passed=true` 마커가 기록되어야 진행 가능.

## 0. 이슈 유형 → 템플릿 매핑

Jira "Type" 필드 값이 다음 중 하나여야 한다:

| Type | 템플릿 섹션 |
|---|---|
| Task | [§1](#1-task) |
| Improvement | [§2](#2-improvement) |
| New Feature | [§3](#3-new-feature) |
| Bug | [§4](#4-bug) |

그 외 유형 — 사용자에게 "어느 템플릿으로 검증할까요?" 질의 후 결정.

---

## 1. Task

**필수 섹션 (순서 무관, 모두 존재해야 함)**:

| # | 섹션 헤더 (굵게) | 내용 가이드 |
|---|---|---|
| 1 | **작업 개요·배경/목적** | 수행할 작업의 요약, 필요한 이유와 목표 |
| 2 | **산출물 및 저장 위치** | 코드/문서/스크립트 등 결과물과 경로 |
| 3 | **추가 사항** | 참고할 만한 문서, 관련 이슈 링크, 유사 사례 등 |

### 예시
```
1. *작업 개요·배경/목적*
: 캐시 모듈 추가 — 업스트림 폴링 부하 절감 위함

2. *산출물 및 저장 위치*
: example-cache/src/main/scala/.../ItemCache.scala
  + example-cache/src/test/scala/.../ItemCacheSpec.scala

3. *추가 사항*
: 관련 이슈 PROJ-38120 / 설계 문서 https://{CONFLUENCE_HOST}/.../item-cache
```

---

## 2. Improvement

**필수 섹션**:

| # | 섹션 헤더 | 내용 가이드 |
|---|---|---|
| 1 | **기존 동작** | 현재 기능 또는 동작 방식 설명 |
| 2 | **기능 개선이 필요한 문제점 (배경/근거)** | 사용자 불편/성능 저하/운영 비효율 등 구체 원인 |
| 3 | **문제 해결 방안** | 기술적 접근, 설계 아이디어 |
| 4 | **수정 내용** | 변경될 기능/모듈/API 등 변경 범위 |
| 5 | **추가 사항** | 참고 문서, 관련 이슈 |

---

## 3. New Feature

**필수 섹션**:

| # | 섹션 헤더 | 내용 가이드 |
|---|---|---|
| 1 | **기능 개요** | 추가하고자 하는 새 기능의 간단한 설명 |
| 2 | **기능 추가 배경/요청 근거** | 이 기능이 왜 필요한지, 어떤 문제/요구사항에서 출발했는지 |
| 3 | **요구사항 및 기대효과** | 기능이 충족해야 할 명세 + 도입 시 예상 효과 |
| 4 | **기능 상세 설계/내용** | 기능 동작 방식, 주요 처리 흐름, API/화면 구성 등 |
| 5 | **추가사항** | 타 시스템 연동, 정책 논의 필요 여부 |

---

## 4. Bug

**필수 섹션**:

| # | 섹션 헤더 | 내용 가이드 |
|---|---|---|
| 1 | **버그 설명** | 발생한 문제에 대한 요약 |
| 2 | **재현 방법** | 단계별 절차 (1) 2) 3) ...) |
| 3 | **기대 동작** | 정상적으로 동작했어야 할 기능 |
| 4 | **실제 동작** | 버그 발생 시 시스템의 실제 동작 |
| 5 | **오류 로그 및 스크린샷** (선택) | 관련 로그/오류 메시지/캡처 |
| 6 | **영향 범위** | 영향 받는 기능/사용자/시스템 |
| 7 | **조치 내용** | 버그 수정 방안 및 조치 계획 |
| 8 | **추가사항** | 기타 참고 사항, 관련 이슈 |

---

## 5. 검증 체크리스트 (6개 항목, 모두 통과해야 stage 2 진입)

| 마커 키 (`.stages."1_planning".substages."jira".template_validation.*`) | 통과 기준 |
|---|---|
| `content_template_match`     | Jira 본문에 해당 유형 템플릿의 **필수 섹션 헤더가 전부 존재** (선택 섹션 제외) |
| `content_quality_adequate`   | 각 섹션이 placeholder("(...)")만 있지 않고 substantive 내용 보유 |
| `priority_set`               | priority ∈ {Highest, High, Medium, Low, Lowest}, 비어있지 않음 |
| `assignee_set`               | assignee가 Unassigned가 아닌 실제 사용자 |
| `reporter_set`               | reporter가 실제 사용자로 설정됨 (Jira 기본은 생성자) |
| `fix_version_handled`        | fix version이 명시되어 있음 OR 사용자가 "N/A 진행" 명시 결정 |

### 섹션 헤더 검출 가이드
- Jira 마크다운에서 `1. *작업 개요·배경/목적*`, `**작업 개요·배경/목적**`, `## 작업 개요·배경/목적` 등 다양한 형식 인정
- 헤더 텍스트의 정확한 한글/공백 일치 — 띄어쓰기·괄호 표기까지 동일해야 함
- 인접 콜론(`:`) 뒤가 비어있거나 placeholder만 있으면 → `content_quality_adequate=false`

---

## 6. 인터뷰 프롬프트 템플릿 (검사 실패 시)

각 실패 항목별로 사용자에게 한 번에 하나씩 질문. 모든 응답 수렴 후
`.stages."1_planning".substages."jira".interview_completed=true` + `.stages."1_planning".substages."jira".validation_passed=true` 기록.

### 6.1 `content_template_match=false`
```
이슈 본문에 다음 섹션이 누락되어 있습니다: <missing_sections>
- A) Jira를 업데이트하고 알려주시면 재검증합니다
- B) 인터뷰로 직접 알려주시면 stage 2로 전달합니다 (Jira 본문 그대로)
- C) 표준 템플릿 적용 예외 (예: 긴급 hotfix) — 검증 건너뛰기 동의
```

### 6.2 `content_quality_adequate=false`
```
다음 섹션이 placeholder만 있고 substantive 내용이 부족합니다:
  <section_name>: "<현재 내용 발췌>"
- A) 어떤 내용이 들어가야 하는지 알려주세요 (인터뷰로 stage 2 전달)
- B) Jira를 업데이트한 뒤 재검증
- C) 의도적으로 비워둠 — 명시 동의 후 진행
```

### 6.3 `priority_set=false` 또는 우선순위 적정성 의심
```
현재 priority='<X>' (또는 비어있음)입니다.
- A) 적정함, 그대로 진행
- B) 변경 필요 → 어떤 값? (Highest/High/Medium/Low/Lowest)
- C) Jira에서 직접 수정 후 재검증
```

### 6.4 `assignee_set=false` 또는 `reporter_set=false`
```
현재 assignee='<X>', reporter='<Y>'입니다.
- A) 올바름, 그대로 진행
- B) assignee 변경 필요 → 누구로?
- C) reporter 변경 필요 → 누구로?
- D) Jira에서 직접 수정 후 재검증
```

### 6.5 `fix_version_handled=false`
```
fix version이 비어있습니다.
- A) 특정 버전 설정 — 어떤 버전?
- B) 다음 정기 릴리스에 포함 (현재 릴리스 + 1)
- C) N/A로 명시 진행 (예: 내부 도구/실험적 작업)
- D) Jira에서 직접 수정 후 재검증
```

### 6.6 인터뷰 응답 처리
- **A 응답**: 해당 검사 항목을 `true`로 갱신 (사용자 명시 수용)
- **B/C 응답**: 사용자가 알려준 정보를 별도 마커(`.stages."1_planning".substages."jira".interview_outcomes.<key>`)에 기록 → stage 2 에이전트가 참조
- **D 응답**: 사용자 업데이트 완료 후 1-3 재검증

모든 인터뷰 완료 + 모든 항목 (자체 통과 OR 사용자 수용) 후에만:
```bash
state.sh set <ISSUE> '.stages."1_planning".substages."jira".interview_completed' 'true'
state.sh set <ISSUE> '.stages."1_planning".substages."jira".validation_passed' 'true'
```

---

## 7. state.json 스키마 (`1_planning.jira` substage 부분)

```json
{
  "stages": {
    "1_planning": {
      "done": false,
      "substages": {
        "jira": {
          "done": false,
          "issue_type": null,
          "template_validation": {
            "content_template_match": false,
            "content_quality_adequate": false,
            "priority_set": false,
            "assignee_set": false,
            "reporter_set": false,
            "fix_version_handled": false,
            "missing_sections": [],
            "issues": []
          },
          "interview_required": false,
          "interview_completed": false,
          "interview_outcomes": {},
          "validation_passed": false
        }
      }
    }
  }
}
```

> 게이트는 `validation_passed`만 본다. 다른 필드는 진단·stage 2 전달용.
