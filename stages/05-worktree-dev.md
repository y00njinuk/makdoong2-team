# 4단계: 격리된 Worktree에서 개발

**목적**: 부장님이 준비한 격리된 작업 공간에서 개발한다.
**진입 게이트**: `verify.sh <이슈키> 2_implementation.dev` (3단계 완료 + 사용자 승인 필요).
**중요**: Worktree는 **부장님(team-leader)이 자동 생성**했다. Engineer는 이미 준비된 환경에서 작업만 수행한다.

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

## 4-0-pre. 임시 파일 경로 (hardrule)

임시 파일·스크래치가 필요하면 **worktree 안**에만 만든다:

```
<worktree>/.makdoong2-team/<이슈키>/tmp/
```

**`/tmp` 을 비롯한 워크스페이스 밖 경로는 사용 금지다.** 두 가지 이유다:

1. opencode 는 bash 명령이 참조하는 디렉토리마다 `external_directory` 승인을 묻는다. 서브에이전트 세션에서 그 요청은 답할 사람이 없어 **자동 거부되고 세션이 그 자리에서 종료된다** — 하던 작업이 통째로 날아간다.
2. 워크스페이스 밖에 쓴 것은 worktree 동기화 대상도 커밋 대상도 아니다. **산출물이 조용히 사라진다.**

위 경로는 cwd 안이라 승인이 필요 없고, `.git/info/exclude` 에 이미 등록돼 있어 `git status` 를 오염시키지 않는다.

## 4-0. Analysis 결과 읽기 (필수 — 개발 시작 전)

analysis substage 가 산출한 `workspace-analysis.json` 을 읽어 구현 방향을 확정한다. **이 단계를 건너뛰면 기존 코드 패턴과 불일치한 구현이 발생할 수 있으므로 반드시 수행한다.**

`artifact_path` 는 상대경로 저장 원칙 (`repo/worktree root` 기준) 을 따르므로 반드시 `state.sh root()` 로 절대경로 해석한다. 절대경로 legacy 값도 함께 수용한다:

```bash
ART_REL="$(bash <SCRIPTS_DIR>/state.sh get <이슈키> \
  '.stages."2_implementation".substages."analysis".artifact_path' | tr -d '"')"

if [ -z "$ART_REL" ] || [ "$ART_REL" = "null" ]; then
  echo "WARNING: workspace-analysis.json 없음 (analysis 스킵된 경우)"
elif [[ "$ART_REL" == /* ]]; then
  ANALYSIS_PATH="$ART_REL"    # legacy 절대경로 수용
else
  ANALYSIS_PATH="$(bash <SCRIPTS_DIR>/state.sh root)/$ART_REL"
fi

if [ -n "${ANALYSIS_PATH:-}" ] && [ -f "$ANALYSIS_PATH" ]; then
  jq '{conventions, integration_points, task_relevant_files}' "$ANALYSIS_PATH"
fi
```

확인 후 아래 항목을 구현 전에 반드시 파악한다:

| 항목 | 출처 | 활용 |
|---|---|---|
| `conventions.patterns` | workspace-analysis.json | 아키텍처 패턴 (Repository/Service/Controller 등) — 동일 패턴으로 구현 |
| `conventions.naming` | workspace-analysis.json | 명명 규칙 — 새 심볼 네이밍에 적용 |
| `conventions.similar_impl` | workspace-analysis.json | **유사 구현체 파일** — `Read` 로 내용 확인 후 같은 방식으로 구현 |
| `integration_points[].symbol` | workspace-analysis.json | 코드 삽입 대상 심볼 |
| `integration_points[].how` | workspace-analysis.json | 삽입 방식 — 이 지시를 그대로 따름 |
| `task_relevant_files` | workspace-analysis.json | 수정 대상·참조 파일 역할 분류 |

**`conventions.similar_impl` 파일이 존재하면**: `Read` 툴로 내용을 실제로 읽고, 해당 구현 방식을 그대로 복제하여 일관성을 유지한다. 유사 구현체를 읽지 않고 독자적으로 구현하는 것을 금지한다.

## 4-1. Worktree 환경 확인

부장님이 준비한 worktree 경로를 확인한다:

```bash
WT=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> '.worktree' | tr -d '"')
echo "Working in: $WT"
pwd  # 현재 위치가 $WT인지 확인
git branch --show-current  # feature/<이슈키>인지 확인
```

**예상되는 환경**:
- 경로: `<메인 repo 부모>/<메인 repo명>-<이슈키>` (메인 repo의 형제 디렉토리)
- 브랜치: `feature/<이슈키>`
- 로컬 셋업 파일: `.env`, `.idea/` 등이 이미 동기화되어 있음

**환경 불일치 시**:
- 현재 경로 ≠ state.json의 worktree → 사용자에게 보고 후 종료 (부장님이 해결)
- 브랜치 ≠ `feature/<이슈키>` → 경고 출력 후 계속 (부장님에게 보고 권장)

## 4-2. 로컬 셋업 파일 상태 확인

`auto_advance_stage` 플러그인이 dev 진입 게이트 직전 `wt-sync-ignored.sh`를 자동 실행했으므로, **추가 작업 불필요**.

필요시 확인 사항:
- `.env`, `.idea/`, IDE 설정 파일들이 존재하는지 확인
- 빌드 도구 캐시(`.gradle/`, `node_modules/` 등)는 **복사되지 않음** — 첫 빌드 시 자동 생성됨

**재동기화가 필요한 경우** (메인 repo의 로컬 파일이 업데이트됨):
```bash
bash <SCRIPTS_DIR>/wt-sync-ignored.sh "$WT" "<이슈키>"
```

> `auto_advance_stage` 플러그인이 gate 진입 직전 이미 실행했으므로 대부분 불필요.


## 4-3. 개발 진행

- 모든 파일 편집을 worktree 절대경로 하위에서만 수행한다.
- **outer-world 에이전트 위임 금지** — engineer 프론트매터에 `Task` 툴이 없으므로 물리적으로 스폰 불가. 구현·조사·리팩토링 모두 본 에이전트가 직접 수행한다. 조사가 필요하면 `skill_mcp` 로 makdoong2 스킬(`bitbucket-research` 등)만 사용.
- 3단계 작업 단위 순서대로 구현한다. 한 단위가 끝나면 커밋 가능 상태로 만들어 둔다(실제 커밋은 6단계).

## 4-4. 최종 자가 검증 (Pre-Completion Checklist)

`done=true` 직전, 아래 6체크를 자가 검증한다.
하나라도 false면 완료 기록 금지 — 미충족 항목을 먼저 해소한다.

| 항목 | 확인 |
|---|---|
| 1 | 3단계에서 합의한 모든 수정/추가 파일이 구현되었다 (스코프 100% 충족) |
| 2 | 기존 테스트(`sbt test` / `./gradlew test` / `mvn test` 등)가 모두 통과한다 |
| 3 | 새 기능·버그 수정에 대한 테스트가 함께 추가되었다 (테스트 동반 원칙) |
| 4 | 타입/린트/컴파일 에러가 0이다 |
| 5 | `.env` / secrets / API 키 / 하드코딩된 비밀이 코드·테스트·로그에 노출되지 않았다 |
| 6 | `write`/`edit`/`patch`/`multiedit` 로 편집한 모든 파일이 staging area 에 반영되었다 (`git ls-files --others --exclude-standard` 결과 0) |

> 항목 6은 `tool.execute.after` 훅이 매 write 완료 시 자동으로 `git add`를 수행하므로 기본적으로 자동 충족된다. 훅 실패로 untracked 가 남으면 §4-5 exit gate 가 BLOCK 하여 재작업을 요구한다.

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."2_implementation".substages."dev".self_check' \
  '{"scope_met": true, "existing_tests_pass": true, "new_tests_added": true, "type_lint_clean": true, "no_secrets": true, "all_writes_staged": true}'
```

## 4-5. Exit Gate 실행 (staging 강제)

```bash
bash <SCRIPTS_DIR>/../gates/verify.sh <이슈키> 2_implementation.dev_post
```

- exit 0: 통과 — 완료 기록 진행
- exit 2 (BLOCKED): 출력된 파일 목록을 확인하고 각각 `git add -- <파일>` 실행 후 재실행

## 완료 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."2_implementation".substages."dev".done' 'true'
```

> 5단계 진입 시 `verify.sh <이슈키> 2_implementation.test`가 worktree가 메인 repo의 형제 디렉토리인지
> 자동 검증한다. 비규약 경로(예: 메인 repo 안)에 만들었다면 거기서 차단된다.
