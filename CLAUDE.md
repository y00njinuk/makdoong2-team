## Project Overview
- **CLAUDE.md**: 개발자가 코드를 작성할 때 따라야 하는 규칙과 가이드라인.
- **ARCHITECTURE.md**: 시스템이 어떻게 동작하는지 (모듈 책임, tool API, hook 흐름, 워크플로우 상태, pollSubSession 방어, tmux 소유권, 배포·릴리즈 프로세스 등).
- **DESIGN.md**: 왜 이렇게 설계했는지 (설계 원칙과 트레이드오프).

새 기능·수정을 착수하기 전에 관련 아키텍처 섹션을 먼저 참조한다.

## Git Commit Guidelines
- 모두 한국말(Korean)로 반드시 작성. 제목과 본문은 빈 줄로 구분하며, 본문은 필요할 때만 작성
- **중요. 3_delivery.commit substage 는 "1 파일 = 1 commit" 원칙을 절대적으로 준수** (post-commit-verify.sh 가 강제). publisher 가 worktree 에서 파일별로 개별 커밋을 생성한다.
- 여러 파일이 논리적으로 하나의 변경이라도 각 파일마다 개별 커밋으로 만들어야 하며, `git add .` / `-A` / `-u` 사용 금지.
- 제목 형식: `<type>: [<Issue>] <subject>` (예: `Feat: PROJ-00000 - 기능 구현`)
- type 종류: feat, fix, chore, refactor, docs, style, test, perf, ci, build, revert
- 제목은 50자 이내, 대문자로 시작, 마침표 금지, 명령조(imperative)로 작성
- 이슈 참조 마커: `[RV] <이슈키>` — 이슈 번호 연결. 본문이 있을 때 필수
- AI 기여도 마커: `[AI] 100%` — AI 작성 비율 표기
    -  예시: `[RV] PROJ-00000` / `[AI] 100%`
- 본문은 "어떻게"보다 "무엇을, 왜"에 초점 (변경 이유와 영향 설명)
- 제목 예시:
  ```
  Feat: PROJ-32487 - 재시도 큐 기능 비활성화
  Chore: PROJ-39988 - .makdoong2-team 워크플로우 디렉토리 gitignore 추가
  ```
- 본문 예시:
  ```
  Test: PROJ-39397 - ProductCacheLookupTest V2 응답 검증 테스트 추가

  TestContainers 환경에서 상품 캐시 조회 API V2 응답의 정합성을 검증하는 Scala 테스트를 추가한다.

  - CassandraFixture.scala: V2 테스트용 만료 항목 삽입 구문, 중복 키 카운터 증가 구문 및 메서드 추가
  - ProductCacheLookupTest.scala: 두 가지 시나리오 검증
      1) fullList / summaryList 필드 전체 정합성 (만료 항목 포함)
      2) zero response (item_cnt = 0) 검증
  ```
  ```
  Refactor: PROJ-37151 - Cassandra Entity → API Response 변환 헬퍼 메서드 수정

  Cassandra Entity → API Response 변환 헬퍼 메서드 수정
  - 메서드 이름에서 메서드의 동작을 유추할 수 있도록 make_expired_item_v1 이름으로 변경
  - src 매개변수의 타입이 서로 달라서 함수를 분리한 것을 하나의 메서드로 통일하고 필요한 데이터를 인자로 직접 전달받는다.
  ```

### Untracked 파일 취급 (커밋/PR 단계)
- `3_delivery.commit` / `3_delivery.pr` 게이트는 worktree 의 untracked 파일을 **자동으로 커밋 대상에서 제외**하고 진행한다. 사용자 확인 프롬프트를 띄우지 않는다.
- untracked 파일이 커밋에 필요하면 engineer 가 `2_implementation.dev` 단계에서 명시적으로 `git add` 해야 한다.
- 빌드 산출물·IDE 설정 등은 원칙적으로 repository 최상위 `.gitignore` 에 추가한다. worktree 로컬 전용 제외 패턴은 `.gitignore` 파일 대신 `.git/info/exclude` 에 추가한다 (`wt-sync-ignored.sh` 가 자동 관리).

## 코드 작성 규칙

### 로깅
- 플러그인 코드(TypeScript)에서 `logger.info(...)` 는 사용하지 않는다. 기록해야 할 이벤트는 다음 세 레벨 중 하나로 배정한다.
  - `logger.debug(...)`: 진단·추적용. 상세 상태 전이, 워크플로우 이벤트(createWorktree/wt-sync/verifier verdict/GONE_ADMIT 등).
  - `logger.warn(...)`: 회복 가능한 이상 상황 (동기화 실패 후 계속 진행 등).
  - `logger.error(...)`: 즉시 사용자 개입 필요 또는 워크플로우 차단 이벤트.
- 사용자 로깅 레벨 설정: `makdoong2-team.json .logging.level`. 기본 `error`. 개발·디버깅 시 `debug` 로 승격해서 이벤트 흐름을 관찰한다.
- **파일 로그는 절대 truncate 하지 않는다 (hardrule)**. `mode="file"` 은 항상 append 하고 `max_bytes` 초과 시에만 `<path>.1` 로 회전한다. 한 호스트의 opencode 프로세스 전부가 같은 파일을 공유하므로 truncate 는 다른 프로세스의 로그를 삭제한다. 세션 구분은 `[pid=N]` 태그로 한다.
- 로깅 아키텍처 상세: ARCHITECTURE.md §11 참조.

### state.json 조작 (hardrule)
- state.json **쓰기**는 오직 `scripts/state.sh` (root/issue/init/status/get/set/append/migrate) 를 통해서만 한다.
- **`state.sh` 안에서도 `cmd > tmp && mv tmp target` 관용구를 쓰지 않는다.** bash 의 errexit 는 `&&` 리스트의 왼쪽 피연산자 실패를 면제하므로, jq 가 죽어도 스크립트는 계속 진행해 **성공 메시지를 찍고 exit 0** 한다. 호출자는 마커가 기록됐다고 믿고 넘어가지만 파일은 그대로다 — issue #6-① 부류의 구조적 정지가 여기서 재생산된다. 쓰기는 전부 `write_json_atomic()` 을 거친다: 대상 존재·JSON 유효성 선검사 → **대상과 같은 디렉토리**에 임시 파일(크로스 디바이스 `mv` 방지) → jq 종료코드 명시 검사 → 결과 유효성 확인 → 교체. `test/state-sh-write-atomicity.test.mjs` 가 강제한다.
- `python -c "... open('state.json', 'w') ..."`, `jq ... > state.json`, `sed -i state.json`, `cp`/`mv`/`rm`, `git add state.json` 등 인터프리터 서브프로세스나 리다이렉트 우회는 `tool.execute.before` 훅이 물리적으로 차단한다.
- **읽기는 차단하지 않는다.** `ls` / `cat` / `file` / `head` / `stat` / `jq` / `git check-ignore` 로 state.json 을 조회하는 진단 명령은 통과한다. 존재·유효성 확인은 `bash <SCRIPTS_DIR>/state.sh status <이슈키>` 를 쓴다 (exists / readable / phantom_keys / next 를 key=value 로 보고). 읽기까지 막으면 `state_unreadable` 이 안내하는 복구 절차를 수행할 수단이 사라진다.
- 판정은 `src/state-access-guard.ts` 의 `classifyStateJsonAccess` 하나가 하고, universal state 훅과 leader 하드룰 2 가 **둘 다** 이것을 쓴다. 한쪽만 고치면 leader 는 여전히 막힌다.
- **리디렉션·세그먼트 판정은 인용 구간을 걷어낸 문자열로 한다.** 따옴표 안의 `>`·`|`·`;` 는 셸 메타문자가 아니다 — `jq -e '… | length >= 1'` 같은 읽기 전용 술어가 "파일 쓰기" 로 차단됐다 (issue #6-③). `stripQuotedSpans()` 는 따옴표 안쪽만 공백으로 덮고 **문자 오프셋을 보존**한다 (`splitUnquotedSegments()` 가 그 위치를 원문에 대응시켜 자른다). 인용을 걷어내면 가려지는 두 경로는 따로 막았다: `sh -c`/`eval` 은 쓰기 지표에 추가, 큰따옴표 안 명령 치환(`$(`·백틱)과 미종료 따옴표는 덮지 않는다.
 애매한 명령은 차단이 기본값이다 — 읽기 오탐에는 `state.sh status` 우회로가 있지만 쓰기 미탐에는 복구 수단이 없다.
- 서브커맨드 목록을 늘릴 때는 `state.sh` 의 case, `STATE_SH_SUBCOMMANDS`, usage 한 줄을 함께 고친다 (`test/state-access-guard.test.mjs` 가 세 곳의 정합성을 강제한다).
- 스키마는 항상 hierarchical: `.stages."<PHASE>".substages."<SUBSTAGE>".<field>`. flat 표기(`"<PHASE>.<SUBSTAGE>"`) 금지. `.policy.auto_approve.*` 만 예외적으로 flat 유지.
- 상세: ARCHITECTURE.md §5.2 (스키마) / §5.5 (읽기 허용 · `state.sh status` · 복구) 참조.

### 파일 편집 (sealed sub-agent + team-leader)
- `makdoong2-team-leader` 는 Write/Edit/Patch/Multiedit 툴 부재 → 직접 파일 편집·생성 불가. 모든 파일 조작은 `dispatch_stage` 로 위임.
- **team-leader 는 git 명령(`commit` / `push` / `add` / `rm` / `worktree`) permission 이 deny** → 3_delivery.* 는 publisher 가 worktree 에서 직접 실행. team-leader 는 오케스트레이션만 수행.
- Sealed sub-agent (`planner` / `analyzer` / `engineer` / `publisher` / `verifier` / `researcher`) 는 outer-world 위임 툴(`call_omo_agent`, `delegate_task`, `background_task`, `task_*`) 호출 금지. `tool.execute.before` 훅이 런타임 차단.
- **신규 서브에이전트를 추가하면 `SEALED_SUBAGENTS` 에도 반드시 등록한다.** 프론트매터에서 Task 툴을 빼는 것은 1차 방어일 뿐이고, 이 집합에 빠지면 런타임 2차 방어가 그 에이전트만 통과시킨다.
- 상세: ARCHITECTURE.md §4.2 참조.

### issue-reporter 스킬 (사용자-전용 트리거 — hardrule)
- `makdoong2-issue-reporter` 는 **skill + agent + command 3종 세트**다. skill 이름 == command 파일명 == agent 이름이 모두 일치해야 command 가 opencode 의 skill-derived command 를 덮어써 전권(full-permission) 에이전트로 라우팅된다 (`test/issue-reporter-guard.test.mjs` 가 강제).
- **유일한 트리거는 사용자의 `/makdoong2-issue-reporter` 직접 호출.** team-leader 포함 다른 에이전트가 `skill()` 로 자율 로드하면 `tool.execute.before` 훅이 차단한다. 실패를 관측한 에이전트는 사용자에게 커맨드 실행을 안내만 한다.
- **에이전트는 어떤 목록에도 노출되지 않는다.** `mode: subagent` + `hidden: true` 로 primary 선택 목록과 `@` 멘션·task 자동완성에서 모두 감춘다. 커맨드의 **`subtask: false` 는 필수** — 이게 빠지면 `mode: subagent` 가 자식 세션으로 격리시켜 직전 대화 컨텍스트를 잃는다. 목록에서 감추는 것만으로는 부족해서(`task` 툴은 mode 를 검사하지 않는다) `issueReporterTaskSpawnViolation` 이 spawn 을 런타임 차단한다.
- **이슈 본문 양식은 SKILL.md §6 이 고정한다.** 필수 섹션 11 + 조건부 섹션 4(`## 관련 관찰` / `## 참고: 의심 근본 원인 코드` / `## 부수 관찰 (minor)` / `## 제안 (참고)`), 제목 규약, 제출 전 자기 점검 11항목. 양식은 발명이 아니라 이슈 #5 가 실제로 갖췄던 구성을 역으로 규약화한 것이다 — 그 이슈의 타임라인·로그 발췌·반복 차단 표·의심 코드 지목이 그대로 v1.7.0 수정에 쓰였다. **자기 점검은 `cat <payload>` 표시 전에 끝낸다** (표시 후 본문을 고치면 표시 증명이 무효가 되어 승인 절차를 처음부터 다시 밟는다). 조건부 섹션은 3장 수집에서 근거가 나왔을 때만 넣고, 근거 없이 채우지 않는다.
- **GitHub 게시(이슈·코멘트·Gist·라벨)는 사용자가 원문 전체를 보고 세션 안에서 승인해야만 가능하다.** 승인은 두 조각이다: (가) 의사표시 — frontmatter 의 `"*-d @/*": "ask"` 가 띄우는 opencode permission 프롬프트의 yes/no, (나) 정보에 근거한 동의 — 전송 전 단독 `cat <payload>` 의 sha256 을 훅이 기록하고 전송 직전 대조한다. 표시 없이 전송하거나 표시 후 내용을 바꾸면 차단되고, 증명은 전송 시 폐기되는 1회용이다.
- **frontmatter 의 ask 패턴과 훅이 허용하는 payload 표기(`-d @/절대경로`)는 한 쌍이다.** 프롬프트는 패턴이 명령에 매치될 때만 뜨므로, 표기를 늘리면(`--data @file` 등) 질문 없이 게시되는 경로가 생긴다. 한쪽만 고치지 말 것. opencode 규칙은 `findLast` 라 **넓은 규칙을 위, 좁은 규칙을 아래**에 둔다.
- **플러그인 훅으로 승인을 가로챌 수 없다.** `@opencode-ai/plugin` 타입의 `permission.ask` 는 1.18.23 런타임에 존재하지 않는 잔재다. 승인 제어 수단은 frontmatter 패턴뿐이다.
- 상세: ARCHITECTURE.md §4.6 참조.

### 에이전트 permission 키 (hardrule)
- **파일 쓰기 권한의 정식 키는 `edit` 다. `write` 키는 존재하지 않는다.** opencode 의 permission 설정 스키마 키 집합은 `read / edit / glob / grep / list / bash / task / external_directory / todowrite / question / webfetch / websearch / lsp / doom_loop / skill` 이고, `write` · `edit` · `apply_patch` 툴이 **전부 `permission: "edit"`** 로 묻는다 (1.18 바이너리에서 확인).
- 스키마가 `StructWithRest` 라 모르는 키도 **에러 없이 통과**한다 — 그래서 `write:` 로 적은 규칙은 오타처럼 드러나지 않고 조용히 무시되고 기본값 `ask` 로 떨어진다. 실제로 analyzer / publisher / researcher 의 쓰기 제한이 전부 무효 상태였다.
- **규칙 평가는 `findLast` 다 — 마지막 매치가 이긴다.** 규칙 목록은 설정 객체의 키 순서 그대로 만들어지므로 **넓은 규칙을 위, 좁은 규칙을 아래**에 둔다. `"**/*": "deny"` 를 맨 아래에 두면 그 위의 allow 가 전부 죽는다.
- frontmatter 는 1차 방어일 뿐이다. 산출물이 제한된 서브에이전트(analyzer / publisher / planner / researcher)는 `src/opencode-plugin.ts` 의 `ARTIFACT_RESTRICTED_AGENTS` 가 경로를 직접 대조해 2차로 막는다 — glob 매칭 의미에 의존하지 않는 결정론적 방어다. 신규 제한 에이전트를 추가하면 두 곳을 함께 고친다. `test/agent-permission-keys.test.mjs` 가 키·순서를 강제한다.

### 게이트의 state 조회 (hardrule)
- `state.sh get` 은 **실패해도 stdout 에 `null` 한 줄을 찍고 exit 1** 한다 (게이트들이 의존하는 계약). 따라서 `q(){ … || echo "__MISSING__"; }` 는 그 위에 한 줄을 **덧붙여** `null\n__MISSING__` 두 줄을 만들고, 그 값은 `= "null"` 에도 `= "__MISSING__"` 에도 걸리지 않는다 — **부재/손상이 "값이 있음" 으로 통과**한다.
- 반드시 `if` 형태로 성공 출력만 취한다: `q(){ local __v; if __v="$(… get …)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }`. 12개 게이트가 같은 한 줄을 복제하므로 하나만 고치면 안 된다. `test/gate-missing-state-sentinel.test.mjs` 가 강제한다.
- **HITL 승인 게이트는 `!= "true"` (fail-closed) 로 쓴다.** `state.sh init` 이 `"policy": null` 을 심으므로 `= "false"` 로 쓰면 기본 상태에서 승인 블록 전체가 건너뛰어진다 — commit 게이트만 그랬고 하필 가장 중대한 단계였다.

### 다출처 병렬 조사 (dispatch_research)
- `1_planning.requirements` 의 교차 조사는 `dispatch_research` 툴 1회 호출로 소스별 세션을 병렬 spawn 한다. planner 가 `skill_mcp` 를 순차 호출하지 않는다.
- 병렬화를 프롬프트가 아니라 플러그인 코드에 둔 이유: "병렬로 호출하라" 는 지시는 모델이 순차로 불러도 감지할 방법이 없다.
- 부분 성공이 정상 동작이다. 한 소스 실패로 fan-out 전체를 재실행하지 않는다.
- 순수 계약(소스 레지스트리·정규화·파싱·병합)은 `src/research-fanout.ts`, 회귀는 `test/research-fanout.test.mjs`.
- 상세: ARCHITECTURE.md §3.6 참조.

### REJECTED verdict 재작업 flow (dispatch_verifier + dispatch_stage 자동 연계)
- `dispatch_verifier` 가 REJECTED 반환 시 verdict raw 텍스트를 state.json 에 자동 기록: `.stages."<PHASE>".substages."<SUBSTAGE>".last_verdict_reason` / `last_verdict_reason_hash` / `last_verdict_at` / `same_reason_streak` / `rejected_count`.
- `dispatch_stage` 재호출 시 `last_verdict_reason` 이 존재하면 자동으로 `=== 이전 검증 실패 사유 (재작업 시 참고) ===` 블록을 프롬프트에 주입. 서브에이전트 (publisher / engineer / planner) 는 이 블록을 읽고 재작업 방향을 설정한다.
- **3_delivery.commit REJECTED 재작업은 rollback 이 필수**. team-leader 는 git 권한 deny 이므로 rollback 을 대신 수행할 수 없다. publisher 가 재작업 진입 시 프롬프트의 재주입 블록을 감지해 **본인이 직접** `bash <SCRIPTS_DIR>/rollback-commits.sh <이슈키>` 를 최우선으로 실행하도록 makdoong2-publisher.md 에 hardrule 로 명시되어 있다.
- 재시도 횟수 제한 없음. 단, **동일 REJECTED 사유 (hash 기반) 가 5회 연속 감지되면** dispatch_verifier 응답에 `same_reason_streak_exceeded: true` 가 세팅되어 team-leader 가 무한루프를 중단하고 사용자에게 에스컬레이션.

### 진입점은 TypeScript 소스에서 제자리 컴파일된다 (hardrule)
- 구현 코드에 손으로 쓴 JavaScript 는 없다. 진입점 7개는 전부 `.ts` / `.mts` 소스이고, `tsc -p tsconfig.entry.json` 이 **같은 디렉토리에 같은 이름의 산출물**을 만든다.

  | 소스 | 산출물 (계약 경로) |
  |---|---|
  | `bin/cli.ts` | `bin/cli.js` |
  | `postinstall.mts` | `postinstall.mjs` |
  | `scripts/install-lib.mts` | `scripts/install-lib.mjs` |
  | `scripts/model-policy.mts` | `scripts/model-policy.mjs` |
  | `scripts/smoke-test.mts` | `scripts/smoke-test.mjs` |
  | `scripts/run-tests.mts` | `scripts/run-tests.mjs` |
  | `scripts/test-postinstall.mts` | `scripts/test-postinstall.mjs` |

- **`.js` / `.mjs` 를 직접 편집하지 말 것.** 다음 `npm run build:entry` 가 덮어쓴다. `test/entry-artifacts.test.mjs` 가 out-of-tree 재컴파일 후 **바이트 비교**로 최신성을 강제하므로, 산출물만 고치면 테스트가 실패한다.
- **산출물은 커밋한다.** `dist/` 와 달리 이 7개는 git 에 들어간다 — `package.json` 의 `bin` / `postinstall` 이 가리키는 경로이고, 빌드 전 체크아웃과 `npm i -g <git-url>` 에서도 동작해야 하기 때문이다.
- 파일이 이동하지 않는 것이 이 방식의 전부다. 그래서 `bin` · `postinstall` · `files` · `main` · `exports` 계약과 pkgRoot 경로 계산(`postinstall` 은 depth 0, `bin/cli` 는 depth 1)이 **한 글자도 바뀌지 않는다**.
- `tsconfig.entry.json` 은 `include` 글로브를 쓰지 않는다 — `rootDir: "."` 이라 `src/**` 나 `test/**` 가 딸려 들어오면 **소스 옆에 `.js` 가 생성된다**. 반드시 `files` 명시 목록만 쓴다.
- `npm run typecheck` (루트 `tsconfig.json`, `noEmit`) 가 `src/` + 진입점 전체를 함께 검사한다. 빌드는 `build`(src→dist) 와 `build:entry`(진입점 제자리) 두 개다.
- **`scripts/model-policy.mts` 는 import 0개 · Node 내장 0개 · `process` 0개를 유지한다.** `bin/cli.js` 가 `dist/` 없이 도는 성질의 근거다 — doctor/validate 는 설치가 깨졌을 때 쓰는 진단 도구인데, 정본(`src/model-fallback-policy.ts`)은 `logger → config` 를 끌고 오고 `config` 는 진단 대상 설정(`logging.mode="file"` + path 누락)에서 throw 한다. 정본과의 동치는 `test/model-policy-parity.test.mjs` 가 매트릭스로 강제한다 (주석이 아니라 테스트다 — 종전에는 주석만 있었고 로직은 초기 커밋부터 갈려 있었다).
- 상세: ARCHITECTURE.md §12.6 참조.

### stall 재디스패치 차단 (hardrule)
- `MAX_ATTEMPTS`(3) 는 `dispatch_stage` **호출 1회 내부** 예산이다. 재호출하면 리셋되므로 이것만으로는 무한 루프를 막지 못한다.
- 누적 hang 상한은 `hang_history` 길이로 판정한다. `timeout.stall_escalate_threshold`(기본 5) 이상이면 `dispatch_stage` 가 세션을 만들지 않고 `escalate: true` 로 즉시 반환한다.
- **한 substage 의 state.json 접근은 전부 같은 cwd 로 한다 — `effectiveWorktree`.** `state.sh root()` 가 cwd 의 git toplevel 을 쓰므로 cwd 가 갈리면 서로 다른 파일이 된다. 그래서 `dispatch_stage` 는 worktree 확정(자동 교정 포함)을 **가장 먼저** 하고, 그 뒤의 done 검사 · `hang_history` read/append · `verify.sh` 가 모두 그 값을 쓴다. 종전에는 앞의 둘만 `args.worktree`(LLM 이 준 값)를 써서, 교정이 발동하면 hang_history 가 main repo 쪽에 쌓이는데 finally 의 reverse sync 가 worktree 사본으로 그 파일을 덮어써 **기록한 이력이 매 시도마다 지워졌다** — 누적 상한이 영영 도달하지 못했다. 예외는 `.worktree` 값 자체를 조회하는 한 줄뿐이다(교정 대상을 찾는 호출이라 `args.worktree` 가 맞다).
- `escalate: true` 수신 시 재디스패치·모델 교체·stage 건너뛰기 모두 금지. 사용자 에스컬레이션만 허용 (모델 교체로 해소되지 않음이 실측 확인됨).
- 신규 helper 를 `src/opencode-plugin.ts` 에 **export 하지 않는다**. opencode 로더가 모든 named export 를 plugin factory 로 호출하므로 별도 파일(`src/*.ts`)에 두고 import 한다. `test/plugin-exports-shape.test.mjs` 가 export 집합을 고정한다.
- 상세: ARCHITECTURE.md §10.2 참조.
- VERIFIED 판정 시 위 필드들이 자동 초기화 (`null` / `0`).
- 상세: ARCHITECTURE.md §10.1 참조.

### Worktree 규칙
- `2_implementation.dev` 진입 시 worktree 는 **메인 repo 의 형제 디렉토리**에 자동 생성된다. 서브디렉토리 배치 금지 (`.gitignore` 누출).
- 경로 관례: `<parentDir>/<repoName>-<issue>`, 브랜치명 `feature/<issue>`.
- 상세: ARCHITECTURE.md §5.4 참조.

### `.makdoong2-team/` 는 스스로 git exclude 에 등록한다 (hardrule)
- 플러그인이 대상 저장소의 작업 트리 안에 자기 상태를 만드는 이상, 그것이 `git status` 에 보이지 않게 하는 것도 플러그인 책임이다. 등록은 `state.sh init` 이 `mkdir -p` 하는 그 자리에서 한다 (`scripts/lib/git-exclude.sh`).
- **`wt-sync-ignored.sh` 의 baseline 만으로는 부족하다.** 그 함수는 worktree 생성(dev 진입) 시점에만 도는데 `2_implementation.analysis` 는 그보다 앞선 main repo 단계다. 등록 지점이 두 곳인 것은 중복이 아니라 각각 다른 시점을 덮는 것이다.
- 등록이 없으면 analysis verifier 가 **구조적으로 통과 불가능**해진다 — 플러그인 자신의 파일이 `git status` 에 잡히는데, 그 시점에 exclude 를 고칠 권한을 가진 역할이 없다 (analyzer=산출물 1개만 쓰기, team-leader=하드룰 2 차단, engineer=analysis 통과 후 단계). 실제로 사용자가 직접 한 줄을 넣어야 풀렸다 (issue #6-②).
- 이중 안전망으로 verifier 의 analysis `git status` 검사도 `.makdoong2-team/` 를 제외한다. 등록 경로를 타지 않은 in-flight 워크플로우 구제용이다.
- 상세: ARCHITECTURE.md §5.1 참조.

### 게이트 3중 안전망 (entry / post / verifier — hardrule)
- **entry gate** (`gates/stage<N>-*-verify.sh`): substage 진입 "전제조건" 만 검사. 완료 조건은 넣지 않는다.
  - 예: `stage7-pr-verify.sh` 는 commit 완료·worktree clean 만 검사. `origin/BR` 존재 검사는 금지 (chicken-and-egg).
  - 예: `stage8-review-verify.sh` 는 pr 산출물·reviewer 마커·HITL 승인만 검사. `.comments` 검사 금지.
- **post-verify** (`gates/stage<N>-post-*-verify.sh`): substage 완료 후 publisher 가 `.done=true` 기록 직전 스스로 호출. 실패 시 exit 2 로 재작업 loop.
  - `stage6-post-commit-verify.sh`: 커밋 원자성, 메시지 형식
  - `stage7-post-pr-verify.sh`: 원격 push, draft_url, body_validation, reviewer 마커 상호 배타
  - `stage8-post-review-verify.sh`: review-comment-plan.json 존재·정합, per-commit 코멘트 ≥1, 총합 정합, all_comments_inline
- **verifier** (dispatch_verifier / makdoong2-verifier): substage 종료 후 최종 판정. post-verify 재실행 + Bitbucket API 교차검증.
- **완료 조건이 entry 에 들어가면 first-entry 자체가 불가능해진다** (PROJ-40406 review 데드락 사례). 신규 substage 추가 시 항상 이 원칙을 준수한다.
- **필수 마커 정의는 게이트 · stage spec 의 self_check · verifier 세 곳이 항상 일치해야 한다.** 한 곳만 갖고 있으면 substage 가 `done=true` + VERIFIED 로 끝난 뒤 **다음 게이트가 하드 차단**하는 정지가 난다. 실제 사례: `stage3-scope-verify.sh` 는 `spec_hash` 가 있으면 `draft_path` 를 요구하는데, `02-requirements.md` 의 self_check 8항목에도 verifier 기준에도 `draft_path` 가 없어서 마커를 빠뜨린 채 통과됐다 (issue #6-①). verifier 가 **마커가 아니라 파일 존재**를 보고 있었던 것이 검출 실패의 직접 원인이다 — 파일은 멀쩡했다. 마커를 추가할 때는 세 곳을 한 번에 고치고, `test/gate-requirements-quality.test.mjs` 의 "스펙 정합" 블록에 케이스를 추가한다.


### 리뷰 인라인 코멘트 (hardrule)
- **1 파일 = 1 commit 원칙에 대응하여 인라인 코멘트도 커밋 1개당 최소 1개** (`stage8-post-review-verify.sh` 강제).
- publisher 는 posting 전에 `review-comment-plan.json` 계획 아티팩트를 먼저 산출한다 (`<worktree>/.makdoong2-team/<이슈키>/review-comment-plan.json`). 스키마 및 절차 상세: `stages/09-review-comments.md` §8-2.
- `.stages."3_delivery".substages."review".comments_per_commit` 는 커밋 SHA → posting 수 매핑. 모든 값 ≥ 1, 항목 수 = `atomic_review.count_commits`, 총합 = `.comments`.

### 테스트
- 새 기능은 반드시 `test/*.test.mjs` 회귀 케이스 추가. `npm test` 는 `scripts/run-tests.mjs` 로 모든 단위 테스트를 순차 실행하며 pre-push 훅에서 자동 검증.
- 새 테스트 파일은 **`scripts/run-tests.mts`** 의 `STEPS` 에 반드시 등록하고 `npm run build:entry` 로 산출물을 갱신할 것 — `scripts/run-tests.mjs` 는 산출물이라 직접 고치면 다음 빌드에 날아간다. 등록하지 않으면 `npm test` 가 영영 실행하지 않는다 (`gate-requirements-quality.test.mjs` 와 `scripts/test-postinstall.mjs` 가 실제로 그 상태였고, 후자는 그 사이 내용까지 현행 구현과 반대로 썩어 있었다).
- 러너는 실패해도 멈추지 않고 끝까지 돌린 뒤 실패 목록을 보고한다. 실패 1건만 보고 끝내지 말고 전체 목록을 확인할 것.
- 셸 스크립트에서 변수 뒤에 한글이 붙으면 반드시 `${VAR}` 로 감쌀 것. macOS libc 는 UTF-8 로케일에서 멀티바이트 첫 바이트를 alnum 으로 보고해 변수명이 오염된다 (Linux 에서는 재현되지 않음). `test/shell-portability.test.mjs` 가 강제한다.
- Linux 교차 검증은 `npm test` 가 자동 수행한다 (비-Linux 호스트 + docker 사용 가능 시 컨테이너에서 스위트 재실행, 종료 시 컨테이너·데몬 자동 정리). 별도 명령을 칠 필요 없다.
- 교차 검증 이미지는 **사용자가 실제로 쓰는 환경**에 맞춘다 — Ubuntu 26.04 LTS · node 24 · tmux 3.6a · bash 5.3 (GitHub 이슈 #5/#6 의 환경표). 24.04 로 검증하면 tmux 3.4 / bash 5.2 를 보게 되어 정작 사용자가 겪는 축이 빠진다.
- **Ubuntu 26.04 의 coreutils 는 GNU 가 아니라 uutils(Rust) 다.** `wc -m` 처럼 구현마다 갈리는 도구에 의존하지 말 것 — 실측으로 BSD(macOS)와 uutils 가 다른 답을 냈다 (`gates/stage6-post-commit-verify.sh` 의 제목 길이 계산 참조).
- 호스트 실행을 컨테이너 실행으로 대체하지 말 것 — Darwin libc 에서만 재현되는 결함이 실재하며 (rollback-commits.sh 사례), 컨테이너로 갈아타면 그 부류가 영구히 은폐된다. 두 번 도는 것이 의도된 설계다.
- pollSubSession / dispatch_stage 로직 수정 시 특히 `test/poll-sub-session.test.mjs`, `test/dispatch-stage-redispatch.test.mjs` 확장 필수.

## 릴리즈 프로세스
- `npm run release:patch|minor|major` — 2회 사용자 승인 게이트를 거쳐 공개 npm registry 배포. 상세: ARCHITECTURE.md §12.5.
- **승인 프롬프트는 stdin 전용 (`scripts/lib/confirm.sh`). `/dev/tty` 를 다시 들이지 말 것** — 제어 터미널이 없는 환경에서 열리지 않아 릴리즈 자체를 막았다. `test/release-confirm.test.mjs` 가 재유입을 차단한다.
- 터미널이 없으면 파이프로 승인을 전달한다: `printf 'y\ny\n' | npm run release:minor`
- `confirm()` 의 반환 `2`(물어볼 수 없음)는 `1`(거부)과 **반드시 구별해서** 처리한다. 섞으면 환경 문제가 "사용자가 거부함" 으로 둔갑해 원인이 은폐된다.
- `--yes` 플래그는 CI 전용. 대화형에서 사용 금지.
- `.husky/pre-push` 훅이 `package.json` version 변경 감지 시 자동 publish (동일 승인 게이트).

## 진단 및 문제 해결
- `npx makdoong2-team doctor` — 설정 상태 검증 (credential, phantom state key, tmux 버전, 로깅 설정).
- 서브세션 hang / gone false-positive 관측 시 우선 `logging.level=debug` 로 승격해 `[pollSubSession] GONE_ADMIT`/`GONE_ADMIT_RESET`/`SESSION_GONE` 로그를 수집.
- 상세 진단 & 복구 절차: ARCHITECTURE.md §8 (서브세션 생존 감지), §9 (tmux pane).
