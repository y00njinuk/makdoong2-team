# makdoong2-team — DESIGN

> 왜 이렇게 설계했는가. 어떻게 동작하는지는 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 참조.

## 0. 요약

사내 "하네스 엔지니어링" 4기둥 **Constrain → Inform → Verify → Correct** 를 opencode 플러그인 아키텍처로 옮긴 결과물이다.

| 기둥 | 한 줄 정의 | 핵심 구현 |
|---|---|---|
| **Constrain** | 할 수 없게 한다 | 에이전트별 권한 + PreToolUse 훅 + sealed workflow |
| **Inform** | 알아야 할 것을 준다 | 단계 명세 + MCP 스킬 lazy connect + SessionStart 재주입 |
| **Verify** | 정말 했는지 확인한다 | 결정론 셸 게이트 + verifier 에이전트 + self_check 5체크 |
| **Correct** | 틀렸을 때 회복한다 | 모델 폴백 2-track + verification loop + 롤백 |

## 1. 출발점 — 다섯 실패 모드

LLM 에이전트는 다섯 가지로 실패한다.

| 실패 모드 | 주 방어 기둥 |
|---|---|
| 환각 함수 호출 | Inform, Verify |
| 긴 세션에서 길을 잃기 | Inform |
| "다 했다" 거짓 보고 | Verify |
| 위험 명령 무방비 실행 | Constrain |
| 같은 실수 무한 반복 | Constrain, Correct |

**설계 원칙 3가지**
1. 셸 게이트가 단일 진실 소스. 동일 검증 로직을 재구현하지 않는다.
2. 결정론 검증 우선. 가능하면 LLM 호출 없이 마커·exit code 로 판정한다.
3. 실패는 격리한다. 에이전트 권한과 worktree 로 폭발 반경을 좁힌다.

---

## 2. CONSTRAIN — 제한

### 2.1 5계층 방화벽

한 겹이면 뚫린다. 독립 계층을 겹친다.

| 계층 | 구현 |
|---|---|
| L1 프롬프트 가드레일 | 에이전트 명세 §"금지" 섹션 |
| L2 도구 제한 | frontmatter `permission:` (deny/allow/ask) |
| L3 조건부 승인 | `.policy.auto_approve` 마커 기반 |
| L4 도구 내부 검증 | `guard-bash.sh` PreToolUse |
| L5 라이프사이클 훅 | `chat.params` / `tool.execute.before` / `.after` / SessionStart |

### 2.2 에이전트별 권한 분리

권한이 좁을수록 사고 반경이 좁다.

| 에이전트 | 담당 | 권한 |
|---|---|---|
| `makdoong2-team-leader` | 라우팅 + 환경 준비 | commit/push 허용 (오케스트레이션), 파일 편집 금지, **worktree 생성** |
| `makdoong2-planner` | 1_planning | 읽기 전용 |
| `makdoong2-engineer` | 2_implementation | edit/write, commit/push deny, **준비된 worktree에서 작업** |
| `makdoong2-publisher` | 3_delivery | 읽기 전용 — spec 계산만 |
| `makdoong2-verifier` | 메타 검증 | 읽기 전용 |

**책임 분리 패턴**:
- engineer 가 코드를 만들지만 커밋은 못 한다. publisher 가 커밋 메시지를 만들지만 실행은 못 한다. 실제 `git commit` 은 team-leader 만 실행한다 (**Publisher 하이브리드 모델**).
- engineer 가 개발하지만 worktree는 만들지 않는다. team-leader 가 Planning 완료 후 Implementation 진입 전에 worktree를 준비한다 (**환경 준비 = 오케스트레이션**).

### 2.3 Team-Leader Hardrule (물리적 차단)

team-leader 의 파일 조작 우회를 hook 이 물리적으로 차단한다.

1. **Hardrule 1** — `write`/`edit`/`patch`/`multiedit` 툴 호출 시 throw. 모든 파일 조작은 `dispatch_stage` 위임.
2. **Hardrule 2** — bash 파일 쓰기 리다이렉트 (`>`, `>>`, `tee`, `sed -i` 등) 차단. 허용: `git commit/push/add/rm`, `state.sh set`.

정규식으로 whitelist 우선 매칭 후 file-write 패턴 탐지. FD 리다이렉트 (`2>/dev/null`) · `/dev/null` 은 허용.

### 2.4 Sealed Workflow (outer-world 차단)

sealed sub-agent (planner/engineer/publisher/verifier) 가 outer-world 위임 툴 (`call_omo_agent`, `delegate_task`, `background_task`, `task_*`) 을 호출하면 throw 한다. frontmatter whitelist (1차) 를 우회해도 `tool.execute.before` (2차) 가 잡는다.

**허용된 대안**
- 조사 — `skill_mcp` + jira/confluence/bitbucket/github-oss/bamboo-ci research 스킬
- 다른 substage — 결과를 team-leader 에게 반환, team-leader 가 `dispatch_stage` 로 라우팅
- 상태 공유 — `state.sh set` 으로 마커 기록

미래의 위임성 툴 (`delegate*` / `spawn*` / `background_*` / `task_*`) 이 sealed subagent 에서 호출되면 경고 로그를 남긴다.

### 2.5 조건부 자동 승인 (`.policy`) 와 HITL opt-in

모두 물으면 사소한 작업도 막히고, 안 물으면 위험한 변경이 통과한다. 2단계에서 위험도를 분류해 `.policy.category` 에 기록하되, **기본 흐름은 두 범주 모두 무인 진행**으로 통일했다. 승인 게이트는 `.policy.auto_approve.<substage>` 마커가 결정하며 기본값은 전 substage `true` 다.

| 분류 | 기준 | 기본 사람 개입 |
|---|---|---|
| `minor` | 단순 작업 + 작은 범위 | 없음 (전 단계 무인) |
| `major` | criticality=critical OR scope_size=large | 없음 (전 단계 무인) — `category` 는 위험도 라벨/opt-in 훅용 |
| 미설정 (구형 state) | — | 모든 단계 (안전 폴백) |

**minor 와 major 는 흐름이 동일**하다. 두 범주의 차이는 `.policy.category` 라벨과 후속 감사·통계·이슈 유형별 확장 훅에서 의미를 갖는다. HITL 이 필요한 예외 상황(예: 향후 이슈 유형별 opt-in, 사용자 명시 지정)에서는 planner 가 특정 substage 의 `auto_approve` 를 `false` 로 재설정한다. `false` 로 opt-in 되면 그때 해당 substage 앞에 변경 보고서 + 사용자 승인이 요구된다. 분류는 LLM 이 1회만 판단하고, 이후 셸 게이트는 결정론적으로 마커만 검사한다.

**ESCALATION**: 3단계 scope 에서 실제 범위가 드러나면 `minor → major` 상향만 허용 (하향 금지). 상향은 `.policy.category` 라벨만 정정하며 `auto_approve` 맵은 그대로 둔다 — HITL 재활성화가 필요하면 opt-in 훅으로 별도 지시한다.

### 2.6 격리 — git worktree

물리 격리 (VM/μVM) 는 비용이 크다. worktree 를 격리 단위로 사용한다.
- 2_implementation.dev 는 별도 worktree 에서만 작업
- 메인 워킹 디렉토리 오염 없음
- 실패 시 worktree 만 삭제해 깨끗한 복구

**Worktree 생성 = Deterministic** (플러그인 `auto_advance_stage`가 직접 실행):
1. Planning → Dev 진입 시점에 `createWorktree()` 호출
2. 브랜치 충돌 감지 (`git worktree list --porcelain` 파싱)
3. 메인 repo 형제 디렉토리에 생성 (`<repo명>-<이슈키>`)
4. 로컬 셋업 파일 동기화 (`wt-sync-ignored.sh`)
5. state.json에 경로 기록

**LLM 개입 없음** — Markdown 프롬프트에 의존하지 않음. 플러그인 코드가 직접 실행하므로:
- ✅ 브랜치 충돌 항상 감지
- ✅ 경로 규약 항상 준수
- ✅ 동기화 항상 실행
- ✅ 실패 시 명확한 에러 메시지

Engineer는 **이미 준비된 worktree**에서 개발만 수행. Team-Leader 프롬프트는 "플러그인이 자동 생성함" 설명만 포함.

강격리 (FireCracker 등) 는 미적용. 신뢰할 수 없는 코드 실행에는 별도 검토 필요.

### 2.7 모델 티어링

값비싼 모델만 쓰면 비용 누적, 싼 모델만 쓰면 품질 저하. 단계별 책임에 맞춰 티어 차등.

fallback 은 항상 primary 보다 **strictly lower tier**. `validatePolicies()` 가 모듈 로드 + 오버라이드 적용 후 검사한다. 사용자 오설정 시 snapshot 복원 → defaults 로 부팅해 워크플로우가 죽지 않는다.

---

## 3. INFORM — 알려줌

### 3.1 세 채널

정보 부족은 능력 부족과 구분되지 않는다.

| 채널 | 비유 | 구현 |
|---|---|---|
| 정적 문서 | 부서 매뉴얼 | `agents/*.md`, `stages/*.md`, `references/` |
| 동적 컨텍스트 | 사내 인트라넷 | MCP 스킬 (lazy connect) |
| 이벤트 리마인더 | 모니터 포스트잇 | `session-start.sh` |

### 3.2 60줄 황금률

긴 문서는 컨텍스트만 차지한다. Anthropic 권장대로 각 에이전트 명세와 stage 명세를 짧게 유지하고, **금지 + 대안** 을 짝지어 쓴다. 금지만 쓰면 다른 잘못된 길로 우회한다.

### 3.3 MCP 스킬 lazy connect

전체 도구를 항상 로드하면 컨텍스트가 빠르게 찬다. 필요할 때만 연결한다.

| 스킬 | 소비자 |
|---|---|
| `jira-research` | planner |
| `confluence-research` | planner |
| `bitbucket-research` | planner, publisher |
| `github-oss-research` | planner |
| `bamboo-ci` | (선택) |
| `makdoong2-team` | 진입점 |

engineer 는 스킬을 로드하지 않는다. 관여하지 않는 단계는 스킬을 보지 못한다.

### 3.4 SCRIPTS_DIR 절대경로 주입

`dispatch_stage`/`dispatch_verifier` 프롬프트 첫 5줄에 `Scripts directory (ABSOLUTE): <경로>` 라인을 주입한다. 서브에이전트가 `$HOME/.config/opencode/scripts/` 나 상대경로를 사용하는 실패 모드를 원천 차단한다. 사용자의 `paths.scripts` override 도 존중된다.

### 3.5 SessionStart 리마인더

세션을 잠시 멈추고 돌아오면 진행 상황을 잊는다. `session-start.sh` 가 stdout 으로 재주입한다.

| 재주입 | 출처 |
|---|---|
| 작업 범주 | `.policy.category` |
| 단계별 done/approved 요약 | `state.json` |
| `verification_pending=true` 목록 | `state.json` |
| 최근 3개 이벤트 | `events.ndjson` (tail) |

opencode plugin API 는 SessionStart 이벤트를 노출하지 않으므로 wire-up 은 운영자 책임 (Claude Code `settings.json` hooks 또는 orchestrator 프롬프트 첫 줄).

### 3.6 이력 로그 (`events.ndjson`)

state.json 은 *현재* 상태만, `events.ndjson` 은 *이력* 만 담는다. 책임 분리.

`scripts/log-event.sh` 가 `jq -nc` 로 안전 escape 후 append. append-only 라 손실되지 않는다. 회고 · 디버깅 · 메트릭 집계 데이터 소스.

### 3.7 Context Rot 대응

컨텍스트가 길어지면 모델 품질이 떨어진다.

1. **JIT 검색** — 시작 시 모두 넣지 않는다.
2. **서브에이전트 격리** — 각 단계가 자기 컨텍스트만 본다 (`client.session.create()` 로 새 서브세션).
3. **컴팩션** — 단계 완료 시 핵심만 요약해 다음 단계로 (부분 적용, §6 한계).

---

## 4. VERIFY — 검증

### 4.1 세 유형 겹치기

한 가지만으로는 부족하다.

| 유형 | 구현 |
|---|---|
| 코드 실행 검증 (결정론) | 셸 게이트 10개 + 커버리지 게이트 |
| 셀프 검증 루프 | 단계별 `self_check` 5체크 |
| 외부 도구 검증 | smoke-test + gate-policy-test |

### 4.2 결정론 셸 게이트

가장 확실한 검증은 실제 실행이다. 셸 게이트는 exit code 로 통과/차단을 판정한다.

- LLM 호출 0 (비용·지연 없음)
- 동일 게이트가 다른 환경에서도 동일 동작
- 단일 진실 소스 (의미 어긋남 위험 없음)

`verify.sh` 가 substage 별로 dispatcher 역할, `stageN-*-verify.sh` 가 실제 검증. `.policy.auto_approve` 마커가 `true` 면 자동 통과, `false` (HITL opt-in) 면 사람 승인 마커를 요구. 기본 흐름은 minor·major 모두 `true` 로 무인 통과한다.

### 4.3 확장 게이트 (LLM 판정 → 결정론 검사)

셸은 *기계적 사실* 만 검증한다. "Jira 본문이 템플릿에 맞는가" 같은 *의미적* 판정은 못 한다.

해결: stage agent 가 LLM 으로 판정 → 결과를 마커로 기록 → 플러그인의 `checkExtensionGates` 가 마커만 결정론적으로 검사.

예: `1_planning.jira` 는 6항목 (`content_template_match` / `content_quality_adequate` / `priority_set` / `assignee_set` / `reporter_set` / `fix_version_handled`) 검사 후 `validation_passed=true` 기록. LLM 비용은 1회만 발생.

### 4.4 Self-Check 5체크

각 단계 종료 직전 stage agent 가 자기 출력을 5-boolean 으로 검토해 `.stages.<N>.self_check` 에 기록. **원칙**: 단계별 위험이 다르므로 동일 형태의 다른 의미를 쓴다.

| 단계 | 5체크 핵심 |
|---|---|
| jira | 6항목 검증 / 인터뷰 / RO 보존 |
| requirements | 체크리스트 / 충돌 해소 / 사용자 확인 / policy 범주화 / draft 동기화 |
| scope | 경로 명시 / 테스트 범위 / atomic 분할 / 승인 |
| dev | 스코프 충족 / 기존 테스트 OK / 신규 테스트 / 시크릿 부재 |
| test | 결과 명시 / 커버리지 / attempt 추적 |
| commit | base_sha / atomic / 메시지 컨벤션 / 스테이징 / 시크릿 스캔 |
| pr | 템플릿 / 시나리오 매핑 / draft / 제목 형식 |
| review | 결정 지점 / live 코멘트 / 메트릭 |

자가 검증 실패 자체는 차단하지 않는다. 차단은 verifier 와 사용자 승인이 담당.

### 4.5 Verifier 에이전트

Planner/Generator/Evaluator 3-Agent 구조의 **Evaluator** 역할. `makdoong2-verifier` (read-only, sonnet-tier) 가 결정론 신호 3개로 판정.

1. `self_check` 5체크 누락 또는 false 1개 이상 → REJECTED
2. 필수 마커 (`done_at`, `draft_url` 등) 누락 → REJECTED
3. 안티패턴 (빈 응답 / 테스트 삭제 / `as any` / 인라인 disable / 도구 난사) → REJECTED

```
<verifier-verdict>VERIFIED</verifier-verdict>
```

**안티-환각 floor**: 플러그인 정규식이 태그를 못 찾으면 자동 REJECTED. 무음 통과를 원천 차단.

**비용**: 단계당 sonnet 1콜 추가. 전체의 15% 미만으로 추산. 비용 민감 환경은 향후 opt-out (§6 한계).

### 4.6 Verification Pending

"다 했다" 거짓 보고 방지를 위해 *완료* 와 *승인* 을 분리.

| 마커 | 의미 |
|---|---|
| `done_at` | 작업 완료 시각 |
| `verification_pending=true` | 완료 선언 후 검증 대기 |
| `approved_by_user=true` | 사용자 검토 · 승인 |
| `approved_at` | 승인 시각 |

다음 substage 게이트는 `verification_pending=true` 면 차단. `approved_by_user=true` 로 해소. 타임스탬프는 stuck 감지 데이터로만 사용 (사람 리뷰 속도는 예측 불가하므로 시간 기반 차단은 안 함).

---

## 5. CORRECT — 수정

### 5.1 네 패턴

방지만으로 부족하다. 회복 경로가 있어야 한다.

| 패턴 | 구현 |
|---|---|
| 감지 → 분석 → 복구 | 게이트 실패 → verifier findings → 재시도/롤백 |
| 재시도 로직 | 모델 폴백 2-track |
| Human-in-the-Loop | `.policy` 기반 조건부 승인 |
| 가비지 컬렉션 | (미구현, §6) |

**좋은 에러 메시지의 조건**: "무엇이 잘못됐고 어떻게 고칠지" 를 에이전트가 이해할 형태로 제공한다. 예: `guard-bash.sh` 출력은 차단 사유 + 우회 방법을 함께 안내.

### 5.2 모델 폴백 2-track

모델은 가끔 실패한다 (rate limit, 5xx, context 초과).

**Track A — in-session**
- `dispatch_stage` 실패 → `get_fallback_model` 호출 → `dispatch_stage(model_override=...)` 로 새 격리 서브세션 재시도
- 같은 대화 흐름 유지

**Track B — out-of-conversation**
- `with-fallback.sh` 래퍼가 `opencode run` exit code 를 보고 재실행
- `model-chain-cli.ts` 가 동일 체인 정의 JSON 노출
- 세션이 새로 시작되므로 단발 CI 잡에 적합

| 상황 | 트랙 |
|---|---|
| 대화형 워크플로우 | A 우선 + B 백업 |
| 단발 CI 잡 | B |

두 트랙 모두 `POLICIES` 를 단일 진실 소스로 참조. SIGINT(130) 는 retry 안 함 (사용자 cancel 보호).

### 5.3 깨끗한 컨텍스트 재시도 (Ralph Loop)

같은 세션에서 계속 재시도하면 실패한 추론이 컨텍스트를 오염시킨다. `dispatch_stage` 는 매번 별도 격리 서브세션을 spawn 하며, 재시도 시 이전 실패 요약만 새 세션에 전달한다.

### 5.4 Verification Loop

완료 선언 후 검증 대기 마커로 완료·승인 분리. 검증 실패 시 단계 되돌리고 재시도.

- `verification_pending=true` → 다음 게이트 차단
- verifier `REJECTED` → `.stages.*.done=false` 되돌리고 재시도 (기본 cap 3회)
- 3회 초과 → 사용자 에스컬레이션

### 5.5 Human-in-the-Loop

자동화가 클수록 사람 개입 지점을 신중히 골라야 한다. 모든 단계 물으면 UX 파탄, 한 군데도 안 물으면 위험.

`.policy` 기반 분류로 major 는 커밋 직전 1곳에 개입 단일화. `change-report.md` 를 자동 생성해 사람이 읽고 승인/거부만 결정한다.

| 보고서 섹션 |
|---|
| 요구사항 요약 |
| 변경 내용 |
| 테스트 결과 |
| 위험 · 영향 범위 |
| 커밋 계획 |

의사결정 비용을 가장 위험한 지점에 집중시킨다.

### 5.6 비가역 작업 차단

사후 복구가 불가능하므로 사전 차단이 핵심.

| 대상 | 메커니즘 |
|---|---|
| `rm -rf` | `guard-bash.sh` |
| `git push --force` (마커 없이) | `guard-bash.sh` |
| 기타 파괴 명령 | `APPROVED_DESTRUCTIVE` 마커 요구 |

마커는 사용자가 명시적으로 부여한다. 마커는 1회용 — 사용 후 삭제 관례.

### 5.7 Hashimoto 원칙 — 실패 → 규칙 누적

> "실패 1건 = 방지책 1줄"

에이전트가 같은 실수를 반복하면 명세에 1줄 추가. 시간이 지나며 가드레일이 강력해진다. 각 `agents/*.md` §"금지" 섹션에 누적.

---

## 6. 한계 (정직한 명시)

### 6.1 SessionStart 이벤트 부재
opencode plugin API 가 SessionStart 를 노출하지 않아 wire-up 은 운영자 책임. 1.5+ 에서 이벤트 추가 시 플러그인이 직접 등록 예정.

### 6.2 opencode plugin API 버전 의존
1.4.17 기준으로 작성. hook payload 시그니처 변경 시 재검증 필요. `chat.params` 로 `sessionID → agent` 매핑을 우회 조달하는 이유도 hook input 에 agent ID 가 없기 때문.

### 6.3 EDD Eval Baseline 미적용
`smoke-test.mjs` 는 모델 정책 invariant + 오버라이드 순수성만 검사. 실제 단계 산출물 회귀 게이트는 부재. 향후 `eval/` 디렉토리와 CI 통합 검토.

### 6.4 Verifier 비용 가산
단계당 sonnet 1콜 추가 (전체 ~15%). 비용 민감 환경용 `verifier.enabled: false` 옵션은 계획 중.

### 6.5 Compaction 정책 부재
단계 간 명시적 컴팩션 미구현. opencode 런타임 자동 처리에 위임. `handoff_summary` 마커는 미구현.

### 6.6 강격리 샌드박스 부재
worktree 는 격리 단위지만 OS 수준 격리 아님. FireCracker μVM 등 강격리 미적용. 신뢰할 수 없는 코드 실행에는 별도 검토 필요.

### 6.7 비용 상한 · 루프 탐지 미적용
단계별 토큰/금액 상한 없음. 동일 파일 5+회 수정 같은 루프 탐지 없음. 향후 LoopDetectionMiddleware 이식.

### 6.8 보안 검증 게이트 부재
`npm audit` / Snyk / CodeQL 통합 미적용. 향후 test 또는 commit 단계에 게이트 추가.

---

## 7. 4기둥의 상호작용

```
   Constrain ──────────▶ Inform
        ▲                   │
        │                   ▼
   Correct ◀────────── Verify
```

- **Constrain → Inform**: 권한 정보가 에이전트에게 전달된다.
- **Inform → Verify**: 자가 검증에 필요한 체크리스트가 공급된다.
- **Verify → Correct**: 검증 실패가 복구 트리거가 된다.
- **Correct → Constrain**: 실패 패턴이 새 금지 규칙으로 누적된다.

### Augment 3-Layer 매핑

| Layer | 시점 | 구현 |
|---|---|---|
| Constraint Harness | 생성 전 | frontmatter permission + hook |
| Feedback Loops | 생성 직후 | `tool.execute.after` → `sync-state.sh` |
| Quality Gates | 머지 전 | `gates/verify.sh` + 커버리지 게이트 |

---

## 8. 향후 보강 우선순위

| 우선 | 작업 | 기둥 |
|---|---|---|
| 1 | EDD Eval Baseline + regression gate | Verify |
| 2 | Compaction 정책 + `handoff_summary` 마커 | Inform |
| 3 | Cost Cap + LoopDetectionMiddleware | Constrain |
| 4 | events.ndjson 기반 메트릭 집계 | Verify |
| 5 | 보안 검증 게이트 (npm audit / Snyk) | Verify |
| 6 | Verifier opt-out 토글 | Correct (비용) |
| 7 | 단계별 timeout 차등 | Constrain |
| 8 | 강격리 샌드박스 (μVM) 검토 | Constrain |

---

## 9. 참고

- **본 프로젝트**
  - [ARCHITECTURE.md](./ARCHITECTURE.md) — 어떻게 동작하는가
  - [AGENTS.md](./AGENTS.md) — 개발 규약
  - `agents/*.md`, `stages/*.md` — 명세
- **외부**
  - Anthropic — Writing Tools for Agents / 3-Agent 패턴
  - Hamel Husain — Your AI Product Needs Evals
  - Mitchell Hashimoto (Ghostty) — "실패 1 = 방지 1"
