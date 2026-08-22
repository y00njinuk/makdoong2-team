---
name: confluence-research
description: 사내 Confluence 문서 조사 스킬. Confluence DC 대상. 위키, 설계문서, 운영 가이드, 회의록, 온보딩 문서 조회 시 사용. docs MCP 우선, 접근 실패 시 chrome-devtools-mcp로 브라우저 fallback. 읽기 전용이며 문서 생성·수정·코멘트는 하지 않는다.
mcp:
  docs:
    command: bash
    args: ["-c", 'exec "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/confluence-research/run-docs.sh"']
---

# Skill: confluence-research

> 사내 Confluence 문서 조사 스킬 — 설정된 `CONFLUENCE_HOST` (makdoong2-team.json `.hosts`)

## 사전 조건 (필수)

이 스킬의 `docs` MCP 는 lazy-load 다. `skill_mcp(mcp_name="docs", ...)` 를 부르기 전에 반드시 `skill(name="confluence-research")` 로 skill 을 이 세션에 로드해야 한다. 로드 없이 호출하면 `MCP server "docs" not found` 로 실패한다. `chrome-devtools-mcp` fallback 은 opencode.json 의 site-wide MCP 로 등록돼 있으므로 별도 로드 불필요.

## MCP

- **docs** (Confluence MCP) — 1차 수단
- **chrome-devtools-mcp** — fallback (docs MCP로 접근 불가 시)

## 트리거 조건

다음 중 하나에 해당하면 이 스킬을 사용한다:

- "사내 문서", "위키", "Confluence" 언급
- 설계 문서, 운영 가이드, 회의록, 온보딩 문서 등 조회 요청
- 특정 프로젝트/시스템의 내부 문서화 상태 확인

## 워크플로우

```
1. docs MCP 검색
   └─ 키워드 기반 문서 검색
   └─ 스페이스 키가 명확하면 스페이스 한정 검색

2. 페이지 내용 조회
   └─ 검색 결과에서 관련 페이지 본문 조회
   └─ 첨부 파일 목록 확인 (필요시)

3. fallback: chrome-devtools-mcp
   └─ docs MCP로 내용 조회 실패 시
   └─ 브라우저로 Confluence 호스트 직접 탐색
   └─ 페이지 렌더링 후 내용 추출

4. 결과 정리
   └─ 문서 제목 + 스페이스 + 최종 수정일 포함
   └─ 핵심 내용 구조화 요약
   └─ 출처 URL 명시
```

## 출력 형식

```
### {문서 제목}
- **스페이스**: {space key / space name}
- **최종 수정**: {날짜} by {작성자}
- **요약**: {핵심 내용, 5줄 이내}
- **출처**: https://{CONFLUENCE_HOST}/pages/viewpage.action?pageId={pageId}
```

복수 문서인 경우 관련도 순으로 나열한다.

## 제약

- **읽기 전용**. 문서 생성, 수정, 코멘트 작성 불가.
- 브라우저 사용 시 동기적 세션만 허용.
- 문서 본문이 과도하게 길 경우 핵심 섹션만 발췌 요약.

## 사용 예시

- "FOO 프로젝트 설계문서 찾아줘" → docs MCP 검색 후 페이지 본문 요약
- "지난주 팀 회의록" → 키워드 + 기간 범위 검색
- "운영 가이드: 배포 롤백 절차" → 스페이스 한정 검색 후 본문 발췌
