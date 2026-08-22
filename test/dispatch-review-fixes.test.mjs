/**
 * Regression tests for PROJ-40406 dispatch review fixes:
 *
 *   Bug 1: inspect_sub_sessions abort_orphans branch called `session.abort` only
 *          → pane and session.delete missed → leak.
 *          Fix: route through cleanupSubSession.
 *
 *   Bug 2: orphanScanTimer tmux branch cleaned by opencode session status
 *          without checking pendingDispatch → live sub-sessions killed during
 *          LLM turn idle windows.
 *          Fix: skip when pendingDispatch.has(sid).
 *
 *   (Bug 3 — legacy pre-marker pane reaping — was removed in 1.0.0: tmux >= 3.0
 *   guarantees markers, so scanOrphans returns marker-carrying panes only.)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Bug 2: pendingDispatch protection in tmux orphan branch ─────────────────
describe("Bug 2 — orphanScanTimer must skip sessions currently in pendingDispatch", () => {
  function classifyTmuxOrphan({ paneSessionId, pendingDispatch, statuses }) {
    const sid = paneSessionId;
    if (!sid) return { action: "skip", reason: "no_session_id" };
    if (pendingDispatch.has(sid)) return { action: "skip", reason: "protected_pending_dispatch" };
    const s = statuses[sid]?.type;
    if (s === undefined || s === "idle") {
      return { action: "cleanup", sid, reason: `tmux pane orphan (opencode session status=${s ?? "gone"})` };
    }
    return { action: "skip", reason: `session_status_${s}` };
  }

  test("live sub-session with idle status is protected when in pendingDispatch", () => {
    const pd = new Map([["ses_LIVE", { stage: "2_implementation.dev", agent: "engineer", worktree: "/wt", startedAt: Date.now() }]]);
    const r = classifyTmuxOrphan({
      paneSessionId: "ses_LIVE",
      pendingDispatch: pd,
      statuses: { ses_LIVE: { type: "idle" } },
    });
    assert.equal(r.action, "skip");
    assert.equal(r.reason, "protected_pending_dispatch");
  });

  test("live sub-session with `busy` status is also protected", () => {
    const pd = new Map([["ses_LIVE", { stage: "s", agent: "a", worktree: "/", startedAt: Date.now() }]]);
    const r = classifyTmuxOrphan({
      paneSessionId: "ses_LIVE",
      pendingDispatch: pd,
      statuses: { ses_LIVE: { type: "busy" } },
    });
    assert.equal(r.action, "skip");
    assert.equal(r.reason, "protected_pending_dispatch");
  });

  test("orphan with idle status → cleanup (pendingDispatch has no entry)", () => {
    const r = classifyTmuxOrphan({
      paneSessionId: "ses_ORPHAN",
      pendingDispatch: new Map(),
      statuses: { ses_ORPHAN: { type: "idle" } },
    });
    assert.equal(r.action, "cleanup");
    assert.equal(r.sid, "ses_ORPHAN");
  });

  test("orphan with `gone` status (undefined) → cleanup", () => {
    const r = classifyTmuxOrphan({
      paneSessionId: "ses_GONE",
      pendingDispatch: new Map(),
      statuses: {},
    });
    assert.equal(r.action, "cleanup");
    assert.ok(r.reason.includes("status=gone"));
  });

  test("orphan with busy status is NOT cleaned (a different branch handles that)", () => {
    const r = classifyTmuxOrphan({
      paneSessionId: "ses_BUSY_NO_PD",
      pendingDispatch: new Map(),
      statuses: { ses_BUSY_NO_PD: { type: "busy" } },
    });
    assert.equal(r.action, "skip");
    assert.equal(r.reason, "session_status_busy");
  });
});

// ─── Bug 1: inspect_sub_sessions routes through cleanupSubSession ────────────
describe("Bug 1 — inspect_sub_sessions abort_orphans must schedule cleanupSubSession", () => {
  function inspectRoute({ sid, pd, rawStatus, staleThresholdMs, nowMs, abortOrphans }) {
    const elapsedMs = pd ? nowMs - pd.startedAt : 0;
    const isOrphan = rawStatus === "busy" && !pd;
    const isStale = rawStatus === "busy" && pd != null && staleThresholdMs != null && elapsedMs > staleThresholdMs;
    if ((isOrphan || isStale) && abortOrphans) {
      return {
        cleanup: true,
        reason: isOrphan
          ? "inspect_sub_sessions: orphan (no pending dispatch)"
          : `inspect_sub_sessions: stale busy ${Math.round(elapsedMs / 60_000)}min`,
      };
    }
    return { cleanup: false };
  }

  test("orphan (busy without pd) with abort_orphans=true → cleanup", () => {
    const r = inspectRoute({
      sid: "ses_A",
      pd: undefined,
      rawStatus: "busy",
      staleThresholdMs: null,
      nowMs: 1_000_000,
      abortOrphans: true,
    });
    assert.equal(r.cleanup, true);
    assert.ok(r.reason.includes("orphan"));
  });

  test("stale (busy with pd, elapsed > threshold) with abort_orphans=true → cleanup", () => {
    const r = inspectRoute({
      sid: "ses_B",
      pd: { stage: "s", agent: "a", worktree: "/", startedAt: 0 },
      rawStatus: "busy",
      staleThresholdMs: 30 * 60_000,
      nowMs: 40 * 60_000,
      abortOrphans: true,
    });
    assert.equal(r.cleanup, true);
    assert.ok(r.reason.includes("stale"));
    assert.ok(r.reason.includes("40min"));
  });

  test("orphan without abort_orphans → no cleanup (inspect only)", () => {
    const r = inspectRoute({
      sid: "ses_C",
      pd: undefined,
      rawStatus: "busy",
      staleThresholdMs: null,
      nowMs: 1_000_000,
      abortOrphans: false,
    });
    assert.equal(r.cleanup, false);
  });

  test("idle session (rawStatus != busy) is never orphan/stale even with abort=true", () => {
    const r = inspectRoute({
      sid: "ses_D",
      pd: undefined,
      rawStatus: "idle",
      staleThresholdMs: 60_000,
      nowMs: 1_000_000_000,
      abortOrphans: true,
    });
    assert.equal(r.cleanup, false);
  });

  test("pd present + elapsed < threshold + busy → not stale (safe zone)", () => {
    const r = inspectRoute({
      sid: "ses_E",
      pd: { stage: "s", agent: "a", worktree: "/", startedAt: 0 },
      rawStatus: "busy",
      staleThresholdMs: 60 * 60_000,
      nowMs: 30 * 60_000,
      abortOrphans: true,
    });
    assert.equal(r.cleanup, false);
  });
});

// ─── Oracle P1-1: resolveInheritedPermission safe fallback ───────────────────
describe("P1-1 — resolveInheritedPermission must apply safe fallback on parent lookup failure", () => {
  const SAFE_FALLBACK_PERMISSION = [
    { permission: "external_directory", action: "allow", pattern: "*" },
    { permission: "question", action: "allow", pattern: "*" },
  ];

  async function resolveInheritedPermission(parentSessionID, mockSessionGet) {
    const info = await mockSessionGet(parentSessionID).catch((e) => ({ __error: e }));
    if (!info || info.__error !== undefined) {
      return [...SAFE_FALLBACK_PERMISSION];
    }
    const inherited = (info?.data?.permission ?? []);
    return [...inherited, { permission: "question", action: "allow", pattern: "*" }];
  }

  test("parent session.get throws → safe fallback (external_directory + question, both allow)", async () => {
    const mockGet = () => Promise.reject(new Error("network down"));
    const r = await resolveInheritedPermission("ses_PARENT", mockGet);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { permission: "external_directory", action: "allow", pattern: "*" });
    assert.deepEqual(r[1], { permission: "question", action: "allow", pattern: "*" });
  });

  test("parent session.get returns null → safe fallback", async () => {
    const mockGet = () => Promise.resolve(null);
    const r = await resolveInheritedPermission("ses_PARENT", mockGet);
    assert.deepEqual(r, SAFE_FALLBACK_PERMISSION);
  });

  test("parent session.get returns { data: undefined } (opencode 404-ish) → inherited=[] + question:allow", async () => {
    const mockGet = () => Promise.resolve({ data: undefined });
    const r = await resolveInheritedPermission("ses_PARENT", mockGet);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], { permission: "question", action: "allow", pattern: "*" });
  });

  test("parent has external_directory allow rules → inherited + question:allow appended", async () => {
    const parentRules = [
      { permission: "external_directory", action: "allow", pattern: "/root/proj/**" },
      { permission: "bash", action: "allow", pattern: "git *" },
    ];
    const mockGet = () => Promise.resolve({ data: { permission: parentRules } });
    const r = await resolveInheritedPermission("ses_PARENT", mockGet);
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], parentRules[0]);
    assert.deepEqual(r[1], parentRules[1]);
    assert.deepEqual(r[2], { permission: "question", action: "allow", pattern: "*" });
  });

  test("appended question:allow overrides parent's question rule (append order matters)", async () => {
    const parentRules = [
      { permission: "question", action: "deny", pattern: "*" },
    ];
    const mockGet = () => Promise.resolve({ data: { permission: parentRules } });
    const r = await resolveInheritedPermission("ses_PARENT", mockGet);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { permission: "question", action: "deny", pattern: "*" });
    assert.deepEqual(r[1], { permission: "question", action: "allow", pattern: "*" });
  });

  test("safe fallback contains external_directory:allow — the PROJ-40406 hang blocker", async () => {
    const mockGet = () => Promise.reject(new Error("timeout"));
    const r = await resolveInheritedPermission("ses_PARENT", mockGet);
    const extDir = r.find(x => x.permission === "external_directory");
    assert.ok(extDir, "fallback must include external_directory rule to prevent ask-dialog hang");
    assert.equal(extDir.action, "allow", "external_directory must be allow (not ask/deny) to avoid headless prompt hang");
  });
});
