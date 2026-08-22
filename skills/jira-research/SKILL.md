---
name: jira-research
description: Jira 이슈 조사 스킬. Jira DC 대상. 이슈 키(예 PROJ-1234) 감지, 티켓 상세 조회, 스프린트/백로그 확인, 이슈 간 관계(블로커/서브태스크/에픽) 재귀 탐색 시 사용. 읽기 전용이며 이슈 생성·수정·전환·코멘트 작성은 하지 않는다.
mcp:
  works:
    command: bash
    args: ["-c", 'exec "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/jira-research/run-works.sh"']
---

# Skill: jira-research

> Jira 이슈 조사 스킬 — 설정된 `JIRA_HOST` (makdoong2-team.json `.hosts`)

## 사전 조건 (필수)

이 스킬의 `works` MCP 는 lazy-load 다. `skill_mcp(mcp_name="works", ...)` 를 부르기 전에 반드시 `skill(name="jira-research")` 로 skill 을 이 세션에 로드해야 한다. 로드 없이 호출하면 `MCP server "works" not found` 로 실패한다.

## MCP

- **works** (Jira MCP)

## 트리거 조건

다음 중 하나에 해당하면 이 스킬을 사용한다:

- 사용자가 Jira 이슈 키(예: `PROJ-1234`)를 언급
- "이슈 찾아줘", "티켓 확인", "백로그", "스프린트", "jira" 등 Jira 관련 키워드
- 특정 기능/버그/작업의 진행 상태 질문
- 이슈 간 관계(블로커, 서브태스크, 링크) 파악 요청

## 워크플로우

```
1. 검색
   └─ works MCP 검색 도구로 키워드/이슈 키 검색

2. 상세 조회
   └─ 검색된 이슈의 상세 정보 조회
      - 요약(summary), 상태(status), 담당자(assignee)
      - 설명(description), 코멘트(comments)
      - 우선순위(priority), 라벨(labels), 컴포넌트

3. 재귀 탐색 (필요시)
   └─ 링크된 이슈, 서브태스크, 에픽 관계를 따라 탐색
   └─ 탐색 깊이: 최대 3단계
   └─ 순환 참조 방지: 이미 조회한 이슈 키는 스킵

4. 결과 정리
   └─ 이슈 키 + 제목 + 상태 + 담당자 형태로 요약
   └─ 출처 URL: https://{JIRA_HOST}/browse/{ISSUE_KEY}
```

## 출력 형식

```
### {ISSUE_KEY}: {요약}
- **상태**: {status}
- **담당자**: {assignee}
- **설명**: {description 요약, 3줄 이내}
- **주요 코멘트**: {최신 또는 핵심 코멘트 요약}
- **링크된 이슈**: {관련 이슈 목록}
- **출처**: https://{JIRA_HOST}/browse/{ISSUE_KEY}
```

## 제약

- **읽기 전용**. 이슈 생성, 수정, 전환, 코멘트 작성 불가.
- 재귀 탐색 시 깊이 3단계 초과 금지.
- 민감 정보(보안 이슈 등)는 사용자에게 직접 확인 유도.

## 사용 예시

- "PROJ-1234 상태 어때?" → 단일 이슈 상세 조회
- "이번 스프린트 내 담당 티켓" → 담당자 필터 + 스프린트 범위 검색
- "PROJ-1234 블로커까지 따라가서 요약" → 링크 이슈 재귀 탐색 (깊이 2~3)
