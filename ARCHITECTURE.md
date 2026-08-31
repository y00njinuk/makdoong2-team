# makdoong2-team — ARCHITECTURE

> **어떻게 동작하는가.** 왜 이렇게 설계했는지는 [DESIGN.md](./DESIGN.md), 어떻게 쓰는지는 [README.md](./README.md).

## 목차

| § | 내용 |
|---|---|
| [1](#1-실행-모델) | 실행 모델 — 한 사이클이 어떻게 돌아가는가 |
| [2](#2-모듈-지도) | 모듈 지도 |
| [3](#3-custom-tool-api) | Custom Tool API (8종) |
| [4](#4-훅과-권한-강제) | 훅과 권한 강제 |
| [5](#5-상태-statejson) | 상태 — state.json |
| [6](#6-게이트) | 게이트 |
| [7](#7-모델-폴백) | 모델 폴백 |
| [8](#8-서브세션-생존-감지와-재시도) | 서브세션 생존 감지와 재시도 |
| [9](#9-tmux-막둥이-pane) | tmux 막둥이 pane |
| [10](#10-무한루프-차단) | 무한루프 차단 (REJECTED / stall / 마커 없는 종료) |
| [11](#11-로깅) | 로깅 |
| [12](#12-배포와-설치-레이아웃) | 배포와 설치 레이아웃 |
| [13](#13-실패-모드와-복구) | 실패 모드와 복구 |
| [14](#14-확장-포인트) | 확장 포인트 |
| [15](#15-용어) | 용어 |
| [A](#부록-a-v100-breaking-changes) | 부록 A — v1.0.0 breaking changes |

---

## 1. 실행 모델

Jira 이슈 하나를 **3 phase · 9 substage** 로 나눠 역할별 에이전트에게 위임한다.

```
1_planning        jira → requirements → scope      planner (한 세션에서 3개 연속 처리)
                          ↓ worktree 자동 생성 (auto_advance_stage)
2_implementation  analysis → dev → test            analyzer, engineer (격리된 worktree)
3_delivery        commit → pr → review             publisher (직접 실행)
```

### 한 substage 의 라이프사이클

```
부장님 ──① auto_advance_stage ──▶ state.json 마커 검사 → 다음 stage 결정 → 게이트 검증
       ◀── { target_stage, agent, model, next_action }

       ──② dispatch_stage ──────▶ 게이트 재검증
                                  └▶ session.create (parentID = 부장님 세션)
                                     session.prompt (절대경로 헤더 5줄 + stage spec 참조)
                                     pollSubSession (2초 폴링, 기본 30분 상한)
                                     tmux pane spawn / close
       ◀── { ok, session_id, output }

       ──③ dispatch_verifier ───▶ verifier 서브세션 spawn → self_check·마커·안티패턴 검사
       ◀── { verdict: VERIFIED | REJECTED }

       VERIFIED → ①로 복귀 (다음 substage)
       REJECTED → 사유를 state.json 에 기록 → ②로 복귀 (사유가 프롬프트에 자동 주입됨)
```

핵심 규칙 세 가지:

1. **부장님은 게이트를 통해서만 진입한다.** 마크다운 체크리스트를 신뢰하지 않는다.
2. **부장님은 파일도 git 도 건드리지 않는다.** 모든 실행은 dispatch 로 위임된다.
3. **모든 서브세션은 격리된 새 세션이다.** 재시도할 때도 마찬가지다. 세션 간 컨텍스트 승계 수단은 state.json 뿐이다.

### 통합 Planning

`1_planning.jira` 를 dispatch 하면 `stages/01-planning.md` 통합 spec 이 적용되어 **한 planner 세션이 jira → requirements → scope 를 순서대로 완료**한다. verifier 가 3개 substage 마커를 한 번에 확인하고, 이후 `auto_advance_stage` 는 곧바로 `2_implementation.analysis` 로 넘어간다.

planner 가 인터뷰가 필요하다고 판단하면 `interview_required=true` 를 기록하고 종료한다. 부장님이 사용자 인터뷰를 진행한 뒤 `context` 파라미터에 답변을 실어 `dispatch_stage(jira)` 를 재호출한다. requirements / scope 단독 dispatch 는 planner 중도 실패 시의 폴백 경로다.

---

## 2. 모듈 지도

### 플러그인 (TypeScript)

| 파일 | 책임 |
|---|---|
| `src/opencode-plugin.ts` | 플러그인 본체. 훅 3종 + custom tool 7종 등록. dispatch 루프·재시도·세션 수명 관리 |
| `src/poll-sub-session.ts` | 서브세션 생존 감지 (§8) |
| `src/tmux-monitor.ts` | 막둥이 pane spawn / 지연 attach / orphan 회수 (§9) |
| `src/config.ts` | `makdoong2-team.json` 로더 (1회 캐시). 경로 해석 |
| `src/model-fallback-policy.ts` | primary → fallback 체인 단일 정의 + invariant 검증 |
| `src/agent-stage-config.ts` | `Stage` 타입, 에이전트 spec, stage → spec 파일 매핑 |
| `src/stall-escalation.ts` | `hang_history` 기반 재디스패치 차단 판정 (§10.2) |
| `src/stage-completion.ts` | substage 마커로 완료 여부 판정 — `done` / `paused` / `incomplete` / `unknown` (§10.3) |
| `src/research-fanout.ts` | 병렬 리서치 fan-out 의 순수 계약 — 소스 레지스트리, 쿼리 정규화, 출력 파싱, 병합 (§3.6) |
| `src/skill-mcp-registry.ts` | SKILL.md frontmatter 스캔 → `mcp_name → skill_name` 룩업 |
| `src/mcp-secret-injector.ts` | MCP 초기화 전 secret in-place 주입 |
| `src/verdict-hash.ts` | verdict 사유 hash (streak 판정용) |
| `src/issue-reporter-guard.ts` | issue-reporter 스킬의 사용자-전용 트리거 판정 (§4.6) |
| `src/redact-secrets.ts` | 로그·출력 시크릿 마스킹 |
| `src/session-index.ts` | 세션 ↔ 이슈/스테이지 인덱스 |
| `src/logger.ts` | level 임계값 + stdin/file 모드 (§11) |
| `src/model-chain-cli.ts` | 체인 JSON 을 stdout 으로 노출 (Track B 소비용) |

> **주의**: opencode 플러그인 로더는 진입 파일의 **모든 named export 를 plugin factory 로 호출**한다. 신규 helper 는 반드시 별도 파일에 두고 import 한다. `test/plugin-exports-shape.test.ts` 가 export 집합을 고정해 회귀를 막는다.

### 훅 · 셸 (LLM 호출 0)

| 파일 | 책임 |
|---|---|
| `src/hooks/guard-bash.sh` | PreToolUse — 파괴 명령 차단, `git push` 게이트 |
| `src/hooks/sync-state.sh` | PostToolUse — `git commit` 감지 시 state 마커 자동 기록 |
| `src/hooks/session-start.sh` | 세션 시작 시 state + events tail 재주입 (외부 wire-up) |
| `gates/verify.sh` + `stage*-verify.sh` | 결정론 진입/사후 게이트 |
| `scripts/state.sh` | state.json CRUD (`init`/`get`/`set`/`migrate`/`root`/`issue`) |
| `scripts/config.sh` | 셸 측 설정 리더 (`get <dotted.key> [default]`) |
| `scripts/wt-sync-ignored.sh` | worktree 로컬 셋업 파일 동기화 (양방향) |
| `scripts/rollback-commits.sh` | commit REJECTED 재작업 시 `reset --soft` |
| `scripts/log-event.sh` | append-only NDJSON 이벤트 로거 |
| `scripts/with-fallback.sh` | Track B 모델 폴백 프로세스 래퍼 |
| `scripts/lint-agent-prompts.sh` | agent 프롬프트 정적 lint (flat 표기 검출) |

### 명세 · 배포

| 파일 | 책임 |
|---|---|
| `agents/*.md` | 8개 에이전트 frontmatter + 시스템 프롬프트 (워크플로우 7 + issue-reporter) |
| `command/*.md` | 사용자 커맨드 (`/makdoong2-issue-reporter`) — configDir `command/` 로 배포 |
| `stages/*.md` | substage 명세 (진입 게이트, 절차, self_check) |
| `scripts/model-policy.mts` | `model-fallback-policy.ts` 의 순수 미러 (CLI·smoke-test 공유, import 0개) |
| `scripts/install-lib.mts` | 배포 로직 (`bin/cli` + `postinstall` 공유) |
| `bin/cli.ts` | `install` / `uninstall` / `doctor` / `validate`. node 네이티브 실행(소스) |


---

## 3. Custom Tool API

플러그인이 등록하는 **8개 툴**. opencode `tool.*` 네임스페이스에 들어가며, 에이전트 frontmatter `tools:` 에 명시해야 사용 가능하다.

`Stage` 유니온:

```
"1_planning.jira" | "1_planning.requirements" | "1_planning.scope"
| "2_implementation.analysis" | "2_implementation.dev" | "2_implementation.test"
| "3_delivery.commit" | "3_delivery.pr" | "3_delivery.review"
```

### 3.1 `verify_stage` — 게이트 검증만

`{ issue, target_stage }` → `verify.sh` + `checkExtensionGates` 실행.

- 통과: `{ ok: true, gate, agent, primary_only, model, category?, auto_approve? }`
- 차단: `{ ok: false, gate, reason, marker_path? }`

### 3.2 `dispatch_stage` — 검증 + spawn + poll

`{ issue, target_stage, worktree, context?, model_override? }`

1. `hang_history` 상한 검사 — 초과 시 세션을 만들지 않고 즉시 에스컬레이션 (§10.2)
2. `primary_only` 체크 → true 면 즉시 `ok=false`
3. `verify.sh` + `checkExtensionGates`
4. 모델 결정 (`model_override ?? POLICIES[agent].primary.id`)
5. `client.session.create()` — `parentID` 로 부모 세션 지정, `question: false` 로 인터랙티브 차단
6. `client.session.prompt()` — 프롬프트 앞머리에 `Working directory` / `Scripts directory (ABSOLUTE)` / `Issue` / `Stage spec` 절대경로 주입. REJECTED 이력이 있으면 이전 실패 사유 블록 자동 삽입 (§10.1)
7. `pollSubSession()` — 2초 간격 폴링. 상한은 `timeout.per_agent[agent] ?? timeout.substage_minutes` (기본 30분, engineer seed 60분)
8. stall/gone 감지 시 최대 3회 자동 재시도 (§8.4)
9. tmux pane spawn / close, worktree state reverse sync (finally)

반환: `{ ok, stage, agent, model, session_id, output, completion, stage_done }` (`output` ≤ 8000자) 또는 실패 스키마 (§8.6).
**완료 판정은 `completion` / `stage_done` 으로 한다 — `output` 문구가 아니다** (§10.3).

### 3.3 `dispatch_verifier` — 3자 검증

비 primary-only 단계 직후 호출. `makdoong2-verifier` (읽기 전용) 를 spawn 해 `self_check` 5체크 + 필수 마커 + 안티패턴으로 판정한다. 단일 시도이며 재시도하지 않는다.

반환: `{ ok, verdict: "VERIFIED" | "REJECTED", raw, session_id, parsed }`.
`<verifier-verdict>VERIFIED|REJECTED</verifier-verdict>` 태그를 파싱하며 **태그 누락은 REJECTED** 로 처리한다 (안티-환각 floor). verdict 는 `log-event.sh` 로 `events.ndjson` 에 append 된다 (best-effort).

REJECTED 시 사유 기록·streak 갱신은 §10.1.

### 3.4 `auto_advance_stage` — 다음 단계 계산

`{ issue, worktree? }`

`STAGE_ORDER` 를 따라 `.done` 마커를 순차 검사한다 (`2_implementation.test` 는 `unit`/`integration` 이 `pass`/`skip` 이면 완료). 다음 stage 를 정하고 게이트를 검증하며, **`2_implementation.dev` 진입 직전에는 worktree 를 자동 생성**한다 (§5.4).

반환: `{ ok, current_stage, target_stage, agent, primary_only, model, category?, auto_approve?, next_action }`. 전부 끝났으면 `{ ok: true, done: true }`.
부장님은 `next_action` 지시를 그대로 따르도록 하드룰이 걸려 있다.

### 3.5 `get_fallback_model` — 폴백 advisor

`{ agent, current, reason? }` → `{ next: ModelSpec | null, exhausted, chain, reasonAccepted }`.

### 3.6 `dispatch_research` — 다출처 병렬 조사 fan-out

`{ issue, worktree, queries: [{ source, focus }], context? }`

소스마다 **별도 서브세션을 동시에** 띄워 조사하고, 결과를 하나의 artifact 로 병합한다. `1_planning.requirements` 의 다출처 교차 조사가 이 툴을 쓴다.

| source | skill | MCP |
|---|---|---|
| `jira` | `jira-research` | `works` |
| `confluence` | `confluence-research` | `docs` |
| `bitbucket` | `bitbucket-research` | `repos` |
| `github-oss` | `github-oss-research` | **없음** — WebFetch / site-wide chrome-devtools-mcp |

**왜 플러그인이 fan-out 하는가.** sealed sub-agent 는 스스로 위임할 수 없고(§4.2), "병렬로 호출하라" 는 프롬프트는 **강제할 수단이 없다** — 모델이 순차로 불러도 이를 감지하는 장치가 없다. 코드로 옮기면 병렬성이 결정론이 되고, 소스마다 세션이 갈리므로 한 소스의 원자료가 다른 소스의 컨텍스트를 잠식하지 않는다 (DESIGN.md §3.7).

**동작**:
1. `normalizeQueries()` — 알 수 없는 source·빈 focus·중복은 `rejected`, 병렬 상한 초과분은 `deferred` 로 분리한다. **조용히 버리지 않는다** — 말없이 빠진 조사는 "그 소스엔 아무것도 없었다" 와 구별되지 않는다
2. 재귀 가드 — 호출자가 `makdoong2-researcher` 면 거부 (중첩 fan-out 금지)
3. `Promise.all` 로 세션 동시 생성 → `makdoong2-researcher` 에이전트로 프롬프트 → 소스별 폴링
4. `parseResearchOutput()` — 마지막 ```json 펜스 우선, 없으면 균형 잡힌 중괄호 스캔. **파싱 실패는 실패로 기록한다** (빈 성공으로 뭉개지 않는다)
5. `mergeResearchFindings()` → `.makdoong2-team/<이슈>/research-findings.json` 기록 + `…requirements.research_path` 마커 (상대경로, §5.3)

**실패 격리**: 소스 하나가 죽어도 나머지 결과는 그대로 남는다. 한 소스라도 성공하면 `ok: true` 이고 전 소스 실패 시에만 `ok: false`.

**결손은 필드로 알린다 — 추론시키지 않는다 (issue #9).** 종전에는 3개 중 1개만 성공한 fan-out 과 3개 모두 성공한 fan-out 이 `ok: true` 로 동일하게 보였고, 차이는 호출자가 스스로 알아채야 하는 `failed` 배열뿐이었다. 실제로 이틀 연속 confluence·bitbucket 이 정확히 10분에 타임아웃했는데 planner 는 jira 단독 결과를 완전한 근거로 취급했고, 그 뒤 결손을 직접 메우려다 세션 예산을 소진하고 **마커를 하나도 기록하지 못한 채** 종료했다 (각 27분·17분). 그래서 `classifyFanoutOutcome()` 이 결손을 자체 필드로 승격한다:

| 반환 필드 | 값 |
|---|---|
| `status` | `"ok"` / `"partial"` / `"failed"` |
| `partial` | 일부만 성공했으면 `true` |
| `next_action` | 상태별 지시문 — 부분 성공이면 (1) gaps 명시 (2) **직접 조사로 메우지 말 것** (3) 마커 기록은 생략 불가 |

부분 성공은 `logger.warn` 으로도 남긴다 (기본 로깅 레벨이 `error` 라 debug 로는 보이지 않는다).

**실패한 소스를 자동 재시도하지 않는 이유**: 관측된 두 실패는 모두 예산을 다 쓴 타임아웃이었다. 그 자리에서 재시도하면 같은 결과에 `timeout_ms` 를 한 번 더 쓰고 부모 세션의 시한까지 밀어낸다. 결손을 호출자에게 넘겨 focus 를 좁혀 재호출할지, gaps 로 남기고 진행할지 판단하게 한다.

순수 계약은 `src/research-fanout.ts`, 회귀는 `test/research-fanout.test.ts`.

**설정**: `research.max_parallel` (기본 3, 상한 6), `research.timeout_minutes` (기본 10 — substage 상한보다 짧게 둬서, 답하지 못하는 소스를 기다리는 대신 실패로 기록하고 나머지 결과를 살린다).

### 3.7 `inspect_sub_sessions` — 잔존 세션 진단·정리

`{ issue, abort_orphans?, stale_minutes? }`

이슈에 연결된 자식 세션을 훑어 **orphan**(부모 dispatch 가 끝났는데 여전히 busy) 과 **stale**(지정 시간 초과 busy) 을 판별한다. 기본은 조회만 하고, `abort_orphans: true` 면 abort 까지 수행한다. dispatch 사이나 워크플로우 이상 감지 시 호출한다.

반환: `{ total, orphans, stale, aborted, sessions: [...] }`.

### 3.8 `cleanup_panes` — tmux 수동 정리

`{ grace_seconds? }`. `@mdn2_session` marker 가 붙은 pane 만 kill 한다 (§9.3).

---

## 4. 훅과 권한 강제

### 4.1 훅 3종

| 훅 | 시점 | 하는 일 |
|---|---|---|
| `chat.params` | 매 LLM 호출 | `sessionID → agent` 매핑 저장. **hook input 에 agent ID 가 없어서** 우회 조달하는 용도 |

> **`chat.params` 는 정체성을 downgrade 하지 않는다 (hardrule).** 이 매핑이 sealed 판정의 유일한 입력이므로, 이미 sealed 로 확정된 세션에 makdoong2 소속이 아닌 agent 이름이 들어오면 **무시하고 `logger.warn`** 한다. 실제로 80% NUDGE 프롬프트가 `agent` 를 싣지 않아 opencode 가 기본 에이전트(`build`)로 그 turn 을 돌렸고, `chat.params` 가 매핑을 덮어써 그 뒤로 해당 세션의 outer-world 차단과 산출물 경로 제한이 조용히 풀렸다 (issue #9). 1차 방어는 모든 프롬프트 호출부가 `agent` 를 싣는 것이고(`test/stage-completion.test.ts` 가 5개 호출부 전부를 강제), 이 규칙은 새 호출부가 또 빠뜨려도 보안 속성이 유지되게 하는 2차 방어다.
| `tool.execute.before` | 툴 실행 전 | 부모 세션 캐치 · sealed workflow · leader 하드룰 · `guard-bash.sh` |
| `tool.execute.after` | 툴 실행 후 | `sync-state.sh` 전달 · skill_mcp 오류 보정 |

### 4.2 `tool.execute.before` 가 하는 6가지

1. `dispatch_*` 호출 시 호출자 세션을 `parentSessionByCallID` (callID 별 Map, 스택 폴백) 에 기록 — 자식 세션의 `parentID` 로 전달해 orphan 을 막는다. callID 별로 분리해 두므로 **같은 부모에서 동시 dispatch 해도 parentID 가 섞이지 않는다** (`dispatch_research` 의 병렬 fan-out 이 이 성질에 의존한다)
2. **Sealed workflow** — sealed sub-agent (planner / analyzer / engineer / publisher / verifier / researcher / issue-reporter) 가 outer-world 위임 툴 (`call_omo_agent`, `delegate_task`, `background_task`, `task_create|update|get|list`) 호출 시 throw. 알려지지 않은 위임성 이름(`delegate*` / `spawn*` / `background_*`)은 경고 로그
3. **Leader 하드룰 1** — 부장님의 `write`/`edit`/`patch`/`multiedit` 호출 시 throw
4. **Leader 하드룰 2** — 부장님 bash 의 파일 쓰기 리다이렉트 (`>`, `>>`, `tee`, `sed -i`, `python -c open()`, `node -e writeFileSync` 등) 차단. **허용 예외는 `state.sh set` 뿐**
5. **Issue-reporter 트리거 강제** — `skill(name="makdoong2-issue-reporter")` 를 전용 에이전트 외의 식별된 에이전트가 호출하면 throw (§4.6)
6. `bash` 툴이면 `guard-bash.sh` 실행 — `rm -rf` / `git push --force` 등은 `APPROVED_DESTRUCTIVE` 마커 없으면 exit 2, `git push` 는 `stage7-pr-verify.sh` 게이트 통과 요구

**state.json 조작 하드룰**: state.json **쓰기**는 오직 `state.sh` 로만 한다. `jq > state.json`, `sed -i state.json`, `python -c open()`, `git add state.json` 같은 우회는 이 훅이 즉시 차단한다. **읽기 전용 진단(`ls` / `file` / `head` / `cat` / `jq` / `git check-ignore`)은 차단하지 않는다** — 막으면 `state_unreadable` 복구 절차 자체가 불가능해진다 (§5.5).

### 4.3 2중 방어

| 층 | 위치 | 역할 |
|---|---|---|
| L1 | agent frontmatter `permission:` | opencode 네이티브 deny/allow/ask |
| L2 | `tool.execute.before` + `guard-bash.sh` | 게이트, 파괴 명령, leader 하드룰, sealed workflow |

### 4.4 skill_mcp lazy-load 보정

리서치 skill 의 MCP 서버(`works`/`docs`/`repos`/`bamboo`)는 SKILL.md frontmatter embedded 로 선언되어 **skill 로드 전에는 스폰되지 않는다.** 로드 없이 호출하면 `MCP server "works" not found` 만 나오고 어떤 skill 이 필요한지는 안 알려준다.

- **1차 (문서)** — 각 SKILL.md 상단 "사전 조건" + planner/publisher 프롬프트 `0-pre` 블록의 `mcp_name → skill_name` 매핑
- **2차 (훅)** — 플러그인 init 시 `${configDir}/skills/*/SKILL.md` frontmatter 를 스캔해 registry 구축. `tool.execute.after` 가 "not found" 응답을 감지하면 정확한 skill 이름을 프리펜드한다. 미등록 mcp_name 에는 개입하지 않는다 — registry 는 whitelist 가 아니라 **정보성 룩업**이다

관련: `src/skill-mcp-registry.ts`, `test/skill-mcp-registry.test.ts`.

### 4.5 SessionStart (외부 wire-up)

opencode plugin API 가 SessionStart 이벤트를 노출하지 않으므로, `src/hooks/session-start.sh` 는 Claude Code `settings.json` 의 `hooks.SessionStart` 로 등록하거나 부장님 프롬프트 첫 줄에서 호출한다. state 진행 현황 + `verification_pending` 목록 + `events.ndjson` tail 3개를 stdout 으로 재주입한다.

### 4.6 issue-reporter — 사용자-전용 full-permission 스킬

makdoong2-team 자체의 결함을 GitHub 이슈(y00njinuk/makdoong2-team)로 등록하는 트러블슈팅 도구. **skill + agent + command 3종 세트**로 패키징되어 있고, 셋의 이름이 모두 `makdoong2-issue-reporter` 로 일치해야 동작한다.

| 구성요소 | 파일 | 역할 |
|---|---|---|
| skill | `skills/makdoong2-issue-reporter/SKILL.md` | 수집 → 이상 지점 포착 → 마스킹 → 중복 확인 → 질의 → 이슈 생성 절차 정의 |
| agent | `agents/makdoong2-issue-reporter.md` | `mode: subagent` + `hidden: true` (목록 비노출) + bash/write 전권. 임시 페이로드 파일 생성·curl 을 직접 수행 |
| command | `command/makdoong2-issue-reporter.md` | 사용자 진입점 `/makdoong2-issue-reporter`. `agent:` 필드로 전용 에이전트에 라우팅, `subtask: false` |

**설계 포인트 3가지**:

1. **권한 상승은 에이전트 교체로 달성하되, 그 에이전트는 목록에 띄우지 않는다.** team-leader 의 파일 쓰기·git 제한(frontmatter L1 + 훅 L2)은 그대로 두고, 커맨드가 전권 에이전트로 라우팅한다. 진입점은 커맨드 하나여야 하므로 에이전트는 `mode: subagent` + `hidden: true` 로 **사용자 선택 목록(primary)과 `@` 멘션·task 자동완성 양쪽에서 감춘다**. opencode 의 노출 필터는 일관되게 `mode !== "subagent" && hidden !== true` 다.

   그러면서도 **인라인 실행은 유지된다**: opencode 의 subtask 판정은 `mode === "subagent" && subtask !== false || subtask === true` 이므로, 커맨드의 `subtask: false` 가 `mode: subagent` 를 이겨 자식 세션을 만들지 않고 현재 세션의 에이전트를 전환한다. 덕분에 직전 대화 컨텍스트를 그대로 보고, 마스킹 최종 확인 같은 사용자 문답도 같은 세션에서 이어진다. **`subtask: false` 를 빼면 격리되어 둘 다 잃는다.**

   목록에서 감추는 것과 부를 수 없는 것은 다르다 — opencode 의 `task` 툴은 `subagent_type` 의 mode 를 검사하지 않아 이름만 알면 spawn 된다. 그 간극은 `tool.execute.before` 의 `issueReporterTaskSpawnViolation` 이 닫는다.
2. **command 이름 == skill 이름 (hardrule).** opencode 는 스킬을 자동으로 같은 이름의 커맨드로 노출하는데, 그 커맨드에는 `agent` 필드가 없어 현재 에이전트(권한 제한된 team-leader)로 실행된다. cfg.command 가 먼저 채워지고 같은 이름의 skill-derived command 는 건너뛰어지므로, 같은 이름의 command 파일을 배포해 이를 덮어쓴다. 이름이 어긋나면 권한 없는 진입점이 살아남는다 — `test/issue-reporter-guard.test.ts` 가 일치를 강제한다.
3. **유일한 트리거는 사용자 직접 호출.** 에이전트가 실패를 관측했다고 자율적으로 이슈를 등록하지 않는다. 1차 방어는 SKILL.md description 의 명시, 2차 방어는 `tool.execute.before` 훅 — 전용 에이전트 외의 식별된 에이전트가 `skill()` 로 로드하면 throw 하고 `/makdoong2-issue-reporter` 실행 안내를 반환한다 (`src/issue-reporter-guard.ts`). agent 미상 세션은 outer-world 가드와 동일하게 passthrough.

issue-reporter 는 SEALED_SUBAGENTS 에도 등록되어 있다 — 워크플로우에 참여하지 않지만, outer-world 로 위임하면 마스킹·사용자 승인 게이트가 위임처에서 우회될 수 있기 때문이다. state.json 은 읽기(`state.sh get`)만 허용한다.

**PAT 부재는 실패가 아니라 요청 사유다.** 토큰은 `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/.github` 에서 읽는데, 파일이 없거나 토큰 패턴을 추출하지 못하면 조용히 종료하지 않는다. 수집·분석은 그대로 끝내고, 등록 직전에 발급 URL(fine-grained / classic)과 **최소 권한**(fine-grained: Issues Read and write, classic: `public_repo`, Gist 를 쓸 때만 각각 Gists / `gist` 추가), 저장 명령(`chmod 600` 포함)을 제시하며 사용자에게 발급을 요청하고 대기한다. 발급·저장 주체는 사용자이고 에이전트는 토큰 값을 재출력하지 않는다. `401`/`403` 도 같은 경로를 타되 받은 상태 코드와 `message` 를 덧붙여 재발급을 요청한다. 사용자가 거부하면 본문 전체를 마크다운으로 출력해 수동 등록으로 넘긴다. 절차 원문은 SKILL.md §1.1, 회귀는 `test/issue-reporter-guard.test.ts` → "PAT 부재 — 토큰 발급 요청 절차".

#### 4.6.1 이슈 양식 (SKILL.md §6)

수집·마스킹·승인 게이트를 다 통과해도 **본문이 진단에 쓸 수 없는 형태면 이슈는 값을 잃는다.** 그래서 본문 구조를 프롬프트 재량이 아니라 규약으로 고정한다 — SKILL.md §6 이 제목 규칙, 섹션 구성(필수 11 / 조건부 4), 섹션별 작성 규칙, 제출 전 자기 점검 11항목을 정의한다.

양식의 출처는 이 저장소의 이슈 [#5](https://github.com/y00njinuk/makdoong2-team/issues/5) 다. 그 이슈는 `state.json` 하드룰의 읽기 오탐을 보고했고, 처리 코멘트가 타임라인·로그 발췌·반복 차단 표·의심 코드 지목을 지목하며 "그대로 진단에 쓰였다" 고 밝혔으며 본문 `## 제안` 3건이 항목별로 v1.7.0 수정에 반영됐다. **양식은 그 이슈가 실제로 갖췄던 구성을 역으로 규약화한 것**이고, 그래서 §6 은 발명이 아니라 관측의 고정이다.

| 설계 결정 | 이유 |
|---|---|
| **조건부 섹션 4개를 명시적으로 목록화** (`## 관련 관찰` / `## 참고: 의심 근본 원인 코드` / `## 부수 관찰 (minor)` / `## 제안 (참고)`) | 이전 템플릿은 필수 섹션만 나열했고, #5 가 채운 이 넷은 어디에도 규정돼 있지 않았다. "있으면 좋은 것" 으로 두면 모델 편차에 따라 빠지고, 빠지면 유지보수자가 같은 조사를 다시 한다 |
| **근거 없이 채우는 것도 금지** | 추측으로 만든 `## 제안` 은 진단을 잘못된 방향으로 끈다. 채택 여부는 3장 수집 결과가 정한다 |
| **자기 점검을 `cat` 표시 *전*에 배치** | 표시 후 본문을 고치면 sha256 표시 증명이 무효가 되어 4.6.2 승인 절차를 처음부터 다시 밟아야 한다. 점검을 뒤로 미루면 그 비용을 사용자가 낸다 |
| **열린 이슈 목록을 문서에 하드코딩하지 않는다** (§5) | 과거 §5 에는 #1·#4 스냅샷 표가 있었는데 두 이슈가 삭제되어(`410 Gone`) 중복 판정이 삭제된 이슈를 가리켰다. 목록은 매 실행 시 검색으로 얻는다 |

회귀는 `test/issue-reporter-guard.test.ts` → "이슈 양식 (§6)" 이 강제한다 — 섹션 목록·자기 점검·제목 규약의 존재, 그리고 삭제된 이슈(#1/#4)를 다시 참조하지 않는 것.

#### 4.6.2 GitHub 게시 승인 게이트 (원문 확인 강제)

에이전트가 전권이더라도 **GitHub 에 무엇을 게시하는가**는 사용자가 원문 전체를 보고 승인해야 한다. 승인은 **세션 안의 yes/no 질문**으로 받고, 그 질문이 형식적 절차로 전락하지 않도록 두 조각을 각각 코드가 강제한다.

| 조각 | 무엇을 보장하나 | 누가 강제하나 |
|---|---|---|
| **(가) 의사표시** | 사용자가 실제로 "예" 라고 답했다 | 에이전트 frontmatter 의 `"*-d @/*": "ask"`. opencode 가 bash 툴 실행 전에 permission 프롬프트를 띄우고(`$ <명령 전문>` + Allow once / Allow always / Reject), 거부하면 tool 이 실행되지 않는다 |
| **(나) 정보에 근거한 동의** | 사용자가 본 원문 == 전송되는 원문 | 전송 전 단독 `cat <payload>` 의 sha256 을 `tool.execute.after` 가 기록하고, `tool.execute.before` 가 전송 직전 현재 파일과 대조한다 |

(나)가 따로 필요한 이유는 permission 프롬프트에 **curl 명령만 보이고 본문은 파일 안에 있기 때문**이다. 프롬프트만으로는 무엇이 게시되는지 알 수 없으므로, 세션에 출력된 원문을 동의의 근거로 삼는다.

**패턴과 허용 표기는 한 쌍이다 (hardrule).** 프롬프트는 frontmatter 패턴이 명령 문자열에 매치될 때만 뜨므로, 훅이 허용하는 전송 표기가 그 패턴에 걸리지 않으면 **질문 없이 게시된다**. 그래서 `classifyGithubApiCall` 은 payload 표기를 정확히 `-d @/절대경로` 하나로 고정하고(`APPROVABLE_PAYLOAD_RE`), 의미가 같은 `--data @file`·`--data-binary @file`·`-d=@file` 을 전부 problems 로 차단한다. 한쪽을 고치면 반드시 다른 쪽도 고쳐야 하며, `test/issue-reporter-guard.test.ts` 의 "frontmatter 의 ask 패턴과 훅이 허용하는 표기가 한 쌍이다" 가 이를 강제한다.

> **플러그인 훅으로 승인을 가로챌 수 없다.** `@opencode-ai/plugin` 타입에는 `"permission.ask"` 훅이 선언되어 있지만, 실행 중인 opencode 1.18.23 바이너리의 훅 트리거 목록(`chat.*`, `command.execute.before`, `tool.definition`, `tool.execute.before/after`, `shell.env`, `file.open`, `tab.new`, `experimental.*`)에 **존재하지 않는다** — 1.18.15 타입에만 남은 잔재다. 승인 여부를 플러그인이 코드로 결정할 방법은 없고, frontmatter 패턴이 유일한 수단이다. 또한 permission 이 `allow` 로 해석되면 요청 객체 자체가 만들어지지 않으므로(`Permission.ask` 는 ask 가 하나도 없으면 즉시 return), 훅이 있었더라도 개입 지점이 없다.

**규칙 순서 주의.** opencode 의 `Permission.evaluate` 는 매치되는 규칙 중 **마지막**을 채택한다(`findLast`). 패턴은 glob 이 아니라 `*`→`.*` 정규식 전체 매치다. 따라서 frontmatter 에서 `"*": "allow"` 를 위에, `"*-d @/*": "ask"` 를 아래에 두어야 하며 순서를 뒤집으면 승인 질문이 사라진다.

```
payload 작성(리터럴 절대경로 JSON)
  → 에이전트가 단독 `cat <payload>` 로 원문 전문을 세션에 표시
      (훅: 그 시점의 sha256 을 표시 증명으로 기록)
  → 에이전트가 단일 curl -d @<payload> 로 전송
      → opencode 가 사용자에게 게시 여부를 묻는다 (yes/no)  ← 승인의 의사표시
      → 훅: 형식 검증 + 표시 증명 해시 일치 → 통과
      → 전송 후 표시 증명 폐기 = 1회용
```

`tool.execute.before` 가 issue-reporter 의 bash 를 `classifyGithubApiCall()` 로 분류해 강제하는 규칙:

| 시도 | 판정 |
|---|---|
| `curl` GET / `-G --data-urlencode` (검색·라벨 조회) | 통과 (읽기). ask 패턴에 걸리지 않아 사용자를 묻지 않는다 |
| `curl -X POST/PATCH/PUT/DELETE` 또는 데이터 플래그 | 표시 증명 검증 대상 + 사용자 yes/no |
| 인라인 JSON(`-d '{...}'`) · stdin(`-d @-`) · 상대경로 · 변수 경로 | 차단 — 승인 검증 불가 형태 |
| `--data @file` · `--data-binary @file` · `-d=@file` | 차단 — 의미는 같지만 ask 패턴에 매치되지 않아 질문 없이 전송된다 |
| 쓰기 명령에 체이닝·리다이렉트·명령 치환 혼합 | 차단 — **TOCTOU 방어** (검증 후 같은 명령 안에서 payload 재작성 → 전송하는 우회를 막는다) |
| `gh` CLI (`gh issue create` 등) · node/python/wget 로 GitHub 접근 | 차단 — URL 문자열 없이 게시 가능한 클라이언트라 검증 불가 |
| 표시 없이 전송 · 표시 후 payload 변경 | 차단 — 사용자가 보지 못한 내용은 게시되지 않는다 |

**읽기를 `allow` 로 내리는 것은 편의가 아니라 게이트 설계의 일부다.** 중복 검색·라벨 조회까지 매번 물으면 승인 프롬프트가 일상이 되어 사용자가 습관적으로 승인하게 되고, 정작 게시 시점의 "예" 가 의미를 잃는다.

표시 증명은 **프로세스 메모리에만** 둔다. 디스크에 남기면 이전 마커 방식과 같은 "파일로 존재하는 승인" 이 되어 위조 표면이 다시 생긴다. `cat` 을 단독 실행으로 제한하는 것도 같은 이유다 — `cat p; echo x > p` 를 허용하면 사용자가 본 내용과 파일에 남는 내용이 갈라진다. write 계열 툴이 표시된 payload 를 건드리면 훅이 증명을 즉시 폐기한다.

**남아 있는 취약점: "Allow always".** 승인 프롬프트의 세 번째 선택지는 매치된 패턴을 세션 `approved` 목록에 `allow` 로 추가하고, 그 규칙은 agent 규칙보다 **뒤에** 병합되어 이긴다. 즉 사용자가 한 번 "always" 를 고르면 남은 세션 동안 (가)가 사라진다. 플러그인이 막을 수단은 없다 — 프롬프트 UI 도, 세션 approved 목록도 훅이 닿지 않는다. 완화는 두 가지뿐이다: 에이전트가 안내할 때 "Allow once" 를 고르도록 명시하고(`agents/makdoong2-issue-reporter.md` 하드룰 2-3), (나)는 그와 무관하게 매 전송마다 재표시를 요구하므로 **무엇이 게시되는지는 여전히 사용자가 본다**.

> **2026-08 변경**: 이전에는 사용자가 별도 셸에서 `scripts/issue-reporter-approve.sh <payload>` 를 직접 실행해 `<payload>.approved` 마커(sha256)를 만드는 방식이었다. 그 한 번의 실행이 (가)와 (나)를 동시에 만족시켰지만, 세션을 벗어나 터미널을 오가야 했다. 승인을 세션 안의 질문으로 옮기면서 (가)는 opencode permission 으로, (나)는 표시 증명으로 나누어 넘겼다. 스크립트와 마커 계약은 제거되었다.

관련: `src/issue-reporter-guard.ts`, `test/issue-reporter-guard.test.ts`.

---

## 5. 상태 (state.json)

### 5.1 디렉토리

```
<repo root>/.makdoong2-team/<ISSUE>/
├─ state.json                   # 현재 상태 (stage 마커, self_check, policy)
├─ events.ndjson                # append-only 이력
├─ APPROVED_DESTRUCTIVE         # 파괴 명령 승인 마커 (1회용)
├─ change-report.md             # HITL opt-in 시 사람 승인용 보고서
└─ requirements-draft.md        # 계획 초안 (선택)
```

**위치는 실행 컨텍스트가 결정한다.** `state.sh root()` 는 `git rev-parse --show-toplevel` 을 반환하므로 —

- Planning (메인 repo cwd) → `main-repo/.makdoong2-team/<issue>/state.json`
- Implementation 이후 (worktree cwd) → `worktree/.makdoong2-team/<issue>/state.json`

**동기화**: `auto_advance_stage` 가 worktree 생성 시 forward, `dispatch_verifier` 가 서브세션 create 직전 forward (stale 방지), `dispatch_stage`/`dispatch_verifier` 의 finally 가 성공·실패 무관 reverse.

#### 이 디렉토리는 스스로 git exclude 에 등록한다 (hardrule)

플러그인이 대상 저장소의 **작업 트리 안**에 자기 상태를 만드는 이상, 그것이 `git status` 에 보이지 않게 하는 것도 플러그인 책임이다. `state.sh init` 이 `mkdir -p` 하는 바로 그 자리에서 `.git/info/exclude` 에 `.makdoong2-team/` 를 등록한다 (`scripts/lib/git-exclude.sh` → `ensure_git_exclude_lines`).

등록하지 않으면 `2_implementation.analysis` 가 **구조적으로 통과 불가능**해진다 (issue #6-②). verifier 는 "`git status --porcelain` 이 산출물 외 변경을 보고하지 않을 것" 을 요구하는데, exclude 가 없으면 플러그인 자신의 파일(`events.ndjson`, `state.json`, `requirements-draft.md` …)이 항상 보고된다. 더 나쁜 것은 **그 시점에 exclude 를 고칠 권한을 가진 역할이 파이프라인에 없다**는 점이다:

| 역할 | 왜 못 고치나 |
|---|---|
| analyzer | write 권한이 `workspace-analysis.json` 하나로 제한 |
| team-leader | 하드룰 2 훅이 bash 파일 쓰기를 차단 |
| engineer | `2_implementation.dev` 단계 — analysis 를 통과해야 도달 |

그래서 동일 사유 REJECTED 가 반복되고 사용자가 직접 한 줄을 넣어야만 풀렸다.

**`wt-sync-ignored.sh` 의 `ensure_baseline_gitexclude()` 만으로는 부족하다.** 그 함수는 worktree 생성(= dev 진입) 시점에만 도는데, 플러그인의 wt-sync 호출은 전부 `DEV_OR_LATER_STAGES` / `worktree !== cwd` 로 가드되어 있다. analysis 는 그보다 앞선 **main repo** 단계라 그때는 한 번도 실행되지 않는다. 그래서 등록 지점이 두 곳이다 — `state.sh init`(생성 시점)과 baseline(worktree 시점). 둘 다 같은 헬퍼를 쓰고, `.git/info/exclude` 는 커밋되지 않는 로컬 파일이라 대상 저장소 이력을 건드리지 않는다. worktree 의 `--git-common-dir` 은 main repo 의 `.git` 이므로 한 번 등록하면 양쪽에 적용된다.

이중 안전망으로 **verifier 의 analysis 판정도 `.makdoong2-team/` 를 제외**하고 `git status` 를 읽는다 — 위 두 등록 경로를 타지 않은 in-flight 워크플로우를 구제하기 위해서다.

회귀: `test/git-exclude-registration.test.ts`.

### 5.2 스키마 (hardrule: hierarchical)

`state.sh init <issue>` 가 시드하는 최소 구조:

```json
{
  "issue": "PROJ-12345",
  "worktree": "/abs/path",
  "stages": {
    "1_planning":       { "done": false, "substages": { "jira": {}, "requirements": {}, "scope": {} } },
    "2_implementation": { "done": false, "substages": { "analysis": {}, "dev": {}, "test": { "unit": "none", "integration": "none" } } },
    "3_delivery":       { "done": false, "substages": { "commit": {}, "pr": { "draft_url": null }, "review": { "comments": 0 } } }
  },
  "policy": null
}
```

주요 필드 (`<S>` = `.stages."<PHASE>".substages."<SUBSTAGE>"`):

| 필드 | 의미 |
|---|---|
| `<S>.done` | substage 완료 |
| `<S>.approved_by_user` / `<S>.verification_pending` | 사용자 승인 / 승인 대기 (다음 게이트 차단) |
| `<S>.self_check` | 자가 검증 5-boolean |
| `<S>.hang_history` | stall/gone 이력 배열 (재디스패치 상한 근거, §10.2) |
| `<S>.last_verdict_reason` / `.same_reason_streak` / `.rejected_count` | REJECTED 재작업 컨텍스트 (§10.1) |
| `<S>.test.unit` / `.integration` (2_implementation) | `"pass"` \| `"skip"` \| `"fail"` \| `"none"` |
| `<S>.test.coverage_pct` (2_implementation) | 라인 커버리지 % |
| `.policy.category` | `"minor"` \| `"major"` |
| `.policy.auto_approve.<Stage>` | substage 별 무인 진행 여부 |

**표기 하드룰**: 반드시 `.stages."<PHASE>".substages."<SUBSTAGE>".<field>` 계층 표기를 쓴다. flat 표기 `.stages."1_planning.jira"` 는 **금지** — jq 가 점 포함 문자열을 단일 키로 해석해 phantom 노드를 만들고, verifier 와 `auto_advance_stage` 는 계층 표기만 조회하므로 자기선언 완료가 통째로 무효화된다. `state.sh` 의 `get`/`set` 이 런타임에 flat 을 감지하면 **exit 65** 로 즉시 실패하고 대체 경로를 안내한다.
**예외**: `.policy.auto_approve."1_planning.requirements"` 는 맵 키 이름 자체가 flat 이므로 그대로 둔다.

오염된 state 는 `state.sh migrate <issue>` 로 이관한다 (idempotent). `state.sh init` 을 다시 부르면 자동 migrate 된다.

**스키마 회귀 6층 방어**: ① agent 프롬프트가 계층 표기만 사용 → ② `lint-agent-prompts.sh` 정적 lint (`npm test` 최상단 + pre-push) → ③ `state.sh` 런타임 exit 65 → ④ `state.sh init` 자동 치유 → ⑤ `doctor` phantom 키 스캔 → ⑥ `test/state-sh-schema.test.ts`, `test/doctor-phantom-scan.test.ts`.

### 5.3 산출물 경로는 상대경로만 (hardrule)

state.json 의 산출물 경로 필드는 **`state.sh root()` 기준 상대경로**로 저장한다. 절대경로로 저장하면 다른 cwd 에서 소비할 때 opencode Read tool 이 hang 한다 (worktree 밖 절대경로에 대한 permission 심사가 무한 대기).

| 필드 (`.stages.` 이하) | 값 예시 |
|---|---|
| `"1_planning".substages."requirements".draft_path` | `.makdoong2-team/<이슈>/requirements-draft.md` |
| `"2_implementation".substages."analysis".artifact_path` | `.makdoong2-team/<이슈>/workspace-analysis.json` |
| `"3_delivery".substages."commit".report_path` | `.makdoong2-team/<이슈>/change-report.md` |
| `"3_delivery".substages."review".plan_path` | `.makdoong2-team/<이슈>/review-comment-plan.json` |

**예외**: `.worktree` 는 worktree 위치 자체를 가리키는 앵커이므로 절대경로를 유지한다.

소비 규약 (bash) — legacy 절대경로도 함께 수용한다:

```bash
REL=$(bash <SCRIPTS_DIR>/state.sh get <이슈> '<jq-path>' | tr -d '"')
if [[ "$REL" == /* ]]; then ABS="$REL"; else ABS="$(bash <SCRIPTS_DIR>/state.sh root)/$REL"; fi
```

**자동 마이그레이션**: dev 분기 프롬프트에 삽입되는 `buildDraftPathReadSnippet` 이 legacy 절대경로를 감지하면 상대경로로 재저장한다 (idempotent). 갱신분은 다음 reverse sync 로 메인 repo 에 전파된다.
**회귀 방지**: `test/state-path-relative.test.ts` (15 시나리오), `test/state-path-migration.test.ts` (6 시나리오).

### 5.4 worktree 자동 생성과 격리

- **트리거**: `auto_advance_stage` 가 `2_implementation.dev` 진입 전 `createWorktree()` 호출. 조건은 `.worktree` 가 없거나 null 이거나 메인 repo/cwd 와 동일할 때
- **위치 (결정론)**: 메인 repo 의 **형제** 디렉토리 `parentDir/repoName-<issue>`. 예: `/root/proj` → `/root/proj-PROJ-12345`. 브랜치는 `feature/<issue>`
- **형제 디렉토리 하드룰**: `stage4-dev-verify.sh` ~ `stage7-pr-verify.sh` 의 `assert_worktree_sibling()` 이 `dirname(worktree) == dirname(main repo)` 를 검증한다. 서브디렉토리 배치는 메인 repo `.gitignore` 누출을 유발하므로 금지
- **동기화**: `wt-sync-ignored.sh <worktree> <issue>` (forward) / `--reverse`. 해당 이슈 디렉토리만 복사하고 다른 이슈, `target/`, `node_modules/` 는 제외한다 — cross-issue state 오염 방지
- **복구**: 잘못된 위치의 worktree 는 `git worktree remove <경로>` + `state.sh set <issue> '.worktree' 'null'` 후 `auto_advance_stage` 재호출

### 5.5 읽기는 막지 않는다 — `state.sh status` 와 state_unreadable 복구

state.json 하드룰이 지키는 것은 **쓰기 경로**다. 읽기는 스키마 정합성에 영향을 주지 않으므로 차단하지 않는다.

이 구분이 없던 동안, `auto_advance_stage` 가 `state_unreadable` 을 반환하며 "존재/유효성을 먼저 확인하라" 고 안내하면 — 그 확인 명령(`ls` / `file` / `head`)이 같은 훅에 "우회 조작 시도" 로 막혔다. leader 는 안내받은 복구 명령을 한 줄도 실행하지 못한 채, 차단을 leader 하드룰 2(bash 파일 쓰기) 위반으로 오인해 자체 abort 했다. 워크플로우는 시작조차 되지 않았다.

**판정** (`src/state-access-guard.ts` — `classifyStateJsonAccess`):

| 순서 | 조건 | 판정 |
|---|---|---|
| 1 | 명령에 `.makdoong2-team/<이슈>/state.json` 이 없음 | `unrelated` |
| 2 | 쓰기 지표 (리디렉션, `tee`, `sed -i`, 인터프리터 `-c/-e`, `cp/mv/rm/truncate`, git 쓰기 서브커맨드, 편집기) | `write` — **차단** |
| 3 | 승인된 `state.sh <서브커맨드>` 호출 | `approved-helper` |
| 4 | state.json 을 언급하는 **모든** 세그먼트가 읽기 전용 allowlist (`ls`/`cat`/`file`/`head`/`stat`/`jq`/`grep`/`git check-ignore` …) | `read-only` |
| 5 | 그 외 | `write` — **차단** |

**판정은 인용 구간을 걷어낸 문자열로 한다 (issue #6-③).** 셸에서 따옴표 안의 `>`·`|`·`;` 는 메타문자가 아니라 리터럴인데, 종전에는 명령 문자열 전체를 훑었다. 그래서 analyzer 가 자기 산출물을 검증하려던 읽기 전용 술어

```
jq -e '… and (.task_relevant_files | type == "array" and length >= 1)' workspace-analysis.json
```

가 두 번 잘못 잡혔다 — `length >= 1` 의 `>` 가 "출력 리디렉션" 으로, `|` 가 "세그먼트 경계" 로. 뒷조각의 선두 토큰(`length`)은 읽기 allowlist 에 없으니 차단이다. 리디렉션도 파이프도 없는 명령이었다.

`stripQuotedSpans()` 가 따옴표 **안쪽만 공백으로 덮되 문자 오프셋을 보존**하고, `looksLikeRedirection()` 과 `splitUnquotedSegments()` 가 그 문자열로 판정한다. 오프셋을 보존하는 이유는 마스킹된 문자열에서 찾은 구분자 위치를 원문에 그대로 대응시켜 세그먼트를 잘라내기 위해서다. `>=` 하나만 예외 처리하는 방법도 있었지만 `awk '$1 > 2'`·`grep '>'` 같은 같은 계열이 그대로 남는다 — 셸 문법을 모델링하는 쪽이 맞다.

인용을 걷어내면 **가려지는 것**이 생기므로 두 구멍을 함께 막았다:

| 구멍 | 조치 |
|---|---|
| `bash -c 'echo x > f'` — 인라인 스크립트 안의 리디렉션이 안 보인다 | `sh`/`bash`/`zsh`/`ksh`/`dash` + `-c`, `eval` 을 쓰기 지표에 추가. 스크립트 *파일* 실행(`bash <SCRIPTS_DIR>/state.sh …`)은 `-c` 가 없어 매치되지 않는다 |
| `"$(cat a > b)"` — 큰따옴표 안 명령 치환은 실제로 실행된다 | 큰따옴표 span 에 `$(` 나 백틱이 있으면 덮지 않는다 |

미종료 따옴표도 덮지 않는다 — 메타문자가 계속 보여야 차단 쪽으로 판정된다. 세 경우 모두 **애매하면 차단** 원칙의 적용이다.

2번이 3번보다 먼저인 것이 계약이다 — `state.sh get … ; rm …/state.json` 같은 밀수를 막는다. 4번이 allowlist 인 것도 계약이다: 오탐(읽기를 막음)에는 `state.sh status` 라는 우회로가 있지만 미탐(쓰기를 허용)에는 복구 수단이 없다. **애매하면 차단**한다.

**두 훅이 함께 움직여야 한다.** universal state 훅(`looksLikeSealedStateWrite`)과 leader 하드룰 2(`looksLikeFileWrite`)가 모두 같은 분류기를 쓴다. 한쪽만 고치면 leader 는 여전히 막힌다 — 실제로 그 상태였다.

**`state.sh status <이슈>`** — 승인된 읽기 전용 진단. `state_unreadable` 복구의 1단계이며 `next_action` 이 이 명령을 지목한다.

```
path=/w/.makdoong2-team/PROJ-1/state.json
exists=true            # 파일 부재와 JSON 손상을 구분한다
readable=true          # jq 로 파싱 가능
issue=PROJ-1
worktree=/w
stages=1_planning,2_implementation,3_delivery
phantom_keys=none      # flat 표기 오염 감지 (§5.2)
next=…                 # 정상이 아닐 때만, 실행할 복구 명령
```

exit 0 = 존재 && 판독 가능, exit 1 = 그 외. `state.sh get` 은 값 조회 전용이라 부재와 `null` 값을 stdout 으로 구분하지 못한다(exit code 만 다름) — 존재 확인에는 `status` 를 쓴다.

**회귀 방지**: `test/state-access-guard.test.ts` (분류 계약 + 두 훅 일치 + 서브커맨드 목록 정합성), `test/state-sh-schema.test.ts` (`status` 출력, usage).

---

## 6. 게이트

`gates/verify.sh` 가 dispatcher, `stage*-verify.sh` 가 실제 검증이다. **LLM 호출 0, exit code 로만 판정.** 진입 게이트(`<stage>`)와 사후 게이트(`<stage>_post`)가 따로 있다.

| target substage | 진입 조건 |
|---|---|
| `1_planning.jira` | 초기 진입 (state init) |
| `1_planning.requirements` | jira `done` + `validation_passed` (6항목 검증 통과) |
| `1_planning.scope` | requirements `done` + (`approved_by_user` + `!verification_pending` **또는** `auto_approve`). 마커가 있으면 추가 검사: `ambiguity_score ≤ 0.2`, `spec_hash` 재계산 일치 (spec drift 차단) |
| `2_implementation.analysis` | scope 동일 규칙 |
| `2_implementation.dev` | analysis 완료 + worktree 준비됨 |
| `2_implementation.test` | dev `done` + worktree 격리 검증 |
| `3_delivery.commit` | test `unit`/`integration` ∈ {pass, skip} + coverage ∈ {pass, exempt}. **HITL opt-in (`auto_approve."3_delivery.commit" == false`) 인 경우에만** `change-report.md` + `approved_by_user` 추가 요구 |
| `3_delivery.pr` | commit `done` + worktree clean + `origin/<branch>` 존재 |
| `3_delivery.review` | pr `draft_url` + body_validation 3항목 + approved |

### 6.1 확장 게이트 (LLM 판정 → 결정론 검사)

셸은 기계적 사실만 검증한다. "Jira 본문이 템플릿에 맞는가" 같은 의미 판정은 stage agent 가 LLM 으로 하고 **결과를 마커로 기록**하며, 플러그인의 `checkExtensionGates` 는 그 마커만 결정론적으로 검사한다.

예: `1_planning.jira` 는 `content_template_match` / `content_quality_adequate` / `priority_set` / `assignee_set` / `reporter_set` / `fix_version_handled` 6항목 검사 후 `validation_passed=true` 를 남긴다. LLM 비용은 1회뿐이다.

### 6.2 커밋 원자성 게이트

- publisher 프롬프트: `git add .` / `-A` / `-u` 금지, 파일별 `git add -- "$FILE"` 강제
- `gates/stage6-post-commit-verify.sh`: 각 커밋 SHA 를 순회하며 `git show --name-only --pretty=""` 로 파일 수를 세고 1 초과면 REJECT. 메시지 형식 `<Type>: <이슈키> - <요약>`, Type 허용값, 이슈키 일치, 제목 길이, 마침표, 결합어, 이슈 종료 키워드(Resolves/Closes/Fixes/See also) 도 함께 강제
- verifier 가 같은 스크립트를 재실행해 이중 확인
- 회귀: `test/commit-atomicity-verify.test.ts` (8 케이스)

---

## 7. 모델 폴백

### 7.1 정책 invariant

`validatePolicies()` 가 모듈 로드 시 + 모든 override 적용 후 검사한다.

1. `policy.primary.id ∈ ALLOWED_PRIMARIES` (defaults ∪ `model_policy.allowed_primaries`)
2. `∀ fb ∈ policy.fallbacks: TIER_RANK[fb.tier] < TIER_RANK[policy.primary.tier]` (`low=1 < medium=2 < high=3 < max=4`)

빌트인 defaults 는 `github-copilot/*` 와 `local/*` 브랜드 40개다 (전체 목록: `src/model-fallback-policy.ts` 의 `DEFAULT_ALLOWED_PRIMARIES`).

**오버라이드 원자성**: `applyConfigOverrides()` 는 적용 전 snapshot 을 뜬다. 검증 실패 시 snapshot 을 복원하고 stderr 에 경고한 뒤 **defaults 로 부팅을 완료한다** — 설정 오류가 워크플로우를 죽이지 않는다. `makdoong2-team validate` 로 사전 검증할 수 있다.

### 7.2 두 트랙

| 트랙 | 흐름 | 적합 |
|---|---|---|
| **A — in-session** | `dispatch_stage` 실패 → 부장님이 `get_fallback_model` → `dispatch_stage(model_override=…)` 로 새 격리 서브세션 재시도 | 대화형 워크플로우 |
| **B — out-of-session** | `with-fallback.sh <agent> -- run …` → `model-chain-cli.ts` 로 체인 조회 → 각 모델로 `opencode --model $M run …` (exit ∈ {1,124,137} 이면 다음 모델) | 단발 CI 잡 |

둘 다 `POLICIES` 를 단일 진실 소스로 참조한다. **SIGINT(130) 는 재시도하지 않는다** (사용자 cancel 보호).

---

## 8. 서브세션 생존 감지와 재시도

sub-session hang 은 결이 세 가지이고 각각 별도 감지가 필요하다. 하나라도 빠지면 `dispatch_stage` 가 substage timeout(기본 30분)까지 그냥 기다린다.

| 결 | 원인 | 감지 조건 | 반환 |
|---|---|---|---|
| **status-absent gone** | orphan-scan / 서버 재시작으로 세션이 status map 에서 사라짐 | `!activeSignal && !toolInFlight && !messagesChanged && !status && (sessionEverAppeared 또는 loose alive)` 가 `statusAbsentGraceMs` (기본 **5분**) 이상 연속 유지 | `session_gone` |
| **tool-call stall** | 사용자 승인 대기 (서브에이전트는 승인할 수 없다) | `hasPendingToolCall && !isToolExecuting() && stalledMs >= toolCallStallThresholdMs` (기본 60s) | `permission_stall` |
| **message stall** | LLM API 무응답 (bootstrap hang 또는 mid-stream hang) | `(sessionEverAppeared \|\| sessionAliveByMessages) && busyIndicated && !toolInFlight && (now - lastProgressAt) >= messageStallThresholdMs` | `session_gone` (reason `message_stall`) |

`busyIndicated = status?.type === "busy" || (!status && messages.length > 0)`. worktree cwd 세션은 status map 에 나타나지 않으므로 loose alive 만으로도 성립한다.

tool-call stall 은 abort 직전에 `client.permission.list()` 를 **1회 best-effort 조회**해 이 세션의 대기 중인 permission 요청(id / 카테고리 / 경로 패턴)을 outcome 과 로그에 싣는다 (issue #8 — 종전에는 `stalledMs` 만 남아 대기 대상을 특정할 수 없었다). 조회 불가·빈 결과면 종전과 동일한 무정보 stall 로 진행하되, 메시지에 `opencode.json` 의 `permission.external_directory` 시드 점검(`npx makdoong2-team doctor`)을 안내한다.

### 8.1 왜 grace 가 5분인가

이전 로직은 3폴 연속 absent(≈8초)면 gone 으로 판정했다. slow-first-token 모델의 세션 초기화나 tool-heavy substage 중 서버가 잠시 status push 를 멈추는 구간에서 **대량 false positive** 가 났다 — 실측에서 8초 window 하 SESSION_GONE 15건 중 실제로 죽은 세션은 **0건**. 5분으로 올려 tool-heavy 작업의 최대 정적 구간을 흡수한다.

### 8.2 alive 신호 이중화

플러그인이 두 map 을 유지하고 **두 개의 서로 다른 콜백**으로 넘긴다.

- `sessionActiveToolCount` — `tool.execute.before` 에서 ++, `.after` 에서 --. **0 초과면 지금 툴이 실행 중**이다
- `sessionLastToolExecuteAt` — 양쪽에서 갱신. counter 가 0 이어도 최근 5분 내 활동이면 alive

| 콜백 | 값 | 쓰이는 곳 | 왜 분리했나 |
|---|---|---|---|
| `isRecentlyActive()` | `counter > 0 \|\| (now - last < 5분)` | gone 판정 스킵 | 넓은 창이라야 tool gap 이 긴 세션의 gone 오탐을 막는다 |
| `isToolExecuting()` | `counter > 0` | **완료 판정 유보** | 순간값이라야 정상 종료가 지연되지 않는다. 넓은 창을 완료 판정에 쓰면 모든 substage 가 5분씩 늦어진다 |

map entry 는 `cleanupSubSession` 과 orphan-scan pane-kill 경로에서 삭제되므로 누수가 없다. `tool.execute.before` 의 가드가 throw 하면 `.after` 가 돌지 않아 counter 가 영구 누수되므로, 증분은 try/catch 로 되돌린다 (§4.2).

#### 완료 판정은 툴이 떠 있는 동안 내리지 않는다 (hardrule)

`finish` 는 "이번 assistant 메시지의 **생성**이 끝났다" 는 뜻이지 "세션이 끝났다" 가 아니다. 모델이 tool call 로 턴을 마치면 그 순간 `finish` 가 붙고 곧바로 툴이 실행된다. 그 사이에 폴이 끼면 tool part 는 아직 메시지에 안 보이고 `finish` 만 보여 **완료로 오판**한다 — 실측 2건 모두 `tool.execute.before` 발화 후 110ms / 108ms 안의 폴이었고, `finishComplete=true` + `textLen=0` 으로 preamble-only 재분류 → 세션 abort 로 이어졌다 (GitHub issue #7).

방어는 세 겹이고 서로 독립이다. 한 겹이 없는 환경에서도 나머지가 선다.

1. **`toolInFlight = hasPendingToolCall || isToolExecuting()`** — 메시지 스냅샷과 실시간 훅 신호의 합집합. 스냅샷은 서버 반영이 늦고, 훅 신호는 훅이 안 붙은 호출자에게 없다. `finishComplete` · `contentStable` · gone 판정 · message stall · preamble 재분류가 모두 이 값을 본다.
2. **finish 단독 완료의 한 폴 재확인** — `statusIdle`(서버의 단언)이나 `contentStable`(5분 무변화)이 함께 서 있지 않고 `finish` 뿐이면 한 폴(기본 2s) 뒤 **같은 content 시그니처**를 다시 본 뒤에만 확정한다. 시그니처가 바뀌었다는 것은 내용이 아직 움직인다는 뜻이므로 결론을 미룬다 (관측된 오판 2건 모두 `contentStable=false`). worktree-CWD 세션은 `statusIdle` 이 영영 안 뜨므로 이 경로를 상시로 타지만, 비용은 폴 1회다.
3. **공백 전용 text part 는 `preamble_only` 가 아니다** — `text.length > 0` 만 보면 `"\n\n"` 같은 스트리밍 초기 상태가 trim 길이 0 으로 임계 미만이 되어 무조건 preamble 로 확정된다 (로그의 `textLen=0` 이 이 경로다). `whitespace_only_text` 로 따로 떨어뜨려야 `dispatch_stage` 가 "작업을 다시 하라" 대신 요약 재프롬프트를 보내고 `.done=true` override 도 그대로 걸린다.

**tool-call stall 의 면제도 같은 신호를 쓴다.** tool part 의 state 변화는 content 시그니처(`id:partsLen:textLen`)를 바꾸지 않으므로 5분짜리 sbt 빌드도 "진전 없음" 으로 보이고 기본 임계 60초에서 abort 대상이 된다. `hasPendingToolCall` 이 프로덕션에서 항상 false 이던 동안에는 이 경로가 발화하지 않아 드러나지 않았고, 그 값을 고치는 순간 무장됐다. `isToolExecuting()` 이 참이면 면제한다 — 진짜 권한 대기는 매 폴 도는 `permission.list()` 경로가 요청 ID·패턴까지 짚어 잡고, 그마저 실패해도 절대 타임아웃이 받쳐준다.

회귀: `test/poll-sub-session.test.ts` ("issue #7: 툴 실행 중 완료 오판 방지" 8 케이스).

### 8.3 content-signature 로 진행을 감지

`messagesChanged` = `messages.length` 변화 **또는** 마지막 assistant 컨텐츠 시그니처(`id + parts.length + text_total_length`) 변화.

스트리밍 텍스트가 기존 메시지에 in-place append 되면 length 는 그대로지만 signature 는 바뀐다. 덕분에 planner/publisher 처럼 도구 없이 5분+ 텍스트만 스트리밍하는 substage 에서 status 가 transient drop 돼도 false positive 가 나지 않는다.

### 8.4 자동 재시도와 백오프

- `session_gone` (양쪽 결) 반환 시 `attempt < MAX_ATTEMPTS(=3)` 이면 새 서브세션으로 continue
- `MESSAGE_STALL_BACKOFF_MS = [300_000, 600_000, 1_200_000]` — attempt 1/2/3 에 **5분 / 10분 / 20분**. 이전 값 1/2/4분은 실측에서 tool-heavy substage 의 정상 세션을 false positive 로 죽였다. 5배 상향으로 slow-first-token + heavy tool call gap 을 흡수한다
- `VERIFIER_STALL_THRESHOLD_MS = 1_200_000` (20분) — verifier 는 단일 시도라 배열 최장값을 쓴다. 실제로 소진될 일은 드물다
- 재시도 세션 첫 프롬프트에 state.json 재개 지시를 넣어 `done=true` substage 를 건너뛰게 한다. **SDK 가 세션 간 대화 이력 이관을 지원하지 않으므로 state.json 이 유일한 컨텍스트 승계 수단이다**
- `cleanupSubSession(skipSessionOps)`: status-absent 는 `true` (NotFoundError 이벤트가 부모 세션을 hang 시킴), message_stall 은 `false` (세션이 살아 있어 abort 가 안전)

### 8.5 abort 후 `session.deleted` 를 기다린다

message_stall 감지 시 즉시 `client.session.abort()` 를 쏘지만, 서버는 **최대 112초 뒤에야** `session.deleted` 이벤트를 낸다. 그 사이 서브에이전트가 tool call 을 계속 발사하는 좀비 실행이 실측됐다 (abort 26초/131초 뒤 파일 write).

해소:
- `sessionDeletedWaiters: Map<string, Array<() => void>>` 에 세션별 waiter 등록
- `event` 핸들러가 `session.deleted` 를 감지하면 해당 세션 waiter 를 전부 resolve
- dispatch 경로는 message_stall 직후 `waitForSessionDeleted(sid, SESSION_DELETED_WAIT_MS=30_000)` 로 최대 30초 대기한 뒤에만 재디스패치
- 30초 초과 시 `deleted_event_received=false` 를 로그로 남기고 진행 (safety net)

### 8.6 최종 실패 응답

`outcome_kind: "session_gone"` + `gone_reason: "message_stall" | "status_absent"`.
부장님은 `message_stall` 이면 `get_fallback_model`, `status_absent` 면 사용자 개입 대기를 선택한다.

`outcome_kind == "timeout"` 이면서 `transient_failures == 0` 이면 `retry_disallowed: true` 가 붙는다 — 네트워크·API 오류 없이 model/prompt 이슈로 hang 한 경우이므로 **같은 stage 재호출을 금지**한다. 다른 모델로 1회 한정 재시도하거나 사용자에게 넘긴다.

### 8.7 관련 파일

`src/poll-sub-session.ts` (감지 본체) · `src/opencode-plugin.ts` (재시도 루프, alive 신호, `sessionDeletedWaiters`) · `test/poll-sub-session.test.ts` · `test/dispatch-stage-redispatch.test.ts`.

---

## 9. tmux 막둥이 pane

pane 은 플러그인 프로세스 수명과 독립적이다. in-memory Map 만으로는 플러그인 재초기화·crash 시 orphan 이 남는다. 그래서 **tmux pane user option 을 out-of-process 소유권 marker 로 쓰고, tmux 를 진실의 원천으로 삼는다.**

활성 조건: `process.env.TMUX` 존재 **AND** `tmux.enabled == true` **AND** tmux ≥ 3.0. 그 외에는 모든 메서드가 no-op 이다.

### 9.1 배치 모드

| `tmux.placement` | tmux 명령 | 부장님 pane 리사이즈 |
|---|---|---|
| `window` (기본) | `new-window -a -t <sourcePane> -d -P -F '#{pane_id}' -n mdn2-<stage>-<ses8>` | **없음** — `-d` 로 active window 불변 |
| `pane` (legacy) | `split-window -t <sourcePane> <dir> -d …` + `select-layout` | **매 spawn/kill 마다 발생** (실측 170x44 → 80x44 → 170x44) |

`layout` / `main_pane_size` / `agent_pane_min_width` / `split_direction` 은 `pane` 모드에서만 유효하다. `window` 모드에서 `computeCapacity()` 는 즉시 `EVICTION_DISABLED(0)` 을 반환해 폭 기반 eviction 을 끈다 — 별도 window 는 부장님과 폭을 경쟁하지 않는다.

### 9.2 지연 attach — OSC 누출의 해결책 (hardrule)

**막둥이 pane 은 절대 `opencode attach` 로 시작하지 않는다.** spawn 시에는 placeholder 만 띄우고, 부장님이 그 창을 포커스한 시점에 실제 TUI 로 교체한다.

| 시점 | pane 이 실행하는 명령 | 자식 opencode 프로세스 |
|---|---|---|
| spawn 직후 | `printf '<배너>'; while :; do sleep 86400; done` | **없음** |
| 포커스 이후 | `opencode attach <url> --session <id> --dir <wt>` | 이때 생성 |

**왜 이렇게까지 하는가.** 부장님 프롬프트에 `/0c0c/0c0c/0c0c…` 가 타이핑되던 현상의 원인은 pane 리사이즈가 **아니었다**. 실측:

| 실험 | 결과 |
|---|---|
| 부장님 pane 리사이즈 (170x44 → 80x44) | 추가 OSC 질의 **0회** |
| window 추가/삭제 | 추가 질의 **0회** |
| 자식 `opencode attach` spawn (`placement=window`) | `:0c0c/0c0c/0c0c` **누출** |
| 자식 `opencode attach` spawn (`placement=pane`) | **동일하게 누출** |

실제 원인은 **자식 opencode TUI 가 기동할 때 보내는 팔레트 질의**다 (프로세스당 `\x1b]4;N;?` × 16 + `]10;?` / `]11;?` / `]12;?` = 19개). tmux 는 이 질의에 자체 응답하지 않고 attach 된 실제 터미널로 중계하는데, 왕복 중 응답이 read 경계로 쪼개지면 tmux 가 앞부분만 소비하고 남은 `/GGGG/BBBB` 를 **활성 pane(= 부장님)에 키 입력으로 배달**한다. 누출 빈도는 자식 프로세스 수에 비례하므로 긴 세션에서 substage 수만큼 누적된다.

placeholder 로 자식 프로세스를 아예 만들지 않으면 이 경로가 끊긴다 — 실측 누출 **0건**. `OTUI_PALETTE_IDLE_TIMEOUT_MS` 는 대기 시간만 줄일 뿐 질의 송신을 막지 못해 대안이 아니다. **즉시 attach 모드는 제공하지 않는다** — 재현성 있게 프롬프트를 오염시키는데 얻는 것이 없다 (포커스 1회면 동일하게 live 관찰이 되고, 이후 다른 창으로 가도 attach 가 유지된다).

**포커스 감지 동작** (oh-my-opencode `tmux-core` 설계를 따름):

1. spawn 시 placeholder 를 띄운다
2. `FOCUS_POLL_INTERVAL_MS`(2초) 주기로 `tmux list-panes -aF '#{pane_id}\t#{pane_active}\t#{window_active}'` 를 훑는다. 감시 타이머는 대기 중인 pane 이 있을 때만 돌고, 없어지면 스스로 멈춘다 (`unref()` — 프로세스를 붙잡지 않는다)
3. **`pane_active` 와 `window_active` 가 모두 1** 인 pane 만 포커스로 인정한다. `pane_active` 는 모든 window 의 자기 활성 pane 에 대해 1 이므로 단독 판정은 배경 pane 까지 attach 시킨다
4. `tmux respawn-pane -k -t <paneId> sh -c "<attach 명령>"` 으로 교체한다. 1회성이며 이후 폴링은 no-op. `respawn-pane` 이 non-zero 로 끝나면 `awaitingFocus` 를 되돌려 다음 폴링에서 재시도한다 (in-flight 가드로 2초 주기가 겹치지 않는다)

**불변식**: pane user option (`@mdn2_*`) 은 `respawn-pane` 을 견딘다 (tmux 3.6 실측). 따라서 scan / cleanup / reap / closePane fallback 은 교체 전후 모두 정상 동작하며 marker 를 다시 쓸 필요가 없다.

**실패 pane 진단**: `auto_close_on_failure=false` 로 유지되는 실패 pane 은 `awaitingFocus` 를 유지한다. 나중에 그 창을 선택하면 그때 attach 되어 실패한 막둥이의 트랜스크립트를 볼 수 있다. 이 플래그를 내려버리면 정보 없는 배너만 남는다.

### 9.3 소유권 marker

`spawnPaneInner()` 성공 직후 `tmux set-option -p -t <paneId>` 로 4개를 붙인다.

| Marker | 값 | 용도 |
|---|---|---|
| `@mdn2_session` | sub-session id | cleanup 대상 판별 (필수) |
| `@mdn2_pid` | 플러그인 프로세스 pid | dead reap 스코프 — 다른 live 플러그인 소유 pane 보호 |
| `@mdn2_stage` | stage 라벨 | 진단 |
| `@mdn2_started_at` | unix seconds | race grace window |

**부모 보호 (hardrule)**: `oc` 래퍼가 부모 opencode 를 항상 `opencode "$@" --port` 로 실행하므로, `pane_start_command` 에 `--port` 가 포함된 pane 은 marker 유무와 무관하게 **cleanup 대상이 아니다** (`PARENT_MARKER_PATTERN = /--port(\s|$)/`).

**`cleanup_panes` 툴**: 기본은 `@mdn2_session` marker 가 있는 pane 만 kill 한다. marker 없는 pane(사용자가 수동으로 연 `opencode attach` 포함)은 절대 건드리지 않는다. `grace_seconds: N` 으로 최근 N 초 내 생성된 pane 을 건너뛸 수 있다 (동시 dispatch pane 오살 방지).

**자동 reap (플러그인 init)**: `checkTmuxVersion()` 후 `reapDeadOwnerPanes()` 가 `@mdn2_pid` 가 죽은(`kill -0` 실패) marked pane 만 kill 한다. 현재 플러그인 또는 다른 live 플러그인 소유 pane 은 보존한다.

**closePane fallback**: dispatch finally 의 `closePane(sessionId)` 는 in-memory Map 에서 못 찾으면 `scanOrphans()` marker 재조회 후 kill 한다 (플러그인 재초기화로 Map 이 리셋된 케이스). `window` 모드에서 마지막 pane 이면 `kill-pane` 이 window 까지 정리한다.

### 9.4 orphan-scan 가드

`ORPHAN_SCAN_INTERVAL_MS = 60_000` 주기의 orphan-scan 은 `session.status()` 가 `undefined` 인 pane 을 "세션 소멸" 로 본다. 그런데 **`session.status()` 는 요청 디렉토리 스코프로 필터링**되므로 worktree 에서 만든 서브세션(dev 이후 전 구간)은 부모 status map 에 영원히 안 나타난다. 가드가 없으면 정상 pane 이 60초 격자에서 kill 되고, 그 kill 이 pane 내부 attach 클라이언트를 죽여 → 서브세션 hang → `MESSAGE_STALL` → `REDISPATCH` 로 연쇄된다.

`orphanCleanupGuard(pane, ctx)` 가 kill 직전 3종을 검사하고, 하나라도 걸리면 그 tick 을 skip 한다.

| reason | 조건 | 근거 |
|---|---|---|
| `foreign-live-owner` | `@mdn2_pid` 가 자기 pid 가 아니고 `kill -0` 생존 | reap 과 동일 정책 |
| `spawn-grace` | `@mdn2_started_at` 이 `ORPHAN_SPAWN_GRACE_MS`(120초) 이내 | status map 반영 지연·부트스트랩 창 보호 |
| `tool-activity` | `sessionActiveToolCount > 0` 또는 `sessionLastToolExecuteAt` 이 5분 이내 | status map 이 필터링돼도 실행 중임을 안다 (§8.2 재사용) |

순수 함수로 구현되어 `isPidAlive` 주입으로 단위 테스트된다. 3종을 모두 통과한 pane 만 기존 판정으로 넘어가므로 실제 orphan 회수 경로는 그대로 유지된다.

### 9.5 진단 명령

```bash
# 모든 marked pane
tmux list-panes -aF '#{pane_id}\t#{@mdn2_session}\t#{@mdn2_pid}\t#{@mdn2_stage}\t#{@mdn2_started_at}\t#{pane_start_command}'

# 부모 opencode pane 만
tmux list-panes -aF '#{pane_id}\t#{pane_start_command}' | grep -- '--port'

# 특정 sub-session 의 pane 위치
tmux list-panes -aF '#{pane_id}\t#{@mdn2_session}' | grep ses_XXX
```

### 9.6 관련 파일

`src/tmux-monitor.ts` · `src/opencode-plugin.ts` (`cleanup_panes`, init reap, orphan-scan 가드) · `test/tmux-monitor-orphan.test.ts` · `test/tmux-monitor.test.ts`.

---

## 10. 무한루프 차단

재시도는 필요하지만 무한 재시도는 실패다. REJECTED 경로와 stall 경로가 **대칭으로** 막혀 있다.

### 10.1 REJECTED — 사유 전달 + streak 상한

#### verdict 는 셋이다 — `ERROR` 는 반려가 아니다 (hardrule)

`dispatch_verifier` 는 다섯 갈래의 결과를 `verdictSource` 로 **구분해 로그에 남기면서도** 반환값의 `verdict` 는 전부 `REJECTED` 하나로 눌러 내보냈다. 그래서 호출자는 "검증했고 물렸다" 와 "검증이 아예 수행되지 않았다" 를 구별할 수 없었다 — 조치가 정반대인데도. 실제로 후자가 전자로 보고되어, 마커가 전부 정상이던 `1_planning.jira` 를 부장님이 통째로 재실행했다 (planner 200초). 재검증은 `VERIFIED` 였다 — 원 작업에는 처음부터 결함이 없었다 (GitHub issue #7).

| `verdict_source` | `verdict` | `counts_as_rejection` | `retryable` | 올바른 조치 |
|---|---|---|---|---|
| `verdict_tag` | 태그 그대로 | REJECTED 일 때만 | false | 판정대로 |
| `json_fallback` | 본문 JSON 값 | REJECTED 일 때만 | false | 판정대로 |
| `malformed_output_default` | `REJECTED` | **true** | false | stage 재실행 (형식 위반은 관측 가능한 콘텐츠 결함) |
| `session_failed_default` | **`ERROR`** | false | **true** | **verifier 만 재호출** |
| `session_gone_default` | **`ERROR`** | false | **true** | **verifier 만 재호출** |

- 판정 태그는 세션 실패보다 **우선**한다. 태그를 뱉은 뒤 꼬리가 죽었다면 그 판정은 실제로 산출된 것이다.
- 완화 대상은 판정이 **물리적으로 존재하지 않는** 두 경로뿐이다. `malformed_output_default` 까지 올리면 무한 재호출만 열고 얻는 것이 없다 — 형식 위반은 `same_reason_streak` 이 이미 막는다.
- `ERROR` 는 `rejected_count` · `same_reason_streak` · `last_verdict_reason` 에 **일절 기록되지 않는다.** 그래서 자체 상한이 필요하다: `.verifier_error_streak` 이 `VERIFIER_ERROR_STREAK_LIMIT(3)` 에 닿으면 `verifier_error_streak_exceeded: true` 로 사용자 에스컬레이션. 판정을 얻으면(VERIFIED/REJECTED 무관) 0 으로 리셋된다.
- 반환값에 `next_action` 이 실린다. 부장님은 **그것을 그대로 따른다** — `raw` / `parsed` 문구를 스스로 해석한 것이 이 사고의 직접 원인이었다.

순수 로직은 `src/verifier-verdict.ts`, 회귀는 `test/verifier-verdict.test.ts` (14 케이스). `src/opencode-plugin.ts` 에 export 하지 않는다 (§plugin-exports-shape 계약).

#### 사유 전달과 streak

**문제였던 것.** 초기에는 부장님이 verdict.raw 를 다음 dispatch 프롬프트에 직접 재주입해야 했는데, 이 로직이 프롬프트 상 pseudocode 로만 존재하고 구현이 없었다. 서브에이전트는 **REJECTED 사유를 모른 채 같은 실수를 반복**했고 무한 루프가 관측됐다 (`3_delivery.commit` REJECTED 4~5회 반복).

**dispatch_verifier (REJECTED 시)**

1. verdict raw 를 4000자로 잘라 `<S>.last_verdict_reason` 에 기록 (`JSON.stringify` 로 안전 인코딩)
2. raw 첫 800자의 SHA-256 앞 16자를 `.last_verdict_reason_hash` 에 기록 — timestamp/session_id 같은 가변 필드를 배제하기 위해 앞 800자만 쓴다
3. 이전 hash 와 비교해 `.same_reason_streak` 증감 (동일 +1, 다름 1로 리셋)
4. `.rejected_count` 누적 (전체 재시도 카운터, 리셋 안 함), `.last_verdict_at` 기록
5. `same_reason_streak >= SAME_REASON_STREAK_LIMIT(5)` 이면 응답에 `same_reason_streak_exceeded: true`

**dispatch_verifier (VERIFIED 시)** — `last_verdict_reason` / `_hash` = null, `same_reason_streak` = 0 리셋. `rejected_count` 는 진단용으로 보존.

**dispatch_stage (다음 호출)** — state 에서 `.last_verdict_reason` 을 읽어(`exit 0 && stdout != "null"`), 있으면 프롬프트에 `=== 이전 검증 실패 사유 (재작업 시 참고) ===` 블록을 자동 삽입한다. 블록에는 raw 원문 + 현재 streak + 임계 경고가 들어간다. 각 서브에이전트 프롬프트의 "이전 검증 실패 사유 재주입 처리 규약" 섹션이 이 블록을 읽는 절차를 규정한다.

**부장님** — `same_reason_streak_exceeded == true` 면 재시도를 중단하고 raw + streak 을 사용자에게 보고 후 종료한다. 그 외 REJECTED 는 재시도한다 (dispatch_stage 를 다시 부르기만 하면 사유가 자동 주입된다).

**commit REJECTED 의 rollback** — 부장님은 git 권한이 없으므로 직접 되돌리지 않는다. publisher 가 재작업 진입 시 **다른 어떤 작업보다 먼저** `rollback-commits.sh <이슈키>` 를 실행해 `git reset --soft` 로 base_sha 까지 되돌린 뒤(working tree/index 는 보존) 커밋 계획부터 새로 세운다.

회귀: `test/verdict-reason-injection.test.ts` (8 케이스).

### 10.2 stall — 재디스패치 차단

**문제였던 것.** `MAX_ATTEMPTS = 3` 은 **`dispatch_stage` 호출 1회 내부**의 예산이다. 예산이 소진돼 실패 응답을 받은 부장님이 `get_fallback_model` 을 거쳐 다시 호출하면 예산이 `attempt=1` 로 리셋된다. 실측(60분 관측)에서 `2_implementation.dev` 가 300초 MESSAGE_STALL → REDISPATCH 루프에 빠졌고, **primary 와 fallback 양쪽에서 동일하게 stall** 했다 — 모델 교체는 해법이 아니다. `hang_history` 는 이미 기록되고 있었지만 소비처가 자연어 권고뿐이라 LLM 이 무시하면 강제력이 없었다.

**해결.** 호출 사이에 유일하게 보존되는 신호인 `hang_history` 길이를 `dispatch_stage` **진입 시점**에 검사한다.

1. `state.sh get <issue> '<S>.hang_history // [] | length'` 로 누적값 조회
2. `timeout.stall_escalate_threshold` (기본 5) 이상이면 **세션을 만들지 않고** `{ ok: false, escalate: true, stall_streak_exceeded: true, hang_history_len, threshold }` 즉시 반환
3. substage 완료 시 `hang_history` 를 `[]` 로 리셋 (VERIFIED 시 streak 리셋과 같은 규약)

**리셋 조건은 "substage `done=true`" 다 — "dispatch 정상 반환" 이 아니다 (issue #8).** 세션이 텍스트만 뱉고 `done=false` 로 끝나도 리셋되던 종전 조건에서는, 재-dispatch 를 반복하는 동안 이력이 매번 비워져 `stall_escalate_threshold` 가 사실상 도달 불가였다 (실측: `done=false` 인데 "substage succeeded" 리셋 로그 3건). 리셋 직전에 `.done` 마커를 다시 읽어 정확히 `"true"` 일 때만 리셋하고, 아니면 `[hang_history] reset skipped` debug 로그를 남긴다.

**cwd 정합성 (hardrule)**: `hang_history` 의 read / append / reset 은 **모두 `effectiveWorktree` 컨텍스트**에서 실행해야 한다. `state.sh root()` 가 cwd 의 git toplevel 을 쓰므로, 하나라도 다른 cwd(예: LLM 이 준 `args.worktree`)로 실행하면 다른 state.json 에 기록되어 상한 검사가 무력화된다 (§10.2 stall 재디스패치 차단의 전제).

**fail-open**: `shouldEscalateStall` 은 `hangCount` 가 NaN(state 판독 실패)이면 차단하지 않는다. 판독 불가를 차단으로 취급하면 state 를 못 읽는 환경에서 워크플로우 전체가 교착된다.

관련: `src/stall-escalation.ts` · `src/config.ts` (`DEFAULT_STALL_ESCALATE_THRESHOLD`) · `agents/makdoong2-team-leader.md` ("stall 재디스패치 금지") · `test/dispatch-stage-redispatch.test.ts`.

### 10.3 마커 없는 조용한 종료 — `completion` / `stage_done`

**문제였던 것.** `pollSubSession` 의 `kind: "text"` 는 "최종 assistant turn 이 나왔다" 는 뜻이지 "substage 가 끝났다" 가 아니다. 예산을 전부 쓰고 `"[1_planning 조기종료 — 시한 80% 도달] … 변경한 state.json 마커: 없음"` 이라고 말하며 끝난 세션도 완주한 세션과 **정확히 같은 outcome kind** 를 낸다. `dispatch_stage` 는 이것을 `ok: true` 로 반환했고, 부장님은 `output` 의 자연어를 읽고 사용자에게 "조회 및 템플릿 검증 완료" 라고 보고했다. 27분(`elapsed_ms≈1,624,653`) 뒤 state.json 은 그대로였다 (issue #9).

`hang_history` 도 비어 있었다. `done=false` 라 리셋은 건너뛰었지만(§10.2) **기록도 하지 않았기 때문**에, 이 실패 모드는 호출 간 상한(`stall_escalate_threshold`)에 영영 도달하지 못하고 매 호출이 타임아웃 전체를 태우며 무한 반복될 수 있었다.

**해결.** 완료 판정을 게이트·verifier 가 읽는 그 `.done` 마커로 옮긴다. `src/stage-completion.ts` 의 `classifyStageCompletion()` 이 순수 함수로 판정하고, `dispatch_stage` 는 그 결과를 그대로 싣는다.

| `completion` | 조건 | `stage_done` | `ok` | 부수 효과 |
|---|---|---|---|---|
| `done` | `.done == "true"` | `true` | `true` | `hang_history` 리셋 |
| `paused` | `.done != true` 이고 `.interview_required == "true"` | `false` | `true` | 없음 — 의도된 중단 |
| `incomplete` | `.done == "false"` 이고 pause 마커 없음 | `false` | **`false`** | `hang_history` append (`reason: "no_done_marker"`) |
| `unknown` | 마커를 읽지 못함 (`null` / 리터럴 `"null"`) | `null` | `true` | 없음 — fail-open |

**정확히 `"false"` 를 읽었을 때만 실패로 뒤집는다.** 판독 실패를 실패로 취급하면 state.json 을 못 읽는 환경에서 끝난 작업이 재시도 루프로 들어간다 (`shouldEscalateStall` 의 fail-open 과 같은 이유).

**`paused` 를 따로 둔 이유**: planner 는 `interview_required=true` 를 기록하고 의도적으로 중단할 수 있다 (§1 통합 Planning). 이것을 `incomplete` 로 묶으면 정상 흐름이 실패로 보고되고 `hang_history` 에 누적돼 결국 재디스패치가 차단된다.

**마커 읽기 cwd**: `readMarker()` 는 `effectiveWorktree` 에서 실행한다 — §10.2 의 cwd 정합성 하드룰과 같은 이유다.

**80% NUDGE 문구도 함께 고쳤다.** 종전 문구는 2번 항목에서 `state.sh` 마커 기록을 요구하면서 마지막 줄에서 "새 tool 호출 추가 금지" 라고 못박아 서로 모순됐다. planner 는 Jira 검증 6/6 을 끝내고도 마커를 남기지 않았다. 지금은 마커 기록이 금지의 **명시적 예외**이고, 마커 없이 종료하면 substage 전체가 재실행된다는 대가를 문구가 직접 알린다.

부장님 규약은 `agents/makdoong2-team-leader.md` "substage 완료 판정은 `stage_done` 으로 한다" 절에 있다. 회귀: `test/stage-completion.test.ts`.

---

## 11. 로깅

스키마: `assets/makdoong2-team.schema.json` `.logging` — 필드 4개. 기본값 `{ level: "error", mode: "stdin", path: null, max_bytes: 10485760 }`.

| 필드 | 설명 |
|---|---|
| `level` | `silent`/`error`/`warn`/`info`/`debug`/`trace` 임계값. 지정 레벨 이하만 emit |
| `mode` | `stdin`(기본) = console, `file` = `path` 에 `[ISO8601] [level] message` 기록 |
| `path` | `mode="file"` 일 때만 사용. null/빈 문자열이면 **초기화 실패 (fail-fast)**. doctor 도 같은 상황을 warn |
| `max_bytes` | 회전 임계값 (기본 10 MiB). 초과 시 `<path>.1` 로 rename, 세대는 1개만 유지 |

**개발 규칙**: 플러그인 코드는 `info` 를 쓰지 않는다 (`debug` / `warn` / `error` 만). `info` 는 사용자 최종 통지용으로 예약돼 있고 현재 활성 사용처가 없다.

### File 모드 쓰기 정책 (hardrule)

**절대 truncate 하지 않는다.** 항상 append 하고 크기 초과 시에만 회전한다. 부모 디렉토리는 자동 생성(`mkdirSync recursive`), 쓰기는 항상 동기(`appendFileSync`), 신규 생성 시 `chmod 600`.

이전 구현은 "프로세스별 첫 write 시 truncate" 였다. 한 호스트에서 메인 TUI · 막둥이별 opencode · `npm test` 가 **같은 `path` 를 공유**하므로, 새 프로세스가 뜰 때마다 다른 프로세스의 기록이 통째로 사라졌다 (60분 관찰 중 2회 역행). 세션 구분은 각 라인의 `[pid=N]` 태그로 대체했다.

회전 경합은 설계상 안전하다 — `renameSync` 는 원자적이므로 두 프로세스가 동시에 초과를 관측해도 늦은 쪽은 이미 작아진 파일을 다시 rename 할 뿐이고, 최악의 경우 `<path>.1` 을 덮어쓴다. 부분 손상은 발생하지 않는다.

**Additive scaffolding**: 기존 설정 파일에 `logging.mode`/`path` 가 없으면 install 시 누락 키만 시드한다. `level` 값은 덮어쓰지 않는다.

관련: `src/config.ts` · `src/logger.ts` · `bin/cli.js` doctor · `test/logger.test.ts` · `test/install-lib.test.ts`.

---

## 12. 배포와 설치 레이아웃

### 12.1 npm 전역 모듈

```
<npm-global>/node_modules/makdoong2-team/
├─ bin/cli.js                # install / uninstall / doctor / validate
├─ dist/opencode-plugin.js   # TS → JS 컴파일 산출물 (main)
├─ src/**/*.ts               # 원본 소스
├─ src/hooks/*.sh            # guard-bash, sync-state, session-start
├─ gates/                    # verify.sh + stage*-verify.sh
├─ stages/                   # 01-planning.md … 09-review-comments.md
├─ scripts/                  # state.sh, config.sh, log-event.sh, release.sh …
├─ references/               # commit-convention.md, pr-template.md …
└─ assets/                   # schema.json + default.json
```

빌드는 `npm run build` (`tsc -p tsconfig.build.json`). `.ts` 상대 import 는 `rewriteRelativeImportExtensions` 로 컴파일 시 `.js` 로 재작성된다. `npm publish` 는 `prepack` 훅에서 clean + build 를 자동 수행한다. `src/hooks/*.sh` 는 컴파일 대상이 아니라 `files` 에 명시적으로 포함된다.

### 12.2 opencode 설정 디렉토리

```
~/.config/opencode/
├─ opencode.json               # plugin 배열 + tools 활성화 (CLI 가 패치)
├─ makdoong2-team.json         # 단일 설정 파일 (없을 때만 seed)
├─ agents/makdoong2-*.md
├─ command/makdoong2-issue-reporter.md   # /makdoong2-issue-reporter 진입점 (§4.6)
└─ skills/{jira,confluence,bitbucket,github-oss}-research, bamboo-ci/, makdoong2-issue-reporter/
```

`install` 이 복사하는 것은 **agents / skill / command / 최초 1회 설정 파일** 뿐이다. `dist`, `gates`, `scripts`, `stages`, `references` 는 npm 모듈 안에 남고 `src/config.ts` 의 `resolvePaths()` 가 경로를 해결한다.

리서치 skill 은 SKILL.md 와 `run-*.sh`, 그리고 skill 간 공유 helper `skills/_lib/load-secret.sh` 가 함께 복사된다.

### 12.3 plugin cache seeding

공개 registry 로 옮긴 뒤에는 opencode 내장 npm client 도 패키지를 fetch 할 수 있는데, 그 fetch 는 전역 설치본과 무관하게 해석되므로 업그레이드 후에도 이전 캐시본이 계속 로드될 수 있다.

`install-lib.mjs` 의 `seedOpencodeCache()` 가 `~/.cache/opencode/packages/makdoong2-team@latest/node_modules/makdoong2-team` 을 npm 전역 설치 경로로 심볼릭 링크해 이 문제를 고정한다 (오프라인 설치도 함께 보장).

### 12.4 credential

**배포**: `npm login` 또는 `~/.npmrc` 의 `//registry.npmjs.org/:_authToken=<token>` (chmod 600 필수). 설치하는 쪽은 인증이 필요 없다. 프로젝트 `.npmrc` 는 `.gitignore` 에 있어 실수로 커밋할 수 없고, tarball 에는 실제 토큰이 들어가지 않는다.

**리서치 skill 토큰 (SSoT: `makdoong2-team.json`)**

- 토큰은 오직 `.secrets.<VAR>` 에서만 읽는다. **환경변수·`opencode.json.mcp.*`·개별 `secrets.env` 로 fallback 하지 않는다.** 지원 키: `BITBUCKET_API_TOKEN`, `JIRA_API_TOKEN`, `CONFLUENCE_API_TOKEN`, `BAMBOO_TOKEN`
- 온프레미스 endpoint 는 같은 파일의 `.hosts.<VAR>` 에서만 읽는다
- 각 `run-*.sh` 가 spawn 시 `load-secret.sh` 의 `load_secret_from_makdoong2_config` / `load_host_from_makdoong2_config` 로 jq 조회한다. 미설정 시 각각 **exit 68 / exit 69**
- 토큰 갱신은 다음 skill spawn 부터 반영된다 (재설치 불필요)

**우선순위 충돌** — `opencode.json` 의 `.mcp.*.environment.*` 는 플러그인 미사용 시 필요하므로 삭제하지 않는다. 값이 다르면:

| 경로 | 처리 |
|---|---|
| `skill_mcp` 경유 | `load-secret.sh` 가 spawn 시점에 override + stderr 경고 |
| 직접 MCP 툴 (`repos_*` / `works_*` / `docs_*` / `bamboo_*`) | `src/mcp-secret-injector.ts` + opencode `config` 훅이 MCP 초기화 전 in-place mutation. drift 시 `MCP secret OVERRIDDEN` 경고. 대상은 `MCP_SECRET_MAPPINGS` 로 고정 |

**한계**: MCP 프로토콜상 spawn 후 env 재주입이 불가하므로 토큰을 갱신하면 opencode 재시작이 필요하다.
**legacy 정리**: 이전 `~/.config/opencode/skills/<skill>/secrets.env` 는 install 시 백업 후 자동 삭제된다.

### 12.5 릴리즈

`npm run release:patch|minor|major` (= `bash scripts/release.sh <bump>`) 가 9단계를 순차 실행한다.

1. Pre-flight (working tree clean, 브랜치, 원격 동기화) → 2. `npm test` → 3. 버전 미리보기 → **4. 승인 #1** → 5. `npm version` (커밋 + 태그) → 6. `npm publish --dry-run` → **7. 승인 #2** → 8. `npm publish` → 9. `git push --follow-tags`

publish 이전 실패는 자동 롤백된다 (태그 삭제 + `git reset --hard HEAD~1`). publish 이후 실패는 수동 조치다. 동일 버전 재-publish 는 registry 가 거부하므로 rollback 후 새 버전이 필요하다. `--yes` 는 CI 전용이다.

**git push 자동 배포**: `.husky/pre-push` 가 `scripts/publish-if-changed.sh` 를 호출해 push 대상 커밋의 `package.json` version 변경을 감지하면 같은 2회 승인 게이트를 밟는다. 이미 registry 에 있는 버전은 skip.

#### 12.5.1 승인 프롬프트는 stdin 전용 (`scripts/lib/confirm.sh`)

두 스크립트가 공유하는 단일 `confirm()` 구현이다. **`/dev/tty` 는 쓰지 않는다.**

이전에는 `read -r reply </dev/tty` 였다. pre-push 훅은 stdin 으로 ref 정보를 받으므로 훅 안에서 프롬프트하려면 /dev/tty 가 필요했고, `release.sh` 가 그 패턴을 그대로 복사했다. 그런데 제어 터미널이 없는 환경(에이전트 셸, 컨테이너, CI)에서는 /dev/tty 열기 자체가 실패한다 — macOS `Device not configured`, Linux `No such device or address`. 릴리즈가 그 환경에서 아예 불가능했다.

실패가 조용했던 것이 더 문제였다. read 가 실패해도 `reply` 는 빈 값이라 `case` 가 `*` 로 떨어져 거부로 처리됐고, 호출부는 `사용자가 거부함` 을 찍었다. **물어보지도 못한 것과 거부당한 것이 구별되지 않아** 진짜 원인이 은폐됐다. `publish-if-changed.sh` 에 있던 `[ ! -e /dev/tty ]` 가드도 무력했다 — 존재와 열 수 있음은 다르고, macOS 에서 /dev/tty 는 존재하지만 열리지 않는다.

현재 계약:

| 반환 | 의미 | 호출부 처리 |
|---|---|---|
| `0` | 승인 (`y` / `yes`) | 진행 |
| `1` | 거부 (그 외 응답) | 사용자 거부로 보고 후 중단 |
| `2` | **물어볼 수 없음** (stdin EOF) | `confirm_unavailable()` 로 원인·해결책 안내 후 중단 |

`2` 를 `1` 과 반드시 분리해서 처리한다. 터미널에서는 stdin 이 곧 터미널이라 종전과 동일하게 동작하고, 터미널이 없으면 파이프로 승인을 전달한다:

```bash
printf 'y\ny\n' | npm run release:minor
```

pre-push 훅 경로는 STEP 1 의 while 루프가 stdin 을 EOF 까지 소진하므로 `confirm` 이 항상 `2` 를 반환한다. **의도된 동작이다** — 훅이 사람을 붙잡고 묻는 대신 push 를 막고 정규 경로(`npm run release:<bump>`)를 안내한다. CI 는 `AUTO_YES=1`.

회귀: `test/release-confirm.test.ts` (EOF→2 분리, `/dev/tty` 재유입 차단, confirm 중복 정의 차단).

---

### 12.6 진입점: 소스만 커밋, 산출물은 tarball 전용

저장소에는 **소스만 커밋한다.** 컴파일 산출물(`dist/**` 와 진입점 `.js/.mjs`)은
전부 `.gitignore` 대상이고, 빌드는 필요할 때(개발 타입검사·배포)만 돈다.

| 대상 | tsconfig | 출력 | git | 언제 빌드 |
|---|---|---|---|---|
| 플러그인 | `tsconfig.build.json` (src→dist) | `dist/**` | ignore | `npm run build` (테스트·prepack) |
| 진입점 4개 | `tsconfig.entry.json` (제자리) | `bin/cli.js`·`postinstall.mjs`·`scripts/{install-lib,model-policy}.mjs` | ignore | `npm run build:entry` (prepack) |
| 타입검사 | `tsconfig.json` (noEmit) | — | — | `npm run typecheck` |

#### 개발은 소스, 배포는 빌드

- **개발/테스트**: repo 는 `node_modules` 밖이라 node ≥ 22.18 의 type-stripping 이
  `.ts/.mts` 를 직접 실행한다 — `node bin/cli.ts`, `node scripts/run-tests.mts`,
  `node --test test/*.ts`. 진입점 빌드 없이 `npm test` 가 돈다.
- **배포**: node 는 **`node_modules/` 안의 `.ts` 를 type-stripping 하지 않는다**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, 실측). 그래서 설치된 패키지의
  `bin`(`bin/cli.js`)·`postinstall`(`node postinstall.mjs`)은 빌드된 JS 여야 한다.
  `prepack` 이 `build`(dist) + `build:entry`(진입점)로 만들어 tarball 에 담는다.

#### 제약과 경계

- **실행에 node ≥ 22.18 필요** (`engines.node`) — dev 는 type-stripping, 설치본은
  빌드된 JS 를 쓰지만 어느 쪽도 node 20 에서 테스트/실행을 보장하지 않는다.
  클라이언트(node 24)·컨테이너(node 24)는 충족한다.
- `tsconfig.entry.json` 은 `rootDir="."`·`outDir="."` 제자리 출력 + `files` 명시
  목록(글로브 금지)이다. 파일이 이동하지 않아 `bin`·`postinstall`·`files` 계약과
  pkgRoot 경로 계산(`postinstall` depth 0, `bin/cli` depth 1)이 그대로 유효하다.
- 테스트 러너(`run-tests`·`smoke-test`·`test-postinstall`)는 빌드 대상이 아니다 —
  repo 에서 `.mts` 소스로 실행된다. tarball 에는 그 소스가 그대로 들어가지만
  런타임에 실행되는 것은 진입점 4개의 빌드 JS 뿐이다.

#### 미러(`scripts/model-policy.mts`)의 위치

`bin/cli` 가 `dist/` 없이 도는 진단 성질을 위해 남긴다 — 정본
(`src/model-fallback-policy.ts`)은 `logger→config` 를 끌고 오고 config 는 진단
대상 설정에서 throw 한다. 정본과의 동치는 `test/model-policy-parity.test.ts` 가
매트릭스로 강제한다.

## 13. 실패 모드와 복구

| 실패 | 조치 |
|---|---|
| `validatePolicies()` throw (defaults 자체 위반) | 플러그인 로드 실패. 코드 롤백 |
| 설정 override 위반 | snapshot 복원 → defaults 로 부팅. stderr 경고. `makdoong2-team validate` 로 사전 검증 |
| `verify.sh exit 2` | 게이트 차단. stderr 사유대로 이전 substage 로 복귀 |
| `state.sh exit 65` | flat 표기 사용. 안내된 hierarchical 경로로 재시도 |
| `guard-bash.sh` 파괴 명령 차단 | 의도된 경우 `touch <worktree>/.makdoong2-team/<ISSUE>/APPROVED_DESTRUCTIVE` 후 재시도 (1회용) |
| `guard-bash.sh` push 게이트 차단 | commit 완료 + worktree clean + PR 게이트 조건 충족 후 재시도 |
| `dispatch_stage` session create/prompt 실패 | opencode 서버 확인 → 재시도 또는 Track B 전환 |
| `dispatch_stage` timeout | 서브세션 abort. 컨텍스트 축소 후 재시도. `retry_disallowed=true` 면 같은 stage 재호출 금지 (§8.6) |
| `session_gone` (message_stall) | 자동 3회 재시도 후에도 실패하면 `get_fallback_model` |
| `session_gone` (status_absent) | 사용자 개입 대기 |
| `stall_streak_exceeded` | `hang_history` 상한 도달. 모델 교체로 안 풀린다 — 사용자 에스컬레이션 (§10.2) |
| `dispatch_verifier` REJECTED | `.done` 되돌리고 재dispatch (사유 자동 주입). commit 이면 publisher 가 먼저 `rollback-commits.sh` |
| `dispatch_verifier` ERROR | **verifier 만 재호출.** state.json 을 건드리지 않는다 — 검증이 수행되지 않았을 뿐 stage 산출물은 그대로다. `verifier_error_streak_exceeded` 면 사용자 에스컬레이션 |
| verdict 태그 누락 | 자동 REJECTED (안티-환각 floor) |
| `same_reason_streak_exceeded` | 같은 사유 5회. 재시도 중단, 사용자 보고 |
| Track A `exhausted=true` | 사용자 보고, 수동 대기 |
| Sealed workflow 위반 | outer-world 툴 throw. `skill_mcp` + `dispatch_stage` 대안 사용 |
| Leader 하드룰 위반 | write/edit/patch 또는 bash 파일 쓰기 throw. `dispatch_stage` 위임 |
| skill_mcp lazy-load 순서 위반 | `MCP server "<name>" not found`. 훅이 정확한 skill 이름을 안내 → 로드 후 재시도 |
| 잘못된 위치의 worktree | `git worktree remove` + `.worktree` = null → `auto_advance_stage` 재호출 |
| tmux orphan pane | `cleanup_panes` (marker 있는 pane 만 kill). 진단은 §9.5 |

---

## 14. 확장 포인트

### 새 substage 추가

1. `src/agent-stage-config.ts` — `Stage` 유니온 + `STAGE_SPEC_FILES` + 필요 시 `agentForStage()` / `AGENTS`
2. `src/opencode-plugin.ts` — `STAGE_ORDER` 배열에 삽입
3. `stages/NN-<name>.md` 작성
4. `agents/makdoong2-<role>.md` + `gates/verify.sh` (+ 전용 `stage*-verify.sh`)
5. `scripts/smoke-test.mts` 미러 테이블 갱신 (소스 직접 실행 — 빌드 불필요, §12.6)
6. README 매핑표 · `CLAUDE.md` 규약 갱신

### 새 primary 모델 등록

`makdoong2-team.json` 의 `model_policy.allowed_primaries` 에 추가 → `agents.<id>.model` 로 소비 → `makdoong2-team validate` 로 검증.

### 사이트별 오버라이드 (코드 수정 없이)

```jsonc
{
  "model_policy": { "allowed_primaries": ["github-copilot/gpt-5.4-codex"] },
  "agents": {
    "makdoong2-engineer": {
      "model": "github-copilot/gpt-5.4-codex",
      "fallback_models": [{ "id": "github-copilot/claude-haiku-4.5", "tier": "low" }]
    }
  }
}
```

---

## 15. 용어

| 용어 | 뜻 |
|---|---|
| **orchestrator (team-leader, 부장님)** | 단계 라우팅·게이트 호출·위임 관리. git 명령은 frontmatter 에서 전면 deny 되어 직접 실행 불가 |
| **direct executor publisher** | `3_delivery.*` 3개 substage 모두 publisher 가 worktree 에서 직접 `git add`/`commit`/`push`/bitbucket MCP 를 실행한다. 부장님은 dispatch 와 verdict 수신만 |
| **PRIMARY-only** | orchestrator 만 실행 가능한 stage 플래그. 현재 사용처 없음 (delivery 전부 publisher 직접 실행) |
| **shell gate** | LLM 호출 0, exit code 로만 판정하는 결정론 게이트. 단일 진실 소스 |
| **extension gate** | LLM 판정 결과를 마커로 남기고 플러그인이 마커만 결정론적으로 검사 (예: `validation_passed`) |
| **self_check** | 각 stage 종료 직전 기록하는 5-boolean 자가 검증 |
| **verification_pending** | `done=true` 직후 설정. `approved_by_user=true` 로 해소될 때까지 다음 게이트 차단 |
| **verifier-verdict** | `<verifier-verdict>VERIFIED\|REJECTED</verifier-verdict>` 태그. 누락 시 REJECTED |
| **policy** | state.json `.policy`. `category`(minor/major, 상향만 허용) + `auto_approve` 맵 |
| **change-report** | HITL opt-in 시 커밋 직전 사람 승인용 한글 보고서 |
| **sealed workflow** | 서브에이전트의 outer-world 위임 툴 호출 금지. frontmatter + `tool.execute.before` 로 물리 차단 |
| **Track A / Track B** | 모델 폴백 2-track. A = in-session (`get_fallback_model`), B = out-of-session (`with-fallback.sh`) |
| **SCRIPTS_DIR 주입** | dispatch 프롬프트가 절대경로를 명시해 서브에이전트의 상대경로/HOME 경로 추측을 차단 |
| **hang_history** | substage 별 stall/gone 이력 배열. 호출 사이에 보존되어 재디스패치 상한의 근거가 된다 |

---

## 부록 A. v1.0.0 breaking changes

**makdoong2-team@1.0.0 은 opencode ≥ 1.18.0 과 tmux ≥ 3.0 을 요구한다.**

### 0.x 에서 올라올 때

**1. opencode SDK 1.18+ 필수**

- `session.create` body 가 더 이상 `permission`/`model` 필드를 받지 않는다 (SDK 스키마 변경)
- 생성 시점 permission 상속이 불가능해졌다. headless 서브세션의 external_directory "ask" hang 방어는 `pollSubSession` 의 permission 자동 응답 루프 + 프롬프트 레벨 `tools: { question: false }` 로 완전히 이관됐다
- 모델은 `session.prompt` body 로 매 프롬프트마다 전달한다 (SDK 1.18 에서 변경 없음)
- SDK 1.4.x 하위 호환은 폐기

**2. tmux ≥ 3.0 필수**

- pane 스코프 user option (`set-option -p`) 이 필수인데 tmux 3.0 (commit `5f92f92`) 에서 도입됐다. tmux 2.7 (RHEL 8 기본) 은 미지원
- `checkTmuxVersion()` 이 플러그인 init 에서 throw 하고 tmux 모니터가 자기-비활성화된다 (`versionBlocked`) — pane spawn/scan/cleanup 이 전부 no-op
- **알려진 잔여물**: async init 버전 검사와 경합한 dispatch 가 tmux 2.x 에서 marker 없는 pane 을 하나 만들 수 있고, 이 pane 은 cleanup 이 닿지 않아 플러그인 재시작 후에도 남는다. `tmux kill-pane` 으로 수동 제거

**3. NUDGE orphan 세션 가드** — 80% timeout 시점의 NUDGE 가 세션 생존을 먼저 확인한다 (사라진 세션에 대한 NotFoundError 방지).

### 업그레이드 절차

```bash
tmux -V              # >= 3.0
opencode --version   # >= 1.18.0
npm install -g makdoong2-team@latest
makdoong2-team install --force
```

tmux 나 opencode 를 올릴 수 없으면 `makdoong2-team@0.22.x` 에 머문다.
