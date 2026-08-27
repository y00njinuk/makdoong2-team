// makdoong2-issue-reporter 스킬의 사용자-전용 트리거 강제.
//
// Lives in its own module rather than opencode-plugin.ts because opencode's
// plugin loader invokes EVERY named export of the plugin entry file as a
// plugin factory (see test/plugin-exports-shape.test.mjs). Helpers must be
// imported, never re-exported from the entry file.
//
// 정책: makdoong2-issue-reporter 스킬의 유일한 트리거는 사용자의 직접 호출
// (/makdoong2-issue-reporter 커맨드)이다. 커맨드는 전용 full-permission
// 에이전트 makdoong2-issue-reporter 로 라우팅되므로, 그 외 에이전트
// (team-leader / sealed 서브에이전트)가 skill() 로 자율 로드하는 것은
// 트리거 정책 위반이다. 1차 방어는 SKILL.md description 의 명시, 이 모듈이
// tool.execute.before 훅에서 호출되는 2차(런타임) 방어다.
//
// agent 미상(undefined)은 차단하지 않는다 — outer/primary 세션 passthrough 로,
// OUTER_WORLD_TOOLS 가드와 동일한 설계 철학이다. 우리가 식별한 에이전트에만
// 정책을 적용하고, 식별 밖의 세션은 opencode 자체 permission 에 맡긴다.

import { createHash } from "node:crypto";

export const ISSUE_REPORTER_SKILL_NAME = "makdoong2-issue-reporter";
export const ISSUE_REPORTER_AGENT = "makdoong2-issue-reporter";

// ── GitHub 게시 승인 게이트 ──────────────────────────────────────────────
//
// 정책: issue-reporter 가 GitHub 에 무엇이든 게시(이슈·코멘트·Gist·라벨)하려면
// 사용자가 게시될 "원문 전체"를 보고 명시적으로 승인해야 한다. 채팅 승인은
// 프롬프트 수준 규약일 뿐이라 강제가 아니다 — 여기의 계약이 물리적 강제다:
//
//   1. 에이전트는 payload 를 "리터럴 절대 경로" 파일로 만들어 -d @<path> 로만
//      전달할 수 있다 (인라인 -d '{...}', 변수 경로, curl 외 HTTP 클라이언트 금지).
//   2. 사용자가 scripts/issue-reporter-approve.sh <payload> 를 "직접" 실행한다.
//      스크립트는 payload 원문 전체를 화면에 출력한 뒤 stdin 으로 승인을 받고,
//      payload 의 sha256 을 <payload>.approved 마커에 기록한다.
//   3. tool.execute.before 훅이 GitHub 쓰기 호출 시 마커의 해시와 현재 payload
//      내용을 대조한다. 승인 후 1바이트라도 바뀌면 차단 — 승인은 특정 원문에
//      바인딩되고, 다른 내용으로 바꿔치기할 수 없다.
//   4. 전송이 실행되면 훅(after)이 마커를 삭제한다. 승인은 1회용이다.
//   5. 에이전트 자신의 승인 스크립트 실행·마커 생성/조작은 훅이 차단한다.
//      승인 스크립트는 stdin confirm 이라 에이전트 셸에서는 EOF 로도 못 넘어가지만,
//      printf 'y' 파이프 우회가 가능하므로 실행 자체를 막는 것이 1차다.

export const APPROVAL_MARKER_SUFFIX = ".approved";
export const APPROVE_SCRIPT_BASENAME = "issue-reporter-approve.sh";

/** GitHub API 호출 분류 결과 */
export type GithubApiCall =
  | { kind: "none" }
  | { kind: "read" }
  | { kind: "mutation"; payloadPaths: string[]; problems: string[] }
  | { kind: "forbidden-client"; reason: string };

const MUTATION_METHOD_RE = /(?:-X|--request)[= ]*['"]?(POST|PATCH|PUT|DELETE)\b/i;
const DATA_FLAG_RE = /(^|[\s'"])(-d|--data|--data-binary|--data-raw|--data-urlencode|--json|-F|--form)([= ]|$)/;
const PAYLOAD_AT_RE = /(?:-d|--data|--data-binary|--data-raw|--json)[= ]+@(["']?)([^"'\s]+)\1/g;

/**
 * issue-reporter 의 bash 명령을 GitHub API 관점에서 분류한다.
 *
 * - api.github.com 미참조 → none (이 게이트와 무관)
 * - curl 이 아닌 클라이언트(node/python/wget/gh …)로 api.github.com 접근
 *   → forbidden-client. 훅이 payload 를 검사할 수 있는 형태가 curl -d @file
 *   뿐이므로 다른 클라이언트는 쓰기·읽기 불문 전부 막는다 (읽기는 curl 로).
 * - curl 이지만 mutation 징후(-X POST/PATCH/PUT/DELETE, 데이터 플래그) 없음 → read
 * - mutation → payload 파일 경로 추출. 문제(인라인 데이터, 상대 경로, 변수 포함)는
 *   problems 로 수집한다 — 호출부는 problems 가 하나라도 있으면 차단한다.
 */
export function classifyGithubApiCall(cmd: string): GithubApiCall {
  // gh CLI 는 URL 문자열 없이도 이슈·코멘트·Gist 를 만들 수 있으므로
  // (gh issue create / gh api ...) api.github.com 참조 여부와 무관하게 막는다.
  if (/(^|[;&|(]\s*|\s)gh\s+(api|issue|pr|gist|label|repo|release)\b/.test(cmd)) {
    return {
      kind: "forbidden-client",
      reason: "gh CLI 는 사용할 수 없다. GitHub 접근은 curl 만 허용된다 (쓰기는 curl -d @<절대경로> 형태만 승인 검증 가능).",
    };
  }

  if (!/api\.github\.com/i.test(cmd)) return { kind: "none" };

  const usesCurl = /(^|[;&|(]\s*|\s)curl(\s|$)/.test(cmd);
  if (!usesCurl) {
    return {
      kind: "forbidden-client",
      reason: "api.github.com 접근은 curl 만 허용된다 (쓰기는 curl -d @<절대경로> 형태만 검증 가능).",
    };
  }

  const hasMutationMethod = MUTATION_METHOD_RE.test(cmd);
  const hasDataFlag = DATA_FLAG_RE.test(cmd);
  // curl -G / --get 은 데이터 플래그를 쿼리 스트링으로 변환하는 GET 이다
  // (중복 검색이 --data-urlencode 와 함께 쓴다). mutation method 가 명시되지
  // 않은 -G 호출은 읽기로 분류한다.
  const isGetConverted = /(^|\s)(-G|--get)(\s|$)/.test(cmd) && !hasMutationMethod;
  if (isGetConverted) return { kind: "read" };
  if (!hasMutationMethod && !hasDataFlag) return { kind: "read" };

  const payloadPaths: string[] = [];
  const problems: string[] = [];

  for (const m of cmd.matchAll(PAYLOAD_AT_RE)) {
    payloadPaths.push(m[2]);
  }

  if (payloadPaths.length === 0) {
    problems.push(
      "payload 는 반드시 파일로 전달한다: -d @</absolute/path/payload.json>. " +
      "인라인 JSON(-d '{...}')과 stdin(-d @-)은 승인 검증이 불가능해 금지된다.",
    );
  }
  for (const p of payloadPaths) {
    if (!p.startsWith("/")) {
      problems.push(`payload 경로는 리터럴 절대 경로여야 한다: "${p}"`);
    }
    if (/[$\`]/.test(p)) {
      problems.push(`payload 경로에 변수·명령 치환을 쓸 수 없다: "${p}"`);
    }
  }

  // TOCTOU 방어: 훅은 "명령 실행 전" 파일 해시를 검증하므로, 같은 명령 안에서
  // payload 를 다시 쓰고(curl 앞에 echo > file 등) 전송하면 검증을 우회할 수 있다.
  // 그래서 쓰기 호출은 셸 제어 연산자·치환이 없는 "단일 curl 호출"만 허용한다.
  // (mutation POST URL 에는 &, ; 등이 필요한 경우가 없다 — 읽기 호출은 이 검사 밖.)
  if (/[;|<>\n`]|\$\(|&&|\s&(\s|$)/.test(cmd)) {
    problems.push(
      "GitHub 쓰기 호출은 단일 curl 명령이어야 한다 — 체이닝(;, &&, |, &), " +
      "리다이렉트(<, >), 명령 치환($(), `)을 함께 쓸 수 없다.",
    );
  }

  return { kind: "mutation", payloadPaths, problems };
}

/** 승인 스크립트 호출 여부 — 에이전트에게는 실행이 금지된다 (사용자 전용). */
export function isApproveScriptInvocation(cmd: string): boolean {
  return cmd.includes("issue-reporter-approve");
}

/** 승인 마커 경로 참조 여부 — 에이전트의 bash/write 에서 일절 금지된다. */
export function referencesApprovalMarker(text: string): boolean {
  return text.includes(APPROVAL_MARKER_SUFFIX);
}

/** payload 파일 경로 → 승인 마커 경로 */
export function approvalMarkerPath(payloadPath: string): string {
  return `${payloadPath}${APPROVAL_MARKER_SUFFIX}`;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 마커 파일 내용에서 해시를 파싱한다. 첫 줄이 64자리 hex 가 아니면 null. */
export function parseApprovalMarker(markerContent: string): string | null {
  const first = markerContent.split("\n")[0]?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(first) ? first : null;
}

/**
 * 승인 검증: 마커의 해시가 현재 payload 내용과 일치하는가.
 * 불일치 사유를 문자열로 반환하고, 유효하면 null.
 */
export function approvalMismatch(
  payloadContent: Buffer,
  markerContent: string,
): string | null {
  const recorded = parseApprovalMarker(markerContent);
  if (recorded === null) return "승인 마커 형식이 잘못됐다 (첫 줄이 sha256 hex 가 아님)";
  const actual = sha256Hex(payloadContent);
  if (actual !== recorded) {
    return "payload 내용이 승인 이후 변경됐다 — 승인은 특정 원문에 바인딩되며, 변경된 내용은 재승인이 필요하다";
  }
  return null;
}

/** skill 툴 args 에서 스킬 이름을 추출한다. { name } 및 { arguments: { name } } 형태 수용. */
export function extractSkillNameFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const direct = (args as { name?: unknown }).name;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = (args as { arguments?: unknown }).arguments;
  if (nested && typeof nested === "object") {
    const inner = (nested as { name?: unknown }).name;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return undefined;
}

/**
 * skill 툴 호출이 issue-reporter 트리거 정책을 위반하면 사용자에게 보여줄
 * 에러 메시지를 반환하고, 정상이면 null 을 반환한다.
 */
export function issueReporterSkillLoadViolation(
  agent: string | undefined,
  args: unknown,
): string | null {
  const skillName = extractSkillNameFromArgs(args);
  if (skillName !== ISSUE_REPORTER_SKILL_NAME) return null;
  if (agent === undefined) return null;
  if (agent === ISSUE_REPORTER_AGENT) return null;
  return (
    `[makdoong2-team issue-reporter trigger violation]\n` +
    `Agent "${agent}" cannot load skill "${ISSUE_REPORTER_SKILL_NAME}".\n\n` +
    `이 스킬의 유일한 트리거는 사용자의 직접 호출이다. 에이전트가 실패·예외를 ` +
    `관측했더라도 자율적으로 이슈를 등록하지 않는다.\n\n` +
    `**올바른 절차:** 사용자에게 다음 커맨드 실행을 안내하라:\n` +
    `    /makdoong2-issue-reporter [증상 한 줄 설명(선택)]\n\n` +
    `커맨드는 전용 full-permission 에이전트(${ISSUE_REPORTER_AGENT})로 라우팅되어 ` +
    `수집·마스킹·등록을 수행한다.`
  );
}
