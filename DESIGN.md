# makdoong2-team — DESIGN

> **왜 이렇게 만들었는가.** 어떻게 동작하는지는 [ARCHITECTURE.md](./ARCHITECTURE.md), 어떻게 쓰는지는 [README.md](./README.md).

---

## 0. 한 문장 요약

사내 "하네스 엔지니어링" 4기둥 **Constrain → Inform → Verify → Correct** 를 opencode 플러그인 구조로 옮긴 결과물이다.

| 기둥 | 한 줄 정의 | 핵심 구현 |
|---|---|---|
| **Constrain** | 할 수 없게 한다 | 에이전트별 권한 + PreToolUse 훅 + sealed workflow + worktree 격리 |
| **Inform** | 알아야 할 것을 준다 | 단계 명세 3계층 + MCP lazy connect + 절대경로 주입 |
| **Verify** | 정말 했는지 확인한다 | 결정론 셸 게이트 + self_check 5체크 + verifier 에이전트 |
| **Correct** | 틀렸을 때 회복한다 | 모델 폴백 2-track + 재작업 루프 + 무한루프 차단 |

---

## 1. 출발점 — 다섯 실패 모드

LLM 에이전트는 대체로 다섯 가지로 실패한다. 각 기둥은 이 중 무엇을 막는지가 분명해야 한다.

| 실패 모드 | 주 방어 기둥 |
|---|---|
| 환각 함수 호출 | Inform · Verify |
| 긴 세션에서 길을 잃기 | Inform |
| "다 했다" 거짓 보고 | Verify |
| 위험 명령 무방비 실행 | Constrain |
| 같은 실수 무한 반복 | Constrain · Correct |

### 관통하는 설계 원칙 3가지

1. **셸 게이트가 단일 진실 소스.** 같은 검증 로직을 두 군데 구현하지 않는다.
2. **결정론 검증 우선.** 가능하면 LLM 없이 마커와 exit code 로 판정한다.
3. **실패는 격리한다.** 권한과 worktree 로 폭발 반경을 좁힌다.

---

## 2. CONSTRAIN — 못 하게 만든다

### 2.1 겹쳐 쌓은 5계층

한 겹은 반드시 뚫린다. 서로 독립적인 계층을 겹친다.

| 계층 | 구현 | 뚫렸을 때 잡는 다음 계층 |
|---|---|---|
| L1 프롬프트 가드레일 | 에이전트 명세 §금지 | L2 |
| L2 도구 제한 | frontmatter `permission:` (deny/allow/ask) | L4 |
| L3 조건부 승인 | `.policy.auto_approve` 마커 | L4 |
| L4 도구 내부 검증 | `guard-bash.sh` PreToolUse | L5 |
| L5 라이프사이클 훅 | `chat.params` / `tool.execute.before` / `.after` | — |

### 2.2 권한을 역할별로 쪼갠 이유

권한이 좁을수록 사고 반경이 좁다. 그래서 **한 에이전트가 계획·구현·배포를 모두 할 수 없게** 만들었다.

| 에이전트 | 담당 | 핵심 제약 |
|---|---|---|
| `team-leader` | 라우팅 | **git 전면 deny**, 파일 편집 불가 |
| `planner` | 1_planning | 읽기 전용 |
| `analyzer` | analysis | 읽기 + 분석 산출물만 write |
| `engineer` | dev / test | 코드는 짜지만 커밋은 못 한다 |
| `publisher` | 3_delivery | 커밋·푸시는 하지만 코드는 못 고친다 |
| `verifier` | 메타 검증 | 읽기 전용 |

**책임 분리의 두 축**

- **만드는 자와 내보내는 자를 나눈다.** engineer 가 코드를 만들고 publisher 가 그것을 커밋한다. 서로의 영역을 침범할 권한 자체가 없다.
- **오케스트레이션과 실행을 나눈다.** 부장님은 어떤 막둥이를 언제 부를지만 결정한다. 직접 무언가를 실행하기 시작하면 게이트를 우회할 수 있으므로, git 권한을 통째로 뺐다.

> **설계 변경 이력 — hybrid publisher 폐기.** 초기에는 publisher 가 commit spec 을 JSON 으로 계산해 반환하고 부장님이 그 spec 으로 실제 git 을 실행하는 하이브리드였다. 오케스트레이터가 spec 검증과 실행을 모두 떠안았고, "publisher 의 자기선언" 과 "부장님의 실제 실행" 사이 갭에서 마커 불일치가 반복됐다. 지금은 publisher 가 직접 실행하고, 부장님에게서 git 권한을 제거해 갭 자체를 없앴다.

### 2.3 부장님 하드룰 — 프롬프트가 아니라 물리적 차단

프롬프트로 "하지 마" 라고 쓴 규칙은 지켜지지 않을 때가 있다. 부장님의 우회 경로는 훅이 물리적으로 막는다.

1. `write` / `edit` / `patch` / `multiedit` 호출 시 throw — 모든 파일 조작은 `dispatch_stage` 위임 강제.
2. bash 파일 쓰기 리다이렉트 (`>`, `>>`, `tee`, `sed -i`, `python -c open()` 등) 차단. 허용 예외는 `state.sh set` 뿐.

whitelist 를 먼저 매칭한 뒤 file-write 패턴을 탐지한다. FD 리다이렉트(`2>/dev/null`)와 `/dev/null` 은 통과시킨다.

### 2.4 Sealed workflow — 바깥 세계로 새지 않게

서브에이전트가 프로젝트 밖 범용 에이전트(`call_omo_agent`, `delegate_task`, `background_task`, `task_*`)에 위임할 수 있으면, 게이트를 통과하지 않은 작업이 워크플로우에 섞여 들어온다. 그래서 sealed sub-agent 는 이런 툴 호출 시 throw 한다. frontmatter whitelist(1차)를 우회해도 `tool.execute.before`(2차)가 잡는다.

**대신 열어 둔 길**

| 하고 싶은 것 | 허용된 방법 |
|---|---|
| 외부 정보 조사 | `skill_mcp` + jira / confluence / bitbucket / github-oss / bamboo 리서치 skill |
| 다른 substage 작업 | 결과를 부장님에게 반환 → 부장님이 `dispatch_stage` 로 라우팅 |
| 상태 공유 | `state.sh set` 마커 |

금지만 쓰면 다른 잘못된 길로 우회한다. **금지와 대안은 항상 짝으로 쓴다.**

미래에 등장할 위임성 툴(`delegate*` / `spawn*` / `background_*` / `task_*`)도 이름 패턴으로 조기 감지해 경고를 남긴다.

### 2.5 승인 게이트를 어디에 둘 것인가

전부 물으면 사소한 작업도 막히고, 아무것도 안 물으면 위험한 변경이 통과한다. 그래서 **위험도 분류와 승인 여부를 분리**했다.

- `1_planning.requirements` 가 `.policy.category` 를 `minor` / `major` 로 한 번만 판정한다 (LLM 1회).
- 실제 승인 여부는 별개의 `.policy.auto_approve.<substage>` 마커가 결정하고, **기본값은 두 범주 모두 전 substage `true`** — 기본 흐름은 무인이다.
- `category` 는 위험도 라벨이자 향후 이슈 유형별 opt-in 훅의 스위치로 남긴다.
- HITL 이 필요한 예외에서는 planner 가 특정 substage 를 `false` 로 내린다. 그때만 그 substage 앞에 `change-report.md` + 사용자 승인이 요구된다.
- 구형 state (마커 미설정) 는 **모든 단계 승인 요구**로 폴백한다 — 안전한 쪽으로 실패한다.

분류는 LLM 이 하지만 그 뒤 게이트는 마커만 결정론적으로 검사한다. 판단 비용은 1회, 강제는 매번.

**ESCALATION**: `1_planning.requirements` 의 개발 범위 확정에서 실제 범위가 드러나면 `minor → major` **상향만** 허용한다 (하향 금지). 상향은 라벨만 정정하고 `auto_approve` 맵은 건드리지 않는다.

### 2.6 격리 단위로 worktree 를 고른 이유

VM / μVM 같은 물리 격리는 비용이 크다. git worktree 는 싸면서도 필요한 성질을 대부분 준다 — 메인 워킹 디렉토리가 오염되지 않고, 실패하면 디렉토리만 지우면 깨끗하게 복구된다.

**worktree 생성은 LLM 이 하지 않는다.** 마크다운 프롬프트에 "worktree 를 만들어라" 라고 쓰면 브랜치 충돌 감지나 경로 규약을 건너뛰는 경우가 생긴다. 그래서 플러그인의 `auto_advance_stage` 가 dev 진입 시점에 코드로 직접 수행한다 — 충돌 감지, 경로 규약(메인 repo 의 **형제** 디렉토리), 로컬 셋업 파일 동기화, state 기록까지. engineer 는 **이미 준비된** worktree 에서 개발만 한다.

강격리(FireCracker 등)는 적용하지 않았다. 신뢰할 수 없는 코드를 실행하는 용도라면 별도 검토가 필요하다 (§6.4).

### 2.7 모델 티어링

비싼 모델만 쓰면 비용이 쌓이고, 싼 모델만 쓰면 품질이 무너진다. 단계별 책임에 맞춰 티어를 차등한다.

폴백은 **항상 primary 보다 낮은 tier** 여야 한다. `validatePolicies()` 가 모듈 로드 시점과 모든 override 적용 후에 이 불변식을 검사한다. 사용자가 잘못 설정하면 snapshot 을 복원해 defaults 로 부팅한다 — **설정 오류가 워크플로우를 죽이지 않는다.**

---

## 3. INFORM — 알아야 할 것을 준다

정보 부족은 겉보기에 능력 부족과 구분되지 않는다.

### 3.1 세 채널

| 채널 | 비유 | 구현 |
|---|---|---|
| 정적 문서 | 부서 매뉴얼 | `agents/*.md`, `stages/*.md`, `references/` |
| 동적 컨텍스트 | 사내 인트라넷 | 리서치 MCP skill (lazy connect) |
| 이벤트 리마인더 | 모니터에 붙인 포스트잇 | `session-start.sh` |

### 3.2 짧게 쓴다

긴 문서는 컨텍스트만 차지한다. 각 에이전트 명세와 stage 명세를 짧게 유지하고, **금지 옆에는 반드시 대안**을 쓴다.

### 3.3 MCP 는 필요할 때만 연결한다

전체 도구를 항상 로드하면 컨텍스트가 금방 찬다. 각 리서치 skill 의 MCP 서버는 SKILL.md frontmatter 에 embedded 로 선언되어 **skill 을 로드하기 전에는 스폰되지 않는다.**

| skill | 소비자 |
|---|---|
| `jira-research` · `confluence-research` · `github-oss-research` | planner |
| `bitbucket-research` | planner, publisher |
| `bamboo-ci` | 선택 |

engineer 와 analyzer 는 skill 을 로드하지 않는다. **관여하지 않는 단계의 도구는 보이지도 않는다.**

조사는 planner 자신의 세션에서 소스를 순서대로 훑는다. 한때는 소스마다 세션을 갈라 동시에 조사했다(`dispatch_research` fan-out) — 대기 시간을 최장 소스 하나로 줄이고, Jira 코멘트 전체·Confluence 원문·PR diff 가 한 컨텍스트에 겹쳐 쌓이는 것을 막기 위해서였다.

**그 설계를 되돌렸다.** 격리와 병렬은 실제로 작동했지만, 대가로 실패 지점이 N개로 늘고 각 실패가 부모 세션에서 진단 불가능해졌다 — 소스가 왜 죽었는지 알려면 사라진 자식 세션의 로그를 봐야 했다. 관측된 결과는 "조사가 오래 걸리고 한 번도 끝까지 가지 못하는" 것이었고, 원인 규명 비용이 병렬화로 아낀 시간을 넘어섰다. 컨텍스트 잠식은 **소스당 호출 상한(5회)과 요약 강제**로 대신 눌렀다 — 원자료를 초안의 `수집된 정보` 로 접어 넣으면 세션에 남는 것은 결론뿐이다.

교훈은 일반적이다: **격리는 공짜가 아니다.** 격리한 만큼 관측도 격리되므로, 실패가 흔한 경로에서는 격리의 이득보다 진단 불가능의 손실이 크다.

병렬화를 프롬프트가 아니라 **플러그인 코드**에 둔 이유도 원칙 2(결정론)다. "병렬로 호출하라" 는 지시는 모델이 순차로 불러도 이를 감지할 방법이 없다. 코드로 옮기면 병렬성이 관찰 가능한 사실이 된다.

대가로 순서 의존이 생긴다 — skill 로드 전 `skill_mcp` 를 부르면 "MCP server not found" 만 나오고 어떤 skill 을 로드해야 하는지는 안 알려준다. 그래서 문서(1차)와 훅(2차)으로 정확한 skill 이름을 안내한다 (ARCHITECTURE.md §6.4).

### 3.4 경로는 절대경로로 못박는다

dispatch 프롬프트 첫 줄들에 `Working directory` / `Scripts directory (ABSOLUTE)` / `Issue` / `Stage spec` 을 절대경로로 주입한다. 서브에이전트가 `$HOME/.config/opencode/scripts/` 나 상대경로를 추측하는 실패 모드를 원천 차단한다.

반대로 **state.json 안의 산출물 경로 필드는 상대경로만** 쓴다. 절대경로로 저장하면 다른 cwd 에서 읽을 때 opencode 의 permission 심사가 무한 대기에 빠진다 (ARCHITECTURE.md §5.3). 규칙이 방향에 따라 다른 이유다.

### 3.5 세션이 끊겨도 잃지 않게

세션을 잠시 멈추고 돌아오면 진행 상황을 잊는다. `session-start.sh` 가 작업 범주 · 단계별 done/approved 요약 · `verification_pending` 목록 · 최근 이벤트 3개를 stdout 으로 재주입한다.

opencode plugin API 가 SessionStart 이벤트를 노출하지 않아 wire-up 은 운영자 책임이다 (§6.1).

### 3.6 현재 상태와 이력을 분리한다

`state.json` 은 **지금** 만, `events.ndjson` 은 **지나온 것** 만 담는다. 하나로 합치면 상태 조회가 이력 파싱에 끌려간다. `log-event.sh` 가 `jq -nc` 로 안전 escape 후 append 하며, append-only 라 손실되지 않는다. 회고·디버깅·메트릭의 데이터 소스다.

### 3.7 Context Rot 대응

컨텍스트가 길어지면 모델 품질이 떨어진다. 세 가지로 대응한다.

1. **JIT 검색** — 시작할 때 전부 넣지 않는다.
2. **서브에이전트 격리** — 각 단계가 자기 컨텍스트만 본다 (매번 새 서브세션).
3. **컴팩션** — 단계 완료 시 핵심만 다음 단계로. 부분 적용 상태다 (§6.3).

---

## 4. VERIFY — 정말 했는지 확인한다

### 4.1 세 유형을 겹친다

| 유형 | 구현 | 잡는 것 |
|---|---|---|
| 코드 실행 검증 (결정론) | 셸 게이트 + 커버리지 게이트 | 기계적 사실 |
| 셀프 검증 | 단계별 `self_check` 5체크 | 절차 누락 |
| 3자 검증 | `makdoong2-verifier` | 자기선언과 실제의 괴리 |

### 4.2 왜 셸 게이트인가

가장 확실한 검증은 실제로 실행해 보는 것이다. 셸 게이트는 exit code 로만 판정한다.

- LLM 호출 0 → 비용도 지연도 없다
- 어느 환경에서든 같은 게이트가 같게 동작한다
- 단일 진실 소스라 의미가 어긋날 위험이 없다

### 4.3 셸이 못 하는 것 — 확장 게이트

셸은 *기계적 사실* 만 안다. "Jira 본문이 템플릿에 맞는가" 같은 *의미적* 판정은 못 한다.

해결: **LLM 이 판정하고, 그 결과를 마커로 남기고, 플러그인은 마커만 결정론적으로 검사한다.** 예를 들어 `1_planning.jira` 는 6항목을 LLM 으로 검사한 뒤 `validation_passed=true` 를 기록하고, 이후 게이트는 그 boolean 만 본다. LLM 비용은 1회, 강제는 매번.

### 4.4 self_check — 단계마다 다른 5체크

각 단계 종료 직전 그 단계의 에이전트가 자기 출력을 5-boolean 으로 검토해 기록한다. **원칙: 단계마다 위험이 다르므로 같은 형식에 다른 의미를 담는다.**

| 단계 | 5체크의 초점 |
|---|---|
| jira | 6항목 검증 / 인터뷰 / 읽기전용 보존 |
| requirements | 체크리스트 / 충돌 해소 / 사용자 확인 / policy 범주화 / draft 동기화 |
| scope | 경로 명시 / 테스트 범위 / atomic 분할 / 승인 |
| dev | 스코프 충족 / 기존 테스트 / 신규 테스트 / 시크릿 부재 |
| test | 결과 명시 / 커버리지 / attempt 추적 |
| commit | base_sha / atomic / 메시지 컨벤션 / 스테이징 / 시크릿 스캔 |
| pr | 템플릿 / 시나리오 매핑 / draft / 제목 형식 |
| review | 결정 지점 / live 코멘트 / 메트릭 |

**self_check 실패 자체는 차단하지 않는다.** 자가 신고는 신호일 뿐이고, 차단은 verifier 와 사용자 승인이 담당한다.

### 4.5 왜 별도의 verifier 가 필요한가

자기 일을 자기가 검사하면 통과시키는 쪽으로 기운다. Planner / Generator / **Evaluator** 3-Agent 구조의 Evaluator 를 별도 에이전트로 뒀다. 읽기 전용이며 결정론 신호 3개로만 판정한다.

1. `self_check` 5체크가 없거나 하나라도 false → REJECTED
2. 필수 마커(`done_at`, `draft_url` 등) 누락 → REJECTED
3. 안티패턴(빈 응답 / 테스트 삭제 / `as any` / 인라인 disable / 도구 난사) → REJECTED

**안티-환각 floor**: `<verifier-verdict>` 태그를 못 찾으면 자동 REJECTED. "검증했다고 말했지만 결론이 없는" 무음 통과를 원천 차단한다.

대가는 비용이다 — 단계당 1콜 추가, 전체의 15% 미만으로 추산한다 (§6.2).

### 4.6 완료와 승인을 분리한다

"다 했다" 거짓 보고를 막는 핵심은 **완료 선언과 승인을 다른 마커로 두는 것**이다.

| 마커 | 의미 |
|---|---|
| `done_at` | 작업 완료 시각 |
| `verification_pending=true` | 완료 선언 후 검증 대기 |
| `approved_by_user=true` | 사람이 검토·승인 |
| `approved_at` | 승인 시각 |

다음 substage 게이트는 `verification_pending=true` 면 차단하고, `approved_by_user=true` 로만 풀린다. 타임스탬프는 stuck 감지용으로만 쓴다 — 사람의 리뷰 속도는 예측할 수 없으므로 시간 기반 자동 차단은 하지 않는다.

### 4.7 완료 판정은 산문이 아니라 마커로 한다

같은 원칙을 오케스트레이션 층까지 밀어야 했다. 서브세션이 "최종 텍스트를 냈다" 는 사실은 **작업이 끝났다는 증거가 아니다** — 예산을 다 쓰고 "조기종료, 마커 기록 없음" 이라고 정직하게 말하며 끝난 세션도 완주한 세션과 같은 형태로 돌아온다. 그 둘을 구별할 수 있는 값은 게이트와 verifier 가 이미 읽고 있던 그 `.done` 마커뿐이었는데, `dispatch_stage` 만 그것을 보지 않고 `ok: true` 를 반환했다. 부장님은 `output` 의 자연어를 읽고 진행 중이라고 보고했고, 27분이 흔적 없이 사라졌다.

교훈은 §4.6 과 같다: **판정에 쓰는 값과 보고에 쓰는 값을 섞지 않는다.** `output` 은 사람에게 보여줄 서술이고, `completion` / `stage_done` 은 기계가 읽을 판정이다. 서술을 판정으로 쓰는 순간, 자기 작업을 후하게 평가하는 모델의 성향이 그대로 워크플로우의 상태가 된다.

세 번째 상태 `paused` 를 따로 둔 것도 이 분리의 연장이다. "의도적으로 멈췄다"(인터뷰 대기)와 "그냥 못 끝냈다" 는 조치가 정반대이므로, 둘을 하나의 실패로 뭉치면 정상 흐름이 재시도 루프에 갇힌다 — §5.5 의 `ERROR` / `REJECTED` 구분과 같은 형태의 실수다.


---

## 5. CORRECT — 틀렸을 때 회복한다

방지만으로는 부족하다. 회복 경로가 없으면 첫 실패에서 워크플로우가 멈춘다.

### 5.1 네 가지 회복 패턴

| 패턴 | 구현 |
|---|---|
| 감지 → 분석 → 복구 | 게이트 실패 → verifier findings → 재시도/롤백 |
| 재시도 | 모델 폴백 2-track + stall 자동 재디스패치 |
| Human-in-the-Loop | `.policy` 기반 조건부 승인 |
| 무한루프 차단 | REJECTED streak + stall streak 상한 |

**좋은 에러 메시지의 조건**: "무엇이 잘못됐고 어떻게 고치는지" 를 **에이전트가 이해할 형태로** 준다. `guard-bash.sh` 가 차단 사유와 우회 방법을 함께 출력하는 이유다.

### 5.2 모델 폴백을 왜 2-track 으로

모델은 가끔 실패한다 (rate limit, 5xx, context 초과). 상황에 따라 필요한 회복이 다르다.

| 상황 | 트랙 | 방식 |
|---|---|---|
| 대화형 워크플로우 | **A (in-session)** | `get_fallback_model` → `dispatch_stage(model_override=…)` 로 새 격리 세션 재시도. 대화 흐름이 끊기지 않는다 |
| 단발 CI 잡 | **B (out-of-session)** | `with-fallback.sh` 가 `opencode run` exit code 를 보고 다음 모델로 재실행 |

두 트랙 모두 `POLICIES` 를 단일 진실 소스로 참조한다. **SIGINT(130) 는 재시도하지 않는다** — 사용자가 명시적으로 취소한 것을 되살리면 안 된다.

### 5.3 재시도는 깨끗한 컨텍스트에서 (Ralph Loop)

같은 세션에서 계속 재시도하면 실패한 추론이 컨텍스트를 오염시켜 같은 실수를 반복한다. `dispatch_stage` 는 매번 **새 격리 서브세션**을 만들고, 이전 실패 요약만 넘긴다.

여기서 제약이 하나 생긴다 — opencode SDK 는 세션 간 대화 이력 이관을 지원하지 않으므로, **state.json 이 유일한 컨텍스트 승계 수단**이다. state 마커를 성실히 기록하는 규약이 하드룰인 이유다.

### 5.4 REJECTED 재작업 — 사유를 반드시 전달한다

초기 구현에서는 verifier 가 REJECTED 를 내면 부장님이 그 사유를 다음 dispatch 프롬프트에 재주입해야 했다. 그런데 이 로직이 프롬프트 상의 pseudocode 로만 존재해 실제로는 전달되지 않았고, 서브에이전트가 **사유를 모른 채 같은 실수를 반복**하는 무한 루프가 관측됐다.

그래서 사유 전달을 코드로 옮겼다. verifier 가 REJECTED 시 사유를 state.json 에 기록하고, 다음 `dispatch_stage` 가 그 블록을 프롬프트에 자동 삽입한다. **사람의 지시가 아니라 배관이 사유를 나른다.**

### 5.5 무한루프는 두 경로 모두 막는다

재시도는 필요하지만 무한 재시도는 실패다. 두 경로가 대칭으로 막혀 있다.

| 경로 | 신호 | 상한 |
|---|---|---|
| 같은 이유로 계속 REJECTED | 사유 hash 의 `same_reason_streak` | 5회 연속 → 중단·보고 |
| 계속 hang → 재디스패치 | 누적 `hang_history` 길이 | 기본 5회 → 세션 생성 없이 에스컬레이션 |

stall 경로가 별도로 필요했던 이유: 호출 1회 안의 재시도 예산은 부장님이 툴을 다시 부르면 리셋된다. **호출 사이에 보존되는 신호**(state.json 의 `hang_history`)를 상한의 근거로 삼아야 실제로 막힌다.

실측에서 stall 은 primary 와 fallback 양쪽에서 동일하게 발생했다 — **모델 교체는 stall 의 해법이 아니다.** 그래서 이 경로는 폴백이 아니라 사람에게 넘긴다.

### 5.6 사람은 가장 위험한 한 지점에만 부른다

자동화가 클수록 개입 지점을 신중히 골라야 한다. HITL 이 opt-in 된 경우 개입은 **커밋 직전 1곳**에 집중된다. `change-report.md` 를 자동 생성해 사람은 읽고 승인/거부만 결정한다.

| 보고서 섹션 |
|---|
| 요구사항 요약 / 변경 내용 / 테스트 결과 / 위험·영향 범위 / 커밋 계획 |

의사결정 비용을 가장 비가역적인 지점에 몰아준다.

### 5.7 비가역 작업은 사후 복구가 없다

되돌릴 수 없으므로 사전 차단이 전부다.

| 대상 | 메커니즘 |
|---|---|
| `rm -rf` | `guard-bash.sh` |
| `git push --force` | `guard-bash.sh` (마커 없으면 차단) |
| 기타 파괴 명령 | `APPROVED_DESTRUCTIVE` 마커 요구 |

마커는 **사용자가 명시적으로 만들고, 쓰고 나면 지우는 1회용**이다. 상시 존재하면 차단이 무의미해진다.

### 5.8 Hashimoto 원칙 — 실패 1건 = 방지책 1줄

에이전트가 같은 실수를 반복하면 명세에 한 줄을 추가한다. 시간이 지날수록 가드레일이 촘촘해진다. 각 `agents/*.md` 의 §금지 섹션이 그 누적물이다.

---

## 6. 한계 (정직하게)

| # | 한계 | 현황 |
|---|---|---|
| 6.1 | **SessionStart 이벤트 부재** | opencode plugin API 가 노출하지 않아 `session-start.sh` wire-up 은 운영자 책임. 이벤트 추가 시 플러그인이 직접 등록 예정 |
| 6.2 | **Verifier 비용 가산** | 단계당 1콜 추가 (~15%). 비용 민감 환경용 `verifier.enabled: false` 는 계획 단계 |
| 6.3 | **Compaction 정책 부재** | 단계 간 명시적 컴팩션 미구현, 런타임 자동 처리에 위임. `handoff_summary` 마커 미구현 |
| 6.4 | **강격리 샌드박스 부재** | worktree 는 격리 단위지만 OS 수준 격리가 아니다. 신뢰할 수 없는 코드 실행에는 별도 검토 필요 |
| 6.5 | **EDD Eval Baseline 부재** | `smoke-test.mjs` 는 모델 정책 invariant 와 오버라이드 순수성만 본다. 단계 산출물 회귀 게이트는 없다 |
| 6.6 | **비용 상한 · 루프 탐지 부재** | 단계별 토큰/금액 상한 없음. 동일 파일 5회+ 수정 같은 루프 탐지 없음 |
| 6.7 | **보안 검증 게이트 부재** | `npm audit` / Snyk / CodeQL 미통합 |
| 6.8 | **plugin API 버전 의존** | hook payload 시그니처 변경 시 재검증 필요. `chat.params` 로 `sessionID → agent` 매핑을 우회 조달하는 것도 hook input 에 agent ID 가 없기 때문 |

---

## 7. 4기둥은 순환한다

```
   Constrain ──────────▶ Inform
        ▲                   │
        │                   ▼
   Correct ◀────────── Verify
```

- **Constrain → Inform**: 무엇이 금지됐는지가 에이전트에게 전달되어야 우회 시도가 줄어든다.
- **Inform → Verify**: 자가 검증에 필요한 체크리스트가 명세에서 나온다.
- **Verify → Correct**: 검증 실패가 곧 복구 트리거다.
- **Correct → Constrain**: 반복된 실패 패턴이 새 금지 규칙으로 굳는다.

한 바퀴 돌 때마다 가드레일이 조금씩 두꺼워지는 구조다.

### Augment 3-Layer 대응

| Layer | 시점 | 구현 |
|---|---|---|
| Constraint Harness | 생성 전 | frontmatter permission + 훅 |
| Feedback Loops | 생성 직후 | `tool.execute.after` → `sync-state.sh` |
| Quality Gates | 머지 전 | `gates/verify.sh` + 커버리지 게이트 |

---

## 8. 다음 보강 우선순위

| 우선 | 작업 | 기둥 |
|---|---|---|
| 1 | EDD Eval Baseline + regression gate | Verify |
| 2 | Compaction 정책 + `handoff_summary` 마커 | Inform |
| 3 | Cost Cap + Loop Detection | Constrain |
| 4 | `events.ndjson` 기반 메트릭 집계 | Verify |
| 5 | 보안 검증 게이트 (npm audit / Snyk) | Verify |
| 6 | Verifier opt-out 토글 | Correct (비용) |
| 7 | 강격리 샌드박스 (μVM) 검토 | Constrain |

---

## 9. 참고

**이 저장소** — [ARCHITECTURE.md](./ARCHITECTURE.md) (어떻게 동작하는가) · [README.md](./README.md) (어떻게 쓰는가) · [CLAUDE.md](./CLAUDE.md) (개발 규약) · `agents/*.md`, `stages/*.md` (실제 명세)

**외부** — Anthropic *Writing Tools for Agents* / 3-Agent 패턴 · Hamel Husain *Your AI Product Needs Evals* · Mitchell Hashimoto (Ghostty) "실패 1 = 방지 1"
