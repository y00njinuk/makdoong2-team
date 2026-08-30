# Pull Request Template

이 문서는 AGENT 가 Bitbucket Data Center (설정된 `BITBUCKET_API_BASE_PATH` 호스트) 에 **자신이 작성한 Pull Request** 를 생성하고, 각 커밋의 변경 지점에 **변경된 내용과 반영한 의도를 설명하는 인라인 코멘트(live)** 를 기록할 때 따르는 템플릿이다.

> 인라인 코멘트의 목적은 PR **작성자 본인이 자기 변경사항을 설명**하는 것이다. 타인 PR 에 대한 리뷰 코멘트가 아니다.

---

## 발동 조건 (Trigger)

다음 **두 조건이 모두 충족될 때만** 이 템플릿을 적용한다.

1. 사용자 메시지에 PR 생성 명시 트리거가 포함된다.
   - 예: `"PR 만들어줘"`, `"Pull Request 생성"`, `"이 브랜치 PR 올려"`, `"draft PR 올리고 인라인 달아줘"`
2. 대상 브랜치·repo 가 식별 가능하다 (`fromRef`, `toRef`, `projectKey`, `repositorySlug`). 모호하면 즉시 질문.

---

## 1. PR 본문 포맷

```markdown
#### 목표
- <이슈의 최종 목적 1>
- <이슈의 최종 목적 2>

#### 구현내용
- <실제 구현한 것 1>
- <실제 구현한 것 2>
- ...

#### Test
- "<테스트 시나리오 1>"
- "<테스트 시나리오 2>"
- ...
```

---

## 2. 섹션별 작성 가이드

### `#### 목표`
- Jira 이슈의 **acceptance criteria** 또는 최종 목적을 자연어로 풀어 쓴다.
- 구현 세부사항이 아니라 **비즈니스 또는 기술 목표** 중심이다.
- 1~4줄 정도가 적절하다.

### `#### 구현내용`
- 실제로 추가하거나 수정한 **기능 단위**로 나열한다.
- 파일 단위로 쓰지 않는다 (`"xxx.java 추가"` ✗).
- 커밋 메시지들을 종합하여 PR 전체의 변경 내역을 압축한다.
- 추상적이지 않게 구체적인 기능명을 사용한다 (`"캐시 조회 로직 개선"` 정도로는 부족하다).

### `#### Test`
- 실제 테스트 시나리오를 **큰따옴표로 감싼 한글 문장**으로 작성한다.
- `"~한 경우 ~한다"` 형태의 완전한 문장을 사용한다.
- 단위 테스트 메서드명을 그대로 쓰지 않고 **의도**를 자연어로 풀어 쓴다.

---

## 3. 실제 예시

```markdown
#### 목표
- GetUpdatedItems API 요청 시 전달받은 Polling 시퀀스를 기준으로 캐시 키를 계산한다.
- 캐시 키를 기준으로 Redis에 조회하여 캐시 갱신 목록을 fetch-out 한다. (Redis에는 이미 데이터가 존재한다고 가정)

#### 구현내용
- GetUpdatedItems API 테스트 코드 추가
- Redis Cache Entity → DB Entity 변환 정의 및 구현
- Redis Cache 구조체 정의
- Redis Cache Key 생성 함수 구현
- DB Entity → API Response 변환 헬퍼 메서드 추가
- DB Entity → API Response 변환 메서드 정의 및 구현
- GetUpdatedItems API 기능 구현

#### Test
- "클라이언트 질의 시 Redis 캐시에 갱신 목록이 존재하는 경우 응답으로 제공한다."
- "클라이언트 질의 시 Redis 캐시에 가장 최근 갱신 목록이 존재하는 경우 응답으로 제공한다."
- "클라이언트 질의 시 갱신 목록을 모두 제공하지 않았다면 isFullList는 false 여야 한다."
```

---

## 4. PR 생성 규칙

1. 반드시 **Draft 로 생성**한다 → `bitbucket_createPullRequest(..., draft=true)`.
2. **토큰 소유자를 리뷰어로 추가한다** → §4-1 로 식별한 username 을 `reviewers` 에 전달한다. 자기 자신이 PR 작성자여서 Bitbucket DC 가 거부하면 `reviewer_self_skipped=true` 로 기록한다 (`stages/08-pr.md` §7-5).
   > 종전 이 항목은 "리뷰어를 추가하지 않는다 (`reviewers` 파라미터 자체를 생략)" 였다. 같은 문서의 §4-1·§4-2 와도, `stages/08-pr.md` 와도, `gates/stage7-post-pr-verify.sh` 의 reviewer 마커 검사(`reviewer_added` XOR `reviewer_self_skipped`, 미기록 시 fail)와도 정면으로 어긋나 있었다. 게이트가 마커를 요구하는 이상 리뷰어는 추가하는 것이 맞다.
3. 생성 후 각 커밋별 diff 를 분석하여 **인라인 코멘트** 를 **개별 live 코멘트** 로 작성한다 (아래 §5–6).

### 4-1. 토큰 소유자 식별 (리뷰어 추가용)

토큰 소유자의 username을 `X-AUSERNAME` 응답 헤더로 식별한다:

```bash
TOKEN=$(jq -r '.secrets.BITBUCKET_API_TOKEN' ~/.config/opencode/makdoong2-team.json)
BB_BASE=$(jq -r '.hosts.BITBUCKET_API_BASE_PATH' ~/.config/opencode/makdoong2-team.json)
USERNAME=$(curl -sI -H "Authorization: Bearer $TOKEN" \
  "$BB_BASE/api/latest/application-properties" \
  | grep -i '^X-AUSERNAME:' | awk '{print $2}' | tr -d '\r')
```

`X-AUSERNAME` 헤더는 API 응답 헤더에 인증된 사용자명이 포함되므로, 권한 불필요하고 토큰 소유자 본인 확인용으로 사용할 수 있다. 이 username을 `bitbucket_createPullRequest`의 `reviewers` 파라미터에 전달한다.

### 4-2. 생성 호출 예
```
bitbucket_createPullRequest(
  projectKey="PROJ",
  repositorySlug="<repo>",
  title="<Jira 키> [<모듈명>] <간단한 변경 요약>",
  description=<§1 포맷 그대로>,
  fromRefId="refs/heads/<feature branch>",
  toRefId="refs/heads/master",          # toRef 는 사용자에게 확인
  draft=true,
  reviewers=["<§4-1에서 식별한 username>"],
  output="full"                          # PR id / 응답 메타데이터 보존
)
```
응답에서 `id` (pullRequestId), `links.self[0].href` (PR URL), `version` 을 저장한다.

---

## 5. 인라인 코멘트 작성 가이드 — 내용

**목적**: PR 작성자 본인이 **무엇을 어떻게 변경했고 왜 그렇게 했는지** 를 변경 지점 옆에 직접 기록한다. 미래의 자신·동료·리뷰어가 코드만 봐서는 이해하기 어려운 의도와 맥락을 남기는 것이 목표.

### 톤
- 자연어와 일상어 중심으로 작성한다.
- 전문 용어가 필요하면 그대로 사용한다.
- 필요하면 마크다운을 사용한다 (코드 블록, 리스트 등).
- 작성자 1 인칭/평문 (`"~합니다"`, `"~했습니다"`) 톤을 유지한다. 리뷰어 톤 (`"~해주세요"`, `"~필요해 보입니다"`) 금지.

### 내용 선정 기준
다음 중 **하나라도 해당하면** 코멘트 대상이다. 해당 없으면 코멘트하지 않는다.
- 비자명한 설계 결정 (왜 A 대신 B 를 선택했는지)
- 도메인 지식이 필요한 부분
- 성능, 보안, 동시성 고려 사항
- 외부 의존성과의 상호작용
- 기존 동작과 달라진 부분의 호환성·마이그레이션 메모
- 미해결 TODO 또는 후속 작업 예고

### 코멘트 작성 금지 대상
- 자명한 리네임/포맷팅/임포트 정렬
- 테스트 추가 그 자체 (어떤 시나리오를 검증했는지가 새로운 정보일 때만 작성)
- 커밋 메시지로 이미 충분히 설명된 내용을 그대로 복붙
- 라이브러리 호출 시그니처 그대로 설명 (코드가 곧 의도)

### 예시
> 여기서 Redis TTL 을 10 분으로 잡은 이유는 캐시 갱신 주기가 업스트림 폴링 주기(5 분)의 2 배를 넘지 않도록 맞춘 것입니다. 폴링 주기가 바뀌면 이 값도 같이 조정해야 합니다.

> Cassandra 조회 시 `LOCAL_QUORUM` 을 명시적으로 지정했습니다. 기본값인 `ONE` 을 사용하면 복제 지연으로 인해 최신 캐시 상태를 놓칠 수 있기 때문입니다.

> 이 부분은 일단 동기 방식으로 구현했습니다. 성능 이슈가 보이면 `CompletableFuture` 기반 비동기로 리팩토링할 예정이고, 관련 내용을 PROJ-38400 후속 이슈에 기록해두었습니다.

> `get_item_cache()` 가 V1/V2 여부와 무관하게 공용 타입 `item_entry` 를 반환하므로, 로컬 변수도 `ITEM_ENTRY_V1` 에서 `item_entry` 로 교체합니다. 덕분에 아래에서 제거되는 중간 변환 코드(`ITEM_ENTRY_V1_to_item_entry`)가 불필요해집니다.

> 기존에 Status Report 를 Thrift → JSON 과정으로 변환하여 발행하던 구조를 Thrift 구조체로 변환하는 것으로 수정합니다. 프로듀서가 데이터를 전송하는 토픽 또한 `StatusReportJson` 이 아닌 `StatusReport` 로 수정합니다.  참고: https://{CONFLUENCE_HOST}/pages/viewpage.action?pageId=123456789

---

## 6. 인라인 코멘트 작성 워크플로 — 실행 (기술)

§5 가 **무엇을·어떤 톤으로** 쓸지를 정의한다면, §6 은 **정확한 위치에 어떻게 anchor 할지** 를 정의한다.

> ⚠️ **CRITICAL**: 코멘트는 반드시 **특정 커밋의 변경 지점** 에 anchor 해야 한다 (PR latest 의 통합 diff 가 아님). Bitbucket UI 의 `Pull request → Commits → <개별 커밋> → 파일 diff` 뷰에 노출되려면 `anchor.diffType = "COMMIT"` 이 필수다.
>
> `bitbucket_postPullRequestComment` **MCP 도구는 기본적으로 `diffType=EFFECTIVE` (PR latest 통합 diff) 로 anchor 한다**. EFFECTIVE 는 PR 의 `Diff` 탭에서만 보이고 개별 커밋 뷰에서는 노출되지 않으므로 **이 워크플로에서는 MCP 도구를 사용하지 않는다**. 대신 Bitbucket REST API 를 `curl` 로 직접 호출한다.

### 6.1 입력
- `projectKey`, `repositorySlug`, `pullRequestId` → §4 의 `createPullRequest` 응답에서 확보
- `BITBUCKET_API_TOKEN` → `~/.config/opencode/opencode.json` 의 `mcp.repos.environment.BITBUCKET_API_TOKEN`
- BASE URL: `https://{BITBUCKET_HOST}/rest/api/1.0/projects/{projectKey}/repos/{repositorySlug}/pull-requests/{pullRequestId}`

### 6.2 코멘트 위치 → 대상 커밋 매핑

각 코멘트마다 **어느 커밋에 anchor 할 것인가** 를 먼저 결정한다.

**파일 신규 추가의 경우** (대부분):
```bash
target=$(git log <branch> --diff-filter=A --format='%H' -- <path> | tail -1)
parent=$(git rev-parse ${target}^)
```
`target` 은 그 파일을 최초로 추가한 커밋. `parent` 는 그 직전 커밋.

**기존 파일 수정의 경우**:
- 코멘트할 라인의 도입 커밋을 `git blame -L <line>,<line> <path>` 또는 `git log -L <line>,<line>:<path>` 로 식별한다.
- 식별한 커밋이 PR 범위 안에 있어야 한다 (`git log <base>..<head>` 에 포함).

### 6.3 파일별 diff → 정확한 line / lineType 확정

대상 커밋의 변경에서 코멘트할 라인 번호와 타입을 확정한다.

```bash
git show <target> -- <path>          # 변경 후 라인 번호 + segment 타입 확인
git diff <parent> <target> -- <path>  # 동일 (parent..target 의 diff)
```

**lineType 결정 규칙** (반드시 diff 에서 segment 타입 확정. 추측 금지):

| diff segment | `lineType` | `line` 번호 기준 |
|---|---|---|
| 녹색 `+` 라인 | `ADDED` | `toHash` 기준 (변경 후 라인 번호) |
| 빨간 `-` 라인 | `REMOVED` | `fromHash` 기준 (변경 전 라인 번호) |
| 변경 없는 컨텍스트 | `CONTEXT` | 양쪽 모두 유효 |

**인라인 코멘트는 보통 `ADDED` 라인에 단다** (자기가 추가한 코드의 설계 의도를 설명하므로). `REMOVED` 라인 코멘트는 "이 코드를 왜 제거했는지" 가 자명하지 않은 경우에만.

### 6.4 multiline 미지원

**Bitbucket Data Center REST API 는 multiline 코멘트를 거부한다.** `anchor.multilineMarker` 와 `anchor.multilineSpan` 두 키 모두 거부되며, 에러 메시지가 서로 상대 키를 요구하는 모순 상태로 떨어진다 (실측 확인). 따라서:

- 의미상 여러 라인에 걸친 설계 결정도 **가장 핵심인 단일 라인** 에 anchor 한다.
  - 예: enum 정의 전체가 아닌 `InProgress = 5` 한 줄에 anchor
  - 예: `setSerialConsistencyLevel(LOCAL_SERIAL)` 한 줄에 anchor
- 코멘트 본문에서 자연어로 라인 범위를 언급할 수 있다 (`"L4–L7 의 enum 정의 전체에서..."`).

### 6.5 commit-anchored 코멘트 POST (live)

```bash
TOKEN=$(jq -r '.secrets.BITBUCKET_API_TOKEN' ~/.config/opencode/makdoong2-team.json)
BB_BASE=$(jq -r '.hosts.BITBUCKET_API_BASE_PATH' ~/.config/opencode/makdoong2-team.json)
BASE="https://{BITBUCKET_HOST}/rest/api/1.0/projects/{projectKey}/repos/{repositorySlug}/pull-requests/{prid}"

# 코멘트 본문은 임시 파일에 저장 (긴 markdown 본문을 안전하게 jq 로 주입)
# 본문 파일은 발행 직후 삭제한다.
cat > /tmp/comment-body.md <<'EOF'
<§5 가이드에 따라 작성한 본문>
EOF

payload=$(jq -n \
  --arg text "$(cat /tmp/comment-body.md)" \
  --arg path "<§6.2 의 파일 경로>" \
  --arg fromHash "<§6.2 의 parent 전체 해시>" \
  --arg toHash "<§6.2 의 target 전체 해시>" \
  --argjson line <§6.3 의 라인 번호> \
  '{
    text: $text,
    severity: "NORMAL",
    anchor: {
      diffType: "COMMIT",
      fromHash: $fromHash,
      toHash: $toHash,
      fileType: "TO",
      path: $path,
      line: $line,
      lineType: "ADDED"
    }
  }')

curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  "$BASE/comments"
```

**anchor 필드 의미**:

| 필드 | 값 | 설명 |
|---|---|---|
| `diffType` | `"COMMIT"` | **필수**. 특정 커밋의 diff 에 anchor. `"EFFECTIVE"` (PR latest 통합) / `"RANGE"` 는 commit 뷰에서 노출 안 됨 |
| `fromHash` | parent commit 전체 SHA | 대상 커밋의 직전 상태 |
| `toHash` | target commit 전체 SHA | 코멘트가 anchor 될 커밋 |
| `fileType` | `"TO"` (ADDED/CONTEXT 시) / `"FROM"` (REMOVED 시) | "변경 후" 또는 "변경 전" 파일 기준 |
| `path` | 파일 경로 (변경 후 기준) | RENAME 의 경우 `srcPath` 도 함께 전달 |
| `line` | 라인 번호 (lineType 에 맞는 기준) | |
| `lineType` | `"ADDED"` / `"REMOVED"` / `"CONTEXT"` | §6.3 에서 확정 |
| `severity` | `"NORMAL"` | 항상. `"BLOCKER"` 금지 (자기 PR 자기 차단 금지) |

응답에서 `id`, `version`, `anchor.diffType` (정상이면 `"COMMIT"`) 확인. `diffType` 이 `"EFFECTIVE"` 로 떨어졌다면 잘못된 호출이다 → §6.6 으로 정리.

### 6.6 잘못 anchor 된 코멘트 정리

`bitbucket_postPullRequestComment` MCP 도구로 실수 발행했거나 `diffType` 누락으로 `EFFECTIVE` 가 됐다면:

```bash
# 1. 잘못된 코멘트의 version 확인 (생성 직후는 보통 0)
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/comments/{id}" | jq '.version'

# 2. DELETE → HTTP 204 기대
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$BASE/comments/{id}?version={version}"

# 3. §6.5 로 commit-anchor 재게시
```

**bash 스크립트로 여러 건 정리 시 주의**: `set -euo pipefail` 상태에서 한 건의 `jq` / `curl` 오류가 전체 루프를 중단시키면 부분 삭제 + 부분 미삭제 상태로 끝난다. **루프 직후 전체 코멘트 목록을 다시 조회하여 잔여물이 없는지 검증한다**:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/activities?limit=100" \
  | jq '[.values[] | select(.action == "COMMENTED" and .commentAction == "ADDED")
         | .comment | {id, diffType: .anchor.diffType}]'
```

`diffType` 이 `"COMMIT"` 이 아닌 항목이 보이면 위 DELETE 절차로 추가 정리한다.

### 6.7 보안

- 토큰을 response echo, 로그, 임시 파일, 커밋 메시지 어디에도 출력하지 말 것.
- 토큰은 항상 `$TOKEN` 변수로 참조. 페이로드 문자열에 인라인 삽입 금지.
- 임시 본문 파일(`/tmp/comment-body.md` 등) 은 발행 후 즉시 삭제.

### 6.8 발행 후 사용자 보고

발행 완료 후 다음 형식으로 사용자에게 보고한다. **각 항목은 commit-specific URL 로 연결**한다.

```
PR <PR URL> 을 draft 로 생성했습니다.

생성된 인라인 코멘트 (총 N개, 전부 diffType=COMMIT):
[1] <commit short> <filePath>:L<line>
    → <BASE_URL>/pull-requests/<prid>/commits/<full hash>#<URL-encoded path>
    > <본문 앞 80자>...
[2] ...

리뷰어 추가 또는 draft 해제는 사용자가 직접 진행해주세요.
```

commit-specific URL 형식:
```
https://{BITBUCKET_HOST}/projects/<projectKey>/repos/<repositorySlug>/pull-requests/<prid>/commits/<full hash>#<URL-encoded file path>
```

---

## 7. 함정 체크리스트 (위반 시 잘못된 PR / 잘못된 코멘트)

### PR 생성 관련
- ❌ **`createPullRequest` 에 `reviewers` 전달 금지.** 필요하다고 판단해도 추가하지 않는다 (§4 의 규칙).
- ❌ **`draft=true` 누락 금지.** PR 은 항상 draft 로 생성한다.
- ❌ **사용자가 제공하지 않은 Jira 키·이슈 번호 추측 금지.** §1 의 `목표` 와 PR 제목에 들어가는 이슈 키는 사용자 제공 또는 브랜치명에서 추출한 것만 사용.

### 인라인 코멘트 anchor 관련
- ❌ **`bitbucket_postPullRequestComment` MCP 도구 사용 금지.** 이 도구는 `anchor.diffType` 을 노출하지 않아 PR latest 통합 diff(`EFFECTIVE`) 로 anchor 된다. 커밋 뷰에서 노출이 안 되므로 §6.5 의 REST API 직접 호출만 사용한다.
- ❌ **`anchor.diffType` 누락 금지.** 기본값은 `EFFECTIVE` (PR latest) 다. **반드시 `"COMMIT"` 을 명시**한다.
- ❌ **`fromHash` 를 PR base (예: master tip) 로 지정 금지.** 대상 커밋의 **직전 커밋** 이어야 한다 (`git rev-parse <target>^`).
- ❌ **`toHash` 를 PR head (예: feature branch tip) 로 지정 금지.** 코멘트를 보일 **개별 커밋** 의 해시여야 한다.
- ❌ **`anchor.multilineMarker` / `anchor.multilineSpan` 사용 금지.** Bitbucket DC 가 거부한다. multiline 의도는 단일 핵심 라인 anchor + 본문에서 자연어 범위 언급으로 대체한다 (§6.4).
- ❌ **`lineType` 추측 금지.** 반드시 `git show <target> -- <path>` 또는 `git diff <parent> <target>` 의 segment 타입에서 확정.
- ❌ **file rename 시 `srcPath` 누락 금지.** anchor 에 `srcPath` 필드를 함께 전달한다.

### 코멘트 발행 정책
- ❌ **top-level 코멘트(`anchor` 없음) 발행 금지.** PR 본문(§1) 이 이미 그 역할. 인라인 코멘트만 작성한다.
- ❌ **`severity="BLOCKER"` 사용 금지.** 자기 PR 을 자기가 차단할 이유 없음.
- ❌ **pending(draft) 코멘트 발행 금지.** §6.5 의 단순 POST 는 즉시 live 다. `pending` 필드를 false 이외로 설정하지 않는다.
- ❌ **`submitPullRequestReview` 호출 금지.** verdict 는 리뷰어가 결정한다.
- ❌ **§5 의 "작성 금지 대상" 에 해당하는 지점에 코멘트 작성 금지.** 자명한 변경에 노이즈 코멘트를 달지 않는다.

### 보안 · 운영
- ❌ **`BITBUCKET_API_TOKEN` 노출 금지.** 응답 echo, 로그, 임시 파일, 페이로드 문자열 인라인 어디에도 토큰을 쓰지 않는다.
- ❌ **배치 정리 후 검증 누락 금지.** `set -euo pipefail` bash 루프는 한 건 실패로 중단되어 잔여물이 남을 수 있다. §6.6 의 활동 목록 재조회로 `diffType=COMMIT` 이 아닌 항목이 0 개임을 확인한다.

---

## 8. 실패 처리

| 상황 | 대응 |
|---|---|
| HTTP 401 / 403 | 토큰 만료 가능성. `~/.config/opencode/opencode.json` 의 `mcp.repos.environment.BITBUCKET_API_TOKEN` 갱신 안내 후 중단. |
| `createPullRequest` 실패 (브랜치 미존재) | 사용자에게 `fromRef` / `toRef` 정정 요청. 임의 브랜치명 추측 금지. |
| 코멘트 POST 응답에 `anchor.diffType = "EFFECTIVE"` | `diffType` 누락 또는 잘못된 페이로드. §6.6 으로 즉시 삭제 후 `diffType: "COMMIT"` 명시하여 재게시. |
| 코멘트 POST 응답에 `errors: [...]` + HTTP 400 | 페이로드 검증 실패. 에러 메시지 그대로 사용자에게 보고하고 수정 후 재시도. multiline 관련 에러면 §6.4 에 따라 단일 라인으로 전환. |
| 코멘트 POST 응답에 `id: null` (HTTP 200 임에도) | 페이로드는 통과했지만 서버가 코멘트를 만들지 못함. 응답 전체를 사용자에게 보고하고 페이로드 점검. |
| 대상 커밋의 diff 에 해당 라인이 없음 | 해당 지점 코멘트 스킵하고 사용자에게 보고. 가장 가까운 라인으로 대체 금지. 다른 커밋이 그 라인을 도입한 경우 §6.2 로 다시 매핑. |
| 코멘트 작성 중 일부 성공 / 일부 실패 | 성공한 것은 그대로 두고, 실패 항목 목록을 사용자에게 보고. 자동 롤백 금지. **§6.6 의 검증 쿼리로 잔여 EFFECTIVE 코멘트가 없는지 확인**. |
| bash 루프가 `set -e` 로 중간 중단 | 어디까지 진행됐는지 알 수 없음. 활동 목록 재조회로 잔여물 식별 후 개별 정리. 동일 스크립트 재실행 금지 (중복 발행 위험). |
| 3 회 연속 API 실패 | 모든 시도 중단. 로그를 정리해 사용자에게 보고. 임의 재시도 금지. |
| PR 은 만들어졌지만 모든 코멘트 작성 실패 | PR URL 은 보고하고, 코멘트는 사용자가 UI 에서 작성하거나 다시 시도하도록 안내. PR 자동 삭제 금지. |

---

## 9. AGENT 가 절대 하지 않는 것

- 리뷰어 자동 추가
- draft 해제 자동화
- PR 머지
- BLOCKER 코멘트 / verdict 발행
- 타인 PR 에 대한 리뷰 코멘트 작성 (이 문서는 작성자 본인의 PR 한정)
- 사용자 메시지에 없는 Jira 키·issue link 임의 삽입
- §1 포맷 외의 추가 섹션 임의 추가 (예: `#### 변경 영향`, `#### 배포 체크리스트` 등) — 사용자가 명시 요청한 경우만 추가
- 코멘트 본문에 회사 외부 링크 무단 삽입 (조직 내부 도메인만 허용)
- 토큰 노출
