import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TmuxMonitor,
  MARKER_SESSION,
  MARKER_PID,
  MARKER_STAGE,
  MARKER_STARTED,
  PARENT_MARKER_PATTERN,
  ORPHAN_SPAWN_GRACE_MS,
  isPidAlive,
  orphanCleanupGuard,
} from "../dist/tmux-monitor.js";

function makePane({ paneId, session = "", stage = "", pid = "", started = "", cmd = "" }) {
  return { paneId, session, stage, pid, started, cmd };
}

function makeShell({ splitPaneId = "%99", widthCols = 400, panes = [], tmuxVersion = "tmux 3.3a" } = {}) {
  const calls = [];
  function tag(strings, ...values) {
    const cmd = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
    const runner = {
      cwd() { return runner; },
      quiet() { return runner; },
      nothrow() { return runner; },
      then(resolve) {
        calls.push(cmd);
        const t = cmd.trim();
        if (t === "tmux -V") {
          return Promise.resolve({
            exitCode: 0,
            stdout: { toString: () => tmuxVersion },
            stderr: { toString: () => "" },
          }).then(resolve);
        }
        if (t.startsWith("tmux split-window")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: { toString: () => splitPaneId + "\n" },
            stderr: { toString: () => "" },
          }).then(resolve);
        }
        if (t.startsWith("tmux display-message") && cmd.includes("#{window_width}")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: { toString: () => String(widthCols) },
            stderr: { toString: () => "" },
          }).then(resolve);
        }
        if (t.startsWith("tmux list-panes")) {
          const lines = panes.map(p =>
            [p.paneId, p.session, p.stage, p.pid, p.started, p.cmd].join("\t")
          ).join("\n");
          return Promise.resolve({
            exitCode: 0,
            stdout: { toString: () => lines },
            stderr: { toString: () => "" },
          }).then(resolve);
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: { toString: () => "" },
          stderr: { toString: () => "" },
        }).then(resolve);
      },
    };
    return runner;
  }
  return { tag, calls };
}

function config(overrides = {}) {
  return {
    enabled: true,
    layout: "main-vertical",
    mainPaneSize: 60,
    agentPaneMinWidth: 52,
    splitDirection: "-h",
    attachCommand: "opencode attach",
    serverUrl: "http://127.0.0.1:9999",
    keepPaneOnSuccess: false,
    autoCloseOnFailure: false,
    paneCloseDelaySeconds: 0,
    ...overrides,
  };
}

function stubActive(monitor) {
  Object.defineProperty(monitor, "active", { value: true, configurable: true });
}

describe("regex patterns — parent/legacy discrimination", () => {
  test("PARENT_MARKER_PATTERN matches `--port` variants", () => {
    assert.ok(PARENT_MARKER_PATTERN.test('opencode "$@" --port'));
    assert.ok(PARENT_MARKER_PATTERN.test("opencode --port"));
    assert.ok(PARENT_MARKER_PATTERN.test("opencode --port 8080"));
  });

  test("PARENT_MARKER_PATTERN does NOT match attach commands", () => {
    assert.ok(!PARENT_MARKER_PATTERN.test("sh -c opencode attach http://127.0.0.1:44891 --session ses_abc"));
    assert.ok(!PARENT_MARKER_PATTERN.test("opencode attach ses_abc"));
  });

});

describe("checkTmuxVersion — >= 3.0 gate (set-option -p requires tmux 3.0+)", () => {
  test("tmux 3.3a passes", async () => {
    const { tag } = makeShell({ tmuxVersion: "tmux 3.3a" });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const r = await m.checkTmuxVersion();
    assert.equal(r.ok, true);
    assert.equal(r.version, "3.3");
  });

  test("tmux 3.0 passes (minimum supported)", async () => {
    const { tag } = makeShell({ tmuxVersion: "tmux 3.0" });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const r = await m.checkTmuxVersion();
    assert.equal(r.ok, true);
  });

  test("tmux 2.9 throws (no set-option -p support)", async () => {
    const { tag } = makeShell({ tmuxVersion: "tmux 2.9" });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    await assert.rejects(
      () => m.checkTmuxVersion(),
      /tmux 2\.9 is not supported/,
    );
  });

  test("tmux 2.4 throws (pane user options existed but no -p flag)", async () => {
    const { tag } = makeShell({ tmuxVersion: "tmux 2.4" });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    await assert.rejects(
      () => m.checkTmuxVersion(),
      /tmux 2\.4 is not supported/,
    );
  });

  test("tmux 2.3 throws", async () => {
    const { tag } = makeShell({ tmuxVersion: "tmux 2.3" });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    await assert.rejects(
      () => m.checkTmuxVersion(),
      /tmux 2\.3 is not supported/,
    );
  });

  test("tmux 4.0 passes (future major)", async () => {
    const { tag } = makeShell({ tmuxVersion: "tmux 4.0" });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const r = await m.checkTmuxVersion();
    assert.equal(r.ok, true);
  });

  test("result is cached — second call skips `tmux -V`", async () => {
    const rec = makeShell({ tmuxVersion: "tmux 3.3a" });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    await m.checkTmuxVersion();
    await m.checkTmuxVersion();
    const versionCalls = rec.calls.filter(c => c.trim() === "tmux -V").length;
    assert.equal(versionCalls, 1, "second call must hit cache");
  });
});

describe("spawnPane — marker attribution", () => {
  test("writes 4 markers via set-option -p after successful split", async () => {
    const rec = makeShell({ splitPaneId: "%42" });
    const m = new TmuxMonitor(rec.tag, config(), 12345);
    stubActive(m);

    const p = await m.spawnPane("ses_ABC", "2_implementation.dev", "engineer", "/wt");
    assert.equal(p, "%42");

    const setOpts = rec.calls.filter(c => c.includes("set-option -p"));
    assert.equal(setOpts.length, 4, `expected 4 set-option calls, got ${setOpts.length}: ${JSON.stringify(setOpts)}`);
    assert.ok(setOpts.some(c => c.includes(MARKER_SESSION) && c.includes("ses_ABC")));
    assert.ok(setOpts.some(c => c.includes(MARKER_PID) && c.includes("12345")));
    assert.ok(setOpts.some(c => c.includes(MARKER_STAGE) && c.includes("2_implementation.dev")));
    assert.ok(setOpts.some(c => c.includes(MARKER_STARTED)));
  });

  test("markers are scoped to the created paneId", async () => {
    const rec = makeShell({ splitPaneId: "%7" });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    await m.spawnPane("ses_X", "stage", "agent", "/wt");
    const setOpts = rec.calls.filter(c => c.includes("set-option -p"));
    for (const c of setOpts) {
      assert.ok(c.includes("-t %7"), `set-option must target paneId, got: ${c}`);
    }
  });

  test("tmux < 3.0: pane created without markers, monitor self-deactivates", async () => {
    const rec = makeShell({ splitPaneId: "%42", tmuxVersion: "tmux 2.9" });
    const m = new TmuxMonitor(rec.tag, config(), 12345);
    stubActive(m);
    const p = await m.spawnPane("ses_ABC", "2_implementation.dev", "engineer", "/wt");
    assert.equal(p, "%42", "in-flight pane creation must still complete");
    const setOpts = rec.calls.filter(c => c.includes("set-option -p"));
    assert.equal(
      setOpts.length,
      0,
      `set-option -p must NOT run on tmux < 3.0, got: ${JSON.stringify(setOpts)}`,
    );
    await assert.rejects(
      () => m.checkTmuxVersion(),
      /tmux 2\.9 is not supported/,
      "version barrier keeps throwing for direct callers",
    );
  });
});

describe("scanOrphans — tmux truth source", () => {
  test("parses marked panes correctly", async () => {
    const { tag } = makeShell({
      panes: [
        makePane({
          paneId: "%1",
          session: "ses_A",
          stage: "commit",
          pid: "9999",
          started: "1700000000",
          cmd: "sh -c opencode attach --session ses_A",
        }),
      ],
    });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const results = await m.scanOrphans();
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "ses_A");
    assert.equal(results[0].stage, "commit");
    assert.equal(results[0].ownerPid, 9999);
    assert.equal(results[0].startedAt, 1700000000);
  });

  test("skips parent panes (--port) even when marker present", async () => {
    const { tag } = makeShell({
      panes: [
        makePane({
          paneId: "%0",
          session: "ses_PARENT",
          pid: "111",
          started: "1700000000",
          cmd: 'opencode "$@" --port',
        }),
        makePane({
          paneId: "%2",
          session: "ses_CHILD",
          pid: "222",
          started: "1700000010",
          cmd: "sh -c opencode attach --session ses_CHILD",
        }),
      ],
    });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const results = await m.scanOrphans();
    assert.equal(results.length, 1, "parent must be filtered out");
    assert.equal(results[0].sessionId, "ses_CHILD");
  });

  test("marker-less attach panes are NOT returned (marker is the only ownership signal)", async () => {
    const { tag } = makeShell({
      panes: [
        makePane({
          paneId: "%5",
          cmd: "sh -c opencode attach http://127.0.0.1:44891 --session ses_MANUAL",
        }),
      ],
    });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const results = await m.scanOrphans();
    assert.equal(results.length, 0, "user-initiated attach panes without markers must be ignored");
  });

  test("ignores panes without markers", async () => {
    const { tag } = makeShell({
      panes: [
        makePane({ paneId: "%10", cmd: "vim" }),
        makePane({ paneId: "%11", cmd: "bash" }),
      ],
    });
    const m = new TmuxMonitor(tag, config());
    stubActive(m);
    const results = await m.scanOrphans();
    assert.equal(results.length, 0);
  });
});

describe("cleanupOrphans — full sweep with safety guards", () => {
  test("kills marked orphans, ignores marker-less attach panes", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%1", session: "ses_A", pid: "999", started: "1", cmd: "sh -c opencode attach --session ses_A" }),
        makePane({ paneId: "%5", cmd: "sh -c opencode attach --session ses_MANUAL" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    const report = await m.cleanupOrphans();
    assert.equal(report.orphans_closed, 1);
    assert.equal(report.total_closed, 1);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%1"));
  });

  test("grace_seconds skips fresh panes", async () => {
    const nowSec = 1_700_000_100;
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%1", session: "ses_OLD", pid: "999", started: String(nowSec - 100), cmd: "sh -c opencode attach --session ses_OLD" }),
        makePane({ paneId: "%2", session: "ses_FRESH", pid: "999", started: String(nowSec - 2), cmd: "sh -c opencode attach --session ses_FRESH" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    const report = await m.cleanupOrphans({ graceSeconds: 5, now: () => nowSec });
    assert.equal(report.orphans_closed, 1);
    assert.equal(report.fresh_skipped, 1);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%1"));
  });

  test("returns zero counts when inactive", async () => {
    const rec = makeShell();
    const m = new TmuxMonitor(rec.tag, config({ enabled: false }));
    const report = await m.cleanupOrphans();
    assert.equal(report.total_closed, 0);
    assert.equal(report.orphans_closed, 0);
    assert.equal(rec.calls.length, 0);
  });
});

describe("reapDeadOwnerPanes — plugin re-init cleanup", () => {
  test("kills panes whose owner pid is dead", async () => {
    const deadPid = 999_999_999;
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%1", session: "ses_DEAD", pid: String(deadPid), started: "1", cmd: "sh -c opencode attach --session ses_DEAD" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config(), 100000);
    stubActive(m);
    const killed = await m.reapDeadOwnerPanes();
    assert.equal(killed, 1);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%1"));
  });

  test("preserves panes owned by the current process", async () => {
    const myPid = process.pid;
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%1", session: "ses_MINE", pid: String(myPid), started: "1", cmd: "sh -c opencode attach --session ses_MINE" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config(), myPid);
    stubActive(m);
    const killed = await m.reapDeadOwnerPanes();
    assert.equal(killed, 0);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0);
  });

  test("preserves panes owned by other LIVE plugin instances", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%1", session: "ses_OTHER", pid: String(process.pid), started: "1", cmd: "sh -c opencode attach --session ses_OTHER" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config(), 42);
    stubActive(m);
    const killed = await m.reapDeadOwnerPanes();
    assert.equal(killed, 0, "live foreign pid must be preserved");
  });

  test("skips legacy (unmarked) panes — only reap marked orphans", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%5", cmd: "sh -c opencode attach --session ses_LEGACY" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config(), 42);
    stubActive(m);
    const killed = await m.reapDeadOwnerPanes();
    assert.equal(killed, 0);
  });

  test("graceSeconds skips dead-owner panes that were started very recently", async () => {
    const deadPid = 999_999_999;
    const nowSec = 1_700_000_100;
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%1", session: "ses_OLD", pid: String(deadPid), started: String(nowSec - 100), cmd: "sh -c opencode attach --session ses_OLD" }),
        makePane({ paneId: "%2", session: "ses_FRESH", pid: String(deadPid), started: String(nowSec - 2), cmd: "sh -c opencode attach --session ses_FRESH" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config(), 42);
    stubActive(m);
    const killed = await m.reapDeadOwnerPanes({ graceSeconds: 5, now: () => nowSec * 1000 });
    assert.equal(killed, 1, "only the aged pane is reaped; fresh pane inside grace window is preserved");
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%1"), "aged pane %1 must be reaped, fresh %2 must survive");
  });

  test("graceSeconds=0 disables grace window (default previous behavior)", async () => {
    const deadPid = 999_999_999;
    const nowSec = 1_700_000_100;
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%2", session: "ses_FRESH", pid: String(deadPid), started: String(nowSec - 1), cmd: "sh -c opencode attach --session ses_FRESH" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config(), 42);
    stubActive(m);
    const killed = await m.reapDeadOwnerPanes({ graceSeconds: 0, now: () => nowSec * 1000 });
    assert.equal(killed, 1);
  });
});

describe("closePane — fallback via marker scan", () => {
  test("in-memory miss triggers marker-based lookup", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%77", session: "ses_LOST", pid: "1", started: "1", cmd: "sh -c opencode attach --session ses_LOST" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    await m.closePane("ses_LOST", { success: true });
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%77"), `expected fallback kill on %77, got: ${kills}`);
  });

  test("marker lookup miss is a no-op", async () => {
    const rec = makeShell({ panes: [] });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    await m.closePane("ses_NOWHERE", { success: true });
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0);
  });

  test("failure with autoCloseOnFailure=false skips fallback kill", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%77", session: "ses_LOST", pid: "1", started: "1", cmd: "sh -c opencode attach --session ses_LOST" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config({ autoCloseOnFailure: false }));
    stubActive(m);
    await m.closePane("ses_LOST", { success: false });
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0, "failed panes must be kept for diagnosis when autoCloseOnFailure=false");
  });
});

describe("closePane — marker-based recovery (untracked pane)", () => {
  test("marker-less attach pane is NOT reachable (marker is the only lookup key)", async () => {
    const rec = makeShell({
      panes: [
        makePane({
          paneId: "%88",
          session: "",
          pid: "",
          started: "",
          cmd: "sh -c opencode attach http://127.0.0.1:44707 --session ses_TARGET --dir /wt",
        }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config({ autoCloseOnFailure: true }));
    stubActive(m);
    await m.closePane("ses_TARGET", { success: false });
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0, "marker-less panes are user-owned and must not be killed");
  });

  test("marker-matched pane is killed even when in-memory tracking is empty", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%markered", session: "ses_TARGET", pid: "1", started: "1", cmd: "irrelevant" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config({ autoCloseOnFailure: true }));
    stubActive(m);
    await m.closePane("ses_TARGET", { success: false });
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%markered"));
  });
});

describe("forceKillBySessionId — marker-less recovery entry point", () => {
  test("kills pane found via marker", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%f1", session: "ses_KILL", pid: "1", started: "1", cmd: "sh" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    const killed = await m.forceKillBySessionId("ses_KILL");
    assert.equal(killed, true);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 1);
    assert.ok(kills[0].includes("%f1"));
  });

  test("marker-less attach pane is not force-killed (no start_command fallback)", async () => {
    const rec = makeShell({
      panes: [
        makePane({
          paneId: "%f2",
          cmd: "sh -c opencode attach http://127.0.0.1:44707 --session ses_FALLBACK --dir /wt",
        }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    const killed = await m.forceKillBySessionId("ses_FALLBACK");
    assert.equal(killed, false);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0);
  });

  test("returns false and kills nothing when no matching pane", async () => {
    const rec = makeShell({
      panes: [
        makePane({ paneId: "%unrelated", cmd: "sh -c opencode attach --session ses_OTHER" }),
      ],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    const killed = await m.forceKillBySessionId("ses_MISSING");
    assert.equal(killed, false);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0);
  });

  test("no-op when monitor is inactive", async () => {
    const rec = makeShell({
      panes: [makePane({ paneId: "%live", session: "ses_KILL" })],
    });
    const m = new TmuxMonitor(rec.tag, { ...config(), enabled: false });
    const killed = await m.forceKillBySessionId("ses_KILL");
    assert.equal(killed, false);
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0);
  });

  test("ownerProcessId exposes the owning pid for the plugin orphan-scan tick", () => {
    const rec = makeShell();
    assert.equal(new TmuxMonitor(rec.tag, config(), 4242).ownerProcessId, 4242);
    assert.equal(new TmuxMonitor(rec.tag, config()).ownerProcessId, process.pid);
  });

  test("rejects malformed session id to prevent accidental kills", async () => {
    const rec = makeShell({
      panes: [makePane({ paneId: "%any", session: "ses_KILL" })],
    });
    const m = new TmuxMonitor(rec.tag, config());
    stubActive(m);
    for (const bad of ["", "not-a-session", "--port"]) {
      const killed = await m.forceKillBySessionId(bad);
      assert.equal(killed, false, `bad id ${JSON.stringify(bad)} must be rejected`);
    }
    const kills = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(kills.length, 0);
  });
});

describe("orphanCleanupGuard — orphan-scan tick must not kill live sub-sessions", () => {
  const OWNER_PID = 1000;
  const NOW_MS = 1_700_000_000_000;
  const nowSec = NOW_MS / 1000;
  const agedSec = nowSec - ORPHAN_SPAWN_GRACE_MS / 1000 - 60;

  // 실측 회귀 기준: worktree 서브세션은 session.status() 에 영원히 뜨지 않으므로
  // 가드가 없으면 아래 pane 들이 전부 60초 격자에서 kill 된다 (PROJ-40406 관측).
  const ctx = (over = {}) => ({
    nowMs: NOW_MS,
    ownerPid: OWNER_PID,
    isPidAlive: () => false,
    ...over,
  });

  test("foreign-live-owner: pane owned by another LIVE opencode process is skipped", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: 2000, startedAt: agedSec },
      ctx({ isPidAlive: pid => pid === 2000 }),
    );
    assert.equal(guard, "foreign-live-owner");
  });

  test("foreign DEAD owner is not guarded — cross-instance reaping still works", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: 2000, startedAt: agedSec },
      ctx({ isPidAlive: () => false }),
    );
    assert.equal(guard, undefined);
  });

  test("our own pid is never treated as a foreign owner", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: agedSec },
      ctx({ isPidAlive: () => true }),
    );
    assert.equal(guard, undefined, "own live pid must fall through to the later guards");
  });

  test("spawn-grace: pane created 42s ago is skipped (observed kill window)", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: nowSec - 42 },
      ctx(),
    );
    assert.equal(guard, "spawn-grace");
  });

  test("spawn-grace expires at the boundary", () => {
    const insideSec = nowSec - ORPHAN_SPAWN_GRACE_MS / 1000 + 1;
    const outsideSec = nowSec - ORPHAN_SPAWN_GRACE_MS / 1000;
    assert.equal(orphanCleanupGuard({ ownerPid: OWNER_PID, startedAt: insideSec }, ctx()), "spawn-grace");
    assert.equal(orphanCleanupGuard({ ownerPid: OWNER_PID, startedAt: outsideSec }, ctx()), undefined);
  });

  test("tool-activity: recent tool.execute keeps an aged pane alive", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: agedSec },
      ctx({ lastToolExecuteAtMs: NOW_MS - 10_000, toolAliveWindowMs: 300_000 }),
    );
    assert.equal(guard, "tool-activity");
  });

  test("tool-activity: in-flight tool call keeps an aged pane alive even with a stale timestamp", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: agedSec },
      ctx({ activeToolCount: 1, lastToolExecuteAtMs: NOW_MS - 999_999, toolAliveWindowMs: 300_000 }),
    );
    assert.equal(guard, "tool-activity");
  });

  test("tool activity older than the window does not guard", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: agedSec },
      ctx({ activeToolCount: 0, lastToolExecuteAtMs: NOW_MS - 300_001, toolAliveWindowMs: 300_000 }),
    );
    assert.equal(guard, undefined);
  });

  test("genuinely dead pane passes every guard and stays killable", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: agedSec },
      ctx({ activeToolCount: 0 }),
    );
    assert.equal(guard, undefined, "regression: real orphan cleanup must not be disabled");
  });

  test("marker-less pane (no ownerPid/startedAt) falls through to status judgement", () => {
    assert.equal(orphanCleanupGuard({}, ctx()), undefined);
  });

  test("spawnGraceMs=0 disables the spawn window", () => {
    const guard = orphanCleanupGuard(
      { ownerPid: OWNER_PID, startedAt: nowSec - 1 },
      ctx({ spawnGraceMs: 0 }),
    );
    assert.equal(guard, undefined);
  });

  test("isPidAlive: current process is alive, absurd pid is not", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999_999), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(Number.NaN), false);
  });
});
