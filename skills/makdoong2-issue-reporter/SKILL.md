---
name: makdoong2-issue-reporter
description: makdoong2-team 플러그인의 오류·비정상 동작을 GitHub 이슈(https://github.com/y00njinuk/makdoong2-team/issues)로 등록한다. 호출 시점 이전의 로그·프롬프트·세션 컨텍스트를 스스로 모두 수집해 문제가 발생한 지점을 포착하는 것이 핵심 동작이며, 사용자 질의는 그 결과를 보완·확인하는 용도로만 쓴다. 유일한 트리거는 사용자의 직접 호출(/makdoong2-issue-reporter 커맨드)이다. 에이전트가 세션 중 실패·예외·행 걸림을 관측했다는 이유로 자율적으로 로드해서는 안 되며, 전용 에이전트(makdoong2-issue-reporter) 외의 skill 로드는 플러그인 훅이 런타임 차단한다. 수집한 증거는 사내 보안 규칙에 따라 마스킹한 뒤 첨부한다.
---

# makdoong2-team Issue Reporter

makdoong2-team 플러그인의 결함을 재현 가능한 형태로 GitHub 이슈에 축적하기 위한 스킬.

## 트리거 & 실행 컨텍스트 (hardrule)

- **유일한 트리거는 사용자의 직접 호출** — `/makdoong2-issue-reporter [보충 설명]` 커맨드. 커맨드 frontmatter 의 `agent` 필드가 전용 에이전트 `makdoong2-issue-reporter` 로 라우팅한다.
- **전용 에이전트는 전권(full-permission) 으로 실행된다** — bash 전체 allow, 파일 쓰기 allow. team-leader 의 파일 쓰기·git 제한이 적용되지 않으므로 아래 절차의 임시 파일 생성(`issue-payload.json` 등)과 curl 호출을 그대로 수행할 수 있다.
- **다른 에이전트의 자율 로드 금지** — team-leader·sealed 서브에이전트가 `skill(name="makdoong2-issue-reporter")` 를 호출하면 플러그인 `tool.execute.before` 훅이 차단한다. 실패를 관측한 에이전트는 스킬을 로드하는 대신 사용자에게 `/makdoong2-issue-reporter` 실행을 안내한다.
- 인라인 실행이므로 현재 세션의 직전 대화 턴을 그대로 볼 수 있다. 4장(항목 확정)과 2.3(마스킹 최종 확인)의 사용자 문답도 같은 세션에서 이어서 진행한다.

## 핵심 동작

**이 스킬이 호출되면, 호출 시점 이전의 로그·프롬프트·컨텍스트를 모두 수집해 문제가 발생한 지점을 스스로 포착하고 이슈로 등록한다.**

- 사용자에게 "무슨 문제였나요"를 먼저 묻지 않는다. 호출 자체가 "직전에 뭔가 잘못됐으니 조사해서 남겨라"라는 지시다.
- 사용자가 증상을 한 줄만 말하거나 아무 설명 없이 호출해도 동작해야 한다. 부족한 정보는 질의가 아니라 **수집과 분석으로 먼저 메운다**.
- 질의(4장)는 수집·분석으로 확정할 수 없는 항목(기대 동작, 재현성, 시도한 조치)과 **분석 결과 확인**에만 사용한다.
- 실행 순서는 고정한다: **수집(3장) → 이상 지점 포착(3.3) → 마스킹(2장) → 중복 확인(5장) → 최소 질의(4장) → 이슈 생성(7장)**.

## 0. 대상 리소스

| 구분 | 값 |
|---|---|
| 저장소 | `y00njinuk/makdoong2-team` (**Public**) |
| 이슈 목록 | https://github.com/y00njinuk/makdoong2-team/issues |
| 신규 이슈 | https://github.com/y00njinuk/makdoong2-team/issues/new |
| 이슈 API | `https://api.github.com/repos/y00njinuk/makdoong2-team/issues` |
| 라벨 | https://github.com/y00njinuk/makdoong2-team/labels |
| PAT 파일 | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.github` (root 로 구동하는 WSL 환경에서는 `/root/.config/opencode/.github`) |
| 기본 로그 | `/var/log/opencode/opencode.log` |

이슈를 생성하거나 코멘트를 남긴 뒤에는 반드시 위 이슈 목록 링크와 생성된 이슈의 `html_url`을 사용자에게 함께 제시한다.

> **저장소가 public이다.** 이슈 본문·로그·프롬프트 발췌는 전 세계에 공개된다. 2장의 보안 규칙을 예외 없이 적용한다.

---

## 1. 인증 (Personal Access Token)

PAT는 opencode config 디렉토리의 `.github` 파일에 기록되어 있다. 파일을 읽어 토큰을 획득한다.

```bash
PAT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.github"
test -r "$PAT_FILE" || { echo "PAT 파일 없음 또는 읽기 권한 없음: $PAT_FILE"; exit 1; }
```

파일 포맷은 다음 중 하나일 수 있으므로 순서대로 판별한다.

| 포맷 | 예시 | 추출 방법 |
|---|---|---|
| 토큰 단독 | `ghp_xxx` / `github_pat_xxx` | 파일 내용 trim |
| `KEY=VALUE` | `GITHUB_TOKEN=ghp_xxx` | `=` 우측 값 |
| INI/JSON | `{"token": "ghp_xxx"}` | 해당 키 값 |

```bash
GH_TOKEN="$(grep -oE '(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+' "$PAT_FILE" | head -n1)"
```

**제약 사항**
- 토큰 값은 대화 출력, 이슈 본문, 로그 어디에도 그대로 노출하지 않는다. 마스킹(`ghp_****`)만 허용.
- `curl` 사용 시 `-H "Authorization: Bearer $GH_TOKEN"` 형태로 환경변수를 통해 전달하고, 커맨드 문자열에 토큰을 직접 문자열로 박지 않는다.
- 토큰 파일 내용을 그대로 출력하거나 다른 경로로 복사하지 않는다.
- 토큰이 없거나 401/403이 반환되면 이슈 생성을 중단하고, 본문 전체를 마크다운으로 출력해 사용자가 수동 등록할 수 있게 한다.

---

## 2. 보안 규칙 (최우선 · 예외 없음)

**회사 보안에 위반되는 소스 코드·설정·데이터는 어떤 형태로도 이슈에 노출되어서는 안 된다.** 부득이하게 포함이 필요한 경우 반드시 마스킹 처리한 뒤 첨부한다. 이 규칙은 이슈 본문, 제목, 라벨, 코멘트, Gist, 대화 출력 전체에 동일하게 적용된다.

### 2.1 절대 노출 금지 (마스킹으로도 대체 불가 — 아예 제외)

- 사내 저장소의 소스 코드 원문, 사내 라이브러리·모듈의 내부 구현
- 고객사명·고객 데이터·위협 인텔리전스 실데이터, 사내 DB 스키마·쿼리 결과
- 사내 시스템 자격 증명 일체: PAT, Bearer/Access token, Azure/Graph client secret, API key, 인증서, 비밀번호
- 사내 문서(Jira/Confluence) 본문 인용

포함하지 않고는 이슈가 성립하지 않는다면, 해당 내용을 **일반화된 서술로 재작성**한다(예: 사내 API 응답 원문 → "사내 REST API가 404를 반환").

### 2.2 마스킹 후 사용 가능

| 대상 | 원본 예 | 마스킹 형태 |
|---|---|---|
| 사내 IP·호스트 | `172.20.11.96:8000` | `<internal-host>:<port>` |
| 사내 도메인/URL | 사내 Jira·Confluence·Bitbucket·Bamboo URL | `<internal-jira>/browse/<ISSUE-KEY>` |
| 이슈 키·티켓 번호 | 실제 Jira 키 | `<ISSUE-KEY>` |
| 계정·사번·이메일 | 사내 계정명 | `<user>` |
| 파일 경로 중 사내 프로젝트명 | `/home/<user>/work/<사내repo>/...` | `/home/<user>/work/<internal-repo>/...` |
| 모델·프로바이더 사내 엔드포인트 | 사내 모델 서버 주소 | `<internal-model-endpoint>` |
| 토큰 유사 문자열 | `ghp_...`, `eyJ...`(JWT) | `<redacted-token>` |

### 2.3 절차

1. 첨부 후보 텍스트를 모은 뒤, **첨부 직전에** 마스킹 스캔을 1회 수행한다.
2. 마스킹 대상 여부가 불확실한 라인은 첨부에서 **제외**한다(포함하고 판단을 미루지 않는다).
3. 마스킹으로 인해 재현 정보가 소실되는 경우, 소실된 항목을 이슈 본문에 `<마스킹됨: 사유>`로 명시한다.
4. 이슈 전송 전, 마스킹 결과 요약(무엇을 몇 건 가렸는지)을 사용자에게 제시하고 **최종 확인을 받는다**. 사용자 승인 없이 전송하지 않는다.

스캔 보조:

```bash
grep -nEi '(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]{10,}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|(client_)?secret|password|api[_-]?key|Authorization:' <파일>
```

이 grep은 보조 수단일 뿐이며, 사내 코드·고객 데이터처럼 패턴으로 잡히지 않는 항목은 내용 판단으로 걸러낸다.

---

## 3. 증거 수집 및 이상 지점 포착

호출 시점을 `T`로 두고, **`T` 이전 구간을 전수 수집한 뒤 좁혀 들어간다.** 수집 범위 기본값은 다음과 같다.

| 범위 | 기본값 | 확장 조건 |
|---|---|---|
| 시간 | `T - 2시간` ~ `T` | 해당 구간에 오류 흔적이 없으면 `T - 24시간`까지 확대 |
| 세션 | 현재 세션 전체 | 사용자가 다른 세션을 지목하면 해당 세션 |
| 턴 | 현재 세션의 모든 턴(프롬프트·응답·tool call) | — |

```bash
T="$(date -Is)"
```

### 3.1 사용 가능한 증거 소스

`opencode.log`에 한정하지 않는다. 문제 재현·원인 파악에 도움이 되는 것은 모두 사용해도 좋다. **단, 3.3의 처리를 거친 뒤 2장의 보안 규칙을 통과한 것만 첨부한다.**

| 소스 | 예 |
|---|---|
| OpenCode 로그 | `/var/log/opencode/opencode.log`, 로테이션 파일(`*.log.1`, `*.gz`) |
| 세션·에이전트 로그 | omo/플러그인이 남기는 세션 로그, 에이전트별 실행 로그 |
| 프롬프트 입출력 | 부장님·막둥이에게 전달된 프롬프트 원문, 서브에이전트 응답 원문, injection된 시스템 프롬프트 |
| 도구 호출 기록 | tool call 파라미터·결과, MCP 서버 요청/응답 |
| 터미널 출력 | 플러그인 실행 시 stdout/stderr, 스택트레이스 |
| 설정 파일 | `opencode.json` 등 설정 스냅샷 (자격 증명 제거 후) |
| 외부 연동 기록 | Teams(Graph API/Power Automate) 호출 응답 코드·에러 메시지 |

### 3.2 수집 예

```bash
# 기본: 최근 500라인
tail -n 500 /var/log/opencode/opencode.log > /tmp/makdoong2-evidence.log

# 키워드 기반 구간 추출
grep -nE 'ERROR|WARN|Exception|Traceback|makdoong2|부장님|막둥이|agent|prompt' \
  /var/log/opencode/opencode.log | tail -n 200

# 로테이션 파일 포함 검색
zgrep -hE 'ERROR|makdoong2' /var/log/opencode/opencode.log* | tail -n 200

# 설정 스냅샷 (자격 증명 키 제거)
jq 'walk(if type == "object" then with_entries(select(.key | test("token|secret|key|password"; "i") | not)) else . end)' opencode.json
```

### 3.3 이상 지점 포착 (수집 직후 수행)

수집한 자료를 시간순으로 정렬한 뒤, 아래 신호를 탐지해 **문제 발생 지점 1곳을 특정**한다.

| 신호 유형 | 탐지 대상 |
|---|---|
| 예외·오류 | `ERROR`, `FATAL`, `Exception`, `Traceback`, non-zero exit, 4xx/5xx 응답 |
| 중단·정체 | 특정 단계 이후 로그 공백, timeout, 응답 없이 종료된 tool call, `session.idle` 미도달 |
| 프롬프트 이상 | 조건과 무관한 프롬프트 injection, 시스템 프롬프트 누락·중복, 컨텍스트 초과·절단 |
| 오케스트레이션 이상 | 호출되지 않아야 할 에이전트 호출, 응답 미수신, 결과 취합 누락, 잘못된 단계 전이 |
| 연동 실패 | MCP·Graph API·Jira 호출 실패, 인증 오류 |
| 반복 | 동일 단계·동일 메시지의 재시도 루프 |

특정 결과는 다음 형태로 정리한다.

- **최초 이상 발생 지점**: 타임스탬프 + 단계명 + 에이전트 + 로그 라인 번호
- **선행 정상 지점**: 마지막으로 정상 동작한 단계 (경계 확정용)
- **후행 파급**: 이상 이후 연쇄 실패 여부
- **근거 인용 3건 이내**: 위 판단을 뒷받침하는 로그/프롬프트 발췌

판정 규칙:

- 후보가 여러 개면 **가장 이른 시각의 것**을 근본 지점으로 삼고, 나머지는 파급으로 분류해 본문에 함께 적는다.
- 신호가 전혀 없으면 이슈를 임의로 만들지 말고, 수집 범위와 탐지 결과(무엇을 봤고 무엇이 없었는지)를 제시한 뒤 사용자에게 증상 설명을 요청한다.
- 이상 지점을 특정했더라도 **원인 단정은 하지 않는다.** 이슈 본문에는 관측된 사실과 추정(추정임을 명시)을 구분해 기재한다.

### 3.4 첨부 전 처리

1. 재현과 무관한 구간 제거 — 발생 시각 ±5분, 관련 세션 ID로 한정한다.
2. 2장 마스킹 적용.
3. 프롬프트 원문은 **문제 재현에 필요한 최소 범위**만 발췌한다. 전체 대화 로그를 통째로 붙이지 않는다.
4. 각 증거 블록에 출처와 범위를 명시한다(파일 경로 + 라인 범위, 또는 "세션 `<id>` 3번째 턴의 서브에이전트 프롬프트").

### 3.5 첨부 방식

GitHub REST API의 issue 생성 엔드포인트는 **바이너리 파일 첨부를 지원하지 않는다**(드래그 앤 드롭 업로드는 웹 UI 전용). 따라서 다음 순서로 처리한다.

| 우선순위 | 방식 | 조건 |
|---|---|---|
| 1 | 이슈 본문 내 `<details>` + 코드블록 인라인 | 발췌가 명확하고 본문 한도 내일 때 |
| 2 | Gist 생성 후 이슈 본문에 링크 | 로그가 크거나 전체 컨텍스트가 필요할 때 |
| 3 | 로컬 경로·라인 범위만 명시 | 마스킹 부담이 크거나 위 두 방식이 불가할 때 |

이슈 본문은 GitHub 제한상 65536자를 넘길 수 없다. 초과 시 방식 2로 전환한다.

> **Gist 주의**: secret gist는 비공개가 아니라 **URL을 아는 누구나 접근 가능**하다. 사내 정보 보호 수단이 아니므로, Gist에 올리는 내용에도 2장 규칙을 동일하게 적용한다.

```bash
curl -sS -X POST https://api.github.com/gists \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d @gist-payload.json
```

---

## 4. 항목 확정 (수집 우선 · 질의 최소화)

3장 수집·분석으로 **채울 수 있는 항목은 전부 스스로 채운다.** 아래 표의 "확보 방법"이 자동인 항목을 사용자에게 되묻지 않는다. 질의는 사용자만 알 수 있는 항목과 분석 결과 확인으로 한정한다.

### 4.1 필수 항목

| 항목 | 설명 | 확보 방법 |
|---|---|---|
| `증상 요약` | 제목용 한 줄 요약 | 자동 (3.3 포착 결과에서 도출, 사용자 확인) |
| `재현 절차` | 입력 프롬프트 포함, 번호 매긴 단계 | 자동 (세션 턴 재구성) |
| `기대 동작` | 정상이라면 어떻게 되어야 하는가 | 질의 (자명한 경우 자동 서술 후 확인) |
| `실제 동작` | 관측된 결과 | 자동 (로그·응답) |
| `발생 시각` | ISO8601, 로그 구간 특정용 | 자동 (3.3 최초 이상 발생 지점) |
| `재현성` | 항상 / 간헐적(빈도) / 1회성 | 질의 (동일 패턴이 로그에 반복되면 자동 추정 후 확인) |

### 4.2 환경 항목 (자동 수집 우선)

| 항목 | 수집 명령 / 출처 |
|---|---|
| OpenCode 버전 | `opencode --version` |
| omo(oh-my-openagent) 버전 | omo 설정 또는 `omo --version` |
| makdoong2-team 커밋/브랜치 | `git -C <plugin-path> rev-parse --short HEAD` |
| OS / 커널 | `cat /etc/os-release; uname -r` (WSL2 여부 명시) |
| 런타임 | `node -v`, `bun -v` |
| provider / model | opencode 설정의 활성 provider·model (엔드포인트는 마스킹) |

### 4.3 makdoong2 고유 항목

| 항목 | 설명 |
|---|---|
| `관련 에이전트` | 부장님(orchestrator) 또는 막둥이 8인 중 해당 에이전트명. 미상이면 `unknown` |
| `단계` | 실패한 워크플로 단계. 단계 파일명 그대로 기재(예: `1_planning.jira`). 특정 불가 시 요청 분배 / 에이전트 실행 / 결과 취합 / 응답 반환 중 선택 |
| `세션 ID` | OpenCode 세션 식별자 (로그 상관관계 추적용) |
| `연동 경로` | Teams(Graph API/Power Automate) 경유 여부, MCP 서버 경유 여부 |
| `프롬프트 이상 여부` | 의도치 않은 프롬프트 injection·누락·중복 발생 여부 |
| `에러 메시지` | 원문 (스택트레이스 포함, 마스킹 후) |

### 4.4 분류 항목

| 항목 | 값 |
|---|---|
| `심각도` | `blocker` / `major` / `minor` |
| `영향 범위` | 특정 에이전트 / 오케스트레이션 전체 / 외부 연동만 |
| `시도한 조치` | 이미 해본 우회·수정 내용 (없으면 `없음`) |

질의 규칙:

1. 첫 응답은 질문이 아니라 **분석 결과 제시**여야 한다 — 포착한 이상 지점, 근거, 자동으로 채운 항목을 먼저 보여준다.
2. 그 다음에 미확보 항목만 한 번에 묻는다. 질의는 최대 1회 라운드로 끝낸다.
3. 사용자가 "그냥 등록해"라고 하면 미확보 항목은 `미확인`으로 채우고 진행한다.
4. **2.3의 최종 마스킹 확인은 어떤 경우에도 생략하지 않는다.**

---

## 5. 중복 확인

이슈 생성 전 동일 증상의 열린 이슈가 있는지 검색한다.

```bash
curl -sS -G https://api.github.com/search/issues \
  -H "Authorization: Bearer $GH_TOKEN" \
  --data-urlencode "q=repo:y00njinuk/makdoong2-team is:issue is:open <핵심 키워드>"
```

유사 이슈가 있으면 신규 생성 대신 **코멘트 추가**를 제안하고 사용자 확인을 받는다.

```bash
curl -sS -X POST https://api.github.com/repos/y00njinuk/makdoong2-team/issues/<number>/comments \
  -H "Authorization: Bearer $GH_TOKEN" -d @comment-payload.json
```

기존 열린 이슈(2026-08-26 기준):

| # | 제목 요약 | 영역 | 링크 |
|---|---|---|---|
| 4 | `1_planning.jira` 단계 반복 실패 | 워크플로 단계 | https://github.com/y00njinuk/makdoong2-team/issues/4 |
| 1 | 서브에이전트 호출 시 조건과 무관한 프롬프트 injection | 오케스트레이션/프롬프트 | https://github.com/y00njinuk/makdoong2-team/issues/1 |

동일 단계(`1_planning.jira`)나 동일 injection 증상은 신규 이슈보다 위 이슈에 코멘트로 축적하는 것이 우선이다.

---

## 6. 이슈 본문 템플릿

제목: 기존 이슈(#1, #4)의 규칙을 따른다. 접두 태그 없이, **어디서 무엇이 어떻게 잘못되는지**를 담은 한국어 서술형 한 문장으로 작성한다.

- 기존 예: `1_planning.jira 단계에서 반복적으로 실패가 발생하는 이슈`
- 기존 예: `서브에이전트 호출할 때 조건에 상관없이 불필요하게 특정 프롬프트가 인입(injection) 되는 현상`

제목에도 사내 식별자(고객사명, 사내 시스템명, 실제 Jira 키)를 넣지 않는다. 심각도·에이전트명은 본문 표에 기재한다.

~~~markdown
## 증상
<한두 문장 요약>

## 환경
| 항목 | 값 |
|---|---|
| OpenCode | <version> |
| omo | <version> |
| makdoong2-team | <branch>@<commit> |
| OS | <os> (WSL2: yes/no) |
| Runtime | node <ver> / bun <ver> |
| Provider / Model | <provider> / <model> |
| 발생 시각 | <ISO8601> |
| 세션 ID | <session-id> |

## 재현 절차
1.
2.
3.

## 기대 동작
<...>

## 실제 동작
<...>

## 실패 지점
- 관련 에이전트: <...>
- 단계: <1_planning.jira 등 단계명>
- 연동 경로: <Teams / MCP / 없음>
- 프롬프트 이상: <injection / 누락 / 중복 / 없음>

## 타임라인 (수집 구간: <T-2h> ~ <T>)
| 시각 | 지점 | 관측 내용 |
|---|---|---|
| <ts> | 마지막 정상 단계 | <...> |
| <ts> | **최초 이상 발생** | <...> |
| <ts> | 파급 | <...> |

> 추정: <원인 추정. 추정임을 명시. 근거 없으면 "미상">

## 에러 메시지
```
<마스킹된 원문>
```

## 재현성 / 영향 범위
- 재현성: <항상 / 간헐적(n회 중 m회) / 1회성>
- 영향 범위: <...>

## 시도한 조치
- <...>

## 증거
<details>
<summary>opencode.log 발췌 (라인 &lt;start&gt;-&lt;end&gt;, 마스킹 처리됨)</summary>

```
<log>
```
</details>

<details>
<summary>서브에이전트 프롬프트 발췌 (세션 &lt;id&gt;, 마스킹 처리됨)</summary>

```
<prompt>
```
</details>

> 마스킹 내역: <가린 항목 종류와 건수>
> 마스킹으로 생략된 정보: <있으면 기재, 없으면 "없음">
~~~

---

## 7. 이슈 생성

```bash
curl -sS -X POST https://api.github.com/repos/y00njinuk/makdoong2-team/issues \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d @issue-payload.json
```

`issue-payload.json`은 `title`, `body`, `labels`를 포함한다.

**라벨은 저장소에 실재하는 것만 사용한다.** 현재 이 저장소에는 GitHub 기본 라벨 10개만 존재한다(https://github.com/y00njinuk/makdoong2-team/labels , 2026-08-26 확인).

`accessibility`, `bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`

이 스킬이 생성하는 트러블슈팅 이슈는 기본적으로 `bug` 단독으로 붙인다. 재현 정보가 부족해 추가 조사가 필요한 경우에만 `question`을 병기한다. `agent:*`, `severity:*` 같은 커스텀 라벨은 존재하지 않으므로 사용하지 않는다(미존재 라벨 전달 시 422).

라벨 체계를 확장하려면 이슈 생성 전에 사용자 확인을 받고 별도로 생성한다.

```bash
# 현재 라벨 재확인
curl -sS https://api.github.com/repos/y00njinuk/makdoong2-team/labels \
  -H "Authorization: Bearer $GH_TOKEN"

# 라벨 신규 생성 (사용자 승인 후에만)
curl -sS -X POST https://api.github.com/repos/y00njinuk/makdoong2-team/labels \
  -H "Authorization: Bearer $GH_TOKEN" \
  -d '{"name":"severity:blocker","color":"b60205"}'
```

**본문은 반드시 파일(`-d @file`)로 전달한다.** 코드블록·백틱·개행이 포함되므로 셸 인라인 문자열로 전달하면 깨진다. 전송 후 페이로드 임시 파일은 삭제한다.

```bash
shred -u issue-payload.json gist-payload.json 2>/dev/null || rm -f issue-payload.json gist-payload.json
```

---

## 8. 완료 보고

생성 성공 시 다음만 출력한다.

- 생성된 이슈 번호와 `html_url`
- 이슈 목록 링크: https://github.com/y00njinuk/makdoong2-team/issues
- 포착한 최초 이상 발생 지점(시각·단계·에이전트)과 수집 구간
- 사용된 라벨
- 증거 첨부 방식(인라인 / Gist / 경로 참조)과 마스킹 내역 요약
- `미확인`으로 남긴 항목 목록

실패 시 HTTP 상태 코드와 응답의 `message` 필드를 제시하고, 이슈 본문 전체를 마크다운으로 출력해 수동 등록(https://github.com/y00njinuk/makdoong2-team/issues/new)이 가능하도록 한다.
