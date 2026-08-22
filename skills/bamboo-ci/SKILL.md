---
name: bamboo-ci
description: Bamboo CI/CD 스킬. Bamboo 대상. 빌드 실행, 배포, 빌드 플랜 조회/생성, 빌드 상태 확인, 실패 로그 요약 시 사용. 검색 키는 조직의 기본 Bamboo 프로젝트로 고정이며, 플랜 생성·트리거·배포 실행 권한을 갖는다.
mcp:
  bamboo:
    command: bash
    args: ["-c", 'exec "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/bamboo-ci/run-bamboo.sh"']
---

# Skill: bamboo-ci

> Bamboo CI/CD 작업 스킬 — 설정된 `BAMBOO_URL` (makdoong2-team.json `.hosts`)

## 사전 조건 (필수)

이 스킬의 `bamboo` MCP 는 lazy-load 다. `skill_mcp(mcp_name="bamboo", ...)` 를 부르기 전에 반드시 `skill(name="bamboo-ci")` 로 skill 을 이 세션에 로드해야 한다. 로드 없이 호출하면 `MCP server "bamboo" not found` 로 실패한다.

## MCP

- **bamboo** (Atlassian Bamboo MCP) — mcp_name 은 `bamboo` 다. `skill_mcp(mcp_name="bamboo", ...)` 로 호출한다.

## 트리거 조건

다음 중 하나에 해당하면 이 스킬을 사용한다:

- 빌드 실행, 배포 요청
- 빌드/배포 상태 확인
- 파이프라인 설정, 빌드 플랜 조회
- "테스트", "빌드", "배포", "Bamboo", "CI/CD" 언급

## 워크플로우

```
1. 프로젝트 검색
   └─ 검색 키: 조직 기본 프로젝트 (예: "Example Project") 고정
   └─ 프로젝트 이름 기준으로 플랜 매칭 (대소문자 무시)

2. 빌드 플랜 확인
   ├─ 플랜 존재 → 3단계로
   └─ 플랜 미존재 → 빌드 플랜 생성

3. 빌드 실행 / 상태 조회
   ├─ 실행 요청 시: 빌드 트리거
   └─ 상태 확인 시: 최근 빌드 결과 조회
      - 성공/실패 상태
      - 실패 시 로그 요약

4. 결과 정리
   └─ 빌드 키, 상태, 실행 시간 포함
   └─ 출처 URL 명시
```

## 출력 형식

```
### 빌드: {PLAN_KEY}-{BUILD_NUMBER}
- **상태**: {SUCCESS|FAILED|BUILDING}
- **트리거**: {manual|scheduled|code change}
- **소요 시간**: {duration}
- **실패 원인** (실패 시): {로그 요약}
- **출처**: {BAMBOO_URL}/browse/{PLAN_KEY}-{BUILD_NUMBER}
```

## 권한

- **읽기 + 쓰기 허용**.
  - 빌드 플랜 생성 가능
  - 빌드 트리거 가능
  - 배포 실행 가능

## 고정 규칙

- 검색 키는 **조직의 기본 Bamboo 프로젝트**로 고정한다. 다른 프로젝트 키를 사용하지 않는다.
- 프로젝트 이름 매칭 시 대소문자를 구분하지 않는다.
- 빌드 플랜이 없으면 사용자 확인 없이 직접 생성한다.

## 사용 예시

- "Example Project 최근 빌드 실패했어?" → 최근 빌드 상태 + 실패 시 로그 요약
- "foo 서비스 빌드 돌려줘" → 해당 플랜 트리거
- "foo 배포 플랜 없는데 만들고 돌려줘" → 플랜 생성 후 트리거
