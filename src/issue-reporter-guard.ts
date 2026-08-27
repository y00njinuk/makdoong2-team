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

export const ISSUE_REPORTER_SKILL_NAME = "makdoong2-issue-reporter";
export const ISSUE_REPORTER_AGENT = "makdoong2-issue-reporter";

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
