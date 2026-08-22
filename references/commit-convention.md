# Git Commit Message Convention

주인이 제공한 팀 커밋 컨벤션. makdoong2-team 스킬의 6단계에서 참조한다.

## 참조
- [How to write a git commit message](https://cbea.ms/git-commit/)
- [How to write better git commit messages (freeCodeCamp)](https://www.freecodecamp.org/news/how-to-write-better-git-commit-messages/)
- [robertpainsi/commit-message-guidelines (gist)](https://gist.github.com/robertpainsi/b632364184e70900af4ab688decf6f53)

---

## 주요 원칙

### 제목과 본문 구조
- 제목과 본문은 **빈 줄**로 구분한다.
- 본문은 필요할 경우에만 작성한다.
- 제목은 **50자로 제한**한다 (한글은 25자 내외).
  - 요약이 어렵다면 한 번에 너무 많은 변경사항을 커밋하는 것은 아닌지 고민하고, **atomic commit**을 고려한다.
- 제목은 **대문자로 시작**한다 (Type 부분).
- 제목 끝에 **마침표를 붙이지 않는다**.
- 제목은 **명령조(imperative)**로 작성한다. 한글도 명령조를 유지한다 ("추가한다" 대신 "추가").
- 본문은 한글 기준 줄당 약 40자 (영문 72자 상당).

### 본문 작성 원칙
본문은 "어떻게"보다 **"무엇을, 왜"**에 집중한다.
- 왜 이렇게 변경했는가?
- 변경사항이 어떤 영향을 미쳤는가?
- 왜 변화가 필요했는가?

---

## Type 일람

| Type | 설명 |
|------|------|
| **Feat** | 새로운 기능 추가 |
| **Fix** | 버그 수정 |
| **Chore** | fix/feature와 관계없고 src 또는 test 파일을 수정하지 않는 변경 (의존성 업데이트 등) |
| **Refactor** | 버그 수정이나 기능 추가가 아닌 리팩토링 |
| **Docs** | 문서 업데이트 (README 등 마크다운 파일 포함) |
| **Style** | 코드 의미에 영향을 주지 않는 변경 (공백, 세미콜론 누락 등 포매팅) |
| **Test** | 테스트 추가 또는 기존 테스트 수정 |
| **Perf** | 성능 개선 |
| **Ci** | CI(Continuous Integration) 관련 |
| **Build** | 빌드 시스템 또는 외부 의존성에 영향을 주는 변경 |
| **Revert** | 이전 커밋 되돌리기 |

---

## 이슈 종료(Close) 키워드

- `close`, `closes`, `closed`
- `fix`, `fixes`, `fixed`
- `resolve`, `resolves`, `resolved`

**사용 구분**:
- 내부 이슈 → `close`, `fix`
- 외부 요청에 의한 이슈 → `resolve`

해당 커밋이 master로 커밋되거나, 커밋의 브랜치가 master로 머지될 때 자동으로 이슈가 종료된다.

---

## 커밋 운영 가이드

- 로컬 브랜치 커밋은 자유롭게 하되, PR 전에 **커밋을 정리**한다 (rebase, squash 등).
- 수정 목적이 일관된 하나의 기능 또는 요구사항이면 **1 PR 1 Commit**을 권장한다.
- 분량이 많으면 기능을 적절히 분리하여(**atomic commit**) 작은 단위로 만든다.
- 이슈와 기능을 **잘게 쪼개야 한다**.

---

## 커밋 메시지 포맷

### 기본 포맷
```
<Type>: [이슈키] <명령조 요약>

[본문: 왜, 무엇을]

[Footer: 이슈 링크]
```

### 예시 1 — 이슈를 footer에 기재
```
Feat: 기능 구현

이러이러한 이유로 이렇게 수정한다

[RV] PROJ-00000
[AI] 100%
```

### 예시 2 — 이슈를 제목에 포함
```
Feat: PROJ-00000 - 기능 구현

이러이러한 이유로 이렇게 수정한다

[RV] PROJ-00000
[AI] 100%
```

### 예시 3 — 간단한 수정 (한 줄)
```
Docs: PROJ-00000 - 기능 설명 추가
```

### 예시 4 — 한글 본문 포함
```
Feat: PROJ-38356 - 상품 캐시 조회 API 구현

클라이언트에서 캐시 조회 요청이 들어오면 요청 파라미터
기반으로 캐시 키를 계산하여 Redis 캐시를 조회한다.

기존에는 Cassandra만 조회했지만 최근 변경 내역의 지연을
줄이기 위해 Redis를 1차 조회 대상으로 사용한다.

- Redis Cache Entity와 Cassandra Entity 간 변환을 정의한다
- Redis Cache Key 생성 함수를 추가한다
- 캐시 미스가 발생하면 Cassandra fallback을 유지한다

[RV] PROJ-38356
[AI] 100%
```

---

## 기타
- **Git 사용은 command line을 권장**한다.
