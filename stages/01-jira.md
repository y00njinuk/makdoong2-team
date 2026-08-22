# 1단계: Jira 이슈 조회 — `1_planning.jira` substage

**목적**: 이슈 내용을 확보한다.
**진입 게이트**: 없음 (시작 단계).

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

## 작업

`jira-research` 스킬을 사용해 이슈키로 조회한다(`works` MCP는 해당 스킬 frontmatter에 embedded — `skill_mcp` 경유). 다음을 수집한다.
- summary, description, status, 담당자
- 코멘트 전체 이력
- 링크된 이슈와 서브태스크 (2단계 깊이까지)

## 출력

이슈 핵심 내용을 3~5줄로 요약하여 사용자에게 제시한다. 출처 URL을 함께 포함한다.

## 최종 자가 검증 (Pre-Completion Checklist)

`done=true` 기록 직전, 다음 5항목을 자체 확인하고 결과를 state.json에 기록한다.
하나라도 false면 완료 기록 금지 — 미충족 항목으로 되돌아간다.

| 항목 | 확인 |
|---|---|
| 1 | `.stages."1_planning".substages."jira".template_validation` 6항목(content_template_match / content_quality_adequate / priority_set / assignee_set / reporter_set / fix_version_handled) 결과가 모두 기록되었다 |
| 2 | 실패 항목이 있었다면 인터뷰가 완료되었거나(`interview_completed=true`) 사용자 명시 수용을 받았다 |
| 3 | `validation_passed=true`는 6항목 통과 또는 사용자 명시 수용 직후에만 기록했다 (임의 우회 X) |
| 4 | Jira 메타데이터(priority/assignee/reporter 등)를 일체 수정하지 않았다 (RO 원칙) |
| 5 | 이슈 요약·출처 URL을 사용자에게 보고했다 |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."jira".self_check' \
  '{"validations_recorded": true, "interview_handled": true, "validation_passed_legit": true, "ro_preserved": true, "summary_reported": true}'
```

## 완료 기록

```bash
ROOT="$(bash <SCRIPTS_DIR>/state.sh root)"
bash <SCRIPTS_DIR>/state.sh init <이슈키> "$ROOT"   # state.json 생성(워크트리 전이면 4단계 후 갱신)
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."1_planning".substages."jira".done' 'true'
```
