# 5단계: 테스트 (단위 + 통합) — `2_implementation.test` substage

**목적**: 코드 변경의 정확성을 단위 테스트와 통합 테스트로 검증한다(로컬 실행).
**진입 게이트**: `verify.sh <이슈키> 2_implementation.test` (`2_implementation.dev` 완료 + worktree 형제 검증).

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

## 5-0. Analysis 결과 읽기 (필수 — 테스트 코드 작성 전)

테스트를 작성하기 전에 `workspace-analysis.json` 의 `test_conventions` 를 읽어 기존 테스트 패턴을 파악한다. **새 테스트 코드는 반드시 이 패턴을 따라야 한다. 독자적인 스타일로 작성하는 것을 금지한다.**

`artifact_path` 는 상대경로 저장 원칙을 따르므로 반드시 `state.sh root()` 로 절대경로 해석한다 (legacy 절대경로도 수용):

```bash
ART_REL="$(bash <SCRIPTS_DIR>/state.sh get <이슈키> \
  '.stages."2_implementation".substages."analysis".artifact_path' | tr -d '"')"

if [ -n "$ART_REL" ] && [ "$ART_REL" != "null" ]; then
  if [[ "$ART_REL" == /* ]]; then
    ANALYSIS_PATH="$ART_REL"    # legacy 절대경로 수용
  else
    ANALYSIS_PATH="$(bash <SCRIPTS_DIR>/state.sh root)/$ART_REL"
  fi
  [ -f "$ANALYSIS_PATH" ] && jq '.test_conventions' "$ANALYSIS_PATH"
fi
```

확인 후 아래 항목을 테스트 코드 작성 전에 반드시 파악한다:

| 항목 | 활용 |
|---|---|
| `test_conventions.framework` | 테스트 프레임워크 — 동일 프레임워크 사용 (`framework: "none"` 이면 도입 불필요) |
| `test_conventions.style` | 테스트 스타일 — 동일 스타일 적용 (예: FlatSpec, @Test+AssertJ) |
| `test_conventions.test_roots` | 테스트 파일 생성 위치 |
| `test_conventions.naming_pattern` | 테스트 파일/클래스 네이밍 |
| `test_conventions.mock_library` | Mock 라이브러리 — 기존과 동일하게 사용 |
| `test_conventions.patterns` | 관찰된 패턴 (given-when-then, fixture 설정 방식 등) |
| `test_conventions.sample_files` | **대표 샘플 파일** — `Read` 툴로 반드시 내용 확인 후 동일 방식으로 작성 |

**`test_conventions.sample_files` 가 존재하면**: `Read` 툴로 각 파일을 실제로 읽어 구조·import·assertion 방식을 파악한 뒤, 그 패턴을 새 테스트에 그대로 적용한다.

## 5-1. 빌드 시스템 식별

- `build.sbt` → **SBT** (이 워크플로의 1순위 대상)
- `build.gradle` / `build.gradle.kts` → Gradle
- `pom.xml` → Maven

빌드 시스템마다 테스트 유형별 명령이 다르다(아래 표 참조).

## 5-2. 단위 테스트

| 빌드 시스템 | 명령 |
|---|---|
| SBT | `sbt test` |
| Gradle | `./gradlew test` |
| Maven | `mvn test` |

실행 후 결과를 셋 중 하나로 분류한다:

- **pass** — 테스트가 실제로 실행되어 모두 통과.
- **fail** — 테스트가 실행되었고 실패한 케이스 존재.
- **skip** — **테스트가 존재하지 않거나 정의되지 않음.** 예:
  - SBT: `No tests to run` / `tests found: 0` / `[info] No tests were executed`
  - Gradle: `No tests found for given includes` / 모듈에 test task 자체가 없음
  - Maven: `No tests to run`
  - 명령 자체가 missing task로 실패: `Unknown task '...'` 등
  - **테스트 부재로 인한 실패는 fail이 아니라 skip이다.**

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."2_implementation".substages."test".unit' '"pass"'   # | "fail" | "skip"
```

## 5-3. 통합 테스트

| 빌드 시스템 | 명령 |
|---|---|
| SBT | `sbt IntegrationTest/test` (SBT 0.13.x: `sbt it:test`) |
| Gradle | `./gradlew integrationTest` (프로젝트 task명에 맞춤) |
| Maven | `mvn verify` 또는 `mvn failsafe:integration-test` |

결과 분류는 5-2와 동일(pass / fail / skip).

특히 SBT에서 `IntegrationTest` config가 정의되지 않아 `Reference to undefined setting` 등으로
명령이 실패하는 경우는 **skip**으로 처리한다(통합 테스트 설정 부재 = 통합 테스트 없음).

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."2_implementation".substages."test".integration' '"skip"'   # | "pass" | "fail"
```

## 5-4. 커버리지 검증

단위·통합 테스트 결과 중 하나라도 `pass`이면 반드시 수행한다. 둘 다 `skip`이면 `"exempt"` 기록 후 완료 기록으로 진행.

**임계값**: makdoong2-team.json 의 `coverage.threshold` (기본: **95%**).
직접 확인: `bash gates/stage5-coverage-verify.sh <이슈키>`

### 커버리지 측정 명령

| 빌드 시스템 | 커버리지 측정 명령 |
|---|---|
| SBT | `sbt coverage test coverageReport` |
| Gradle | `./gradlew jacocoTestReport` |
| Maven | `mvn jacoco:prepare-agent test jacoco:report` |
| npm/Jest | `npm test -- --coverage --coverageReporters=text` |
| Go | `go test -cover ./...` |

수정된 파일의 **라인 커버리지(line coverage)** 기준으로 판단한다.

### 커버리지 루프 (최대 2라운드)

| 라운드 | 커버리지 | 행동 |
|---|---|---|
| 1 | ≥ 임계값 | `pass` 기록 → 완료 기록으로 진행 |
| 1 | < 임계값 | 미커버 구간 분석 → 새 테스트 코드 생성 → 재측정 |
| 2 | ≥ 임계값 | `pass` 기록 → 완료 기록으로 진행 |
| 2 | < 임계값 | `fail` 기록 → 6단계 게이트가 차단함. 사용자에게 상세 보고 |

**테스트 생성 불가 판단 기준** (사용자에게 `exempt` 승인 요청):
- 레거시 코드로 모킹이 불가능한 구조
- 외부 시스템 의존으로 단위 테스트 환경 구성 불가
- → 사용자 명시 승인 시에만 `"exempt"` 기록

```bash
# 라운드 1: 커버리지 측정 후 숫자(<측정된_pct>)를 추출해서 스크립트에 전달
# coverage-record.sh 가 config.coverage.threshold 와 비교하고 pass/fail 을 state.json 에 기록한다
bash <SCRIPTS_DIR>/coverage-record.sh <이슈키> <측정된_pct> 1
# 종료코드 0 → pass, 1 → fail

# 라운드 2: 라운드 1 이 fail 인 경우에만 실행 (미커버 구간 분석 + 새 테스트 작성 후)
bash <SCRIPTS_DIR>/coverage-record.sh <이슈키> <측정된_pct> 2
# 종료코드 0 → pass, 1 → fail → 6단계 게이트가 차단 + 사용자에게 보고
```

## 5-5. 최종 자가 검증 (Pre-Completion Checklist)

`done=true` 직전, 다음 5항목을 자체 확인하고 state.json에 결과를 기록한다.
하나라도 false면 완료 기록 금지.

| 항목 | 확인 |
|---|---|
| 1 | 단위·통합 결과(pass/fail/skip)가 명시적으로 state.json에 기록되었다 (none 잔존 X) |
| 2 | 커버리지 측정 명령이 실제 빌드 시스템(SBT/Gradle/Maven/Jest/Go)에 맞게 사용되었다 |
| 3 | `coverage_attempt`가 1 또는 2로 정확히 기록되었다 (race condition 방지) |
| 4 | `exempt` 처리 시 사용자 명시 승인을 받았다 (legacy/외부 의존 사유) |
| 5 | 라운드 2 fail 또는 단위·통합 fail 시 4단계 복귀와 함께 사용자에게 상세 보고했다 |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."2_implementation".substages."test".self_check' \
  '{"results_recorded": true, "coverage_cmd_correct": true, "attempt_tracked": true, "exempt_user_approved": true, "fail_reported": true}'
```

## 완료 기록

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."2_implementation".substages."test".done' 'true'
```

> `3_delivery.commit` 진입 시 `verify.sh <이슈키> 3_delivery.commit`이 단위·통합·커버리지 결과를 함께 검사한다.
> 단위·통합은 **pass 또는 skip**, 커버리지는 **pass 또는 exempt**이어야 통과한다.
> 하나라도 `fail`이면 `2_implementation.dev` substage로 복귀해 수정한다.
> 기본 흐름에서는 `.policy.category` 가 `minor`이든 `major`이든 테스트 완료 후 `3_delivery.commit` 로 무인 자동 진행한다. `.policy.auto_approve."3_delivery.commit"` 가 명시적으로 `false` 로 opt-in 된 경우에만 부장님이 변경 보고서(6단계 §6-0의 `change-report.md`)를 작성하고 사람의 커밋 승인을 받는다.
