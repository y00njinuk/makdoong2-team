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
// 사용자가 게시될 "원문 전체"를 보고 명시적으로 승인해야 한다. 승인은 두 조각이
// 함께 성립해야 유효하며, 어느 쪽도 프롬프트 규약이 아니라 코드가 강제한다:
//
//   (가) 의사표시 — opencode permission 프롬프트의 yes/no.
//        에이전트 frontmatter 가 api.github.com 접근을 "ask" 로 올리고,
//        plugin 의 permission.ask 훅이 쓰기(mutation)에 대해 status 를 "ask" 로
//        고정한다 (읽기는 "allow" 로 내려 사용자를 성가시게 하지 않는다).
//        사용자가 거부하면 tool 은 실행되지 않는다.
//   (나) 정보에 근거한 동의 — "사용자가 본 원문" == "전송되는 원문".
//        permission 프롬프트에는 curl 명령만 보이고 본문은 파일 안에 있으므로,
//        프롬프트만으로는 무엇이 게시되는지 알 수 없다. 그래서 에이전트는 전송 전에
//        payload 를 세션에서 `cat` 으로 그대로 출력해야 하고, 훅이 그 시점의
//        sha256 을 기록한다. 전송 시 기록된 해시와 현재 파일이 다르면 차단된다.
//
// 이 조합은 2026-08 이전의 "issue-reporter-approve.sh + <payload>.approved 마커"
// 방식을 대체한다. 마커 방식은 사용자가 별도 셸에서 스크립트를 직접 실행해야 했고,
// 그 실행이 곧 (가)와 (나)를 동시에 만족시켰다. 승인을 세션 안의 질문으로 옮기면서
// (가)는 opencode permission 으로, (나)는 표시 해시로 각각 넘겼다.
//
// 형식 제약은 그대로다 — 에이전트는 payload 를 "리터럴 절대 경로" 파일로 만들어
// 단일 curl 의 -d @<path> 로만 전달할 수 있다 (인라인 -d '{...}', 변수 경로,
// 체이닝, curl 외 HTTP 클라이언트 금지). 이것이 없으면 훅이 무엇이 전송되는지
// 검증할 수 없고, (나)의 해시 대조도 우회된다.

/** 표시 증명으로 인정되는 명령의 형태: 체이닝 없는 단일 `cat <절대경로>`. */
const DISPLAY_CAT_RE = /(?:^|\s)cat\s+(?:--\s+)?(["']?)(\/[^"'\s]+)\1(?:\s|$)/g;
const SHELL_COMPOSITION_RE = /[;|<>\n`]|\$\(|&&|\s&(\s|$)/;

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
 * 승인 프롬프트를 띄우는 유일한 형식: `-d @<절대경로>` (등호·따옴표 없이 공백 하나).
 *
 * 게시 승인의 의사표시는 opencode 의 bash permission 프롬프트가 받는데, 그 프롬프트는
 * 에이전트 frontmatter 의 `"*-d @/*": "ask"` 패턴이 명령 문자열에 매치될 때만 뜬다.
 * 그래서 `--data @/x` 나 `-d=@/x` 처럼 같은 의미의 다른 표기를 허용하면 **질문 없이
 * 전송되는 경로**가 생긴다. 의미가 아니라 표기에 승인이 걸려 있으므로, 표기를 하나로
 * 고정하고 나머지는 차단한다. 이 상수를 고칠 때는 frontmatter 패턴도 같이 고쳐야 한다.
 */
const APPROVABLE_PAYLOAD_RE = /(^|\s)-d @\/[^\s'"]+(\s|$)/;

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
  } else if (!APPROVABLE_PAYLOAD_RE.test(cmd)) {
    // 같은 의미라도 표기가 다르면 승인 프롬프트가 뜨지 않는다 — APPROVABLE_PAYLOAD_RE 주석 참조.
    problems.push(
      "payload 표기는 정확히 `-d @/절대경로` 여야 한다 (공백 하나, 등호·따옴표 없이). " +
      "--data / --data-binary / --data-raw / --json / -d=@ 형태는 사용자 승인 프롬프트를 " +
      "띄우지 못해 질문 없이 전송되므로 금지된다.",
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

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 이 명령이 "원문 표시" 로 인정되는 절대 경로들을 돌려준다.
 *
 * 인정 조건은 **체이닝·리다이렉트·명령 치환이 없는 단일 `cat <절대경로>`** 다.
 * 좁게 잡은 이유는 표시가 증거이기 때문이다 — `cat p; echo x > p` 를 허용하면
 * 사용자가 본 내용과 파일에 남는 내용이 갈라져 (나) 불변 조건이 깨진다.
 * jq 등으로 예쁘게 렌더링하는 것은 막지 않지만, 해시 증명으로 인정되지 않는다
 * (렌더링은 원문이 아니다).
 */
export function payloadDisplayPaths(cmd: string): string[] {
  if (SHELL_COMPOSITION_RE.test(cmd)) return [];
  const paths: string[] = [];
  for (const m of cmd.matchAll(DISPLAY_CAT_RE)) paths.push(m[2]);
  return paths;
}

/**
 * 표시 증명 검증: 사용자가 본 원문의 해시가 지금 전송하려는 payload 와 같은가.
 * 불일치 사유를 문자열로 반환하고, 유효하면 null.
 */
export function displayMismatch(
  payloadContent: Buffer,
  shownHash: string | undefined,
): string | null {
  if (!shownHash) {
    return "이 payload 의 원문이 세션에 표시된 적이 없다 — 사용자는 무엇이 게시되는지 볼 수 없었다";
  }
  if (sha256Hex(payloadContent) !== shownHash) {
    return "표시 이후 payload 내용이 변경됐다 — 승인은 사용자가 본 원문에 바인딩되며, 변경된 내용은 재표시·재승인이 필요하다";
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
 * task 툴 호출이 issue-reporter 를 서브에이전트로 spawn 하려 하면 차단 사유를,
 * 아니면 null 을 반환한다.
 *
 * 이 에이전트의 진입점은 `/makdoong2-issue-reporter` 커맨드 하나뿐이다. frontmatter 의
 * `mode: subagent` + `hidden: true` 는 선택·자동완성 목록에서 감출 뿐이고, opencode 의
 * task 툴은 **subagent_type 의 mode 를 검사하지 않으므로** 이름만 알면 spawn 된다.
 * 목록에 없는 것과 부를 수 없는 것은 다르다 — 그 간극을 여기서 닫는다.
 *
 * spawn 을 막아야 하는 이유는 격리 그 자체다. task 로 띄운 자식 세션은 직전 대화
 * 컨텍스트를 보지 못해 수집이 반쪽이 되고, 사용자 승인 프롬프트도 그 세션에서 뜬다.
 * 무엇보다 "사용자가 직접 부른다" 는 트리거 정책이 우회된다.
 */
export function issueReporterTaskSpawnViolation(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const direct = (args as { subagent_type?: unknown }).subagent_type;
  const nested = (args as { arguments?: { subagent_type?: unknown } }).arguments?.subagent_type;
  const target = typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
  if (target !== ISSUE_REPORTER_AGENT) return null;
  return (
    `[makdoong2-team issue-reporter trigger violation]\n` +
    `"${ISSUE_REPORTER_AGENT}" 는 task 툴로 spawn 할 수 없다.\n\n` +
    `이 에이전트는 사용자가 /makdoong2-issue-reporter 커맨드를 실행할 때만, 현재 세션 안에서 ` +
    `인라인으로 전환되어 동작한다. 자식 세션으로 격리하면 직전 대화 컨텍스트를 잃어 증거 수집이 ` +
    `불완전해지고, 사용자 직접 호출이라는 트리거 정책도 우회된다.\n\n` +
    `**올바른 절차:** 사용자에게 다음 실행을 안내하라:\n` +
    `    /makdoong2-issue-reporter [증상 한 줄 설명(선택)]`
  );
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
