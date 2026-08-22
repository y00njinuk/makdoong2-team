# 4단계: Workspace 분석 (Analysis)

**목적**: 개발 진입 전에 workspace 구조·의존성·관례·통합 지점을 결정론적으로 분석하고, 그 결과를 고정 JSON schema로 산출한다. 로컬 LLM 계열이 분석을 건너뛰고 코드 생성으로 직행하는 문제를 harness 레벨에서 차단하는 phase gating 이다.

**진입 게이트**: `verify.sh <이슈키> 2_implementation.analysis` (3단계 scope 완료 필요).

> 게이트가 build tool 마커 파일 부재를 감지하면 자동 스킵 처리한다 (`skipped=true`, `done=true` 마킹 후 dispatch 없이 dev substage 로 진행). 본 명세는 게이트를 통과하여 dispatch 된 경우에만 실행된다.

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

## 4-0. 사전 확인 (재개 판정)

이미 완료된 재실행을 방지한다.

```bash
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."2_implementation".substages."analysis"' 2>/dev/null
```

- `.done == true` → 재실행 금지. 부장님에게 "이미 완료" 회신 후 종료.
- `.skipped == true` → 게이트가 이미 SKIP 처리한 상태. dispatch 자체가 발생하지 않았어야 하므로 상태 이상. 부장님에게 보고.
- 그 외 → 다음 절차로 진행.

## 4-1. Workspace 스캔 (Read-Only)

프로젝트 루트의 파일 시스템을 read-only 로 스캔한다. **Edit / Patch / MultiEdit 툴 사용 금지 (프론트매터에서 차단)**. `glob`, `grep`, `read`, read-only `bash` (`ls`, `find`, `cat`, `jq`, `grep` 등) 만 사용.

### 4-1-1. Build tool 및 프로젝트 형태 확인

```bash
# 프로젝트 루트에서 build tool 마커 파일 확인
cd <worktree>
ls -la package.json build.gradle build.gradle.kts pom.xml Cargo.toml go.mod \
       pyproject.toml setup.py requirements.txt Gemfile mix.exs build.sbt \
       composer.json Package.swift Makefile CMakeLists.txt 2>/dev/null || true

# .csproj 는 glob 필요
ls -la *.csproj 2>/dev/null || true
```

식별된 build tool 을 기반으로 `project_structure.build_tool` 필드 값을 확정한다 (`npm`|`gradle`|`maven`|`cargo`|`go`|`pip`|`bundler`|`mix`|`sbt`|`composer`|`swiftpm`|`make`|`cmake`|`dotnet` 등). 여러 마커가 있으면 primary 를 선택 (예: gradle wrapper + Makefile → gradle).

### 4-1-2. Source tree 파악

```bash
# 디렉토리 구조 (max depth 3, 빌드 산출물 제외)
find . -maxdepth 3 -type d \
  -not -path '*/node_modules*' -not -path '*/.git*' -not -path '*/build*' \
  -not -path '*/dist*' -not -path '*/target*' -not -path '*/.gradle*' \
  -not -path '*/out*' -not -path '*/.venv*' -not -path '*/__pycache__*' | sort

# 주요 확장자별 파일 카운트 (분석 참고용)
for ext in java kt scala py js ts go rs rb cs cpp c h swift; do
  cnt=$(find . -maxdepth 5 -type f -name "*.$ext" \
        -not -path '*/node_modules*' -not -path '*/.git*' \
        -not -path '*/build*' -not -path '*/target*' 2>/dev/null | wc -l)
  [ "$cnt" -gt 0 ] && echo "  .$ext: $cnt"
done
```

`project_structure.tree` 필드에 간략화된 tree 를 문자열로 기록 (최대 100 줄 이내). `project_structure.modules` 배열에는 최상위 모듈/패키지 명을 기록 (예: gradle multi-module 이면 settings.gradle 파싱, npm workspace 이면 package.json workspaces 파싱).

### 4-1-3. Dependency 선언 조사

Build tool 별 대응:

| Build tool | 조사 명령 |
|---|---|
| npm | `jq '.dependencies, .devDependencies' package.json` |
| gradle | `grep -E '(implementation\|api\|testImplementation\|compileOnly)\s+' build.gradle*` |
| maven | `grep -A2 '<dependency>' pom.xml` |
| cargo | `awk '/^\[dependencies\]/{f=1} /^\[/&&!/^\[dependencies\]/{f=0} f' Cargo.toml` |
| go | `cat go.mod` |
| pip | `cat requirements.txt` 또는 `grep -A5 dependencies pyproject.toml` |
| sbt | `cat build.sbt` |
| composer | `jq '.require, .["require-dev"]' composer.json` |

- `dependencies.internal`: 프로젝트 내부 모듈 참조 (multi-module 또는 workspace 형태의 경우).
- `dependencies.external`: 외부 패키지. 각 항목은 `{name, version}` 형태.

버전을 확정할 수 없는 경우 `version: null`.

### 4-1-4. Task-relevant files 파악

3단계 scope substage 에서 확정한 수정 대상 파일 목록을 state.json 에서 조회한다.

```bash
bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."1_planning".substages."scope"' 2>/dev/null
```

scope 결과의 각 파일에 대해 실제 파일을 read + grep 하여:

- `path`: repo root 기준 상대 경로
- `role`: `target` | `reference` | `test` | `integration_point` 중 하나
- `reason`: 이 파일이 왜 관련되는지 200자 이내 서술

**`task_relevant_files` 배열은 반드시 1개 이상의 요소를 가져야 한다.** (verifier 필수 요건)

### 4-1-5. Conventions 조사

수정 대상 파일 및 그 이웃 파일들에서 명명 규칙·패턴·유사 구현체를 파악한다.

```bash
# naming 예시 확인 (수정 대상 파일에서)
grep -hE '(public|private|def|fn|func)\s+[a-zA-Z_]+' <target-file> | head -20

# 아키텍처 패턴 파악 (Repository/Service/Controller/Handler 계열)
grep -rE 'class\s+\w+(Service|Repository|Controller|Handler|Manager|Facade)' \
  <source-root>/ 2>/dev/null | head -10

# 유사 기능 구현체 검색 (수정 대상과 유사 심볼)
grep -rl '<유사 심볼 패턴>' <source-root>/ 2>/dev/null | head -5
```

- `conventions.naming`: 짧은 요약 (예: "camelCase for methods, PascalCase for classes")
- `conventions.patterns`: 문자열 배열 (예: `["3-tier Repository/Service/Controller", "@Transactional on service methods"]`)
- `conventions.similar_impl`: 유사 구현체 파일 경로 배열

### 4-1-6. Test conventions 조사

기존 테스트 코드의 구조·프레임워크·패턴을 파악한다. engineer 가 테스트 코드를 새로 작성할 때 이 정보를 기반으로 기존 패턴과 일관성을 유지하도록 강제한다.

```bash
cd <worktree>

# 테스트 루트 디렉토리 탐색
find . -maxdepth 4 -type d \
  \( -name "test" -o -name "tests" -o -name "__tests__" -o -name "spec" \) \
  -not -path '*/.git*' -not -path '*/node_modules*' -not -path '*/target*' \
  -not -path '*/build*' 2>/dev/null | sort

# build tool 별 표준 테스트 루트 확인
ls -d src/test/scala src/test/java src/test/kotlin \
       test/ tests/ __tests__/ spec/ 2>/dev/null || true

# 언어별 테스트 파일 탐색 (프레임워크 식별용)
find . -maxdepth 6 -type f \
  \( -name "*Spec.scala" -o -name "*Test.scala" -o -name "*Suite.scala" \
     -o -name "*Test.java" -o -name "*Tests.java" \
     -o -name "*Test.kt" -o -name "*Spec.kt" \
     -o -name "*.test.ts" -o -name "*.spec.ts" \
     -o -name "*.test.js" -o -name "*.spec.js" \
     -o -name "test_*.py" -o -name "*_test.py" \
     -o -name "*_test.go" \) \
  -not -path '*/.git*' -not -path '*/node_modules*' \
  -not -path '*/target*' -not -path '*/build*' 2>/dev/null | head -20

# 테스트 프레임워크 의존성 확인 (build tool 별)
# SBT:
grep -E '(ScalaTest|specs2|munit|scalacheck|mockito|scalamock)' build.sbt 2>/dev/null || true
# Gradle:
grep -E '(junit|testng|mockito|assertj|kotest)' build.gradle build.gradle.kts 2>/dev/null || true
# Maven:
grep -B1 -A1 'junit\|testng\|mockito\|assertj' pom.xml 2>/dev/null | head -20 || true
# npm:
jq '.devDependencies | to_entries[] | select(.key | test("jest|mocha|vitest|jasmine|chai|sinon"))' \
  package.json 2>/dev/null || true

# 대표 테스트 파일 2-3개 내용 확인 (패턴 파악)
find . -maxdepth 6 -type f \
  \( -name "*Spec.scala" -o -name "*Test.java" -o -name "*.test.ts" -o -name "test_*.py" \) \
  -not -path '*/target*' -not -path '*/build*' -not -path '*/node_modules*' \
  2>/dev/null | head -3 | while read -r f; do
    echo "=== $f ==="
    head -40 "$f"
    echo "---"
done
```

수집 항목:
- `framework`: 테스트 프레임워크 명 (예: `ScalaTest`, `JUnit5`, `Jest`, `pytest`, `Go test`)
- `style`: 테스트 스타일 (예: `FlatSpec with Matchers`, `@Test + AssertJ`, `describe-it`, `FunSuite`)
- `test_roots`: 테스트 루트 디렉토리 배열 (예: `["src/test/scala"]`)
- `naming_pattern`: 테스트 파일 네이밍 규칙 (예: `*Spec`, `*Test`, `test_*`, `*.test.ts`)
- `sample_files`: 대표 테스트 파일 경로 2-3개 (repo root 기준 상대 경로)
- `mock_library`: Mock 라이브러리 (예: `Mockito`, `ScalaMock`, `jest.mock`, `unittest.mock`, `null`)
- `patterns`: 관찰된 테스트 패턴 문자열 배열 (예: `["given-when-then", "MockitoSugar trait", "fixture setup in beforeEach"]`)

테스트 파일이 전혀 없는 경우: `framework: "none"`, 나머지 필드 빈 배열/null.

### 4-1-7. Integration points 결정

수정 대상 파일 각각에 대해 신규 코드 삽입 위치를 명시한다.

- `file`: repo root 기준 상대 경로
- `symbol`: 삽입 대상 심볼 (예: `com.example.UserService.createUser`, `src/api/routes/auth.ts::loginHandler`)
- `how`: 삽입 방식 서술 (100자 이내, 예: "메서드 시작부에 validation 호출 추가", "새 case 절을 switch 문에 추가")

**`integration_points` 배열은 반드시 1개 이상의 요소를 가져야 한다.** (verifier 필수 요건)

## 4-2. 분석 산출물 파일 생성

**경로 (repo/worktree root 기준 상대경로)**: `.makdoong2-team/<이슈키>/workspace-analysis.json`
**물리 파일 생성 위치**: analyzer 는 worktree cwd 에서 실행되므로 `<worktree>/.makdoong2-team/<이슈키>/workspace-analysis.json` 에 물리 파일이 생성된다.
**형식**: 아래 스키마 엄수. **파일 하나만 생성 허용**. 그 외 파일은 생성·수정 절대 금지.

```json
{
  "project_structure": {
    "tree": "<간략 tree, 최대 100줄, 문자열>",
    "build_tool": "<npm|gradle|maven|cargo|go|pip|bundler|mix|sbt|composer|swiftpm|make|cmake|dotnet|other>",
    "modules": ["<모듈명 문자열 배열>"]
  },
  "dependencies": {
    "internal": ["<internal module refs>"],
    "external": [
      {"name": "<pkg name>", "version": "<version or null>"}
    ]
  },
  "task_relevant_files": [
    {
      "path": "<relative path from repo root>",
      "role": "<target|reference|test|integration_point>",
      "reason": "<200자 이내>"
    }
  ],
  "conventions": {
    "naming": "<naming convention 요약>",
    "patterns": ["<pattern 명 배열>"],
    "similar_impl": ["<유사 구현체 경로 배열>"]
  },
  "integration_points": [
    {
      "file": "<relative path>",
      "symbol": "<class.method 또는 모듈 심볼>",
      "how": "<100자 이내>"
    }
  ],
  "test_conventions": {
    "framework": "<ScalaTest|JUnit5|Jest|pytest|Go test|none|other>",
    "style": "<FlatSpec with Matchers|@Test + AssertJ|describe-it|FunSuite|etc>",
    "test_roots": ["<relative path to test root dirs>"],
    "naming_pattern": "<*Spec|*Test|test_*|*.test.ts|etc>",
    "sample_files": ["<2-3 existing test file paths, repo-root relative>"],
    "mock_library": "<Mockito|ScalaMock|jest.mock|unittest.mock|null>",
    "patterns": ["<observed pattern 1>", "<observed pattern 2>"]
  }
}
```

생성 방식: `Write` 툴을 사용해 위 경로에 파일을 저장한다. `bash` heredoc 리디렉션 (`cat > file <<'JSON' ...`) 은 파일 쓰기 우회로 간주되어 훅에서 차단될 수 있으므로 사용하지 않는다.

## 4-3. State.json 마커 기록

`state.sh set` 만 사용한다. state.json 직접 편집 금지 (하드룰).

```bash
# artifact 경로 기록 — 반드시 상대경로만 저장한다 (절대경로 저장 시 다른 cwd 에서 Read hang 유발).
# 소비 측(dev/test substage, verifier)은 state.sh root() 로 절대경로 해석한다.
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."2_implementation".substages."analysis".artifact_path' \
  '".makdoong2-team/<이슈키>/workspace-analysis.json"'

bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."2_implementation".substages."analysis".self_check' \
  '{"has_project_structure": true, "has_dependencies": true, "has_task_relevant_files": true, "has_conventions": true, "has_integration_points": true, "has_test_conventions": true, "json_schema_valid": true}'
```

## 4-4. 자가검증 (Pre-Completion Checklist)

`done=true` 직전, 아래 7체크를 자가검증한다. 하나라도 false 면 완료 기록 금지 — 미충족 항목을 먼저 해소한다.

| 항목 | 확인 |
|---|---|
| 1 | `workspace-analysis.json` 이 지정 경로에 생성되었다 (파일 존재) |
| 2 | JSON parse 성공 (`jq . workspace-analysis.json` 통과) |
| 3 | 6개 필수 필드 (`project_structure`, `dependencies`, `task_relevant_files`, `conventions`, `integration_points`, `test_conventions`) 모두 존재한다 |
| 4 | `task_relevant_files` 배열이 비어있지 않다 (>= 1) |
| 5 | `integration_points` 배열이 비어있지 않다 (>= 1) |
| 6 | `test_conventions.framework` 가 명시되었다 (테스트 파일 없으면 `"none"`) |
| 7 | `workspace-analysis.json` 외 파일을 생성·수정하지 않았다 (`git status` 로 확인 — untracked/modified 없음) |

## 완료 기록

self_check 7개 모두 true 이며 `workspace-analysis.json` 이 유효하면 `done=true` 를 마킹한다.

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."2_implementation".substages."analysis".done' 'true'
```

> 5단계 진입 시 `verify.sh <이슈키> 2_implementation.dev` 는 `.stages."2_implementation".substages."analysis".done == true` 를 요구한다 (`skipped=true` 인 경우에도 `done=true` 로 처리됨). verifier 는 산출물 파일 존재 + JSON 스키마 정합 + self_check 3중 검증한다.
