import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TmuxMonitor, readTmuxConfig, isInsideTmux, buildWindowName, buildPlaceholderCommand } from "../dist/tmux-monitor.js";

function makeShellRecorder({ splitWindowExitCode = 0, splitPaneId = "%1", widthCols = 400, heightRows = 100, panesTable = null, focusedPaneIds = null } = {}) {
  const calls = [];
  function tag(strings, ...values) {
    const cmd = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
    const runner = {
      cwd() { return runner; },
      quiet() { return runner; },
      nothrow() { return runner; },
      then(resolve) {
        calls.push(cmd);
        const trimmed = cmd.trim();
        if (trimmed === "tmux -V") {
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => "tmux 3.6\n" }, stderr: { toString: () => "" } }).then(resolve);
        }
        if (trimmed.startsWith("tmux list-panes") && cmd.includes("#{pane_active}")) {
          const table = panesTable
            ?? (focusedPaneIds ?? []).map(id => `${id}\t1\t1`).join("\n");
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => table }, stderr: { toString: () => "" } }).then(resolve);
        }
        if (trimmed.startsWith("tmux new-window") || trimmed.startsWith("tmux split-window")) {
          if (splitWindowExitCode !== 0) {
            return Promise.resolve({ exitCode: splitWindowExitCode, stdout: { toString: () => "" }, stderr: { toString: () => "boom" } }).then(resolve);
          }
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => splitPaneId + "\n" }, stderr: { toString: () => "" } }).then(resolve);
        }
        if (trimmed.startsWith("tmux display-message") && cmd.includes("#{session_id}:#{window_index}")) {
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => "$0:0\n" }, stderr: { toString: () => "" } }).then(resolve);
        }
        if (trimmed.startsWith("tmux display-message") && cmd.includes("#{window_width}")) {
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => String(widthCols) }, stderr: { toString: () => "" } }).then(resolve);
        }
        if (trimmed.startsWith("tmux display-message") && cmd.includes("#{window_height}")) {
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => String(heightRows) }, stderr: { toString: () => "" } }).then(resolve);
        }
        return Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve);
      },
    };
    return runner;
  }
  return { tag, calls };
}

function config(overrides = {}) {
  return {
    enabled: true,
    placement: "pane",
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

function stubIsInsideTmux(monitor) {
  Object.defineProperty(monitor, "active", { value: true, configurable: true });
}

describe("readTmuxConfig — config parsing", () => {
  test("defaults when block is undefined", () => {
    const c = readTmuxConfig(undefined);
    assert.equal(c.enabled, false);
    assert.equal(c.layout, "main-vertical");
    assert.equal(c.mainPaneSize, 60);
    assert.equal(c.splitDirection, "-h");
    assert.equal(c.attachCommand, "opencode attach");
    assert.equal(c.paneCloseDelaySeconds, 5);
  });

  test("invalid layout falls back to main-vertical", () => {
    const c = readTmuxConfig({ layout: "not-a-layout" });
    assert.equal(c.layout, "main-vertical");
  });

  test("split_direction '-v' preserved", () => {
    const c = readTmuxConfig({ split_direction: "-v" });
    assert.equal(c.splitDirection, "-v");
  });

  test("split_direction invalid falls back to -h", () => {
    const c = readTmuxConfig({ split_direction: "-diagonal" });
    assert.equal(c.splitDirection, "-h");
  });

  test("server_url falsy (empty string, null) becomes undefined", () => {
    assert.equal(readTmuxConfig({ server_url: "" }).serverUrl, undefined);
    assert.equal(readTmuxConfig({ server_url: null }).serverUrl, undefined);
  });

  test("numeric overrides applied", () => {
    const c = readTmuxConfig({
      main_pane_size: 70,
      agent_pane_min_width: 30,
      pane_close_delay_seconds: 10,
    });
    assert.equal(c.mainPaneSize, 70);
    assert.equal(c.agentPaneMinWidth, 30);
    assert.equal(c.paneCloseDelaySeconds, 10);
  });

  test("boolean flags honored", () => {
    const c = readTmuxConfig({
      enabled: true,
      keep_pane_on_success: true,
      auto_close_on_failure: true,
    });
    assert.equal(c.enabled, true);
    assert.equal(c.keepPaneOnSuccess, true);
    assert.equal(c.autoCloseOnFailure, true);
  });
});

describe("readTmuxConfig — placement", () => {
  test("defaults to 'window' when unset", () => {
    assert.equal(readTmuxConfig(undefined).placement, "window");
    assert.equal(readTmuxConfig({}).placement, "window");
  });

  test("explicit 'pane' preserved", () => {
    assert.equal(readTmuxConfig({ placement: "pane" }).placement, "pane");
  });

  test("unknown value falls back to 'window'", () => {
    assert.equal(readTmuxConfig({ placement: "floating" }).placement, "window");
    assert.equal(readTmuxConfig({ placement: "" }).placement, "window");
  });
});

describe("buildWindowName — tmux window name sanitisation", () => {
  test("stage + last 8 chars of session id", () => {
    assert.equal(buildWindowName("dev", "ses_abcdef12345678"), "mdn2-dev-12345678");
  });

  test("spaces and specials collapse to dashes", () => {
    assert.equal(buildWindowName("3_delivery commit!", "ses_00000000"), "mdn2-3_delivery-commit-00000000");
  });

  test("empty stage falls back to 'stage'", () => {
    assert.equal(buildWindowName("!!!", "ses_00000000"), "mdn2-stage-00000000");
  });
});

describe("TmuxMonitor.spawnPane — placement=window (no 부장님 pane resize)", () => {
  test("uses new-window -d and never splits or re-layouts the source window", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%77" });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    const paneId = await monitor.spawnPane("ses_aaaabbbb", "dev", "engineer", "/wt");
    assert.equal(paneId, "%77");

    const newWindow = rec.calls.find(c => c.trim().startsWith("tmux new-window"));
    assert.ok(newWindow, "placement=window must use tmux new-window");
    assert.ok(newWindow.includes(" -d "), `new-window must be detached (-d) so the active window is unchanged: ${newWindow}`);
    assert.ok(newWindow.includes("mdn2-dev-aaaabbbb"), `window should be named: ${newWindow}`);

    assert.equal(
      rec.calls.filter(c => c.trim().startsWith("tmux split-window")).length, 0,
      "placement=window must never split the 부장님 window",
    );
    assert.equal(
      rec.calls.filter(c => c.includes("select-layout")).length, 0,
      "placement=window must never re-layout (this is what resizes 부장님's pane)",
    );
    assert.equal(
      rec.calls.filter(c => c.includes("set-window-option")).length, 0,
      "placement=window must not touch main-pane-width/height",
    );
  });

  test("does not steal focus back — no select-pane on the source pane", async () => {
    const origPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%3";
    try {
      const rec = makeShellRecorder({ splitPaneId: "%78" });
      const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
      stubIsInsideTmux(monitor);

      await monitor.spawnPane("ses_ccccdddd", "test", "engineer", "/wt");

      const focusRestore = rec.calls.filter(c => c.trim() === "tmux select-pane -t %3");
      assert.equal(focusRestore.length, 0, "detached new-window never moves focus, so no restore is needed");

      const newWindow = rec.calls.find(c => c.trim().startsWith("tmux new-window"));
      assert.ok(
        /-a[ ,]-t[ ,]\$0:0\b/.test(newWindow),
        `new-window must target a <session_id>:<window>, not a pane id — tmux rejects panes with "can't specify pane here": ${newWindow}`,
      );
      assert.ok(
        !/-t[ ,]%3\b/.test(newWindow),
        `new-window must never receive the source pane id as -t: ${newWindow}`,
      );
    } finally {
      if (origPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = origPane;
    }
  });

  test("pane markers are still written so orphan scan keeps working", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%79" });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_eeeeffff", "commit", "publisher", "/wt");

    assert.ok(
      rec.calls.some(c => c.includes("set-option -p -t %79") && c.includes("@mdn2_session")),
      "window-placed panes must still carry @mdn2_session",
    );
  });

  test("unresolvable source window → spawn is SKIPPED, never an untargeted new-window", async () => {
    const rec = { calls: [] };
    rec.tag = function tag(strings, ...values) {
      const cmd = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
      const runner = {
        cwd() { return runner; }, quiet() { return runner; }, nothrow() { return runner; },
        then(resolve) {
          rec.calls.push(cmd);
          if (cmd.includes("#{session_id}:#{window_index}")) {
            return Promise.resolve({ exitCode: 1, stdout: { toString: () => "" }, stderr: { toString: () => "no such pane" } }).then(resolve);
          }
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve);
        },
      };
      return runner;
    };
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    const paneId = await monitor.spawnPane("ses_55556666", "dev", "engineer", "/wt");
    assert.equal(paneId, null, "spawn must fail closed when the target window cannot be resolved");
    assert.equal(monitor.trackedPaneCount, 0);
    assert.equal(
      rec.calls.filter(c => c.trim().startsWith("tmux new-window")).length, 0,
      "an untargeted new-window could land in another session — it must never be issued",
    );
  });

  test("new-window failure clears placeholder → retryable", async () => {
    const rec = makeShellRecorder({ splitWindowExitCode: 1 });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    const paneId = await monitor.spawnPane("ses_11112222", "dev", "engineer", "/wt");
    assert.equal(paneId, null);
    assert.equal(monitor.trackedPaneCount, 0);
  });

  test("placement=pane still splits and re-layouts (legacy path intact)", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%80" });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "pane" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_33334444", "dev", "engineer", "/wt");

    assert.ok(rec.calls.some(c => c.trim().startsWith("tmux split-window")), "placement=pane must split");
    assert.ok(rec.calls.some(c => c.includes("select-layout")), "placement=pane must re-layout");
    assert.equal(rec.calls.filter(c => c.trim().startsWith("tmux new-window")).length, 0);
  });
});

describe("buildPlaceholderCommand — no opencode process is started", () => {
  test("prints a banner then sleeps forever, never runs opencode", () => {
    const cmd = buildPlaceholderCommand("dev", "engineer", "ses_aaaabbbb");
    assert.ok(!cmd.includes("opencode attach"), `placeholder must not attach: ${cmd}`);
    assert.ok(cmd.includes("while :; do sleep 86400; done"), `placeholder must keep the pane alive: ${cmd}`);
    assert.ok(cmd.includes("aaaabbbb"), "banner should identify the session");
  });

  test("single quotes in stage/agent cannot break out of the shell string", () => {
    const cmd = buildPlaceholderCommand("de'v", "engi'neer", "ses_11112222");
    assert.ok(!/[^\\]';\s*(rm|curl|sh)\b/.test(cmd), `must not allow command injection: ${cmd}`);
    assert.ok(cmd.includes("'\\''"), "single quotes must be escaped via the '\\'' idiom");
  });
});

describe("TmuxMonitor — attach is always deferred until the pane is focused", () => {
  test("spawn runs the placeholder, NOT opencode attach", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%90" });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_aaaabbbb", "dev", "engineer", "/wt");

    const spawn = rec.calls.find(c => c.trim().startsWith("tmux new-window"));
    assert.ok(spawn.includes("sleep 86400"), `spawn must run the placeholder: ${spawn}`);
    assert.ok(
      !spawn.includes("opencode attach"),
      `spawn must NOT start an opencode TUI — that is the OSC-leak source: ${spawn}`,
    );
  });

  test("unfocused pane is never activated", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%92", focusedPaneIds: [] });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_eeeeffff", "dev", "engineer", "/wt");
    const activated = await monitor.pollFocusOnce();

    assert.equal(activated, 0);
    assert.equal(rec.calls.filter(c => c.includes("respawn-pane")).length, 0);
  });

  test("pane_active=1 alone must NOT trigger attach — window_active is required", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%93", panesTable: "%93\t1\t0\n%0\t1\t1\n" });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_55556666", "dev", "engineer", "/wt");
    const activated = await monitor.pollFocusOnce();

    assert.equal(activated, 0, "a background window's own active pane must not count as focused");
    assert.equal(rec.calls.filter(c => c.includes("respawn-pane")).length, 0);
  });

  test("focused pane is respawned into opencode attach exactly once", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%94", panesTable: "%94\t1\t1\n" });
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_77778888", "dev", "engineer", "/wt");

    assert.equal(await monitor.pollFocusOnce(), 1);
    const respawn = rec.calls.find(c => c.includes("respawn-pane"));
    assert.ok(respawn.includes("-k"), `respawn must replace the placeholder process: ${respawn}`);
    assert.ok(respawn.includes("opencode attach"), `respawn must run the real TUI: ${respawn}`);
    assert.ok(respawn.includes("ses_77778888"));

    assert.equal(await monitor.pollFocusOnce(), 0, "activation must be idempotent");
    assert.equal(rec.calls.filter(c => c.includes("respawn-pane")).length, 1);
  });

  test("respawn failure leaves the pane retryable on the next poll", async () => {
    let respawnExit = 1;
    const rec = { calls: [] };
    rec.tag = function tag(strings, ...values) {
      const cmd = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
      const runner = {
        cwd() { return runner; }, quiet() { return runner; }, nothrow() { return runner; },
        then(resolve) {
          rec.calls.push(cmd);
          const t = cmd.trim();
          const ok = (out) => Promise.resolve({ exitCode: 0, stdout: { toString: () => out }, stderr: { toString: () => "" } }).then(resolve);
          if (t === "tmux -V") return ok("tmux 3.6\n");
          if (t.startsWith("tmux new-window")) return ok("%96\n");
          if (cmd.includes("#{session_id}:#{window_index}")) return ok("$0:0\n");
          if (t.startsWith("tmux list-panes") && cmd.includes("#{pane_active}")) return ok("%96\t1\t1\n");
          if (cmd.includes("respawn-pane")) {
            return Promise.resolve({ exitCode: respawnExit, stdout: { toString: () => "" }, stderr: { toString: () => "pane not found" } }).then(resolve);
          }
          return ok("");
        },
      };
      return runner;
    };
    const monitor = new TmuxMonitor(rec.tag, config({ placement: "window" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_abcd1234", "dev", "engineer", "/wt");

    assert.equal(await monitor.pollFocusOnce(), 0, "failed respawn must not count as activated");
    respawnExit = 0;
    assert.equal(await monitor.pollFocusOnce(), 1, "a failed activation must be retried, not silently dropped");
  });

  test("failure-kept pane stays focus-activatable (auto_close_on_failure=false)", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%97", panesTable: "%97\t1\t1\n" });
    const monitor = new TmuxMonitor(rec.tag, config({
      placement: "window", autoCloseOnFailure: false,
    }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_dddd4444", "dev", "engineer", "/wt");
    await monitor.closePane("ses_dddd4444", { success: false });

    assert.equal(monitor.trackedPaneCount, 1, "failed pane is kept for diagnosis");
    assert.equal(
      await monitor.pollFocusOnce(), 1,
      "focusing a kept failure pane must still attach — otherwise it is an inert banner",
    );
  });

  test("eviction of an awaiting-focus pane stops the focus watch", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%98", widthCols: 60, panesTable: "" });
    const monitor = new TmuxMonitor(rec.tag, config({
      placement: "pane", mainPaneSize: 50, agentPaneMinWidth: 20,
    }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("ses_ffff1111", "dev", "engineer", "/wt");
    await monitor.spawnPane("ses_ffff2222", "dev", "engineer", "/wt");
    await monitor.closePane("ses_ffff1111", { success: true });
    await monitor.closePane("ses_ffff2222", { success: true });

    assert.equal(monitor.trackedPaneCount, 0);
    assert.equal(await monitor.pollFocusOnce(), 0, "no tracked panes left → nothing to activate");
  });

});

describe("isInsideTmux — TMUX env detection", () => {
  test("returns true when TMUX env set", () => {
    const orig = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    try {
      assert.equal(isInsideTmux(), true);
    } finally {
      if (orig === undefined) delete process.env.TMUX;
      else process.env.TMUX = orig;
    }
  });

  test("returns false when TMUX env unset", () => {
    const orig = process.env.TMUX;
    delete process.env.TMUX;
    try {
      assert.equal(isInsideTmux(), false);
    } finally {
      if (orig !== undefined) process.env.TMUX = orig;
    }
  });
});

describe("TmuxMonitor.spawnPane — duplicate guard", () => {
  test("returns null when inactive", async () => {
    const monitor = new TmuxMonitor(makeShellRecorder().tag, config({ enabled: false }));
    const p = await monitor.spawnPane("s1", "stage", "agent", "/wt");
    assert.equal(p, null);
  });

  test("second call for same sessionId returns cached paneId (no second split-window)", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%42" });
    const monitor = new TmuxMonitor(rec.tag, config());
    stubIsInsideTmux(monitor);

    const p1 = await monitor.spawnPane("s1", "stage", "agent", "/wt");
    assert.equal(p1, "%42");

    const splitCallsAfterFirst = rec.calls.filter(c => c.startsWith("tmux split-window")).length;
    assert.equal(splitCallsAfterFirst, 1);

    const p2 = await monitor.spawnPane("s1", "stage", "agent", "/wt");
    assert.equal(p2, "%42");

    const splitCallsAfterSecond = rec.calls.filter(c => c.startsWith("tmux split-window")).length;
    assert.equal(splitCallsAfterSecond, 1, "expected exactly one split-window across both spawnPane calls");
    assert.equal(monitor.trackedPaneCount, 1);
  });

  test("concurrent spawnPane calls for same sessionId → only one split-window", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%99" });
    const monitor = new TmuxMonitor(rec.tag, config());
    stubIsInsideTmux(monitor);

    const [p1, p2, p3] = await Promise.all([
      monitor.spawnPane("s1", "stage", "agent", "/wt"),
      monitor.spawnPane("s1", "stage", "agent", "/wt"),
      monitor.spawnPane("s1", "stage", "agent", "/wt"),
    ]);
    assert.equal(p1, "%99");
    assert.equal(p2, "%99");
    assert.equal(p3, "%99");
    const splitCalls = rec.calls.filter(c => c.startsWith("tmux split-window")).length;
    assert.equal(splitCalls, 1, "concurrent calls must collapse to one split-window");
  });

  test("split-window failure clears placeholder → next call retries", async () => {
    let splitExit = 1;
    const rec = { calls: [] };
    let paneCounter = 0;
    rec.tag = function tag(strings, ...values) {
      const cmd = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
      const runner = {
        cwd() { return runner; },
        quiet() { return runner; },
        nothrow() { return runner; },
        then(resolve) {
          rec.calls.push(cmd);
          const trimmed = cmd.trim();
          if (trimmed.startsWith("tmux split-window")) {
            if (splitExit !== 0) {
              return Promise.resolve({ exitCode: splitExit, stdout: { toString: () => "" }, stderr: { toString: () => "boom" } }).then(resolve);
            }
            paneCounter++;
            return Promise.resolve({ exitCode: 0, stdout: { toString: () => `%${paneCounter}\n` }, stderr: { toString: () => "" } }).then(resolve);
          }
          if (trimmed.startsWith("tmux display-message") && cmd.includes("#{window_width}")) {
            return Promise.resolve({ exitCode: 0, stdout: { toString: () => "400" }, stderr: { toString: () => "" } }).then(resolve);
          }
          return Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve);
        },
      };
      return runner;
    };
    const monitor = new TmuxMonitor(rec.tag, config());
    stubIsInsideTmux(monitor);

    const p1 = await monitor.spawnPane("s1", "stage", "agent", "/wt");
    assert.equal(p1, null);
    assert.equal(monitor.trackedPaneCount, 0, "placeholder must be cleaned up on split-window failure");

    splitExit = 0;
    const p2 = await monitor.spawnPane("s1", "stage", "agent", "/wt");
    assert.equal(p2, "%1");
    assert.equal(monitor.trackedPaneCount, 1);
  });
});

describe("TmuxMonitor.spawnPane — main-pane-width/height enforcement", () => {
  test("main-vertical layout: set-window-option main-pane-width = floor(width * mainPaneSize / 100)", async () => {
    const rec = makeShellRecorder({ widthCols: 200 });
    const monitor = new TmuxMonitor(rec.tag, config({ layout: "main-vertical", mainPaneSize: 60 }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("s1", "stage", "agent", "/wt");

    const setOpt = rec.calls.find(c => c.includes("set-window-option") && c.includes("main-pane-width"));
    assert.ok(setOpt, "set-window-option main-pane-width must be called");
    assert.ok(setOpt.includes("120"), `expected width 120 (200*60/100) but got: ${setOpt}`);
  });

  test("main-horizontal layout: set-window-option main-pane-height = floor(height * mainPaneSize / 100)", async () => {
    const rec = makeShellRecorder({ heightRows: 100 });
    const monitor = new TmuxMonitor(rec.tag, config({ layout: "main-horizontal", mainPaneSize: 70 }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("s1", "stage", "agent", "/wt");

    const setOpt = rec.calls.find(c => c.includes("set-window-option") && c.includes("main-pane-height"));
    assert.ok(setOpt, "set-window-option main-pane-height must be called");
    assert.ok(setOpt.includes("70"), `expected height 70 (100*70/100) but got: ${setOpt}`);
    const widthOpt = rec.calls.find(c => c.includes("set-window-option") && c.includes("main-pane-width"));
    assert.equal(widthOpt, undefined, "main-pane-width must NOT be set for main-horizontal");
  });

  test("tiled layout: no set-window-option call", async () => {
    const rec = makeShellRecorder();
    const monitor = new TmuxMonitor(rec.tag, config({ layout: "tiled" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("s1", "stage", "agent", "/wt");

    const setOpt = rec.calls.find(c => c.includes("set-window-option"));
    assert.equal(setOpt, undefined, "tiled layout must not call set-window-option");
  });

  test("even-horizontal layout: no set-window-option call", async () => {
    const rec = makeShellRecorder();
    const monitor = new TmuxMonitor(rec.tag, config({ layout: "even-horizontal" }));
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("s1", "stage", "agent", "/wt");

    const setOpt = rec.calls.find(c => c.includes("set-window-option"));
    assert.equal(setOpt, undefined, "even-horizontal layout must not call set-window-option");
  });

  test("default config (mainPaneSize=60, widthCols=400): main-pane-width=240", async () => {
    const rec = makeShellRecorder({ widthCols: 400 });
    const monitor = new TmuxMonitor(rec.tag, config());
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("s1", "stage", "agent", "/wt");

    const setOpt = rec.calls.find(c => c.includes("set-window-option") && c.includes("main-pane-width"));
    assert.ok(setOpt, "set-window-option main-pane-width must be called with default config");
    assert.ok(setOpt.includes("240"), `expected 240 (400*60/100) but got: ${setOpt}`);
  });
});

describe("TmuxMonitor.closePane — placeholder safety", () => {
  test("closing an unknown sessionId is a no-op", async () => {
    const rec = makeShellRecorder();
    const monitor = new TmuxMonitor(rec.tag, config());
    stubIsInsideTmux(monitor);

    await monitor.closePane("unknown-session", { success: true });
    const killCalls = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(killCalls.length, 0);
  });

  test("closePane after successful spawn removes entry from tracking", async () => {
    const rec = makeShellRecorder({ splitPaneId: "%7" });
    const monitor = new TmuxMonitor(rec.tag, config());
    stubIsInsideTmux(monitor);

    await monitor.spawnPane("s1", "stage", "agent", "/wt");
    assert.equal(monitor.trackedPaneCount, 1);

    await monitor.closePane("s1", { success: true });
    assert.equal(monitor.trackedPaneCount, 0);
    const killCalls = rec.calls.filter(c => c.startsWith("tmux kill-pane"));
    assert.equal(killCalls.length, 1);
  });
});

describe("discoverServerUrl — grandchild pid lookup", () => {
  test("serverUrl in config → uses config directly, no pgrep", async () => {
    const { tag, calls } = makeShellRecorder({ splitPaneId: "%1", panesTable: "%1\t1\t1\n" });
    const monitor = new TmuxMonitor(tag, config({ serverUrl: "http://127.0.0.1:9999" }));
    stubIsInsideTmux(monitor);
    await monitor.spawnPane("s1", "dev", "engineer", "/wt");

    const splitCall = calls.find(c => c.includes("split-window"));
    assert.ok(splitCall, "pane should be spawned");
    assert.ok(
      !splitCall.includes("http://127.0.0.1:9999"),
      `spawn runs the placeholder — the server URL only appears once the pane is focused: ${splitCall}`,
    );

    await monitor.pollFocusOnce();
    const respawn = calls.find(c => c.includes("respawn-pane"));
    assert.ok(respawn?.includes("http://127.0.0.1:9999"), `attach should include server URL, got: ${respawn}`);
    assert.ok(!calls.some(c => c.includes("pgrep")), "should not call pgrep when serverUrl is configured");
  });

  test("serverUrl absent → SERVER_URL_UNRESOLVED warning (no paneId available) but pane still spawned", async () => {
    const { logger } = await import("../dist/logger.js");
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    logger._setLevelForTests("warn");
    try {
      const { tag, calls } = makeShellRecorder();
      const monitor = new TmuxMonitor(tag, config({ serverUrl: undefined }));
      stubIsInsideTmux(monitor);
      await monitor.spawnPane("s1", "dev", "engineer", "/wt");
      const splitCall = calls.find(c => c.includes("split-window"));
      assert.ok(splitCall, "pane should still be spawned despite missing URL");
      assert.ok(
        warnings.some(w => w.includes("SERVER_URL_UNRESOLVED")),
        `expected SERVER_URL_UNRESOLVED warning, got: ${JSON.stringify(warnings)}`
      );
    } finally {
      console.warn = origWarn;
      logger._resetForTests();
    }
  });
});
