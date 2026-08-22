import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pollSubSession, isWithinWorktreeScope, isMatchedByConfiguredRules } from "../dist/poll-sub-session.js";

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
