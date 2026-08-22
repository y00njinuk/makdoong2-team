---
name: bitbucket-research
description: Bitbucket DC 코드/PR 조사 스킬. Bitbucket DC 대상. 소스 코드 검색, 특정 파일/클래스/메서드 위치 파악, PR 조회 및 리뷰 상태 확인, 브랜치/커밋 이력 확인 시 사용. 읽기 전용이며 PR 생성·코드 수정·브랜치 생성은 하지 않는다.
mcp:
  repos:
    command: bash
    args: ["-c", 'exec "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/bitbucket-research/run-repos.sh"']
---

# Skill: bitbucket-research

> Bitbucket DC 코드/PR 조사 스킬 — 설정된 `BITBUCKET_API_BASE_PATH` (makdoong2-team.json `.hosts`)

## 사전 조건 (필수)

이 스킬의 `repos` MCP 는 lazy-load 다. `skill_mcp(mcp_name="repos", ...)` 를 부르기 전에 반드시 `skill(name="bitbucket-research")` 로 skill 을 이 세션에 로드해야 한다. 로드 없이 호출하면 `MCP server "repos" not found` 로 실패한다.

## MCP

- **repos** (Bitbucket DC MCP)

## 트리거 조건

다음 중 하나에 해당하면 이 스킬을 사용한다:

- 소스 코드 검색, 특정 클래스/메서드/설정 파일 위치 파악
- PR(Pull Request) 조회, 리뷰 상태 확인
- 브랜치 상태, 최근 커밋 이력 확인
- "Bitbucket", "저장소", "PR" 언급

## 워크플로우

```
1. 검색
   └─ repos MCP로 코드/PR/저장소 검색
   └─ 프로젝트 키 + 저장소명이 명확하면 범위 한정

2. 파일 내용 조회
   └─ 검색된 파일의 내용 조회
   └─ 특정 라인 범위가 필요하면 해당 범위만 추출

3. PR 히스토리 확인 (필요시)
   └─ PR 목록 조회 (상태: OPEN / MERGED / DECLINED)
   └─ PR 상세: 리뷰어, 승인 상태, diff 요약
   └─ 관련 커밋 메시지 수집

4. 브랜치 상태 (필요시)
   └─ 브랜치 목록 조회
   └─ 특정 브랜치의 최신 커밋 확인

5. 결과 정리
   └─ 파일 경로, 저장소, 프로젝트 키 명시
   └─ 출처 URL 포함
```

## 출력 형식

### 코드 검색 결과

```
### {프로젝트}/{저장소} — `{파일 경로}`
- **브랜치**: {branch}
- **내용**: (관련 코드 발췌)
- **출처**: https://{BITBUCKET_HOST}/projects/{PROJECT}/repos/{REPO}/browse/{PATH}
```

### PR 조회 결과

```
### PR #{id}: {제목}
- **상태**: {OPEN|MERGED|DECLINED}
- **작성자**: {author}
- **리뷰어**: {reviewers + 승인 상태}
- **변경 파일**: {파일 수} files
- **출처**: https://{BITBUCKET_HOST}/projects/{PROJECT}/repos/{REPO}/pull-requests/{ID}
```

## 제약

- **읽기 전용**. PR 생성, 코드 수정, 브랜치 생성 불가.
- 대용량 파일(바이너리, 1000줄 초과)은 관련 부분만 발췌.

## 사용 예시

- "XYZ 클래스 정의된 곳 찾아줘" → 코드 검색 후 파일 경로/범위 반환
- "PROJECT/repo의 오픈 PR 리스트" → 상태 필터 PR 목록 조회
- "PR #123 리뷰 상태" → PR 상세 + 승인 현황 요약
