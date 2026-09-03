import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pollSubSession, isWithinWorktreeScope, isMatchedByConfiguredRules,
  worktreeAllowedScope, pollOutcomeToLegacy, PERMISSION_STALL_NEXT_ACTION,
  buildPermissionCorrectionMessage, buildPathScopePromptBlock } from "../dist/poll-sub-session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = readFileSync(resolve(HERE, "../src/opencode-plugin.ts"), "utf8");

describe("static call-site regression — allowedWorktree propagation", () => {
  test("dispatch_stage initial poll passes effectiveWorktree", () => {
    const matches = PLUGIN_SRC.match(/pollSubSession\(subSessionID,\s*substageTimeoutMs,\s*effectiveWorktree\)/g) ?? [];
    assert.ok(matches.length >= 1, "dispatch_stage must pass effectiveWorktree to pollSubSession");
  });

  test("dispatch_verifier poll does NOT pass allowedWorktree (read-only, safe default)", () => {
    const withWorktree = PLUGIN_SRC.match(/pollSubSession\(subSessionID,\s*substageTimeoutMs,\s*args\.worktree\)/g) ?? [];
    assert.equal(withWorktree.length, 0, "dispatch_verifier must NOT pass allowedWorktree (verifier is read-only)");
  });

  test("no bare pollSubSession(subSessionID) calls remain (missing allowedWorktree)", () => {
    const bare = PLUGIN_SRC.match(/pollSubSession\(subSessionID\)/g) ?? [];
    assert.equal(bare.length, 0, "all pollSubSession calls must explicitly pass timeoutMs and worktree or omit worktree intentionally via substageTimeoutMs");
  });
});

describe("isWithinWorktreeScope — path matching", () => {
  const wt = "/root/IdeaProjects/tutorial/my-project-PROJ-123";

  test("sibling dir (/* glob) is within scope", () => {
    assert.ok(isWithinWorktreeScope(["/root/IdeaProjects/tutorial/my-project/*"], wt));
  });

  test("sibling dir (/** glob) is within scope", () => {
    assert.ok(isWithinWorktreeScope(["/root/IdeaProjects/tutorial/other-repo/**"], wt));
  });

  test("sibling dir (no glob) is within scope", () => {
    assert.ok(isWithinWorktreeScope(["/root/IdeaProjects/tutorial/main-repo"], wt));
  });

  test("exact parent dir itself is within scope", () => {
    assert.ok(isWithinWorktreeScope(["/root/IdeaProjects/tutorial"], wt));
  });

  test("grandparent dir is outside scope", () => {
    assert.ok(!isWithinWorktreeScope(["/root/IdeaProjects"], wt));
  });

  test("completely unrelated path is outside scope", () => {
    assert.ok(!isWithinWorktreeScope(["/tmp/evil/**"], wt));
  });

  test("all patterns must be within scope (AND logic)", () => {
    assert.ok(!isWithinWorktreeScope([
      "/root/IdeaProjects/tutorial/ok-repo/*",
      "/etc/passwd",
    ], wt));
  });

  test("empty patterns array returns false", () => {
    assert.ok(!isWithinWorktreeScope([], wt));
  });

  test("empty worktree returns false", () => {
    assert.ok(!isWithinWorktreeScope(["/root/IdeaProjects/tutorial/foo"], ""));
  });

  test("worktree with trailing slash is handled correctly", () => {
    assert.ok(isWithinWorktreeScope(
      ["/root/IdeaProjects/tutorial/sibling/*"],
      "/root/IdeaProjects/tutorial/my-project-PROJ-123/",
    ));
  });
});

function makePermissionClient({
  sessionId,
  pendingPermissions = [],
  replyCalls = [],
  abortCalls = [],
  messagesAfterAllow = [],
} = {}) {
  let pollN = 0;
  let allowedIds = new Set();
  return {
    session: {
      status: async () => {
        pollN++;
        if (allowedIds.size > 0 && messagesAfterAllow.length > 0) {
          return { data: { [sessionId]: { type: "idle" } } };
        }
        return { data: { [sessionId]: { type: "working" } } };
      },
      messages: async () => {
        if (allowedIds.size > 0 && messagesAfterAllow.length > 0) {
          return { data: messagesAfterAllow };
        }
        return { data: [] };
      },
      abort: async () => { abortCalls.push(Date.now()); return {}; },
    },
    permission: {
      list: async () => {
        if (pollN % 5 !== 0) return { data: [] };
        return { data: pendingPermissions.filter(p => !allowedIds.has(p.id)) };
      },
      reply: async ({ path: { requestID }, body: { reply } }) => {
        replyCalls.push({ requestID, reply });
        if (reply === "once") allowedIds.add(requestID);
        return {};
      },
    },
  };
}

const IDLE_MSG = [{ info: { role: "assistant", finish: {} }, parts: [{ type: "text", text: "done" }] }];

// NOTE: isMatchedByConfiguredRules uses prefix comparison, NOT path.matchesGlob.
// path.matchesGlob's "**" does NOT cross dot-directories (.nvm, .config), so
// middle-wildcard patterns like "**/@local/**" would silently fail for ~/.nvm paths.
// opencode.json must use absolute-path prefixes for any dot-directory paths.
describe("isMatchedByConfiguredRules — prefix-based opencode.json pattern matching", () => {
  const configuredGlobs = [
    "/root/.nvm/**",
    "/root/.config/opencode/**",
  ];

  test("npm pkg under /root/.nvm/** is covered by prefix", () => {
    assert.ok(isMatchedByConfiguredRules(
      ["/root/.nvm/versions/node/v24.14.0/lib/node_modules/@local/makdoong2-team/dist/*"],
      configuredGlobs,
    ));
  });

  test("opencode config dir under /root/.config/opencode/** is covered", () => {
    assert.ok(isMatchedByConfiguredRules(
      ["/root/.config/opencode/agents/**"],
      configuredGlobs,
    ));
  });

  test("unrelated path /etc/passwd is NOT covered", () => {
    assert.ok(!isMatchedByConfiguredRules(["/etc/passwd"], configuredGlobs));
  });

  test("sibling-but-not-prefix path is NOT covered", () => {
    assert.ok(!isMatchedByConfiguredRules(["/root/.nvmrc"], configuredGlobs));
  });

  test("empty configured globs → false", () => {
    assert.ok(!isMatchedByConfiguredRules(["/root/.nvm/foo"], []));
  });

  test("empty patterns → false", () => {
    assert.ok(!isMatchedByConfiguredRules([], configuredGlobs));
  });

  test("AND logic — one outside prefix rejects all", () => {
    assert.ok(!isMatchedByConfiguredRules(
      ["/root/.nvm/foo/*", "/etc/secrets/**"],
      configuredGlobs,
    ));
  });
});

describe("pollSubSession — permission allow branch (within worktree scope)", () => {
  const worktree = "/root/IdeaProjects/tutorial/my-project-PROJ-123";
  const sibling  = "/root/IdeaProjects/tutorial/main-repo";
  const SID = "ses_test_allow";

  test("external_directory within scope → reply once, session continues, returns text", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_001", sessionID: SID,
        permission: "external_directory",
        patterns: [`${sibling}/*`],
      }],
      replyCalls,
      abortCalls,
      messagesAfterAllow: IDLE_MSG,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      allowedWorktree: worktree,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "text", `expected text, got ${outcome.kind}`);
    assert.equal(replyCalls.length, 1);
    assert.deepEqual(replyCalls[0], { requestID: "per_001", reply: "once" });
    assert.equal(abortCalls.length, 0, "session must NOT be aborted on allow");
  });
});

describe("pollSubSession — permission allow via configuredAllowPatterns", () => {
  const configuredGlobs = ["/root/.nvm/**", "/root/.config/opencode/**"];
  const SID = "ses_cfg_allow";

  test("npm pkg under /root/.nvm/** prefix → reply once, continues", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_cfg1", sessionID: SID,
        permission: "external_directory",
        patterns: ["/root/.nvm/versions/node/v24.14.0/lib/node_modules/@local/makdoong2-team/dist/*"],
      }],
      replyCalls,
      abortCalls,
      messagesAfterAllow: IDLE_MSG,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      configuredAllowPatterns: configuredGlobs,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "text");
    assert.equal(replyCalls[0]?.reply, "once");
    assert.equal(abortCalls.length, 0);
  });

  test("path NOT in configured globs → reject", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_cfg2", sessionID: SID,
        permission: "external_directory",
        patterns: ["/etc/secrets/**"],
      }],
      replyCalls,
      abortCalls,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      configuredAllowPatterns: configuredGlobs,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "permission_stall");
    assert.equal(replyCalls[0]?.reply, "reject");
    assert.equal(abortCalls.length, 1);
  });

  test("allow when worktree scope covers path even if configuredGlobs doesn't", async () => {
    const worktree = "/root/IdeaProjects/tutorial/my-project-PROJ-999";
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_cfg3", sessionID: SID,
        permission: "external_directory",
        patterns: ["/root/IdeaProjects/tutorial/main-repo/*"],
      }],
      replyCalls,
      abortCalls,
      messagesAfterAllow: IDLE_MSG,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      allowedWorktree: worktree,
      configuredAllowPatterns: configuredGlobs,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "text", "worktree scope covers IdeaProjects siblings even without configured glob");
    assert.equal(replyCalls[0]?.reply, "once");
    assert.equal(abortCalls.length, 0);
  });
});

describe("pollSubSession — permission reject branch (outside worktree scope or wrong type)", () => {
  const worktree = "/root/IdeaProjects/tutorial/my-project-PROJ-123";
  const SID = "ses_test_reject";

  test("external_directory outside scope → reject + abort + permission_stall", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_002", sessionID: SID,
        permission: "external_directory",
        patterns: ["/etc/secrets/**"],
      }],
      replyCalls,
      abortCalls,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      allowedWorktree: worktree,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionID, "per_002");
    assert.equal(outcome.permissionType, "external_directory");
    assert.equal(replyCalls[0]?.reply, "reject");
    assert.equal(abortCalls.length, 1, "session must be aborted on reject");
  });

  test("non-external_directory permission → always reject regardless of worktree", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_003", sessionID: SID,
        permission: "bash",
        patterns: ["rm -rf /**"],
      }],
      replyCalls,
      abortCalls,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      allowedWorktree: worktree,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionType, "bash");
    assert.equal(replyCalls[0]?.reply, "reject");
    assert.equal(abortCalls.length, 1);
  });

  test("no allowedWorktree → external_directory is rejected (safe default)", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_004", sessionID: SID,
        permission: "external_directory",
        patterns: ["/root/IdeaProjects/tutorial/main-repo/*"],
      }],
      replyCalls,
      abortCalls,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "permission_stall");
    assert.equal(replyCalls[0]?.reply, "reject");
  });

  test("permission from different session is ignored", async () => {
    const replyCalls = [];
    const abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_005", sessionID: "ses_OTHER",
        permission: "external_directory",
        patterns: ["/etc/**"],
      }],
      replyCalls,
      abortCalls,
      messagesAfterAllow: IDLE_MSG,
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 300,
      permissionCheckIntervalPolls: 5,
    });

    // timeout fires (no message for SID → never idle), but abort is expected from timeout.
    // Critical assertion: permission from ses_OTHER must NOT be replied to.
    assert.equal(replyCalls.length, 0, "must not reply to other session's permission");
    assert.ok(outcome.kind !== "permission_stall", "other session's permission must not cause stall");
  });
});

// ── GitHub #12 — 조부모 요청 차단은 유지하고, 회복은 "범위 확장" 이 아니라 안내로 한다 ──
//
// 관측된 정지: worktree=/root/IdeaProjects/<group>/<repo>-<KEY> 에서 engineer 의
// read-only `glob` 이 /root/IdeaProjects/* 를 요청 → 스코프 밖 → 자동 거부 + abort
// → dispatch_stage 하드 실패 → team-leader 가 "승인 대기" 로 오판 보고.
//
// 이슈의 제안 1(스코프를 조부모까지 확장)은 **채택하지 않는다.** 이 판정의 결과는
// 사람의 확인 없이 `allow` 로 응답되므로, 조부모를 여는 순간 형제 프로젝트 전체가
// 무단 승인 대상이 되고 루트(`/`)면 파일시스템 전체가 열린다. 차단은 정상 동작이고
// 고칠 것은 (a) 무엇이 막혔고 어디까지 허용인지 알려주는 것, (b) 그 안내를 실어
// 재디스패치하는 것, (c) "이미 종료됨" 을 리더가 오판하지 못하게 하는 것이다.
describe("issue #12 — 자동 승인 범위는 worktree 부모 한 단계로 고정된다", () => {
  const wt = "/root/IdeaProjects/tutorial/my-project-PROJ-123";

  test("worktreeAllowedScope 는 부모 한 단계다 (조부모가 아니다)", () => {
    assert.equal(worktreeAllowedScope(wt), "/root/IdeaProjects/tutorial");
    assert.equal(worktreeAllowedScope("/root/IdeaProjects/tutorial/x/"), "/root/IdeaProjects/tutorial");
  });

  test("조부모 glob(`/root/IdeaProjects/*`) 은 계속 스코프 밖이다 — 확장 금지", () => {
    assert.ok(!isWithinWorktreeScope(["/root/IdeaProjects/*"], wt));
  });

  test("루트 패턴은 어떤 worktree 에서도 통과하지 못한다", () => {
    for (const pat of ["/", "/*", "/**"]) {
      assert.ok(!isWithinWorktreeScope([pat], wt), `${pat} 가 자동 승인됐다 — 파일시스템 전체가 열린다`);
    }
  });

  test("스코프 밖 요청은 outcome 에 permissionScope 를 실어 준다", async () => {
    const SID = "ses_i12_scope";
    const client = makePermissionClient({
      sessionId: SID,
      pendingPermissions: [{
        id: "per_i12", sessionID: SID,
        permission: "external_directory",
        patterns: ["/root/IdeaProjects/*"],
      }],
      replyCalls: [],
      abortCalls: [],
    });

    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      allowedWorktree: wt,
      permissionCheckIntervalPolls: 5,
    });

    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionReason, "outside_allowed_roots");
    assert.equal(
      outcome.permissionScope,
      "/root/IdeaProjects/tutorial",
      "허용 범위를 안 실어 주면 서브에이전트도 리더도 경로를 좁힐 근거가 없다",
    );
  });
});

describe("issue #12 — outside_allowed_roots 처방은 차단 경로와 허용 범위를 담는다", () => {
  const legacy = (over = {}) => pollOutcomeToLegacy({
    kind: "permission_stall",
    polls: 1, elapsedMs: 1000, stalledMs: 0,
    permissionType: "external_directory",
    permissionReason: "outside_allowed_roots",
    permissionPatterns: ["/root/IdeaProjects/*"],
    permissionScope: "/root/IdeaProjects/tutorial",
    ...over,
  });

  test("차단된 패턴과 허용 범위가 본문에 그대로 나온다", () => {
    const { text } = legacy();
    assert.match(text, /\/root\/IdeaProjects\/\*/, "무엇이 막혔는지 안 알려준다");
    assert.match(text, /\/root\/IdeaProjects\/tutorial/, "어디까지 허용인지 안 알려준다");
  });

  test("조회(glob/grep/read/list) 처방이 있다 — 종전에는 임시파일 안내뿐이었다", () => {
    const { text } = legacy();
    assert.match(text, /glob/, "read-only 조회가 막힌 경우의 처방이 없다");
  });

  test("임시 파일 처방은 그대로 남는다 (기존 회귀 유지)", () => {
    assert.match(legacy().text, /\.makdoong2-team\/<이슈키>\/tmp\//);
  });

  test("scope 미상이어도 던지지 않고 일반 문구로 떨어진다", () => {
    const { text } = legacy({ permissionScope: undefined, permissionPatterns: undefined });
    assert.ok(text.length > 0);
    assert.match(text, /패턴 미상/);
  });
});

describe("issue #12 — permission_stall 은 '승인 대기' 로 보고될 수 없다", () => {
  test("next_action 이 승인 요청 보고를 명시적으로 금지한다", () => {
    const { nextAction } = pollOutcomeToLegacy({
      kind: "permission_stall",
      polls: 1, elapsedMs: 1, stalledMs: 0,
      permissionReason: "outside_allowed_roots",
    });
    assert.equal(nextAction, PERMISSION_STALL_NEXT_ACTION);
    assert.match(nextAction, /승인/);
    assert.match(nextAction, /abort|종료/);
  });

  test("permission_stall 외의 outcome 에는 next_action 이 붙지 않는다", () => {
    for (const outcome of [
      { kind: "text", text: "ok", polls: 1, elapsedMs: 1 },
      { kind: "timeout", polls: 1, elapsedMs: 1, transientFailures: 0 },
      { kind: "session_gone", polls: 1, elapsedMs: 1 },
    ]) {
      assert.equal(pollOutcomeToLegacy(outcome).nextAction, undefined, `${outcome.kind} 에 next_action 이 붙었다`);
    }
  });

  test("team-leader 프롬프트가 '승인 대기' 오판을 하드룰로 막는다", () => {
    const md = readFileSync(resolve(HERE, "../agents/makdoong2-team-leader.md"), "utf8");
    assert.match(md, /permission_stall.*승인 대기|승인 대기.*permission_stall/s, "하드룰 섹션이 없다");
    assert.match(md, /awaiting_user_approval/, "응답 필드를 안 가리킨다");
    assert.match(md, /permission_scope/, "허용 범위 필드를 안 가리킨다");
  });
});

// ── issue #12 재발 보고 — 스코프 밖 요청은 abort 전에 세션 안에서 되돌려 준다 ──
//
// 재발 보고의 새 증거: 모델이 저장소 안 검색이 비자 조부모를 검색 루트로 **명시적으로**
// 넘겼다 (`glob {path:"/root/IdeaProjects"}`). 종전 3층 방어는 전부 세션이 죽은
// 뒤에 작동한다. opencode 의 `reject` 에 `message` 를 실으면 CorrectedError 로
// 툴 호출 하나만 실패하고 세션은 계속 돈다 — 그 경로를 폴러가 먼저 탄다.

/**
 * `correct` 를 지원하는 모킹 클라이언트. 교정 뒤에는 서브에이전트가 경로를 좁혔다고
 * 가정해 다음 라운드의 대기 요청을 `roundsAfterCorrect` 에서 꺼낸다 (없으면 idle 로
 * 완료). `correctBehavior` 가 "throw" 면 엔드포인트 부재/오류를 흉내낸다.
 */
function makeCorrectableClient({
  sessionId,
  rounds,
  replyCalls = [],
  correctCalls = [],
  abortCalls = [],
  correctBehavior = "ok",
} = {}) {
  let pollN = 0;
  let round = 0;
  let finished = false;
  return {
    session: {
      status: async () => {
        pollN++;
        return { data: { [sessionId]: { type: finished ? "idle" : "working" } } };
      },
      messages: async () => ({ data: finished ? IDLE_MSG : [] }),
      abort: async () => { abortCalls.push(Date.now()); return {}; },
    },
    permission: {
      list: async () => {
        if (pollN % 5 !== 0) return { data: [] };
        const cur = rounds[round];
        if (!cur) { finished = true; return { data: [] }; }
        return { data: cur };
      },
      reply: async ({ path: { requestID }, body: { reply } }) => {
        replyCalls.push({ requestID, reply });
        const cur = rounds[round] ?? [];
        rounds[round] = cur.filter(p => p.id !== requestID);
        if (rounds[round].length === 0) round++;
        return {};
      },
      correct: async ({ path: { requestID }, body: { message } }) => {
        correctCalls.push({ requestID, message });
        if (correctBehavior === "throw") throw new Error("permission correction rejected by server: status=404");
        // opencode 는 reject 하나에 같은 세션의 나머지 대기 요청도 연쇄 거부한다.
        round++;
        return {};
      },
    },
  };
}

describe("issue #12 재발 — 스코프 밖 요청은 피드백 거부(in-place correction)로 먼저 돌려보낸다", () => {
  const worktree = "/root/IdeaProjects/tutorial/my-project-PROJ-123";
  const SID = "ses_correct";
  const GRANDPARENT = { id: "per_gp", sessionID: SID, permission: "external_directory", patterns: ["/root/IdeaProjects"] };

  test("첫 위반은 correct 로 답하고 abort 하지 않는다 — 세션은 계속 돌아 완료된다", async () => {
    const replyCalls = [], correctCalls = [], abortCalls = [];
    const client = makeCorrectableClient({
      sessionId: SID, rounds: [[GRANDPARENT]], replyCalls, correctCalls, abortCalls,
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
    });
    assert.equal(outcome.kind, "text", `세션이 살아서 끝나야 한다: ${JSON.stringify(outcome)}`);
    assert.equal(correctCalls.length, 1);
    assert.equal(correctCalls[0].requestID, "per_gp");
    assert.equal(replyCalls.length, 0, "correct 가 됐으면 plain reject 는 보내지 않는다");
    assert.equal(abortCalls.length, 0, "교정 경로에서는 abort 하지 않는다");
    // 피드백 문구가 차단 패턴과 허용 범위를 담는다.
    assert.match(correctCalls[0].message, /\/root\/IdeaProjects/);
    assert.match(correctCalls[0].message, /\/root\/IdeaProjects\/tutorial\//);
    assert.match(correctCalls[0].message, /승인을 요청하지 말 것/);
    assert.match(correctCalls[0].message, /상위 디렉토리로 넓혀 찾지 말 것/);
  });

  test("예산(maxPermissionCorrections) 소진 뒤의 위반은 종전대로 reject + abort 하고 횟수를 싣는다", async () => {
    const replyCalls = [], correctCalls = [], abortCalls = [];
    const client = makeCorrectableClient({
      sessionId: SID,
      rounds: [[GRANDPARENT], [{ ...GRANDPARENT, id: "per_gp2" }], [{ ...GRANDPARENT, id: "per_gp3" }]],
      replyCalls, correctCalls, abortCalls,
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
      maxPermissionCorrections: 2,
    });
    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionReason, "outside_allowed_roots");
    assert.equal(outcome.permissionID, "per_gp3");
    assert.equal(outcome.permissionCorrections, 2);
    assert.equal(correctCalls.length, 2);
    assert.deepEqual(replyCalls, [{ requestID: "per_gp3", reply: "reject" }]);
    assert.equal(abortCalls.length, 1);
    // 마지막 교정 메시지는 "한도 도달" 을 경고한다.
    assert.match(correctCalls[0].message, /남은 자동 교정 1회/);
    assert.match(correctCalls[1].message, /자동 교정 한도에 도달/);
  });

  test("maxPermissionCorrections=0 은 종전 동작(첫 위반에서 abort)이다", async () => {
    const replyCalls = [], correctCalls = [], abortCalls = [];
    const client = makeCorrectableClient({
      sessionId: SID, rounds: [[GRANDPARENT]], replyCalls, correctCalls, abortCalls,
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
      maxPermissionCorrections: 0,
    });
    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionCorrections, 0);
    assert.equal(correctCalls.length, 0);
    assert.equal(abortCalls.length, 1);
  });

  test("correct 가 throw 하면(엔드포인트 부재·NotFound) reject + abort 로 폴백한다", async () => {
    const replyCalls = [], correctCalls = [], abortCalls = [];
    const client = makeCorrectableClient({
      sessionId: SID, rounds: [[GRANDPARENT]], replyCalls, correctCalls, abortCalls, correctBehavior: "throw",
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
    });
    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionCorrections, 0, "실패한 교정은 예산을 쓰지 않는다");
    assert.equal(correctCalls.length, 1);
    assert.deepEqual(replyCalls, [{ requestID: "per_gp", reply: "reject" }]);
    assert.equal(abortCalls.length, 1);
  });

  test("correct 가 없는 클라이언트(구형 소스)는 종전 동작을 유지한다", async () => {
    const replyCalls = [], abortCalls = [];
    const client = makePermissionClient({
      sessionId: SID, pendingPermissions: [GRANDPARENT], replyCalls, abortCalls,
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
    });
    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionCorrections, 0);
    assert.equal(abortCalls.length, 1);
  });

  test("non_external_permission 은 교정 대상이 아니다 — 경로 문제가 아니므로 바로 abort", async () => {
    const replyCalls = [], correctCalls = [], abortCalls = [];
    const client = makeCorrectableClient({
      sessionId: SID,
      rounds: [[{ id: "per_bash", sessionID: SID, permission: "bash", patterns: ["rm -rf /**"] }]],
      replyCalls, correctCalls, abortCalls,
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
    });
    assert.equal(outcome.kind, "permission_stall");
    assert.equal(outcome.permissionReason, "non_external_permission");
    assert.equal(correctCalls.length, 0);
    assert.equal(abortCalls.length, 1);
  });

  test("같은 폴에 허용·거부가 섞이면 허용을 먼저 전부 답한다 (연쇄 거부에 형제 요청이 딸려 죽지 않게)", async () => {
    const replyCalls = [], correctCalls = [], abortCalls = [];
    const sibling = { id: "per_sib", sessionID: SID, permission: "external_directory", patterns: ["/root/IdeaProjects/tutorial/main-repo/*"] };
    const client = makeCorrectableClient({
      sessionId: SID,
      // 거부 대상이 목록 앞에 있어도 허용이 먼저 나가야 한다.
      rounds: [[GRANDPARENT, sibling]],
      replyCalls, correctCalls, abortCalls,
    });
    const outcome = await pollSubSession(client, SID, {
      pollIntervalMs: 1, timeoutMs: 5_000, allowedWorktree: worktree, permissionCheckIntervalPolls: 5,
    });
    assert.equal(outcome.kind, "text", JSON.stringify(outcome));
    assert.deepEqual(replyCalls, [{ requestID: "per_sib", reply: "once" }]);
    assert.equal(correctCalls.length, 1);
    assert.equal(correctCalls[0].requestID, "per_gp");
    assert.equal(abortCalls.length, 0);
  });

  test("legacy 처방은 교정 횟수를 보고한다 — 첫 차단과 '안내를 받고도 반복' 을 리더가 구분한다", () => {
    const withCorrections = pollOutcomeToLegacy({
      kind: "permission_stall", polls: 1, elapsedMs: 1, stalledMs: 0,
      permissionReason: "outside_allowed_roots", permissionPatterns: ["/root/IdeaProjects"],
      permissionScope: "/root/IdeaProjects/tutorial", permissionCorrections: 3,
    });
    assert.match(withCorrections.text, /3회 경로 교정 안내/);
    const without = pollOutcomeToLegacy({
      kind: "permission_stall", polls: 1, elapsedMs: 1, stalledMs: 0,
      permissionReason: "outside_allowed_roots", permissionPatterns: ["/root/IdeaProjects"],
      permissionScope: "/root/IdeaProjects/tutorial",
    });
    assert.doesNotMatch(without.text, /경로 교정 안내/);
  });
});

describe("issue #12 재발 — 세 층의 문구는 같은 규칙을 말한다", () => {
  const worktree = "/root/IdeaProjects/tutorial/my-project-PROJ-123";

  test("buildPermissionCorrectionMessage — 패턴·범위·조치·예산을 한 문구에 담는다", () => {
    const msg = buildPermissionCorrectionMessage({
      patterns: ["/root/IdeaProjects"], worktree, scope: worktreeAllowedScope(worktree), remaining: 2,
    });
    assert.match(msg, /\["\/root\/IdeaProjects"\]/);
    assert.match(msg, /\/root\/IdeaProjects\/tutorial\/ 이하/);
    assert.match(msg, /조부모 이상.*열리지 않는다/);
    assert.match(msg, /경로 인자를 아예 주지 않고/);
    assert.match(msg, /\.makdoong2-team\/<이슈키>\/tmp\//);
    assert.match(msg, /남은 자동 교정 2회/);
    assert.match(buildPermissionCorrectionMessage({ patterns: [], remaining: 0 }), /한도에 도달/);
    assert.match(buildPermissionCorrectionMessage({ patterns: [], remaining: 0 }), /\(패턴 미상\)/);
  });

  test("buildPathScopePromptBlock — 선제 안내가 검색 루트 확장을 명시적으로 금지한다", () => {
    const lines = buildPathScopePromptBlock(worktree, 3);
    const block = lines.join("\n");
    assert.match(block, /=== 경로 범위 \(hardrule\) ===/);
    assert.match(block, /\/root\/IdeaProjects\/tutorial\/ 이하/);
    assert.match(block, /상위 디렉토리로 넓혀 찾지 말 것/);
    assert.match(block, /배포 설정/, "재발 사례(배포 설정 탐색)를 예시로 든다");
    assert.match(block, /세션당 3회/);
    assert.match(block, /with the following feedback/, "모델이 보게 될 오류 문구를 미리 알려준다");
    const zero = buildPathScopePromptBlock(worktree, 0).join("\n");
    assert.match(zero, /즉시 종료/);
    assert.doesNotMatch(zero, /세션당/);
  });

  test("dispatch_stage 는 모든 프롬프트에 경로 범위 블록을 싣는다", () => {
    assert.match(PLUGIN_SRC, /\.\.\.buildPathScopePromptBlock\(effectiveWorktree, permissionCorrectionsPerSession\)/);
    // dev 전용 분기 **앞**(base 배열 안)에 있어야 모든 substage 에 실린다.
    const idx = PLUGIN_SRC.indexOf("...buildPathScopePromptBlock(effectiveWorktree");
    const devIdx = PLUGIN_SRC.indexOf('if (args.target_stage === "2_implementation.dev") {', idx - 4000);
    assert.ok(idx > 0 && devIdx > idx, "경로 범위 블록이 dev 전용 분기보다 앞에 있어야 한다");
  });

  test("permissionSourceFor.correct 는 디렉토리 스코프 라우트를 worktree 로 명시해 부른다", () => {
    const start = PLUGIN_SRC.indexOf("const permissionSourceFor = ");
    const block = PLUGIN_SRC.slice(start, PLUGIN_SRC.indexOf("const pollSubSession = (", start));
    assert.match(block, /correct: async/);
    assert.match(block, /url: "\/permission\/\{requestID\}\/reply"/);
    assert.match(block, /registry\.sessionWorktree\.get\(sessionId\)/, "worktree 를 query.directory 로 넘겨야 한다");
    assert.match(block, /query: directory \? \{ directory \} : undefined/);
    assert.match(block, /body: \{ reply: "reject", message: req\.body\.message \}/);
    assert.match(block, /if \(res\?\.error !== undefined\) \{\s*throw/, "서버 오류는 throw 해서 폴러가 폴백하게 한다");
    // 연쇄 거부로 사라진 요청에 다음 폴이 다시 답하지 않도록 레지스트리를 비운다.
    assert.equal((block.match(/permissionsRejectedCascade\(registry, sessionId\)/g) ?? []).length, 2,
      "reply(reject) 와 correct 양쪽에서 cascade 정리를 해야 한다");
  });

  test("dispatch_stage 응답과 hang_history 가 교정 횟수를 싣는다", () => {
    assert.match(PLUGIN_SRC, /permission_corrections: outcome\.permissionCorrections \?\? 0/);
    assert.match(PLUGIN_SRC, /corrections: outcome\.permissionCorrections \?\? 0,\s*elapsed_ms: outcome\.elapsedMs/);
  });

  test("서브에이전트 프롬프트가 검색 루트 확장을 금지한다", () => {
    for (const agent of ["makdoong2-engineer", "makdoong2-planner", "makdoong2-analyzer", "makdoong2-publisher"]) {
      const md = readFileSync(resolve(HERE, `../agents/${agent}.md`), "utf8");
      assert.match(md, /상위 디렉토리로 넓혀/, `${agent}.md 에 검색 루트 확장 금지 문구가 없다`);
    }
    const leader = readFileSync(resolve(HERE, "../agents/makdoong2-team-leader.md"), "utf8");
    assert.match(leader, /permission_corrections/, "team-leader 하드룰이 permission_corrections 필드를 안 가리킨다");
  });
});
