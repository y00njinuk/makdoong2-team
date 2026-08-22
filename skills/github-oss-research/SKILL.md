---
name: github-oss-research
description: GitHub 오픈소스 참조 스킬. 공개 라이브러리/프레임워크의 소스 코드, README, 이슈, 릴리즈 노트 조회 시 사용. 단일 파일은 raw.githubusercontent.com WebFetch 우선, 페이지 탐색은 chrome-devtools-mcp 사용. 읽기 전용이며 public 저장소만 접근한다.
---

# Skill: github-oss-research

> GitHub 오픈소스 참조 스킬 — `github.com`

## MCP

- **chrome-devtools-mcp** — 브라우저 탐색
- WebFetch — raw 콘텐츠 직접 조회

## 트리거 조건

다음 중 하나에 해당하면 이 스킬을 사용한다:

- 오픈소스 라이브러리/프레임워크의 소스 코드 참조
- GitHub 저장소의 README, 이슈, 릴리즈 노트 확인
- 특정 오픈소스 설정 예제, 구현 패턴 조회
- "GitHub", 특정 저장소 URL, 오픈소스 프로젝트명 언급

## 워크플로우

```
1. 접근 방식 결정
   ├─ raw 콘텐츠(단일 파일) → WebFetch 우선
   │   └─ https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
   └─ 페이지 탐색(이슈, PR, 릴리즈 등) → chrome-devtools-mcp

2. 내용 조회
   └─ 파일 내용, README, 이슈 본문, 릴리즈 노트 등 추출

3. 결과 정리
   └─ 저장소명, 파일 경로, 브랜치/태그 명시
   └─ 출처 URL 포함
```

## 출력 형식

```
### {owner}/{repo} — `{파일 경로 또는 페이지}`
- **브랜치/태그**: {branch or tag}
- **내용**: {관련 내용 요약 또는 코드 발췌}
- **출처**: {GitHub URL}
```

## 제약

- **읽기 전용**.
- 브라우저 사용 시 동기적 세션만 허용.
- GitHub API 인증 불가 — public 저장소만 접근 가능.

## 사용 예시

- "openai/whisper setup.py 내용 보여줘" → raw WebFetch로 파일 직접 조회
- "facebook/react 최신 릴리즈노트" → chrome-devtools-mcp로 releases 페이지 탐색
- "특정 오픈소스 README" → raw WebFetch (기본 브랜치의 README.md)
