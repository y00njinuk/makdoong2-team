# makdoong2-team

> Jira 이슈를 3 phase · 8 substage로 나눠 역할별 전문 에이전트에게 위임하는 self-contained opencode 플러그인.
>
> **Phase**: `1_planning` (jira/requirements/scope) → `2_implementation` (dev/test) → `3_delivery` (commit/pr/review)

## 설치

패키지는 사내 Artifactory (`@local` scope) 에 게시된다.

```bash
# ~/.npmrc 최초 1회
# @local:registry=https://registry.example.com/artifactory/api/npm/npm-local-repos/
# //registry.example.com/artifactory/api/npm/npm-local-repos/:_auth=<base64 user:pass>

npm install -g @local/makdoong2-team    # npm 모듈 설치
makdoong2-team install                  # opencode 배포 (agents, skills, opencode.json 패치)
makdoong2-team doctor                   # 설치 진단
```

로컬 dev 설치는 `npm pack` 후 tgz 를 `npm install -g` 한다.

- `install` 은 agents / skills / config seed 만 `~/.config/opencode/` 에 복사한다. 런타임 자산 (dist, gates, stages, scripts) 은 npm 모듈 내부에서 로드된다.
- opencode 는 npm registry 에서 플러그인을 fetch 하지 않고 `~/.cache/opencode/packages/@local/makdoong2-team@latest/` 심볼릭 링크로 seed 된 전역 모듈을 로드한다.
- 재설치 시 `makdoong2-team.json` 은 보존된다. 덮어쓰려면 `--force`.

## 설정 — `makdoong2-team.json` 한 파일

모든 설정은 `~/.config/opencode/makdoong2-team.json` 하나로 제어한다. 플러그인 (`src/config.ts`) 과 셸 게이트 (`scripts/config.sh`) 가 같은 파일을 읽는다. 환경변수는 사용하지 않는다.

| 블록 | 용도 |
|---|---|
| `agents` | 에이전트별 모델 오버라이드 (`model`, `variant`, `fallback_models`) |
| `model_policy.allowed_primaries` | 빌트인 primary 허용 목록 **확장** (추가 전용 — 빈 배열은 "제한 없음" 이 아니라 "추가 없음") |
| `coverage.threshold` | 커버리지 게이트 최소 (%, 기본 95) |
| `timeout.stall_escalate_threshold` | substage 누적 hang 상한 (기본 5). 초과 시 dispatch_stage 차단 후 사용자 에스컬레이션 |
| `tmux` | 서브세션 pane 모니터 (기본 비활성). `placement` 로 배치 방식 선택 — 아래 참조 |
| `worktree.extra_exclude` | worktree 동기화 추가 제외 패턴 |
| `logging.level` | 플러그인 콘솔 로그 레벨 (`silent`/`error`/`warn`/`info`/`debug`/`trace`, 기본 `error`) |
| `logging.max_bytes` | `mode="file"` 로그 회전 임계값 (기본 10 MiB). 초과 시 `<path>.1` 로 회전 |
| `paths` | 비표준 설치 경로 오버라이드 |
| `hosts` | 리서치 skill MCP 온프레미스 endpoint (`JIRA_HOST`, `CONFLUENCE_HOST`, `BITBUCKET_API_BASE_PATH`, `BAMBOO_URL`) |
| `secrets` | 리서치 skill MCP 토큰 (Bitbucket/JIRA/Confluence/Bamboo) |

로그 레벨은 임계값 기반이다. `error` 는 error 만, `debug` 는 error/warn/info/debug 모두 출력. 기본값 `error` 는 BLOCKED 등 중요 이벤트만 노출하고 orphan-scan 같은 정보성 로그는 억제한다. 로그 레벨 변경 후에는 opencode 를 재시작해야 반영된다 (config 는 플러그인 초기화 시 한 번만 로드된다).

`mode="file"` 로그는 **append 전용**이다. 한 호스트의 모든 opencode 프로세스 (메인 TUI, 막둥이 pane, `npm test`) 가 같은 파일을 공유하므로 truncate 하면 다른 프로세스의 기록이 사라진다. 프로세스 구분은 각 라인의 `[pid=N]` 태그로 하고, 크기는 `max_bytes` 회전으로 제한한다. 상세: ARCHITECTURE.md §14.

빌트인 primary 허용 목록은 `local/*` 와 `github-copilot/*` 브랜드 (claude-haiku/opus/sonnet, gemini, gpt, grok-code, kimi, mai-code, qwen 계열 총 40개) 이다. 전체 목록은 `src/model-fallback-policy.ts` 의 `DEFAULT_ALLOWED_PRIMARIES` 참조. fallback tier 는 항상 primary 보다 strictly lower 여야 한다 (`low < medium < high < max`).

```jsonc
{
  "model_policy": {
    "allowed_primaries": ["custom-provider/custom-model"]
  },
  "agents": {
    "makdoong2-engineer": {
      "model": "anthropic/claude-opus-4-7",
      "fallback_models": [
        { "id": "github-copilot/claude-haiku-4.5", "tier": "low" }
      ]
    }
  }
}
```

### `tmux.placement` — 막둥이 배치 방식

| 값 | 동작 | 부장님 pane 리사이즈 |
|---|---|---|
| `window` (기본) | 막둥이마다 **별도 tmux window** (`new-window -d`) | 없음 |
| `pane` | 부장님 window 를 분할 (`split-window` + `select-layout`) | 매 spawn/kill 마다 발생 |

`pane` 모드는 substage 마다 부장님 화면이 분할·재배치되어 흔들린다 (실측 170x44 → 80x44 → 170x44). `window` 모드는 detached window 를 쓰므로 부장님 pane 크기와 포커스가 전혀 변하지 않는다. 기본값을 `window` 로 둔 이유다.

`layout` · `main_pane_size` · `agent_pane_min_width` · `split_direction` 은 `placement: "pane"` 일 때만 의미가 있다.

### 막둥이 창은 포커스할 때 붙는다 (지연 attach)

막둥이 pane 은 spawn 직후에는 배너만 띄운 placeholder 상태이고, **해당 창을 선택하는 순간** `opencode attach` 로 자동 전환된다. 한 번 전환되면 다른 창으로 돌아가도 attach 상태가 유지되므로 live 관찰에 제약은 없다.

프롬프트 입력창에 `/0c0c/0c0c/0c0c…` 가 타이핑되던 현상의 원인은 **spawn 되는 자식 opencode TUI 가 기동 시 보내는 터미널 팔레트 질의**다 (프로세스당 19개). tmux 가 이를 실제 터미널로 중계하는데, 응답이 조각나면 남은 조각이 활성 pane(= 부장님)에 키 입력으로 배달된다. 포커스 전까지 자식 프로세스를 아예 만들지 않아 이 경로를 차단한다 — 실측상 누출 0건. 즉시 attach 하는 모드는 제공하지 않는다 (동일 현상이 재현됨). oh-my-opencode 의 `tmux-core` placeholder → `respawn-pane -k` 설계를 따랐다. 상세: ARCHITECTURE.md §17.7.

`makdoong2-team validate` 로 정책 위반 여부와 최종 chain 을 사전 검증할 수 있다. 위반 시 plugin 은 defaults 로 롤백되며 stderr 에 경고를 남긴다. 전체 스키마: `assets/makdoong2-team.schema.json`.

## 에이전트 5개

| ID | 담당 phase | 권한 요약 |
|---|---|---|
| `makdoong2-team-leader` | 라우팅 (orchestrator) | commit/push 허용 — PRIMARY 단계 직접 실행 |
| `makdoong2-planner` | 1_planning | 읽기 전용 |
| `makdoong2-engineer` | 2_implementation | edit/write 허용, commit/push deny |
| `makdoong2-publisher` | 3_delivery | 읽기 전용 — spec 계산만 (하이브리드) |
| `makdoong2-verifier` | 메타 검증 | 읽기 전용 |

**Publisher 하이브리드**: `3_delivery.commit`/`3_delivery.pr` 는 publisher 가 spec (commit 메시지, PR 본문) 을 계산·반환하고, team-leader 가 그 spec 을 받아 실제 git 명령을 실행한다. `3_delivery.review` 는 publisher 가 bitbucket MCP 로 직접 실행.

## 작업 범주화 & 자동 승인

`1_planning.requirements` substage 가 작업을 `.policy.category` 로 분류한다 (`minor` | `major`). `1_planning.scope` 는 minor → major 상향만 허용한다.

- **minor** — 전 substage 무인 자동 진행
- **major** — 테스트까지 무인 진행 후 `3_delivery.commit` 직전 1곳만 사람 승인 + `change-report.md` 필수

셸 게이트가 `.policy` 마커를 결정론적으로 검사한다 (LLM 호출 0).

## 단계별 시스템 프롬프트 확장

각 단계(substage)에 시스템 프롬프트를 추가하려면 **어느 계층**에 넣을지 먼저 정한다. `dispatch_stage` 는 세 계층을 조합해 서브에이전트에 주입한다.

| 계층 | 파일 | 범위 | 재빌드 |
|---|---|---|---|
| ① Agent persona | `agents/makdoong2-<role>.md` | 해당 role 이 담당하는 **모든 substage 공통** | 불필요 (마크다운만) |
| ② Stage spec | `stages/NN-<name>.md` | **단일 substage 전용** 절차·게이트·마커 | 불필요 (마크다운만) |
| ③ Dispatch header | `src/opencode-plugin.ts` `promptText` | **모든 stage 공통** 헤더 라인 | 필요 (`npm run build` + republish) |

### Phase → Agent → Stage spec 매핑

| Substage | Agent (① persona) | Stage spec (② 절차) |
|---|---|---|
| `1_planning.jira` | `makdoong2-planner` | `stages/01-jira.md` |
| `1_planning.requirements` | `makdoong2-planner` | `stages/02-requirements.md` |
| `1_planning.scope` | `makdoong2-planner` | `stages/03-scope.md` |
| `2_implementation.analysis` | `makdoong2-analyzer` | `stages/04-analysis.md` |
| `2_implementation.dev` | `makdoong2-engineer` | `stages/05-worktree-dev.md` |
| `2_implementation.test` | `makdoong2-engineer` | `stages/06-test.md` |
| `3_delivery.commit` | `makdoong2-publisher` | `stages/07-commit.md` |
| `3_delivery.pr` | `makdoong2-publisher` | `stages/08-pr.md` |
| `3_delivery.review` | `makdoong2-publisher` | `stages/09-review-comments.md` |

매핑 원본: `src/agent-stage-config.ts` (`STAGE_SPEC_FILES` + `agentForStage()`).

### 어디에 무엇을 쓰는가

- **① Agent persona (`agents/*.md`)** — 페르소나, 권한 요약, 금지사항, 공통 절차. 같은 role 의 substage 여러 개에 걸치는 규칙. YAML frontmatter (`tools`, `permission`) 아래 본문이 시스템 프롬프트로 주입된다.
- **② Stage spec (`stages/*.md`)** — 해당 substage 전용 단계별 절차, 게이트 조건, state.json 마커 예시. `dispatch_stage` 프롬프트에 `Stage spec: read <경로> and follow it strictly.` 로 참조 지시가 자동 삽입된다.
- **③ Dispatch header (`src/opencode-plugin.ts`)** — 모든 stage 에 공통으로 강제할 헤더 (예: `Working directory`, `Scripts directory`, `Issue`). 거의 건드릴 일 없음. 수정 시 `npm run build` + 재배포 필요.

### 새 substage 추가 절차 (드문 경우)

기존 substage 에 프롬프트를 **추가**만 하려면 위 ① 또는 ② 를 편집하면 끝난다. **새 substage 자체를 추가**하려면 아래 5곳을 함께 수정한다.

1. `src/agent-stage-config.ts` — `Stage` union 에 신규 키 추가 + `STAGE_SPEC_FILES` 에 spec 파일 경로 매핑 + 필요 시 `agentForStage()` 라우팅 확장.
2. `stages/NN-<name>.md` — 신규 stage spec 파일 생성 (절차, 게이트 조건, 마커 예시).
3. `agents/makdoong2-<role>.md` — 담당 agent 페르소나에 신규 substage 처리 로직 추가.
4. `gates/verify.sh` — 진입 게이트 검증 로직 추가 (state.json 마커 조건).
5. `README.md` 매핑표 갱신 + `AGENTS.md` sealed workflow 규약 반영.

`makdoong2-team validate` 로 정책 위반 여부를 사전 검증한 뒤 `npm test` 로 게이트 정책 회귀 확인.

### 편집 후 반영

- ① · ② 만 수정 → 재빌드 불필요. `makdoong2-team install --force` 로 `~/.config/opencode/agents/` 에 재배포.
- ③ 또는 `src/**` 수정 → `npm run build` 후 배포 절차(아래 "배포" 섹션) 진행.

상세 규약(sealed workflow, skill_mcp lazy-load, state.sh 하드룰)은 `AGENTS.md` 참조.

## 배포 (Maintainer)

두 가지 경로 모두 **승인 게이트 2회**를 통과해야 배포된다.

### 경로 A — `npm run release:*` (권장)

```bash
npm run release:patch   # 0.2.3 → 0.2.4  (버그 수정)
npm run release:minor   # 0.2.3 → 0.3.0  (기능 추가)
npm run release:major   # 0.2.3 → 1.0.0  (breaking)
```

`scripts/release.sh` 가 9단계를 순차 실행한다 — pre-flight → `npm test` → 버전 미리보기 → **승인 #1** → `npm version` → `publish --dry-run` → **승인 #2** → `npm publish` → `git push --follow-tags`. Publish 이전 실패 시 자동 롤백. CI 에서는 `--yes` 로 대화형 우회 (대화형 셸에선 금지).

### 경로 B — git push 시 자동 배포

`package.json` 의 `version` 을 수동으로 올린 커밋을 push 하면 `.husky/pre-push` 훅이 감지해 승인 게이트 2회 후 자동 publish 한다. 이미 registry 에 있는 버전은 skip.

### 사내 Artifactory 인증

`~/.npmrc` 에 `_auth` (base64 `user:pass`) 형식으로 저장 (chmod 600). `~/.docker/config.json` 의 동일 registry 호스트 항목에서 재사용 가능.

## Testing

```bash
npm test               # build + smoke + gate policy + install-lib
npm run test:install   # 설치 라이브러리 테스트
```

`.husky/pre-push` 가 unit test 실행 + version 변경 감지 시 자동 배포 훅을 트리거한다.

## 문서

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — 어떻게 동작하는가. 모듈, hook 흐름, custom tool API, state schema, 실패 모드.
- **[DESIGN.md](./DESIGN.md)** — 왜 이렇게 설계했는가. 하네스 4기둥 (Constrain / Inform / Verify / Correct).
- **[AGENTS.md](./AGENTS.md)** — 개발 규약 (git commit, npm 배포, sealed workflow).

## 라이선스

MIT — [`LICENSE`](./LICENSE)
