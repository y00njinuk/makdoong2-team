# makdoong2-team — ARCHITECTURE

> 어떻게 동작하는가. 왜 이렇게 설계했는지는 [`DESIGN.md`](./DESIGN.md) 참조.

## Breaking Changes in v1.0.0

**makdoong2-team@1.0.0** requires **opencode >= 1.18.0** and **tmux >= 3.0**.

### Migration from 0.x

1. **OpenCode SDK 1.18+ required**:
   - `session.create` body no longer accepts `permission`/`model` fields (SDK schema change)
   - Create-time permission inheritance is no longer possible; PROJ-40406 (headless sub-session external_directory "ask" hang) defense moved entirely to pollSubSession's permission auto-reply loop + prompt-level `tools: { question: false }`
   - Model is passed per-prompt via `session.prompt` body (unchanged in SDK 1.18)
   - Backward compatibility with SDK 1.4.x dropped

2. **tmux >= 3.0 required**:
   - Pane-scoped user options (`set-option -p`) are mandatory
   - tmux 2.7 (RHEL 8 default) no longer supported
   - `checkTmuxVersion()` throws at plugin init and the tmux monitor self-deactivates (`versionBlocked`) — pane spawn/scan/cleanup become no-ops
   - Known residue: a dispatch racing the async init version check on tmux 2.x can create one marker-less pane that survives plugin restart (unreachable by cleanup); kill it manually with `tmux kill-pane`

3. **NUDGE orphaned session guard**:
   - NUDGE at 80% timeout now checks session liveness before firing
   - Prevents NotFoundError on gone sessions (bug fix from PROJ-40406)

### Upgrade Steps

```bash
# 1. Verify tmux version
tmux -V  # Must show >= 3.0

# 2. Verify opencode version
opencode --version  # Must show >= 1.18.0

# 3. Upgrade plugin
npm install -g @local/makdoong2-team@1.0.0
makdoong2-team install --force
```

If you cannot upgrade tmux or opencode, stay on `@local/makdoong2-team@0.22.x`.

---

## 1. 개요

Jira 이슈 하나를 **3 phase · 8 substage** 로 나눠 역할별 에이전트에게 위임한다.

```
1_planning       : jira → requirements → scope         (planner)
                   ↓ (worktree 자동 준비 — team-leader)
2_implementation : dev → test                           (engineer, 격리된 worktree)
3_delivery       : commit → pr → review                 (publisher, direct executor)
```

오케스트레이터 (`makdoong2-team-leader`) 가 셸 게이트로 단계 진입을 검증하고, **Planning 완료 후 Implementation 진입 전에 worktree를 자동 생성**한다. `dispatch_stage` 툴로 서브 에이전트를 격리된 opencode 서브세션에 spawn 하고, 완료 후 `dispatch_verifier` 가 산출물을 2차 검증한다.

## 2. 모듈 책임

| 파일 | 책임 |
|---|---|
| `src/opencode-plugin.ts` | opencode `Plugin` 본체. hook 3종 (`chat.params`, `tool.execute.before`, `tool.execute.after`) + custom tool 6종 등록. `dispatch_stage` 가 `client.session.create/prompt` 로 서브세션 spawn. |
| `src/config.ts` | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/makdoong2-team.json` 로더. 1회 캐시. 환경변수 전면 대체. |
| `src/model-fallback-policy.ts` | primary → fallback 체인 단일 정의. invariant 검증 + JSON override 원자적 머지. |
| `src/agent-stage-config.ts` | Stage 타입, 에이전트 spec (권한·툴·primary-only), 스테이지→명세 파일 매핑. |
| `src/tmux-monitor.ts` | 서브세션마다 tmux pane split 해 `opencode attach` 실행. tmux 외부/비활성 시 no-op. |
| `src/model-chain-cli.ts` | 체인 JSON 을 stdout 으로 노출 (Track B 래퍼 소비용). |
| `src/hooks/guard-bash.sh` | PreToolUse — 파괴 명령 차단, `git push` 게이트. dual-mode (인자 우선, stdin fallback). |
| `src/hooks/sync-state.sh` | PostToolUse — `git commit` 감지 시 state.json 자동 마커 기록. |
| `src/hooks/session-start.sh` | orchestrator 세션 시작 시 state + events tail 재주입. Claude Code `hooks.SessionStart` 로 wire-up. |
| `agents/*.md` | 5개 agent frontmatter + 시스템 프롬프트. |
| `stages/NN-*.md` | 8개 substage 명세 (진입 게이트, 절차, 자가 검증 5체크). |
| `gates/verify.sh` + `stage*-verify.sh` | 결정론 셸 게이트. LLM 호출 0. |
| `scripts/state.sh` | state.json CRUD (`init`/`get`/`set`/`root`/`issue`). |
| `scripts/config.sh` | 셸 측 makdoong2-team.json 리더 (`get <dotted.key> [default]`). |
| `scripts/wt-sync-ignored.sh` | worktree 로컬 셋업 파일 동기화 (`.env`, IDE 설정 등). team-leader 가 worktree 생성 직후 자동 호출. |
| `scripts/log-event.sh` | append-only NDJSON 이벤트 로거. |
| `scripts/model-policy.mjs` | `src/model-fallback-policy.ts` 의 JS 미러. `bin/cli.js` / `smoke-test.mjs` 공유. |
| `scripts/with-fallback.sh` | Track B 모델 폴백 프로세스 래퍼. |
| `scripts/install-lib.mjs` | 재사용 가능 배포 로직. `bin/cli.js` + `postinstall.mjs` 공유. |
| `bin/cli.js` | `makdoong2-team install`/`doctor`/`validate` CLI. 무의존 Node ESM. |

## 3. Custom Tool API

플러그인이 등록하는 **6개 툴**. opencode `tool.*` 네임스페이스에 들어가며, 에이전트 frontmatter `tools:` 에서 명시해야 사용 가능하다.

### 3.1 `verify_stage` — 게이트 검증만

**입력**: `{ issue: string; target_stage: Stage }`

**동작**: `verify.sh` + `checkExtensionGates` 실행.

**반환 (ok)**: `{ ok: true, gate, agent, primary_only, model, category?, auto_approve? }`

**반환 (blocked)**: `{ ok: false, gate, reason, marker_path? }`

`Stage` 유니온:
```
"1_planning.jira" | "1_planning.requirements" | "1_planning.scope"
| "2_implementation.dev" | "2_implementation.test"
| "3_delivery.commit" | "3_delivery.pr" | "3_delivery.review"
```

### 3.2 `dispatch_stage` — 검증 + spawn + poll

**입력**: `{ issue; target_stage; worktree; context?; model_override? }`

**동작**:
1. `primary_only` 체크 → true 면 즉시 `ok=false` (orchestrator 가 직접 실행).
2. `verify.sh` + `checkExtensionGates`.
3. `model_override ?? POLICIES[agent].primary.id` 로 모델 결정.
4. `client.session.create()` — `parentID` 로 부모 세션 지정 (`chat.params` hook 이 매핑한 `currentParentSessionID`). `question:deny` 로 인터랙티브 차단.
5. `client.session.prompt()` — 프롬프트 첫 5줄에 `Working directory`, `Scripts directory`, `Issue`, `Stage spec` 절대경로 주입.
6. `pollSubSession()` — 2초 간격 `client.session.status()` 폴링. idle 또는 `finish` 완결 시 마지막 assistant 텍스트 추출. 기본 timeout **10분**.
7. tmux pane spawn/close.

**반환**: `{ ok: true, stage, agent, model, session_id, output }` (`output` ≤ 8000자) 또는 `{ ok: false, ... }`.

### 3.3 `dispatch_verifier` — 3rd party evaluator

비 primary-only 단계 직후 자동 호출. `makdoong2-verifier` (read-only) 를 spawn 해 `self_check` 5체크 + 필수 마커 + 안티패턴 신호로 판정.

**반환**: `{ ok, verdict: "VERIFIED" | "REJECTED", raw, session_id, parsed }`. `<verifier-verdict>VERIFIED|REJECTED</verifier-verdict>` 태그 파싱. **태그 누락 → REJECTED** (안티-환각 floor).

`scripts/log-event.sh` 로 verdict 를 events.ndjson 에 append (best-effort).

### 3.4 `auto_advance_stage` — 다음 단계 계산

**입력**: `{ issue; worktree? }`

**동작**: state.json 의 `.stages.*.done` 마커를 순차 검사 (`2_implementation.test` 는 `unit`/`integration` 값이 `pass`/`skip` 이면 완료). 다음 stage 결정 → 게이트 검증.

**반환**: `{ ok, current_stage, target_stage, agent, primary_only, model, category?, auto_approve?, next_action }`. 완료 시 `{ ok: true, done: true }`. `next_action` 필드는 orchestrator 가 실행할 다음 지시.

### 3.5 `get_fallback_model` — 폴백 advisor

**입력**: `{ agent; current; reason? }`

**반환**: `{ next: ModelSpec | null, exhausted, chain, reasonAccepted }`.

### 3.6 `cleanup_panes` — tmux 수동 정리

실패로 유지된 tmux pane 을 일괄 close.

## 4. 상태 표현

```
<worktree>/.makdoong2-team/<ISSUE>/
├─ state.json                   # 현재 상태 (stage 마커, self_check, policy)
├─ events.ndjson                # append-only 이력
├─ APPROVED_DESTRUCTIVE         # 파괴 명령 명시 승인 마커 (1회용)
├─ change-report.md             # major 커밋 직전 사람 승인용 보고서
└─ requirements-draft.md        # 2단계 초안 (선택)
```

### 4.1 state.json 초기 스키마

`state.sh init <issue>` 가 시드하는 최소 구조:

```json
{
  "issue": "PROJ-12345",
  "worktree": "/abs/path",
  "stages": {
    "1_planning":       { "done": false, "substages": { "jira": {...}, "requirements": {...}, "scope": {...} } },
    "2_implementation": { "done": false, "substages": { "dev": {...}, "test": { "unit": "none", "integration": "none" } } },
    "3_delivery":       { "done": false, "substages": { "commit": {...}, "pr": { "draft_url": null }, "review": { "comments": 0 } } }
  },
  "policy": null
}
```

에이전트는 필요할 때 `state.sh set` 으로 세부 필드를 추가한다. 주요 필드:

| 필드 | 의미 |
|---|---|
| `.stages.<phase>.substages.<sub>.done` | substage 완료 |
| `.stages.<phase>.substages.<sub>.approved_by_user` | 사용자 승인 |
| `.stages.<phase>.substages.<sub>.verification_pending` | 승인 대기 중 (다음 게이트 차단) |
| `.stages.<phase>.substages.<sub>.self_check` | 자가 검증 5체크 (5-boolean) |
| `.policy.category` | `"minor"` \| `"major"` — 2단계 범주화 결과 |
| `.policy.auto_approve.<Stage>` | substage 별 무인 진행 여부 |
| `.stages."2_implementation".substages.test.unit`/`.integration` | `"pass"` \| `"skip"` \| `"fail"` \| `"none"` |
| `.stages."2_implementation".substages.test.coverage_pct` | 라인 커버리지 % |

**도출 규칙**: `base = (intent_type ∈ {Simple,Standard}) ? "minor" : "major"`. `criticality="critical"` 또는 `scope_size="large"` 면 major. `auto_approve` 는 **minor·major 공통으로 전 substage 기본 `true`** (두 범주 모두 무인 진행). `.policy.category` 는 위험도 라벨/향후 이슈 유형별 opt-in 훅용으로 유지된다. HITL 이 필요한 경우 planner 가 특정 substage 를 명시적으로 `false` 로 재설정한다.

### 4.2 진입 게이트 요약

| target substage | 진입 조건 |
|---|---|
| `1_planning.requirements` | jira substage `done + validation_passed` (6항목 검증 통과) |
| `1_planning.scope` | requirements `done + approved_by_user + !verification_pending` **OR** `.policy.auto_approve`. 추가 조건부 품질 검사(마커 존재 시): `ambiguity_score ≤ 0.2`, `spec_hash` 재계산 일치 (spec drift 차단) |
| `2_implementation.dev` | scope 동일 규칙 |
| `2_implementation.test` | dev `done` + worktree 격리 검증 |
| `3_delivery.commit` | test `unit`/`integration` ∈ {pass,skip} + coverage ∈ {pass,exempt}. **`.policy.auto_approve."3_delivery.commit"==false` (HITL opt-in)** 인 경우에만 `change-report.md` + `approved_by_user` 추가 요구. 기본 흐름(모두 `true`)에서는 발생하지 않음 |
| `3_delivery.pr` | commit `done` + worktree clean + `origin/<branch>` 존재 |
| `3_delivery.review` | pr `draft_url` + body_validation 3항목 + approved |

## 5. Hook 흐름

### 5.1 `chat.params`
매 LLM 호출마다 발동. `sessionID → agent` 매핑 저장 (hook input 에 agent ID 가 없기 때문에 우회 용도).

### 5.2 `tool.execute.before` — PreToolUse
1. `dispatch_stage`/`dispatch_verifier` 호출 시 `currentParentSessionID = sessionID` 캐치 (자식 세션의 `parentID` 로 전달, orphan 방지).
2. **Sealed workflow** — sealed sub-agent (`planner`/`engineer`/`publisher`/`verifier`) 가 outer-world 위임 툴 (`call_omo_agent`, `delegate_task`, `background_task`, `task_*`) 호출 시 throw.
3. **Leader hardrule 1** — `team-leader` 가 `write`/`edit`/`patch`/`multiedit` 호출 시 throw. 파일 조작은 `dispatch_stage` 위임 강제.
4. **Leader hardrule 2** — `team-leader` bash 명령 중 파일 쓰기 리다이렉트 (`>`, `>>`, `tee`, `sed -i` 등) 차단. 허용: `state.sh set` 만. **git 명령 (`commit`/`push`/`add`/`rm`/`worktree`) 도 frontmatter permission 으로 deny** — 3_delivery.* 는 publisher 가 직접 실행한다.
5. `bash` 툴이면 `guard-bash.sh` 실행 — 파괴 명령 (`git push --force`, `rm -rf` 등) 은 `APPROVED_DESTRUCTIVE` 마커 없으면 exit 2, `git push` 는 `stage7-pr-verify.sh` 게이트 통과 요구.

### 5.3 `tool.execute.after` — PostToolUse
`bash` 실행 결과를 `sync-state.sh` 로 전달. `git commit` 감지 시 `.stages."3_delivery".substages.commit.done=true` 자동 기록.

### 5.4 SessionStart (외부 wire-up)
opencode plugin API 는 SessionStart 이벤트를 노출하지 않으므로 `src/hooks/session-start.sh` 는 Claude Code `settings.json` 의 `hooks.SessionStart` 로 등록하거나 orchestrator 프롬프트 첫 줄에서 호출한다. state.json 진행 현황 + `verification_pending` 목록 + events.ndjson tail 3개를 stdout 으로 재주입.

## 6. 권한 강제 — 2중 방어

| 층 | 위치 | 역할 |
|---|---|---|
| L1 | agent frontmatter `permission:` | opencode 네이티브. deny/allow/ask 판정. |
| L2 | `tool.execute.before` + `guard-bash.sh` | `git push` 게이트, 파괴 명령 차단, leader hardrule, sealed workflow. |

hook input 에 호출 agent ID 가 없으므로 `chat.params` 로 채운 `sessionAgent` Map 을 조회한다.

## 7. 모델 폴백

### 7.1 정책 invariant

`validatePolicies()` 가 모듈 로드 시 + 모든 override 적용 후 검사:

1. `policy.primary.id ∈ ALLOWED_PRIMARIES` (= defaults ∪ `model_policy.allowed_primaries`)
2. `∀ fb ∈ policy.fallbacks: TIER_RANK[fb.tier] < TIER_RANK[policy.primary.tier]` (`low=1 < medium=2 < high=3 < max=4`)

**빌트인 defaults**: `github-copilot/*` (claude-haiku/opus/sonnet, gemini, gpt, grok-code, kimi, mai-code) + `local/*` (qwen) 브랜드 총 40개. 전체 목록은 `src/model-fallback-policy.ts` 의 `DEFAULT_ALLOWED_PRIMARIES` 참조.

**오버라이드 원자성**: `applyConfigOverrides()` 는 호출 전 snapshot 을 뜬다. 검증 실패 시 snapshot 으로 복원 후 stderr 경고. plugin 은 defaults 로 부팅을 완료해 워크플로우가 죽지 않는다. `makdoong2-team validate` 로 사전 검증 가능.

### 7.2 Track A — in-session 폴백

`dispatch_stage` 실패 → orchestrator 가 `get_fallback_model` 호출 → `dispatch_stage(model_override=...)` 로 새 격리 서브세션 재시도. 같은 대화 흐름이 끊기지 않는다.

### 7.3 Track B — out-of-session 폴백

```
with-fallback.sh <agent> -- run --agent <agent> "..."
  → model-chain-cli.ts 로 체인 JSON 조회
  → for each model: opencode --model $M run ...  (exit ∈ {1,124,137} 이면 다음 모델)
```

Track A/B 모두 `POLICIES` 를 단일 진실 소스로 참조한다. SIGINT(130) 는 retry 하지 않음 (사용자 cancel 보호).

## 8. Sub-Session tmux 모니터

`src/tmux-monitor.ts` 가 `dispatch_stage` 라이프사이클에 hook 해 서브세션마다 tmux pane 을 spawn. `process.env.TMUX` 존재 **AND** `tmux.enabled==true` 일 때만 작동. 그 외 no-op.

**동작**: `tmux split-window` 로 pane 생성 → `opencode attach <sessionId>` 실행 → 완료 시 `paneCloseDelaySeconds` (기본 5초) 대기 후 kill. 실패 pane 은 `autoCloseOnFailure=false` (기본) 면 진단용으로 유지 (`cleanup_panes` 툴로 수동 정리).

capacity 산정: window 폭 / `agent_pane_min_width`. 가득 차면 가장 오래된 pane 을 FIFO eviction.

## 9. 저장소 레이아웃

### npm 전역 모듈 (`npm install -g` 로 설치)

```
<npm-global>/node_modules/@local/makdoong2-team/
├─ bin/cli.js                # install / doctor / validate
├─ dist/opencode-plugin.js   # TS → JS 컴파일 산출물 (main)
├─ src/**/*.ts               # 원본 소스
├─ src/hooks/*.sh            # guard-bash, sync-state, session-start
├─ gates/                    # verify.sh + stage*-verify.sh
├─ stages/                   # 01-jira.md ... 09-review-comments.md (04-analysis.md 포함)
├─ scripts/                  # state.sh, config.sh, log-event.sh, release.sh 등
├─ references/               # commit-convention.md, pr-template.md 등
└─ assets/
   ├─ makdoong2-team.schema.json
   └─ makdoong2-team.default.json
```

### opencode 설정 디렉토리 (`~/.config/opencode/`)

```
~/.config/opencode/
├─ opencode.json               # plugin 배열 + 6 tools (CLI 가 패치)
├─ makdoong2-team.json         # 단일 설정 파일 (없을 때만 seed)
├─ agents/makdoong2-*.md
└─ skills/{jira-research, bitbucket-research, confluence-research, github-oss-research, bamboo-ci}/
```

**SCRIPTS_DIR 주입**: `dispatch_stage`/`dispatch_verifier` 프롬프트 첫 5줄에 `Scripts directory (ABSOLUTE): <경로>` 라인이 주입된다. agents/stages 는 이 절대경로를 `<SCRIPTS_DIR>` placeholder 로 참조한다 (사용자의 `paths.scripts` override 존중).

**Worktree 동기화**: `scripts/wt-sync-ignored.sh <worktree> <issue>` 는 이슈 스코프의 `.makdoong2-team/<issue>/` 만 새 worktree 로 복사한다. cross-issue state pollution 방지.

## 10. 실패 모드 & 복구

| 실패 | 조치 |
|---|---|
| `validatePolicies()` throw (defaults 자체 위반) | plugin 로드 실패. 코드 롤백. |
| makdoong2-team.json override 위반 | `applyConfigOverrides()` snapshot 복원 → defaults 로 부팅. stderr 경고. `makdoong2-team validate` 로 사전 검증. |
| `verify.sh exit 2` | 게이트 차단. stderr 사유대로 이전 substage 로 복귀. |
| `guard-bash.sh` 파괴 명령 차단 | 의도된 경우 `touch <worktree>/.makdoong2-team/<ISSUE>/APPROVED_DESTRUCTIVE` 후 재시도. |
| `guard-bash.sh` push 게이트 차단 | commit 완료 + worktree clean + PR 게이트 조건 충족 후 재시도. |
| `dispatch_stage` session create/prompt 실패 | opencode 서버 확인, 재시도 또는 Track B 전환. |
| `dispatch_stage` timeout (10분 초과) | 서브세션 abort. 컨텍스트 축소 후 재시도. |
| `dispatch_verifier` REJECTED | `.stages.*.done` 되돌리고 dispatch_stage 재시도 (기본 retry cap 3회). |
| verifier verdict 태그 누락 | 자동 REJECTED 처리 (안티-환각 floor). |
| Track A `exhausted=true` | 사용자 보고, 수동 대기. |
| Sealed workflow 위반 | outer-world 툴 호출 throw. 대안 사용 (`skill_mcp` + `dispatch_stage`). |
| Leader hardrule 위반 | write/edit/patch 툴 또는 bash 파일 쓰기 throw. `dispatch_stage` 위임 필수. |
| skill_mcp lazy-load 순서 위반 | opencode 가 `MCP server "<name>" not found` 로 실패. `tool.execute.after` 훅이 SKILL.md registry 룩업으로 정확한 skill 이름(예: `skill(name="jira-research")` 를 먼저 호출) 을 안내로 프리펜드. 세션 안에서 skill 을 로드한 뒤 재시도. |

## 11. 확장 포인트

### 새 substage 추가
1. `src/agent-stage-config.ts` — `Stage` 유니온에 새 값, `STAGE_SPEC_FILES` 매핑, 필요시 `AGENTS` 추가.
2. `src/opencode-plugin.ts` — `STAGE_ORDER` 배열에 삽입.
3. `agents/`, `stages/`, `gates/verify.sh`, `gates/stage*-verify.sh` 추가.
4. `scripts/smoke-test.mjs` 미러 테이블 갱신.

### 새 primary 모델 등록
`makdoong2-team.json` 의 `model_policy.allowed_primaries` 에 추가. `agents.<id>.model` 오버라이드로 소비. `makdoong2-team validate` 로 검증.

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

## 12. 용어

- **orchestrator (team-leader)** — 단계 라우팅 · 게이트 호출 · 위임 관리. **git 명령 (`commit`/`push`/`add`/`rm`/`worktree`) permission 이 frontmatter 에서 deny** 되어 직접 실행 불가. Publisher / engineer 등 sealed sub-agent 에게 dispatch_stage 로 위임한다.
- **PRIMARY-only** — orchestrator 만 실행 가능 (agent-stage-config 에서 플래그). 현재는 사용처 없음 (모든 3_delivery.* 는 publisher 가 직접 실행).
- **direct executor publisher** — `3_delivery.commit` / `3_delivery.pr` / `3_delivery.review` 세 substage 모두 publisher 가 worktree 에서 **직접 `git add` / `git commit` / `git push` / bitbucket MCP 호출**을 수행한다. team-leader 는 dispatch 만 하고 verdict 를 받는다.
- **shell gate** — LLM 호출 0. exit code 로 통과/차단 판정. 단일 진실 소스.
- **extension gate** — LLM 판정 결과를 마커로 기록하고 플러그인이 결정론적으로 검사 (예: `1_planning.jira.validation_passed`).
- **verification_pending** — substage `done=true` 기록 직후 설정. `approved_by_user=true` 로 해소될 때까지 다음 게이트 차단.
- **self_check** — 각 stage 종료 직전 stage agent 가 기록하는 5-boolean 자가 검증. verifier 가 결정론적으로 검사.
- **policy** — state.json `.policy`. 2단계 범주화 결과 (`minor`/`major`). 3단계에서 minor→major 상향만 허용.
- **change-report** — major 커밋 직전 사람 승인용 한글 보고서. `<worktree>/.makdoong2-team/<ISSUE>/change-report.md`.
- **verifier-verdict** — `<verifier-verdict>VERIFIED|REJECTED</verifier-verdict>` 태그. 누락 시 REJECTED.
- **sealed workflow** — sealed sub-agent (planner/engineer/publisher/verifier) 는 outer-world 위임 툴 호출 금지. `chat.params` + `tool.execute.before` 훅이 물리적 차단.
- **Track A / Track B** — 모델 폴백 2-track. A=in-session (`get_fallback_model`), B=out-of-session (`with-fallback.sh`).
- **SCRIPTS_DIR 주입** — dispatch 프롬프트가 절대경로를 명시해 서브에이전트가 상대경로/HOME 경로를 사용하지 않도록 강제.

## 13. 배포 & 릴리즈

### 13.1 npm 패키지 이름 및 registry
- 패키지 이름은 `@local/makdoong2-team` (사내 전용 스코프).
- 배포 대상: 사내 Artifactory `npm-local-repos` (`https://registry.example.com/artifactory/api/npm/npm-local-repos/`). `package.json` 의 `publishConfig` 로 고정한다.
- opencode.json 에는 다른 플러그인들과 마찬가지로 npm 이름만 기록한다. 절대경로는 legacy 로 취급하며 install 시 자동으로 stripping 된다.

### 13.2 빌드 산출물
- 런타임 진입점은 `dist/opencode-plugin.js` (TS → JS 컴파일 산출물). `package.json` 의 `main`/`exports` 가 dist 를 가리킨다.
- 소스는 `src/**/*.ts` 이며, `.ts` 상대 import 는 `rewriteRelativeImportExtensions` 옵션으로 컴파일 시 `.js` 로 자동 재작성된다.
- 빌드는 `npm run build` (`tsc -p tsconfig.build.json`). `npm publish` 는 `prepack` 훅에서 clean + build 를 자동 수행한다.
- `src/hooks/*.sh` (guard-bash, sync-state, session-start) 는 shell script 이므로 컴파일 대상이 아니고 `files` 에 명시적으로 포함된다.

### 13.3 설치 시 배포되는 파일
- `makdoong2-team install` (또는 `npm install -g` 시 `postinstall.mjs`) 는 npm 모듈의 일부 파일만 선택적으로 `~/.config/opencode/` 하위로 복사한다.
- **Agents** (`agents/*.md`) → `~/.config/opencode/agents/` — opencode 컨벤션상 agent 정의는 config dir 에 있어야 한다.
- **Research Skills** (`skills/<research-skill>/*`) → `~/.config/opencode/skills/` — 연구용 skill (`jira-research`, `confluence-research`, `bitbucket-research`, `github-oss-research`, `bamboo-ci`) 의 SKILL.md 와 run-*.sh, 그리고 skill 간 공유 helper `skills/_lib/load-secret.sh`.
- **Config** (`assets/makdoong2-team.default.json`) → `~/.config/opencode/makdoong2-team.json` — 최초 설치 시에만 복사. 기존 파일이 있으면 보존 (단, `--force` 시 백업 후 덮어쓰기).
- **나머지** (`dist/`, `gates/`, `scripts/`, `stages/`, `references/`, `bin/`) → npm 모듈 내부에만 존재. `src/config.ts`의 `resolvePaths()`가 npm 모듈 경로를 자동으로 해결한다.

### 13.4 opencode plugin cache seeding
- opencode 내장 npm client 는 하드코딩된 `registry.npmjs.org` 만 사용하므로 사내 registry 에서 자동으로 fetch 하지 못한다.
- `scripts/install-lib.mjs` 의 `seedOpencodeCache()` 가 `~/.cache/opencode/packages/@local/makdoong2-team@latest/node_modules/@local/makdoong2-team` 을 npm 전역 설치 경로로 심볼릭 링크하여 opencode 가 fetch 를 건너뛰도록 한다. 이 우회는 opencode 가 사내 registry 를 정식 지원하기 전까지 유지된다.

### 13.5 credential 관리
- 사내 Artifactory 인증은 `~/.npmrc` 에 `_auth` (base64 `user:pass`) 로 저장한다. chmod 600 필수.
- `~/.docker/config.json` 의 동일 registry 호스트 항목이 같은 형식의 credential 을 가지면 재사용할 수 있다.
- 프로젝트 `.npmrc` 는 `.gitignore` 에 포함되어 있어 실수로 credential 을 커밋할 수 없다.

### 13.6 리서치 skill credential 관리 (SSoT: makdoong2-team.json)
- 리서치 skill (bitbucket / jira / confluence / bamboo) MCP 서버가 사용하는 personal access token 은 오직 `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/makdoong2-team.json` 의 `.secrets.<VAR>` 에서만 읽는다. **다른 소스 (환경변수, opencode.json.mcp.*, 개별 secrets.env) 는 fallback 하지 않는다** — single source of truth.
- 지원 키: `BITBUCKET_API_TOKEN`, `JIRA_API_TOKEN`, `CONFLUENCE_API_TOKEN`, `BAMBOO_TOKEN`. 스키마는 `assets/makdoong2-team.schema.json` `.secrets`. 기본값 빈 문자열, install 시 additive scaffolding.
- 각 `skills/<skill>/run-*.sh` 는 spawn 시 `skills/_lib/load-secret.sh` 의 `load_secret_from_makdoong2_config` 로 jq 조회, 미설정 시 exit 68.
- 온프레미스 endpoint 는 같은 파일의 `.hosts.<VAR>` (`JIRA_HOST`, `CONFLUENCE_HOST`, `BITBUCKET_API_BASE_PATH`, `BAMBOO_URL`) 에서만 읽는다. `load_host_from_makdoong2_config` 가 jq 조회, 미설정 시 exit 69. 토큰 갱신은 다음 skill spawn 부터 즉시 반영 (재설치 불필요).
- **opencode.json vs makdoong2-team.json 우선순위**: 플러그인 사용 시 makdoong2-team.json 이 SSoT. opencode.json 의 `.mcp.*.environment.*` 는 플러그인 미사용 시 필요하므로 삭제하지 않는다. 두 값 다를 시:
  - **skill_mcp 경유**: `load-secret.sh` 가 spawn 시점에 override + stderr 경고.
  - **직접 MCP 툴** (`repos_*` / `works_*` / `docs_*` / `bamboo_*`): `src/mcp-secret-injector.ts` + opencode `config` hook 이 MCP 초기화 전 in-place mutation. drift 발생 시 `[makdoong2-team config] MCP secret OVERRIDDEN` 경고. 대상 MCP 는 `MCP_SECRET_MAPPINGS` (repos/works/docs/bamboo) 로 고정.
  - **한계**: MCP 프로토콜상 spawn 후 env 재주입 불가. 토큰 갱신 시 opencode 재시작 필요.
- **legacy 정리**: 이전 `~/.config/opencode/skills/<skill>/secrets.env` 는 install 시 백업 후 자동 삭제.
- npm 패키지 tarball 에는 실제 토큰이 들어가지 않는다.

### 13.7 릴리즈 프로세스
- 릴리스는 `npm run release:patch|minor|major` (또는 `bash scripts/release.sh <bump>`) 로 자동화. 9단계 순차 실행 + **두 사용자 승인 게이트**:
  1. Pre-flight 체크 (working tree clean, 브랜치 확인, 원격 동기화)
  2. `npm test` 전체 실행
  3. 버전 bump 미리보기
  4. **승인 게이트 #1** — 버전 bump 확인
  5. `npm version <bump>` 실행 (커밋 + 태그)
  6. `npm publish --dry-run` 으로 tarball 검증
  7. **승인 게이트 #2** — 사내 registry 배포 확인
  8. `npm publish` → 사내 Artifactory
  9. `git push --follow-tags`
- Publish 이전 실패 시 자동 롤백(태그 삭제 + `git reset --hard HEAD~1`). Publish 이후 실패 시 수동 조치.
- 동일 버전 재-publish 는 registry 가 거부 → rollback 후 새 버전 필요.
- `--yes` 플래그는 CI 전용, 대화형 금지.
- **git push 시 자동 배포**: `.husky/pre-push` 훅이 `scripts/publish-if-changed.sh` 를 호출하여 push 대상 커밋 중 `package.json` version 변경 감지 시 2회 승인 게이트 자동 진행. 이미 registry 에 있는 버전은 skip.

## 14. 로깅 시스템

- 스키마: `assets/makdoong2-team.schema.json` `.logging` — 필드 4개 (`level`, `mode`, `path`, `max_bytes`). 기본값 `{ level: "error", mode: "stdin", path: null, max_bytes: 10485760 }`.
- **`level`** (`silent`/`error`/`warn`/`info`/`debug`/`trace`): 임계값. 지정 레벨 이하만 emit. **개발 규칙**: 플러그인 코드는 `info` 레벨을 사용하지 않는다. `debug` / `warn` / `error` 만 사용. `info`는 사용자 최종 통지가 필요한 경우로 예약되어 있으나 현재 활성 사용처 없음.
- **`mode`** (`stdin`/`file`):
  - `stdin` (default): `console.error`/`console.warn`/`console.log` 로 출력.
  - `file`: `path` 파일에 `[ISO8601] [level] message` 형식으로 기록.
- **`path`** (string | null): `mode="file"` 일 때만 사용. `stdin` 모드에서는 무시. `mode="file"` + `path` null/빈 → 초기화 실패 (fail-fast). doctor 가 동일 상황을 warn 리포트.
- **`max_bytes`** (integer, 기본 10 MiB): `mode="file"` 회전 임계값. 초과 시 `<path>.1` 로 rename 후 새 파일 시작. 세대는 1개만 유지한다.
- **File-mode 쓰기 정책 (hardrule)**: **절대 truncate 하지 않는다.** 항상 append 하고 크기 초과 시에만 회전한다. 부모 디렉토리 자동 생성 (`mkdirSync recursive`), 쓰기는 항상 동기 (`fs.appendFileSync`), 파일 신규 생성 시 `chmod 600`.
  - 이전 구현은 "프로세스별 첫 write 시 truncate" 였다. 한 호스트에서 메인 TUI · 막둥이 pane 별 opencode · `npm test` 가 **동일 `path` 를 공유**하므로, 새 프로세스가 뜰 때마다 다른 프로세스가 기록 중인 로그가 통째로 삭제됐다 (실측 60분 관찰 중 2회 역행). 세션별 로그 분리 목적은 각 라인의 `[pid=N]` 태그로 대체한다.
  - 회전 경합은 설계상 안전하다. `renameSync` 는 원자적이므로 두 프로세스가 동시에 초과를 관측해도 늦은 쪽은 이미 작아진 파일을 다시 rename 할 뿐이며, 최악의 경우 `<path>.1` 을 덮어쓴다. 부분 손상은 발생하지 않는다.
- **Additive scaffolding**: 기존 `makdoong2-team.json` 에 `logging.mode`/`logging.path` 없으면 install 시 누락 키만 시드. `level` 값은 덮어쓰지 않는다.
- **관련 구현**: `src/config.ts` (`LogMode`, `ResolvedLoggingConfig`, `readLoggingConfig`), `src/logger.ts` (mode 분기), `bin/cli.js` doctor 검증, `test/logger.test.mjs`, `test/install-lib.test.mjs`.

## 15. 워크플로우 상태 & 위임 규약

### 15.1 상태 파일 (worktree-local 모델)
- `.makdoong2-team/<issue>/state.json` — 이슈별 워크플로우 상태. `.gitignore` 포함, 로컬 전용, 이슈 간 격리.
- **state.json 위치는 실행 컨텍스트 canonical**: `scripts/state.sh root()` 는 `git rev-parse --show-toplevel` 반환.
  - Planning phase (main repo CWD): `main repo/.makdoong2-team/<issue>/state.json`
  - Implementation phase (worktree CWD): `worktree/.makdoong2-team/<issue>/state.json`
- **동기화**: `auto_advance_stage` 가 worktree 생성 시 forward sync, `dispatch_verifier` 가 sub-session create 직전 forward sync (stale state 방지), `dispatch_stage`/`dispatch_verifier` finally 가 성공·실패 무관 reverse sync.

#### 15.1.1 산출물 경로 필드 규약 (relative-only, hardrule)

state.json 의 산출물 경로 필드는 반드시 **`state.sh root()` 기준 상대경로**로 저장한다. 절대경로 저장은 다른 cwd 에서 소비 시 opencode 1.4.17 Read tool hang 을 유발한다 (원인: worktree 밖 절대경로 접근 시 permission 심사 무한 대기).

| 필드 | 규약 예시 |
|---|---|
| `.stages."1_planning".substages."requirements".draft_path` | `.makdoong2-team/<이슈>/requirements-draft.md` |
| `.stages."2_implementation".substages."analysis".artifact_path` | `.makdoong2-team/<이슈>/workspace-analysis.json` |
| `.stages."3_delivery".substages."commit".report_path` | `.makdoong2-team/<이슈>/change-report.md` |
| `.stages."3_delivery".substages."review".plan_path` | `.makdoong2-team/<이슈>/review-comment-plan.json` |

**예외**: `.worktree` 필드는 worktree 위치 자체를 가리키는 앵커이므로 절대경로 유지.

**소비 규약** (bash):
```bash
REL=$(bash <SCRIPTS_DIR>/state.sh get <이슈> '<jq-path>' | tr -d '"')
if [[ "$REL" == /* ]]; then ABS="$REL"; else ABS="$(bash <SCRIPTS_DIR>/state.sh root)/$REL"; fi
```
소비 지점은 어느 cwd 에서 실행되든 `state.sh root()` 가 worktree-local 을 반환하므로 상대경로 join 이 자연스럽게 hang-free 경로가 된다. legacy 절대경로도 `/* == *` 조건으로 수용한다.

**자동 마이그레이션**: `dispatch_stage` 의 dev 분기 프롬프트에 삽입되는 `buildDraftPathReadSnippet` (opencode-plugin.ts) 이 legacy 절대경로 (`/**/.makdoong2-team/*` 패턴) 감지 시 상대경로로 재저장한다 (idempotent). state.json 이 갱신되면 다음 REVERSE sync 로 main repo 에 전파된다.

**회귀 방지**: `test/state-path-relative.test.mjs` (15 시나리오) 는 stages/*.md 명세와 dispatch_stage 프롬프트가 상대경로 규약을 유지하는지 검증. `test/state-path-migration.test.mjs` (6 시나리오) 는 마이그레이션 sh 스니펫의 idempotency 를 검증.

### 15.2 state.json 스키마 (hardrule: hierarchical)
- 스키마: `.stages."<PHASE>".substages."<SUBSTAGE>".<field>`. 예: `.stages."1_planning".substages."requirements".done`.
- flat 표기 `.stages."<PHASE>.<SUBSTAGE>"` **금지** — jq 가 dot 포함 문자열을 단일 키로 해석해 phantom 노드 생성, verifier·auto_advance_stage 는 hierarchical 만 조회하므로 자기선언 완료가 무효화됨.
- `scripts/state.sh` 의 `get`/`set` 이 런타임에 flat 표기 감지 시 exit 65 로 즉시 실패 + hierarchical 대체 경로 안내.
- **`.policy.*` 예외**: `.policy.auto_approve."1_planning.requirements"` 같은 flat 스타일은 policy 맵 키 이름이 flat 이어서 유지.
- 오염된 state 는 `state.sh migrate <issue>` 로 이관 (idempotent). `state.sh init` 이 재호출되면 자동 migrate.

### 15.3 스키마 회귀 방지 6층 방어
1. **agent 프롬프트 (개발 시점)**: 모든 sub-agent 프롬프트가 hierarchical 표기만 사용.
2. **정적 lint (commit/push)**: `scripts/lint-agent-prompts.sh` 가 `agents/*.md` grep. `npm test` 최상단 실행, pre-push 훅 자동.
3. **런타임 guard (실행 시점)**: `state.sh` `get`/`set` 이 flat 감지 시 exit 65 + 안내.
4. **자동 치유 (재진입)**: `state.sh init` 이 기존 파일에 대해 호출되면 자동 migrate.
5. **진단**: `npx makdoong2-team doctor` 가 phantom 키 스캔.
6. **regression test (CI)**: `test/state-sh-schema.test.mjs` (12 시나리오), `test/doctor-phantom-scan.test.mjs` (3 시나리오).

### 15.4 Worktree 자동 생성 & 격리
- **자동 생성**: `auto_advance_stage` 가 `2_implementation.dev` 단계 진입 전 `createWorktree()` 호출. 조건: `.worktree` 필드 없음/null 또는 메인 repo/cwd 와 동일.
- **위치 (deterministic)**: 메인 repo `parentDir/repoName-<issue>`. 예: `/root/proj` → `/root/proj-PROJ-12345`. 브랜치명 `feature/<issue>`.
- **형제 디렉토리 hardrule**: `gates/stage4-dev-verify.sh` ~ `stage7-pr-verify.sh` 의 `assert_worktree_sibling()` 이 `dirname(worktree) == dirname(main repo)` 검증. 서브디렉토리 배치 금지 (메인 repo `.gitignore` 누출 방지).
- **동기화 흐름**:
  - Forward (`wt-sync-ignored.sh <worktree> <issue>`): auto_advance_stage 가 worktree 생성 시, dispatch_verifier 가 sub-session create 직전.
  - Reverse (`--reverse`): dispatch_stage / dispatch_verifier finally 블록.
  - state.json 포함, 다른 이슈 디렉토리 제외, `target/`/`node_modules/` 제외.
- **복구**: 잘못된 위치의 worktree 발견 시 `git worktree remove <경로>` + `state.sh set <issue> '.worktree' 'null'` → auto_advance_stage 재호출.

### 15.5 Team-Leader 위임 규칙 (hardrule)
- team-leader 는 Edit/Write 툴 부재 → 직접 파일 편집·생성 불가.
- 모든 파일 조작은 `dispatch_stage` 로 다른 에이전트 위임.
- `auto_advance_stage` 결과의 `next_action` 지시를 100% 따른다.

### 15.6 Sealed Workflow — 런타임 강제
makdoong2 서브에이전트(`planner` / `analyzer` / `engineer` / `publisher` / `verifier`)는 **outer-world 에이전트**로 위임 불가. 프론트매터(1차) + `tool.execute.before` 훅(2차)의 다층 방어.

- **차단 대상 툴**: `call_omo_agent`, `delegate_task`, `background_task`, `task_create`, `task_update`, `task_get`, `task_list`.
- **보호 대상 서브에이전트**: `makdoong2-planner`, `makdoong2-analyzer`, `makdoong2-engineer`, `makdoong2-publisher`, `makdoong2-verifier`.
- **team-leader 예외**: 오케스트레이터. 대신 별도 하드룰 (Write/Edit/Patch/Multiedit 물리 차단 + bash 파일 쓰기 리디렉션 차단).
- **state.json 조작 hardrule**: state.json 은 오직 `state.sh` 로만 조작. `python -c open()`, `jq > state.json`, `sed -i state.json` 등 우회는 `tool.execute.before` 훅이 즉시 차단.
- **허용 대안**: `skill_mcp` 로 리서치, 다른 substage 는 team-leader 반환 후 dispatch, 상태 공유는 `state.sh set` 마커.
- **미래 툴 조기 감지**: 알려지지 않은 위임성 이름(`delegate*` / `spawn*` / `background_*` / `task_create|update|delete`) 이 sealed subagent 에서 호출되면 경고. 업그레이드 후 `OUTER_WORLD_TOOLS` 상수 재검토.

### 15.7 skill_mcp lazy-load 방어
각 리서치 skill 의 MCP 서버(`works`/`docs`/`repos`/`bamboo`)는 SKILL.md frontmatter embedded 로 선언, **skill 로드 전에는 스폰되지 않는다**. 로드 없이 `skill_mcp(mcp_name="works", ...)` 호출 시 `MCP server "works" not found` 만 나오고 어떤 skill 을 로드해야 하는지는 안 알려준다.

- **1차 방어 (문서)**: 각 SKILL.md 상단 "사전 조건" 섹션 + planner/publisher 프롬프트 `0-pre` 블록의 `mcp_name → skill_name` 매핑.
- **2차 방어 (훅)**: 플러그인 초기화 시 `${configDir}/skills/*/SKILL.md` frontmatter 스캔 → registry. `tool.execute.after` 훅이 skill_mcp 응답에서 "not found" 감지 시 정확한 skill 이름 프리펜드. 미등록 mcp_name (chrome-devtools-mcp 등)은 registry 에 없으므로 개입 안 함 — registry 는 whitelist 아닌 정보성 lookup.
- **관련 파일**: `src/skill-mcp-registry.ts`, `test/skill-mcp-registry.test.mjs` (13 케이스).

## 16. pollSubSession 방어 로직 & 자동 재시도

sub-session hang 은 세 가지 결이 다르며 각각 별도의 감지 로직 필요. 하나라도 빠지면 dispatch_stage 가 최상위 substage timeout(기본 60분)까지 대기.

| 결 | 원인 | 감지 조건 | 반환 |
|---|---|---|---|
| **status-absent gone** | orphan-scan / 서버 재시작으로 세션이 status map 삭제 | `!activeSignal && !hasPendingToolCall && !messagesChanged && !status && (sessionEverAppeared 또는 loose alive)` 상태가 `statusAbsentGraceMs` (default 5분) 이상 연속 유지 | `session_gone` (reason 없음) |
| **tool-call stall** | 사용자 승인 대기 (subagent 는 승인 불가) | `hasPendingToolCall && stalledMs >= toolCallStallThresholdMs` (default 60s) | `permission_stall` |
| **message stall** | LLM API 무응답 — bootstrap hang 또는 mid-stream inference hang | `(sessionEverAppeared \|\| sessionAliveByMessages) && busyIndicated && !hasPendingToolCall && (now - lastProgressAt) >= messageStallThresholdMs`. worktree-CWD 세션은 status map 에 등장하지 않으므로 `sessionAliveByMessages` (loose alive) 만으로도 predicate 성립. `busyIndicated = status?.type === "busy" \|\| (!status && messages.length > 0)`. progress = new message OR content-signature (`id:parts.length:text_total`) 변경 | `session_gone` (reason `"message_stall"`, mode `bootstrap` 또는 `mid_stream` 을 로그로 구분) |

### 16.1 status-absent gone grace period 상향 배경 (관측 기반)
이전 로직은 `SESSION_GONE_THRESHOLD=3` (3폴 연속 absent ≈ 8초 window) 판정이었으나, slow-first-token 모델 (qwen3.6-27b 등) 의 세션 초기화 및 tool-heavy substage 중간에 opencode 서버가 잠시 `session.status` push 를 멈추는 케이스에서 **대량의 false positive** 유발. 실 관측(PROJ-40406): 8초 window 하에서 SESSION_GONE 15건 발생 중 실제 죽은 세션 0건. Grace 5분 상향 후 tool-heavy 작업의 최대 정적 구간을 흡수한다.

### 16.2 Alive signal 이중화
`isRecentlyActive?: () => boolean` 콜백. opencode-plugin 은 두 map 유지:
- `sessionActiveToolCount: Map<string, number>` — `tool.execute.before` 에서 counter++, `tool.execute.after` 에서 counter--. counter > 0 이면 무조건 alive (heavy tool 5분+ 도 감지).
- `sessionLastToolExecuteAt: Map<string, number>` — before/after 양쪽 갱신. counter=0 이어도 최근 5분 이내 활동이면 alive.

pollSubSession 래퍼가 `(counter > 0) OR (Date.now() - last < TOOL_EXECUTE_ALIVE_WINDOW_MS=5분)` 로 콜백. `true` 시 gone-admission 스킵 + `firstGoneObservedAt` 리셋. Map entry 는 `cleanupSubSession` 및 orphan-scan pane-kill 경로에서 삭제 — 메모리 누수 없음.

### 16.3 Content-signature 진행 감지
`messagesChanged` = `messages.length` 변화 OR last assistant 컨텐츠 시그니처(`id + parts.length + text_total_length`) 변화. 스트리밍 텍스트가 기존 assistant message 에 in-place append 될 때 length 는 안 바뀌어도 signature 는 바뀌므로 progress signal 정상 발화, grace/stall timer 리셋. planner/publisher 같이 tool 없이 텍스트만 5분+ 스트리밍하는 substage 에서 status transient drop 되어도 false-positive 없음.

### 16.4 dispatch_stage 자동 재시도 및 지수 백오프 (모든 substage 통일)
- `session_gone` (양쪽 결) 반환 시 `attempt < MAX_ATTEMPTS(=3)` 이면 새 sub-session 만들어 continue.
- **`MESSAGE_STALL_BACKOFF_MS = [300_000, 600_000, 1_200_000]` (5분 / 10분 / 20분)** — attempt 1/2/3 에 순서대로 주입. 60/120/240s (1/2/4분) 값은 실 관측 (PROJ-40406) 에서 tool-heavy substage 중 정상 세션을 false-positive 로 killed. 5x 상향으로 slow-first-token + heavy tool call gap 을 흡수한다.
- `VERIFIER_STALL_THRESHOLD_MS = MESSAGE_STALL_BACKOFF_MS[last] = 1_200_000` (20분) — dispatch_verifier 는 single-attempt (재시도 없음) 이므로 배열 최장값 적용. verifier 는 대부분 빠르게 완료하므로 이 값을 실제로 소진할 일은 거의 없다.
- 재시도 세션 첫 prompt 에 state.json 재개 지시 추가 → 이미 완료된 substage 마커(`done=true`) skip. opencode SDK 가 세션 간 대화 이력 이관 미지원이므로 state.json 이 유일한 context 승계.
- `cleanupSubSession(skipSessionOps)`: status-absent 는 `true` (opencode NotFoundError 이벤트가 부모 세션 hang 유발), message_stall 은 `false` (세션 살아있어 abort 안전).

### 16.5 MESSAGE_STALL abort → session.deleted 이벤트 대기 (race 해소)
`pollSubSession` 이 message_stall 을 감지하면 즉시 `client.session.abort()` 를 fire 하지만, opencode 서버는 잠시 후 (관측: 최대 112s) `session.deleted` 이벤트를 발생시킨다. abort 반환 시점부터 delete 이벤트 발생 시점 사이에는 sub-agent 가 여전히 tool call 을 계속 발사할 수 있어 좀비 실행이 발생한다 (실 관측 PROJ-40406: abort 후 26s / 131s 뒤 write pyproject.toml 호출).

**해소 방법** (opencode-plugin.ts):
- `sessionDeletedWaiters: Map<string, Array<() => void>>` — 세션별 pending waiter 등록.
- `event` 핸들러에서 `type === "session.deleted"` 감지 시 해당 세션의 waiter 를 모두 resolve.
- dispatch_stage / dispatch_verifier 는 pollSubSession 이 message_stall 을 반환한 직후 `waitForSessionDeleted(subSessionID, SESSION_DELETED_WAIT_MS=30_000)` 로 최대 30s 대기. 이 후에만 redispatch 진입.
- 30s 초과 시 (`deleted_event_received=false` 로그) 대기 포기하고 진행 — safety net.

### 16.6 최종 실패 응답 스키마
`outcome_kind: "session_gone"` + `gone_reason: "message_stall" | "status_absent"`. team-leader 는 gone_reason 에 따라 `get_fallback_model` (message_stall) 또는 사용자 개입 대기 (status_absent) 선택.

### 16.7 관련 파일
- `src/poll-sub-session.ts` — 감지 로직 본체 (predicate 라인 466-472 참조).
- `src/opencode-plugin.ts` — dispatch_stage / dispatch_verifier 재시도 루프 + alive signal wire-up + sessionDeletedWaiters + waitForSessionDeleted.
- `test/poll-sub-session.test.mjs` — messageStallThresholdMs / statusAbsentGraceMs / isRecentlyActive / content-signature / active-tool-counter / gone-admission 회귀.
- `test/dispatch-stage-redispatch.test.mjs` — backoff 배열 (5/10/20분) + verifier 최장값 + resume prompt + 종료 조건.

## 17. tmux pane 소유권 & orphan cleanup

sub-agent pane 은 plugin 프로세스 라이프사이클과 독립 → in-memory Map(`TrackedPane`) 만으로는 plugin 재초기화·crash 시 orphan 남음. 해결: tmux pane user options 를 out-of-process 소유권 marker 로 사용, tmux 를 진실의 원천.

### 17.1 Marker schema
`spawnPaneInner()` 성공 직후 `tmux set-option -p -t <paneId>` 로 4개 marker:

| Marker | 값 | 용도 |
|---|---|---|
| `@mdn2_session` | sub-session id (`ses_XXX`) | cleanup 대상 판별 (필수) |
| `@mdn2_pid` | plugin 프로세스 pid | dead reap 스코프 (다른 live plugin 소유 pane 보호) |
| `@mdn2_stage` | stage 라벨 | 진단용 |
| `@mdn2_started_at` | unix seconds | race grace window |

### 17.2 Parent protection (hardrule)
`oc` 래퍼가 부모 opencode 를 항상 `opencode "$@" --port` 로 실행하므로 `pane_start_command` 에 `--port` 포함 pane 은 marker 여부 무관 **cleanup 대상 아님**. `PARENT_MARKER_PATTERN = /--port(\s|$)/` 필터, `scanOrphans()` 반환 전 스킵.

### 17.3 cleanup_panes 툴 동작
- **default** (`cleanup_panes()`) — `@mdn2_session` marker 가 있는 pane 만 kill. marker 없는 pane (사용자 수동 `opencode attach` 포함) 은 절대 건드리지 않는다.
- **`grace_seconds: N`** — 생성된 지 N 초 이내인 pane skip. 동시 dispatch pane 오살 방지 (default 0).

### 17.4 자동 reap (plugin init)
`TmuxMonitor` 생성 직후 async `checkTmuxVersion()` + `reapDeadOwnerPanes()`:
1. tmux < 3.0 → `checkTmuxVersion()` 이 throw + `versionBlocked` 세팅 → monitor 전체 자기-비활성화 (`active=false`, pane spawn/scan 전부 no-op). v1.0.0 breaking change — tmux >= 3.0 필수 (`set-option -p` 는 tmux commit `5f92f92`, v3.0 에서 도입).
2. `@mdn2_pid` 가 dead(`kill -0 <pid>` 실패) 인 marked pane 만 kill. 현재 plugin (`process.pid`) 또는 다른 live plugin 소유 pane 보존.

### 17.5 orphan-scan tick 가드 (`orphanCleanupGuard`)
`ORPHAN_SCAN_INTERVAL_MS = 60_000` 주기의 orphan-scan 은 `session.status()` 결과가 `undefined` 인 pane 을 "세션 소멸" 로 간주한다. 그러나 **`session.status()` 는 요청 디렉토리 스코프로 필터링**되므로, worktree 에서 생성된 서브세션 (`2_implementation.dev` 이후 전 구간) 은 부모 status map 에 영구히 나타나지 않는다. 가드가 없으면 정상 pane 이 60초 격자에서 kill 되고, kill 이 pane 내부 `opencode attach` 클라이언트를 종료시켜 서브세션 hang → `MESSAGE_STALL` → `REDISPATCH` 로 연쇄된다.

`orphanCleanupGuard(pane, ctx)` 가 kill 직전 3종을 검사하며, 하나라도 걸리면 해당 tick 을 skip 하고 `[orphan-scan] skip ... guard=<reason>` 을 debug 로 남긴다.

| reason | 조건 | 근거 |
|---|---|---|
| `foreign-live-owner` | `@mdn2_pid` 가 자기 pid 가 아니고 `kill -0` 생존 | `reapDeadOwnerPanes` 와 동일 정책 (§17.4) |
| `spawn-grace` | `@mdn2_started_at` 이 `ORPHAN_SPAWN_GRACE_MS`(120초) 이내 | status map 반영 지연·부트스트랩 창 보호 |
| `tool-activity` | `sessionActiveToolCount > 0` 또는 `sessionLastToolExecuteAt` 이 `TOOL_EXECUTE_ALIVE_WINDOW_MS`(5분) 이내 | status map 이 CWD 필터링돼도 실행 중임을 안다 (§16 liveness 신호 재사용) |

가드는 순수 함수로 `src/tmux-monitor.ts` 에 있으며 `isPidAlive` 주입으로 단위 테스트된다. 3종 모두 통과한 pane 만 기존 `status=idle`/`status=undefined` 판정으로 넘어가므로, 실제 orphan 회수 경로는 그대로 유지된다.

### 17.6 배치 모드 (`tmux.placement`) — 부장님 pane 리사이즈 회피 (hardrule)

`tmux.placement` 는 막둥이 pane 을 **어디에** 띄울지 결정한다. 기본값 `window`.

| 값 | tmux 명령 | 부장님 pane 리사이즈 | 비고 |
|---|---|---|---|
| `window` (기본) | `tmux new-window -a -t <sourcePane> -d -P -F '#{pane_id}' -n mdn2-<stage>-<ses8>` | **없음** | `-d` 로 active window 불변 → 포커스 복원 불필요 |
| `pane` (legacy) | `tmux split-window -t <sourcePane> <dir> -d …` + `select-layout` | **매 spawn/kill 마다 발생** | `layout`/`main_pane_size`/`agent_pane_min_width`/`split_direction` 는 이 모드에서만 유효 |

**왜 기본값이 `window` 인가**

`pane` 모드는 substage 마다 `split-window` → `select-layout` → (종료 시) `kill-pane` → `select-layout` 을 실행하며, 그때마다 부장님 pane 의 크기가 바뀐다 (실측: 170x44 → 80x44 → 170x44). 작업 중인 화면이 substage 마다 흔들리는 것은 그 자체로 방해이고, layout 재계산·포커스 복원 등 tmux 왕복도 매번 발생한다. `window` 모드는 `-d` 로 detached window 를 만들므로 부장님 pane 지오메트리와 포커스가 **전혀 변하지 않는다** (실측: 200x50 유지, active window 불변).

**주의 — 프롬프트 OSC 문자열 누출은 `placement` 로 해결되지 않는다 (실측). §17.7 의 지연 attach 가 해결한다.**

프롬프트 입력창에 `/0c0c/0c0c/0c0c…` 가 타이핑되는 현상의 원인은 pane 리사이즈가 **아니다**. 실측:

| 실험 | 결과 |
|---|---|
| 부장님 pane 리사이즈 (170x44 → 80x44) 발생 | opencode 추가 OSC 질의 **0회** — 리사이즈는 재탐지를 유발하지 않는다 |
| window 추가/삭제 (status-line 변화) | 추가 질의 **0회** |
| 자식 `opencode attach` spawn, `placement=window` | 부장님 프롬프트에 `:0c0c/0c0c/0c0c` **누출** |
| 자식 `opencode attach` spawn, `placement=pane` | **동일하게 누출** |

실제 원인은 **spawn 되는 자식 opencode TUI 가 기동 시 보내는 팔레트 질의**다. opencode 는 프로세스 기동 1회당 `\x1b]4;N;?` × 16 + `]10;?` / `]11;?` / `]12;?` = 19개를 보낸다. tmux 는 이 질의에 자체 응답하지 않고 **attach 된 클라이언트의 실제 터미널로 중계**한다 (클라이언트가 없으면 응답 0바이트). 왕복 경로에서 응답이 read 경계로 쪼개지면 tmux 가 `\x1b]4;N;rgb:RRRR` 앞부분만 소비하고 남은 `/GGGG/BBBB` 를 **활성 pane (= 부장님) 에 일반 키 입력으로 전달**한다. 누출 빈도는 **자식 opencode 프로세스 수**에 비례하므로, 30분 이상 세션에서 substage 수만큼 누적된다.

### 17.7 지연 attach — OSC 누출의 실제 해결책 (hardrule)

**막둥이 pane 은 절대 `opencode attach` 로 시작하지 않는다.** spawn 시에는 placeholder 만 띄우고, 부장님이 그 창을 포커스한 시점에 실제 TUI 로 교체한다. 즉시 attach 하는 모드는 제공하지 않는다 — 재현성 있게 프롬프트를 오염시키는데 지연 attach 대비 얻는 것이 없기 때문이다 (포커스 1회면 동일하게 live 관찰이 가능하고, 이후 다른 창으로 돌아가도 attach 상태가 유지된다).

| 단계 | pane 이 실행하는 명령 | 자식 opencode 프로세스 |
|---|---|---|
| spawn 직후 | `printf '<배너>'; while :; do sleep 86400; done` | **없음** |
| 포커스 이후 | `opencode attach <url> --session <id> --dir <wt>` | 이때 생성 |

oh-my-opencode 의 `tmux-core` (`buildTmuxPlaceholderCommand` → `activateTmuxPane`) 설계를 그대로 따른다. 동작:

1. spawn 시 pane 에 placeholder 를 띄운다. opencode 프로세스가 없으므로 **팔레트 질의 0개**.
2. `FOCUS_POLL_INTERVAL_MS`(2초) 주기로 `tmux list-panes -aF '#{pane_id}\t#{pane_active}\t#{window_active}'` 를 훑는다. 감시 타이머는 대기 중인 pane 이 있을 때만 돌고, 없어지면 스스로 멈춘다 (`unref()` 적용 — 프로세스를 붙잡지 않는다).
3. **`pane_active` 와 `window_active` 가 모두 1** 인 pane 만 포커스로 인정한다. `pane_active` 는 모든 window 의 자기 활성 pane 에 대해 1 이므로 단독 판정은 배경 pane 까지 attach 시켜 버린다.
4. 포커스 감지 시 `tmux respawn-pane -k -t <paneId> sh -c "<attach 명령>"` 으로 placeholder 를 실제 TUI 로 교체한다. 1회성이며 이후 폴링은 no-op.

**실측 검증** (실제 opencode 바이너리 + 조각난 OSC 응답을 내는 가짜 터미널):

| spawn 방식 | 자식 OSC 질의 | 부장님 프롬프트 누출 |
|---|---|---|
| placeholder (현재 구현) | 0 | **0** |
| 즉시 `opencode attach` (제거됨) | 발생 | `:0c0c/0c0c/0c0c` **재현** |

**불변식** — pane user option (`@mdn2_*`) 은 `respawn-pane` 을 견딘다 (tmux 3.6 실측). 따라서 `scanOrphans` / `cleanupOrphans` / `reapDeadOwnerPanes` / `closePane` fallback 은 교체 전후 모두 정상 동작한다. 마커를 다시 쓸 필요 없다.

`OTUI_PALETTE_IDLE_TIMEOUT_MS` 는 대기 시간만 줄일 뿐 질의 송신을 막지 못하므로 대안이 아니다.

**실패 pane 진단** — `auto_close_on_failure=false` 로 유지되는 실패 pane 은 `awaitingFocus` 를 유지한다. 즉 나중에 그 창을 선택하면 그때 `opencode attach` 로 전환되어 실패한 막둥이의 트랜스크립트를 볼 수 있다. 이 플래그를 여기서 내려버리면 부장님에게는 아무 정보 없는 배너만 남는다.

**활성화 실패 재시도** — `respawn-pane` 이 non-zero 로 끝나면 `awaitingFocus` 를 되돌려 다음 폴링에서 재시도한다. 폴링 콜백에는 in-flight 가드가 있어 2초 주기가 겹쳐 실행되지 않는다.

**모드 무관 유지 항목** — pane marker (`@mdn2_*`) 는 `window` 모드에서도 동일하게 기록되므로 `scanOrphans` / `cleanupOrphans` / `reapDeadOwnerPanes` / `closePane` fallback 경로는 전부 그대로 동작한다 (`list-panes -a` 가 전 window 를 스캔). `computeCapacity()` 는 `window` 모드에서 즉시 `EVICTION_DISABLED(0)` 을 반환해 폭 기반 eviction 을 끈다 — 별도 window 는 부장님과 폭을 경쟁하지 않는다.

### 17.8 closePane fallback
`dispatch_stage`/`dispatch_verifier` finally 의 `closePane(sessionId, opts)` 은 in-memory Map 에서 sessionId 를 못 찾으면 `scanOrphans()` marker 기반 재조회 후 kill. plugin 재초기화로 Map 리셋 케이스 커버. `window` 모드에서 pane 이 해당 window 의 마지막 pane 이면 `kill-pane` 이 window 까지 정리한다.

### 17.9 진단 명령
```bash
# 모든 marked pane 조회
tmux list-panes -aF '#{pane_id}\t#{@mdn2_session}\t#{@mdn2_pid}\t#{@mdn2_stage}\t#{@mdn2_started_at}\t#{pane_start_command}'

# 부모 opencode pane 만 조회
tmux list-panes -aF '#{pane_id}\t#{pane_start_command}' | grep -- '--port'

# 특정 sub-session pane 위치
tmux list-panes -aF '#{pane_id}\t#{@mdn2_session}' | grep ses_XXX
```

### 17.10 관련 파일
- `src/tmux-monitor.ts` — marker 상수, `spawnInNewWindow` / `spawnInSplitPane` / `rebalanceLayout` / `buildWindowName` / `buildPlaceholderCommand` / `activatePane` / `pollFocusOnce`, `scanOrphans` / `cleanupOrphans` / `reapDeadOwnerPanes` / `checkTmuxVersion` / `closePane` fallback / `orphanCleanupGuard` / `isPidAlive` / `ownerProcessId`.
- `src/opencode-plugin.ts` — `cleanup_panes` 툴 (grace_seconds), init 시 async reap 트리거, orphan-scan tick 에서 `orphanCleanupGuard` 적용.
- `test/tmux-monitor-orphan.test.mjs` — regression 케이스 (regex, 버전 게이트 ≥ 3.0 throw + versionBlocked, marker 부여, 스캔, cleanup, reap + graceSeconds, closePane marker fallback, orphan-scan 가드 3종 + 실제 orphan kill 유지).
- `test/tmux-monitor.test.mjs` — `placement` 파싱 기본값/폴백, `buildWindowName` 정규화, `window` 모드에서 split-window/select-layout/set-window-option/포커스 복원이 **호출되지 않음** + marker 는 그대로 기록됨, `pane` legacy 경로 유지, placeholder 가 attach 명령을 포함하지 않음·인용부호 이스케이프, 비포커스/`window_active=0` 시 미활성화, 포커스 시 `respawn-pane -k` 1회 멱등 활성화, respawn 실패 시 재시도 가능, eviction 시 포커스 감시 정지, 실패 유지 pane 의 포커스 활성화.

## 18. REJECTED verdict 재작업 flow

### 18.1 문제
초기 구현에서 `dispatch_verifier` 가 REJECTED verdict 를 반환하면 team-leader 가 verdict.raw 를 자체적으로 다음 dispatch_stage 프롬프트에 재주입해야 했다. 이 로직이 프롬프트 상 pseudocode 로만 존재했고 실제 구현은 없어 서브에이전트가 **REJECTED 사유를 모른 채 동일한 실수를 반복**해 무한 루프 (관측: 3_delivery.commit REJECTED 4~5회 반복) 가 발생했다.

### 18.2 해결 (dispatch_verifier + dispatch_stage 자동 연계)

**dispatch_verifier** (REJECTED 시):
1. verdict raw 텍스트를 4000자로 슬라이스해 `.stages."<PHASE>".substages."<SUBSTAGE>".last_verdict_reason` 에 기록 (JSON.stringify 로 안전 인코딩).
2. raw 첫 800자의 SHA-256 hash 앞 16자를 `.last_verdict_reason_hash` 에 기록 (streak 판정용).
3. 이전 hash 와 비교해 `.same_reason_streak` 카운터 증감 (동일: +1, 다름: 1 로 리셋).
4. `.rejected_count` 누적 (전체 재시도 카운터, 리셋되지 않음).
5. `.last_verdict_at` ISO timestamp 기록.
6. `same_reason_streak >= 5` 일 때 응답에 `same_reason_streak_exceeded: true` 추가.

**dispatch_verifier** (VERIFIED 시):
1. `.last_verdict_reason` / `.last_verdict_reason_hash` = null 리셋.
2. `.same_reason_streak` = 0 리셋.
3. `.rejected_count` 는 보존 (진단 목적).

**dispatch_stage** (호출 시):
1. state.json 에서 `.last_verdict_reason` 을 읽는다 (`state.sh get` exit code 0 && stdout != "null" 인 경우만).
2. 존재하면 프롬프트에 `=== 이전 검증 실패 사유 (재작업 시 참고) ===` 블록을 자동 삽입. 블록에는 verdict raw 원문 + 현재 streak 값 + 무한루프 임계 경고가 포함된다.
3. 서브에이전트 (publisher / engineer / planner) 는 자체 프롬프트의 "이전 검증 실패 사유 재주입 처리 규약" 섹션에 따라 이 블록을 읽고 재작업 방향을 잡는다.

**team-leader**:
1. `dispatch_verifier` 응답의 `same_reason_streak_exceeded == true` 감지 시 재시도 중단, verdict.raw + streak 을 사용자에게 보고 후 세션 종료.
2. 그 외 REJECTED 는 무제한 재시도 (dispatch_stage 재호출만 하면 last_verdict_reason 자동 주입됨).
3. **3_delivery.commit REJECTED 시 rollback 은 team-leader 가 직접 수행하지 않는다** (frontmatter git permission deny). publisher 가 재작업 진입 시 스스로 `rollback-commits.sh` 를 실행하도록 프롬프트 규약으로 강제되어 있다.

**publisher (3_delivery.commit REJECTED 재작업 진입 시)**:
1. 프롬프트에서 `=== 이전 검증 실패 사유 (재작업 시 참고) ===` 블록 감지.
2. `Target substage == commit` 확인.
3. **다른 어떤 작업보다 먼저** `bash <SCRIPTS_DIR>/rollback-commits.sh <이슈키>` 실행 (git reset --soft 로 base_sha 까지 되돌리며 working tree/index 변경은 보존).
4. rollback 후 §6-2 (커밋 계획 수립) 부터 새로 진행. 이때 verifier 지적 사항 (파일 분리·메시지 형식 등) 을 반영.

### 18.3 안전장치
- 동일 REJECTED 사유 5회 연속 → 자동 중단. 임계 상수 `SAME_REASON_STREAK_LIMIT = 5` 는 `src/opencode-plugin.ts` dispatch_verifier 스코프에 정의.
- Hash 비교 대상은 raw 첫 800자만 (verdict JSON body 의 timestamp/session_id 등 가변 필드 배제).
- 재작업 사유는 4000자 상한 (opencode 프롬프트 token limit 보호).
- state.sh get 은 raw 문자열을 unquoted 로 반환하므로 dispatch_stage 에서 JSON.parse 없이 그대로 프롬프트에 삽입. exit code != 0 을 null 판정 근거로 사용.

### 18.4 관련 파일
- `src/opencode-plugin.ts` — dispatch_verifier REJECTED 등록 로직 + dispatch_stage last_verdict_reason 자동 주입 (line 1329~).
- `agents/makdoong2-publisher.md` — "이전 검증 실패 사유 재주입 처리 규약" 섹션.
- `agents/makdoong2-team-leader.md` — "REJECTED 재시도 정책" 섹션.
- `test/verdict-reason-injection.test.mjs` — 8 regression 케이스 (첫 REJECTED / streak 5회 초과 / 다른 사유 리셋 / VERIFIED 리셋 / 특수문자 라운드트립 / state.sh get 계약).

### 18.5 stall 재디스패치 차단 (REJECTED streak 의 stall 경로 대칭)

**문제.** `MAX_ATTEMPTS = 3` 은 `dispatch_stage` **호출 1회 내부**의 예산이다. 예산 소진 후 실패 응답을 받은 team-leader 가 `get_fallback_model` 을 거쳐 `dispatch_stage` 를 다시 호출하면 예산이 `attempt=1` 로 리셋된다. 실측 (60분 관측) 에서 `2_implementation.dev` 가 300초 MESSAGE_STALL → REDISPATCH → 재호출 루프에 빠졌고, `local/qwen3.6-27b` 와 fallback `github-copilot/claude-haiku-4.5` **양쪽에서 동일하게 stall** 했다. 즉 모델 교체는 해법이 아니다.

`hang_history` 는 이미 기록되고 있었으나 소비처가 `agents/makdoong2-team-leader.md` 의 자연어 권고뿐이라 LLM 이 무시하면 강제력이 없었다.

**해결.** 호출 간 유일하게 보존되는 신호인 `hang_history` 길이를 `dispatch_stage` **진입 시점**에 검사한다.
1. `state.sh get <issue> '.stages."<PHASE>".substages."<SUBSTAGE>".hang_history // [] | length'` 로 누적값 조회.
2. `timeout.stall_escalate_threshold` (기본 5) 이상이면 **세션을 생성하지 않고** `{ ok: false, escalate: true, stall_streak_exceeded: true, hang_history_len, threshold }` 즉시 반환.
3. substage 성공 시 `hang_history` 를 `[]` 로 리셋 (VERIFIED 시 `same_reason_streak` 리셋과 동일 규약).

**cwd 정합성 (hardrule).** `hang_history` 의 read / append / reset 은 **모두 `args.worktree`** 컨텍스트에서 실행해야 한다. `state.sh root()` 가 cwd 의 git toplevel 을 쓰므로, append 만 cwd 없이 실행하면 프로세스 cwd 기준으로 기록되어 상한 검사가 다른 state.json 을 읽고 차단이 무력화된다. verdict streak 경로와 동일한 관례다.

**fail-open.** `shouldEscalateStall` 은 `hangCount` 가 NaN (state.json 판독 실패) 이면 차단하지 않는다. 판독 불가를 차단으로 취급하면 state 를 읽지 못하는 환경에서 워크플로우 전체가 교착된다.

**모듈 분리 이유.** `shouldEscalateStall` 은 `src/stall-escalation.ts` 에 있다. opencode 플러그인 로더가 진입 파일의 **모든 named export 를 plugin factory 로 호출**하므로 (§ PROJ-40406 근본원인, `test/plugin-exports-shape.test.mjs` 가 export 집합을 고정) 신규 helper 는 별도 파일에서 import 해야 한다.

**관련 파일**: `src/stall-escalation.ts`, `src/opencode-plugin.ts` (진입 게이트 + 성공 리셋), `src/config.ts` (`DEFAULT_STALL_ESCALATE_THRESHOLD`), `agents/makdoong2-team-leader.md` ("stall 재디스패치 금지" hardrule), `test/dispatch-stage-redispatch.test.mjs`.

## 19. Publisher direct executor 모델

### 19.1 배경
초기 구현은 hybrid publisher 모델이었다: publisher 가 commit spec (파일별 명령·메시지) 을 JSON 으로 반환하면 team-leader 가 그 spec 을 받아 `git commit` / `git push` 를 실행. 이 모델은 오케스트레이터가 spec 검증 및 실제 실행을 모두 해야 하는 부담이 있었고, publisher 자기선언과 team-leader 실제 실행 사이 갭에서 마커 불일치가 자주 발생했다.

### 19.2 변경 (2026-07 이후)
- team-leader frontmatter permission: `git commit*` / `git push*` / `git add*` / `git rm*` / `git worktree*` 모두 **deny**.
- publisher frontmatter permission: 위 명령 모두 **allow** (단 `--force` / `reset --hard` / `branch -D` / `worktree remove` 는 deny 유지).
- 3_delivery.commit: publisher 가 worktree 에서 직접 `git add <파일>` → `git commit -m ...` 을 파일별로 반복.
- 3_delivery.pr: publisher 가 worktree 에서 직접 `git push -u origin HEAD` + bitbucket MCP `createPullRequest`.
- 3_delivery.review: 변경 없음 (원래 publisher 직접 실행).

### 19.3 1 파일 = 1 commit 강제
- publisher 프롬프트: `git add .` / `-A` / `-u` 사용 금지, 파일별 `git add -- "$FILE"` 강제.
- post-commit-verify.sh: 각 커밋 SHA 를 순회하며 `git show --name-only --pretty=""` 로 파일 수를 확인, 1 초과 시 REJECT.
- verifier: post-commit-verify.sh 를 재실행하고 커밋 메시지 형식 (`<Type>: <이슈키> - <요약>`) / Type 허용값 / 이슈키 일치 / 제목 길이 / 마침표 / 결합어 / 이슈 종료 키워드 (Resolves/Closes/Fixes/See also) 모두 재검증.

### 19.4 관련 파일
- `agents/makdoong2-publisher.md` — direct executor 프론트매터 + §1 commit + §2 pr.
- `agents/makdoong2-team-leader.md` — git deny + orchestration only.
- `stages/07-commit.md` + `stages/08-pr.md` — publisher 직접 실행 명세.
- `gates/stage6-post-commit-verify.sh` — 1 파일/commit + 메시지 형식 + Type + 이슈키 강제.
- `agents/makdoong2-verifier.md` §2-3 — 3_delivery.commit 재검증 절차.
- `test/commit-atomicity-verify.test.mjs` — 8 regression 케이스 (통과 + 다중 파일 REJECT + Type 누락 REJECT + 잘못된 Type REJECT + 다른 이슈키 REJECT + 마침표 REJECT + 키워드 누락 REJECT + marker 누락 REJECT).
