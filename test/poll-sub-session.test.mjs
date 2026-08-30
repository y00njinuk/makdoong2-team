import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pollSubSession,
  pollOutcomeToLegacy,
} from "../dist/poll-sub-session.js";

function makeClient({
  statusScript = [],
  messagesScript = [],
  onAbort = () => {},
  throwOnPolls = { status: new Set(), messages: new Set() },
} = {}) {
  let statusCalls = 0;
  let messagesCalls = 0;
  return {
    session: {
      status: async () => {
        statusCalls++;
        if (throwOnPolls.status.has(statusCalls)) {
          throw new Error(`status boom @${statusCalls}`);
        }
        const idx = Math.min(statusCalls - 1, statusScript.length - 1);
        return { data: statusScript[idx] ?? {} };
      },
      messages: async () => {
        messagesCalls++;
        if (throwOnPolls.messages.has(messagesCalls)) {
          throw new Error(`messages boom @${messagesCalls}`);
        }
        const idx = Math.min(messagesCalls - 1, messagesScript.length - 1);
        return { data: messagesScript[idx] ?? [] };
      },
      abort: async () => {
        onAbort();
        return {};
      },
    },
  };
}

const NOW = 1_000_000_000;
function fakeClock() {
  let t = NOW;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

const asstFinished = (id = "a1", text = "hello world") => ({
  info: { id, role: "assistant", finish: { reason: "stop" } },
  parts: [{ type: "text", text }],
});
const userMsg = (id = "u1") => ({ info: { id, role: "user" }, parts: [] });

describe("pollSubSession — INV-1: !status alone is not idle", () => {
  test("session status absent for 3 polls, then idle → completes on 4th poll with text", async () => {
    let aborted = false;
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [
        {},
        {},
        {},
        { s1: { type: "idle" } },
      ],
      messagesScript: [
        [],
        [],
        [],
        [userMsg(), asstFinished("a1", "hello")],
      ],
      onAbort: () => {
        aborted = true;
      },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 20_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "hello");
    assert.equal(outcome.polls, 4);
    assert.equal(aborted, false);
  });

  test("session never appears; empty messages; !status must NOT complete → hits timeout", async () => {
    let aborted = false;
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{}],
      messagesScript: [[]],
      onAbort: () => {
        aborted = true;
      },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 500,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "timeout");
    assert.equal(aborted, true);
  });
});

describe("pollSubSession — INV-2: transient failures retry, not swallow", () => {
  test("session.messages() throws once, recovers, then completes", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [
        { s1: { type: "running" } },
        { s1: { type: "idle" } },
      ],
      messagesScript: [
        null,
        [userMsg(), asstFinished("a1", "recovered")],
      ],
      throwOnPolls: { status: new Set(), messages: new Set([1]) },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 20_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "recovered");
    assert.equal(outcome.polls, 2);
  });

  test("all messages() calls throw → timeout with transientFailures counted", async () => {
    const clock = fakeClock();
    const throws = new Set();
    for (let i = 1; i <= 20; i++) throws.add(i);
    const client = makeClient({
      statusScript: [{ s1: { type: "running" } }],
      messagesScript: [[]],
      throwOnPolls: { status: new Set(), messages: throws },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 500,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "timeout");
    assert.ok(outcome.transientFailures > 0);
  });
});

describe("pollSubSession — INV-3: array-index ordering, not string ID compare", () => {
  test("finishComplete triggers when lastAssistantIdx > lastUserIdx (regardless of ID lexicographic order)", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{ s1: { type: "running" } }],
      messagesScript: [
        [
          userMsg("zzzz-user"),
          asstFinished("aaaa-asst", "ordered by index"),
        ],
      ],
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "ordered by index");
  });
});

describe("pollSubSession — INV-4: empty vs text discrimination", () => {
  test("assistant with only tool_call parts → kind=empty, not text", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [
        [
          userMsg(),
          {
            info: { id: "a1", role: "assistant", finish: null },
            parts: [{ type: "tool_call", text: "" }],
          },
        ],
      ],
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "empty");
    assert.match(outcome.reason, /no text parts/);
  });

  test("assistant with empty text parts (whitespace-only) → kind=empty", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [
        [
          userMsg(),
          {
            info: { id: "a1", role: "assistant", finish: { reason: "stop" } },
            parts: [
              { type: "text", text: "" },
            ],
          },
        ],
      ],
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "empty");
  });

  test("idle with zero messages and session never appeared → keeps polling until timeout", async () => {
    const clock = fakeClock();
    let aborted = false;
    const client = makeClient({
      statusScript: [{}],
      messagesScript: [[]],
      onAbort: () => {
        aborted = true;
      },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 300,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "timeout");
    assert.equal(aborted, true);
  });
});

describe("pollSubSession — hasPendingToolCall blocks completion", () => {
  test("assistant with text AND tool_use pending → does not complete on finishComplete path", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [
        { s1: { type: "running" } },
        { s1: { type: "idle" } },
      ],
      messagesScript: [
        [
          userMsg(),
          {
            info: { id: "a1", role: "assistant", finish: { reason: "stop" } },
            parts: [
              { type: "text", text: "partial" },
              { type: "tool_use" },
            ],
          },
        ],
        [
          userMsg(),
          asstFinished("a2", "final answer"),
        ],
      ],
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "final answer");
  });
});

describe("pollSubSession — maxPolls safety abort", () => {
  test("exceeds maxPolls → returns kind=aborted with abort() called", async () => {
    let aborted = false;
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{ s1: { type: "running" } }],
      messagesScript: [[]],
      onAbort: () => {
        aborted = true;
      },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 100_000,
      pollIntervalMs: 100,
      pollSafetyMargin: 2,
      now: clock.now,
      sleep: async () => {},
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "aborted");
    assert.match(outcome.reason, /max polling attempts/);
    assert.equal(aborted, true);
  });
});

describe("pollSubSession — status.type=idle with messages triggers completion", () => {
  test("session appeared once, later idle with text → text extracted", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [
        { s1: { type: "running" } },
        { s1: { type: "idle" } },
      ],
      messagesScript: [
        [userMsg()],
        [userMsg(), asstFinished("a1", "done")],
      ],
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "done");
  });
});

describe("pollSubSession — session_gone: session disappears after appearing", () => {
  test("sessionEverAppeared=true, then status absent + no new messages, grace=0 → session_gone immediately", async () => {
    const clock = fakeClock();
    let aborted = false;
    const client = makeClient({
      statusScript: [
        { s1: { type: "running" } },
        {},
        {},
        {},
      ],
      messagesScript: [
        [userMsg()],
        [userMsg()],
        [userMsg()],
        [userMsg()],
      ],
      onAbort: () => { aborted = true; },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "session_gone");
    assert.ok(outcome.polls >= 2, `poll should have detected gone by poll 2+ (got ${outcome.polls})`);
    assert.equal(
      aborted,
      false,
      "session_gone MUST NOT call abort() — session is already gone and abort triggers NotFoundError hang",
    );
  });

  test("session absent but new messages arrive → consecutiveGoneCount resets, keeps polling", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [
        { s1: { type: "running" } },
        {},
        {},
        {},
        { s1: { type: "idle" } },
      ],
      messagesScript: [
        [userMsg()],
        [userMsg()],
        [userMsg(), userMsg("u2")],
        [userMsg(), userMsg("u2")],
        [userMsg(), userMsg("u2"), asstFinished("a1", "recovered")],
      ],
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "text", "reset should prevent session_gone despite absent status");
    assert.equal(outcome.text, "recovered");
  });

  test("session never appeared → session_gone NOT triggered, falls through to timeout", async () => {
    const clock = fakeClock();
    let aborted = false;
    const client = makeClient({
      statusScript: [{}, {}, {}, {}, {}, {}],
      messagesScript: [[], [], [], [], [], []],
      onAbort: () => { aborted = true; },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 500,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(
      outcome.kind,
      "timeout",
      "session that never appeared should not trigger session_gone (INV-1 guard)",
    );
    assert.equal(aborted, true, "timeout path calls abort() normally");
  });

  test("default grace (5 min) suppresses gone within 8 s window (regression: qwen slow-first-token false positive)", async () => {
    const clock = fakeClock();
    let aborted = false;
    const idleStatus = { s1: { type: "idle" } };
    const client = makeClient({
      statusScript: [
        { s1: { type: "running" } },
        {}, {}, {}, {}, {}, {}, {},
        idleStatus,
      ],
      messagesScript: [
        [userMsg()], [userMsg()], [userMsg()], [userMsg()], [userMsg()],
        [userMsg()], [userMsg()], [userMsg()],
        [userMsg(), asstFinished("a1", "recovered after grace")],
      ],
      onAbort: () => { aborted = true; },
    });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(
      outcome.kind,
      "text",
      "default 5-min grace must swallow ~16 s (8 polls × 2 s) of status absence and let recovery win",
    );
    assert.equal(outcome.text, "recovered after grace");
    assert.equal(aborted, false, "no abort() because outcome was text, not gone");
  });

  test("explicit grace (5 s) → gone fires ONLY after grace elapses, not on first admission", async () => {
    const clock = fakeClock();
    const script = [];
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      script.push(i === 0 ? { s1: { type: "running" } } : {});
      msgs.push([userMsg()]);
    }
    const client = makeClient({ statusScript: script, messagesScript: msgs });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "session_gone");
    assert.ok(
      outcome.polls >= 4,
      `gone must not fire until grace elapses — expected polls ≥ 4 (2 s per poll × 5 s grace), got ${outcome.polls}`,
    );
  });

  test("isRecentlyActive() === true → gone suppressed entirely, falls through to timeout", async () => {
    const clock = fakeClock();
    const script = [];
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      script.push(i === 0 ? { s1: { type: "running" } } : {});
      msgs.push([userMsg()]);
    }
    const client = makeClient({ statusScript: script, messagesScript: msgs });

    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 20_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 1_000,
      isRecentlyActive: () => true,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(
      outcome.kind,
      "timeout",
      "alive signal must override grace-period-elapsed gone admission",
    );
  });

  test("isRecentlyActive() toggling false→true resets firstGoneObservedAt (timer restart)", async () => {
    const clock = fakeClock();
    const script = [];
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      script.push(i === 0 ? { s1: { type: "running" } } : {});
      msgs.push([userMsg()]);
    }
    const client = makeClient({ statusScript: script, messagesScript: msgs });

    let poll = 0;
    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 6_000,
      isRecentlyActive: () => {
        poll++;
        return poll === 4;
      },
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(outcome.kind, "session_gone");
    assert.ok(
      outcome.polls >= 7,
      `alive signal at poll 4 must reset grace timer, pushing gone from ~poll 4 to ~poll 7+ (got ${outcome.polls})`,
    );
  });

  test("Oracle risk #1 — streaming text appended in-place (length unchanged) resets grace via content-signature progress", async () => {
    const clock = fakeClock();
    const scriptStatus = [{ s1: { type: "running" } }];
    for (let i = 0; i < 20; i++) scriptStatus.push({});
    scriptStatus.push({ s1: { type: "idle" } });

    const messagesScript = [];
    for (let i = 0; i < 21; i++) {
      messagesScript.push([
        userMsg("u1"),
        {
          info: { id: "a1", role: "assistant" },
          parts: [{ type: "text", text: "x".repeat(200 + i * 50) }],
        },
      ]);
    }
    messagesScript.push([userMsg("u1"), asstFinished("a1", "final answer after streaming")]);

    const client = makeClient({ statusScript: scriptStatus, messagesScript });
    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(
      outcome.kind,
      "text",
      "streaming text appends must count as progress and prevent gone false-positive even with 5s grace",
    );
    assert.equal(outcome.text, "final answer after streaming");
  });

  test("Oracle risk #2 — long-tool with pending tool_call spanning grace period does NOT trigger gone", async () => {
    const clock = fakeClock();
    const scriptStatus = [{ s1: { type: "running" } }];
    for (let i = 0; i < 30; i++) scriptStatus.push({});
    scriptStatus.push({ s1: { type: "idle" } });

    const frozenWithPendingTool = [
      userMsg("u1"),
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          { type: "text", text: "Running docker build" },
          { type: "tool_call", tool: "bash", input: { command: "docker build ..." } },
        ],
      },
    ];
    const messagesScript = Array.from({ length: 31 }, () => frozenWithPendingTool);
    messagesScript.push([userMsg("u1"), asstFinished("a1", "build succeeded")]);

    const client = makeClient({ statusScript: scriptStatus, messagesScript });
    const outcome = await pollSubSession(client, "s1", {
      timeoutMs: 300_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 5_000,
      toolCallStallThresholdMs: 300_000,
      isRecentlyActive: () => false,
      now: clock.now,
      sleep: clock.sleep,
      logger: { error: () => {} },
    });

    assert.equal(
      outcome.kind,
      "text",
      "pending tool_call must block gone-admission regardless of grace/alive-signal state " +
      "(tool-call stall raised to 300s to isolate the gone-admission path from permission_stall)",
    );
    assert.equal(outcome.text, "build succeeded");
  });

  test("gone-admission debug logging: GONE_ADMIT + GONE_ADMIT_RESET fired at correct edges", async () => {
    const clock = fakeClock();
    const debugLogs = [];
    const script = [
      { s1: { type: "running" } },
      {}, {},
      { s1: { type: "running" } },
      {}, {}, {}, {},
    ];
    const msgs = [
      [userMsg()], [userMsg()], [userMsg()], [userMsg()],
      [userMsg()], [userMsg()], [userMsg()], [userMsg()],
    ];
    const client = makeClient({ statusScript: script, messagesScript: msgs });

    await pollSubSession(client, "s1", {
      timeoutMs: 30_000,
      pollIntervalMs: 2_000,
      statusAbsentGraceMs: 6_000,
      now: clock.now,
      sleep: clock.sleep,
      logger: {
        debug: (msg) => debugLogs.push(msg),
        error: () => {},
      },
    });

    const admits = debugLogs.filter(l => l.includes("GONE_ADMIT session"));
    const resets = debugLogs.filter(l => l.includes("GONE_ADMIT_RESET"));
    assert.ok(admits.length >= 2, `expected at least 2 GONE_ADMIT logs (first admission then re-admission after reset), got ${admits.length}`);
    assert.ok(resets.length >= 1, `expected at least 1 GONE_ADMIT_RESET when status reappears, got ${resets.length}`);
  });

});

describe("pollOutcomeToLegacy — success flag discrimination", () => {
  test("text outcome → success=true, text preserved", () => {
    const r = pollOutcomeToLegacy({
      kind: "text",
      text: "hi",
      polls: 3,
      elapsedMs: 500,
    });
    assert.equal(r.success, true);
    assert.equal(r.text, "hi");
  });

  test("empty outcome → success=false, reason embedded", () => {
    const r = pollOutcomeToLegacy({
      kind: "empty",
      reason: "no text parts",
      polls: 5,
      elapsedMs: 900,
    });
    assert.equal(r.success, false);
    assert.match(r.text, /no text parts/);
  });

  test("timeout outcome → success=false with poll count", () => {
    const r = pollOutcomeToLegacy({
      kind: "timeout",
      polls: 10,
      elapsedMs: 10_000,
      transientFailures: 4,
    });
    assert.equal(r.success, false);
    assert.match(r.text, /timeout/);
    assert.match(r.text, /polls=10/);
    assert.match(r.text, /transientFailures=4/);
  });

  test("aborted outcome → success=false with reason", () => {
    const r = pollOutcomeToLegacy({
      kind: "aborted",
      reason: "exceeded max polling attempts 12/12",
      polls: 12,
      elapsedMs: 1200,
    });
    assert.equal(r.success, false);
    assert.match(r.text, /aborted/);
  });

  test("session_gone outcome → success=false, text mentions session_gone + redispatch hint", () => {
    const r = pollOutcomeToLegacy({
      kind: "session_gone",
      polls: 8,
      elapsedMs: 16000,
    });
    assert.equal(r.success, false);
    assert.match(r.text, /session_gone/);
    assert.match(r.text, /redispatch/i);
    assert.match(r.text, /polls=8/);
  });
});

const asstPendingToolCall = (id = "a1") => ({
  info: { id, role: "assistant" },
  parts: [{ type: "tool_call", text: undefined }],
});

describe("pollSubSession — permission_stall detection", () => {
  test("pending tool_call unchanged for toolCallStallThresholdMs → permission_stall + abort called", async () => {
    let aborted = false;
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{}],
      messagesScript: [
        [userMsg(), asstPendingToolCall("tc1")],
        [userMsg(), asstPendingToolCall("tc1")],
        [userMsg(), asstPendingToolCall("tc1")],
      ],
      onAbort: () => { aborted = true; },
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      toolCallStallThresholdMs: 6_000,
    });
    assert.equal(outcome.kind, "permission_stall");
    assert.ok(outcome.stalledMs >= 6_000);
    assert.ok(aborted, "abort should have been called");
  });

  test("pending tool_call resolves (count increases) → stall resets, no permission_stall", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{}, {}, {}, { s1: { type: "idle" } }],
      messagesScript: [
        [userMsg(), asstPendingToolCall("tc1")],
        [userMsg(), asstPendingToolCall("tc1")],
        [userMsg(), asstPendingToolCall("tc1"), userMsg("u2")],
        [userMsg(), asstFinished("a2", "done")],
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      toolCallStallThresholdMs: 6_000,
    });
    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "done");
  });

  test("no pending tool_call → stall never triggers even after toolCallStallThresholdMs", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{}],
      messagesScript: [],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      toolCallStallThresholdMs: 4_000,
    });
    assert.equal(outcome.kind, "timeout");
  });
});

describe("pollSubSession — nudge mechanism", () => {
  const asstPendingToolCall = (id = "a1") => ({
    info: { id, role: "assistant", finish: { reason: "tool_calls" } },
    parts: [{ type: "tool_call", text: "" }],
  });

  test("onNudge fires once at nudgeAtFraction * timeout", async () => {
    const clock = fakeClock();
    const nudgeCalls = [];
    const client = makeClient({
      statusScript: [{}, {}, {}, {}, { s1: { type: "idle" } }],
      messagesScript: [
        [],
        [userMsg(), asstPendingToolCall()],
        [userMsg(), asstPendingToolCall()],
        [userMsg(), asstPendingToolCall()],
        [userMsg(), asstFinished("a2", "완료")],
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      nudgeAtFraction: 0.5,
      onNudge: async (sid, elapsed) => {
        nudgeCalls.push({ sid, elapsed });
      },
    });
    assert.equal(outcome.kind, "text");
    assert.equal(nudgeCalls.length, 1, "onNudge fires exactly once");
    assert.equal(nudgeCalls[0].sid, "s1");
    assert.ok(nudgeCalls[0].elapsed >= 5_000, "elapsed at least 50% of timeout");
  });

  test("onNudge not called if session completes before fraction reached", async () => {
    const clock = fakeClock();
    const nudgeCalls = [];
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [[userMsg(), asstFinished()]],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      nudgeAtFraction: 0.8,
      onNudge: async (sid, elapsed) => { nudgeCalls.push({ sid, elapsed }); },
    });
    assert.equal(outcome.kind, "text");
    assert.equal(nudgeCalls.length, 0, "no nudge when completes early");
  });

  test("onNudge fires before timeout, session still times out → timeout outcome", async () => {
    const clock = fakeClock();
    const nudgeCalls = [];
    const client = makeClient({
      statusScript: [{ s1: { type: "busy" } }, { s1: { type: "busy" } }, { s1: { type: "busy" } }, { s1: { type: "busy" } }, { s1: { type: "busy" } }, {}],
      messagesScript: [[userMsg()], [userMsg()], [userMsg()], [userMsg()], [userMsg()], [userMsg()]],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      nudgeAtFraction: 0.6,
      onNudge: async (sid, elapsed) => { nudgeCalls.push({ sid, elapsed }); },
    });
    assert.equal(outcome.kind, "timeout");
    assert.equal(nudgeCalls.length, 1, "nudge fired exactly once even on timeout");
  });

  test("onNudge error is swallowed, polling continues normally", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{}, {}, {}, { s1: { type: "idle" } }],
      messagesScript: [
        [],
        [userMsg(), asstPendingToolCall()],
        [userMsg(), asstPendingToolCall()],
        [userMsg(), asstFinished("a2", "ok")],
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      nudgeAtFraction: 0.3,
      onNudge: async () => { throw new Error("nudge boom"); },
    });
    assert.equal(outcome.kind, "text", "error in onNudge does not abort polling");
    assert.equal(outcome.text, "ok");
  });
});

describe("pollSubSession — messageStallThresholdMs (LLM API hang detection)", () => {
  test("busy status + no assistant message + threshold exceeded → session_gone with reason=message_stall + abort", async () => {
    let aborted = false;
    const clock = fakeClock();
    const busyStatuses = Array.from({ length: 10 }, () => ({ s1: { type: "busy" } }));
    const emptyMessagesRun = Array.from({ length: 10 }, () => [userMsg()]);
    const client = makeClient({
      statusScript: busyStatuses,
      messagesScript: emptyMessagesRun,
      onAbort: () => { aborted = true; },
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 6_000,
    });
    assert.equal(outcome.kind, "session_gone");
    assert.equal(outcome.reason, "message_stall");
    assert.ok(outcome.elapsedMs >= 6_000, `elapsed ${outcome.elapsedMs} should meet threshold`);
    assert.ok(aborted, "abort should have been called for message stall (session is real)");
  });

  test("assistant message appears before threshold → normal completion, no stall", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{ s1: { type: "busy" } }, { s1: { type: "busy" } }, { s1: { type: "idle" } }],
      messagesScript: [
        [userMsg()],
        [userMsg()],
        [userMsg(), asstFinished("a1", "done")],
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 6_000,
    });
    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "done");
  });

  test("messageStallThresholdMs undefined (opt-out) → no stall detection, hits full timeout", async () => {
    const clock = fakeClock();
    const busyStatuses = Array.from({ length: 20 }, () => ({ s1: { type: "busy" } }));
    const emptyMessagesRun = Array.from({ length: 20 }, () => [userMsg()]);
    const client = makeClient({
      statusScript: busyStatuses,
      messagesScript: emptyMessagesRun,
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
    });
    assert.equal(outcome.kind, "timeout", "no messageStallThresholdMs → no early stall");
  });

  test("status=busy but session NEVER appeared (bootstrap, empty messages) → stall NOT triggered", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: Array.from({ length: 10 }, () => ({})),
      messagesScript: Array.from({ length: 10 }, () => []),
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 8_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 4_000,
    });
    assert.equal(outcome.kind, "timeout",
      "sessionEverAppeared=false + no messages must not trigger message_stall (avoids bootstrap false-positive)");
  });

  test("worktree-cwd session (status always absent, messages present, no assistant) → message_stall fires", async () => {
    let aborted = false;
    const clock = fakeClock();
    const worktreeStatuses = Array.from({ length: 10 }, () => ({}));
    const worktreeMessages = Array.from({ length: 10 }, () => [userMsg("u1")]);
    const client = makeClient({
      statusScript: worktreeStatuses,
      messagesScript: worktreeMessages,
      onAbort: () => { aborted = true; },
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 6_000,
    });
    assert.equal(outcome.kind, "session_gone",
      "worktree session with messages but no assistant should trigger message_stall");
    assert.equal(outcome.reason, "message_stall");
    assert.ok(aborted, "abort should have been called");
  });

  test("worktree-cwd bootstrap (only user prompt, no assistant) → message_stall (NOT session_gone)", async () => {
    const clock = fakeClock();
    let aborted = false;
    const client = makeClient({
      statusScript: Array.from({length: 40}, () => ({})),
      messagesScript: Array.from({length: 40}, () => [userMsg("u1")]),
      onAbort: () => { aborted = true; },
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 300_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 60_000,
    });
    assert.equal(outcome.kind, "session_gone");
    assert.equal(outcome.reason, "message_stall",
      "bootstrap-only worktree session must go through message_stall path (opt-in threshold), NOT session_gone false-positive");
    assert.ok(outcome.elapsedMs >= 60_000, "must wait for message_stall threshold, not gone-count threshold");
    assert.ok(aborted, "message_stall path calls abort");
  });

  test("worktree-cwd session that produced assistant then froze WITHOUT contentStableCompletionMs → session_gone within grace period", async () => {
    const clock = fakeClock();
    const frozenMessages = [
      userMsg("u1"),
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ type: "text", text: "partial thought before hang" }],
      },
    ];
    const client = makeClient({
      statusScript: Array.from({length: 30}, () => ({})),
      messagesScript: [
        [userMsg("u1")],
        frozenMessages,
        ...Array.from({length: 28}, () => frozenMessages),
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 1_800_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 60_000,
      statusAbsentGraceMs: 10_000,
    });
    assert.equal(outcome.kind, "session_gone",
      "assistant present + no pending tool_call + frozen messages → session_gone (worktree publisher regression, backward-compat)");
    assert.ok(
      outcome.elapsedMs >= 10_000 && outcome.elapsedMs < 30_000,
      `must detect within the configured grace window (10s..<30s), got ${outcome.elapsedMs}ms`,
    );
  });

  test("worktree-cwd session that produced assistant then froze WITH contentStableCompletionMs=10_000 → text returned (content-stable third-arm completion)", async () => {
    const clock = fakeClock();
    const frozenMessages = [
      userMsg("u1"),
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ type: "text", text: "partial thought before hang" }],
      },
    ];
    const client = makeClient({
      statusScript: Array.from({length: 30}, () => ({})),
      messagesScript: [
        [userMsg("u1")],
        frozenMessages,
        ...Array.from({length: 28}, () => frozenMessages),
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 1_800_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 60_000,
      statusAbsentGraceMs: 60_000,
      contentStableCompletionMs: 10_000,
    });
    assert.equal(outcome.kind, "text",
      "content-stable completion inference must convert frozen worktree assistant into text success (PROJ-40406 fix C)");
    assert.equal(outcome.text, "partial thought before hang");
    assert.ok(
      outcome.elapsedMs >= 10_000 && outcome.elapsedMs < 30_000,
      `content-stable must fire close to the configured threshold, got ${outcome.elapsedMs}ms`,
    );
  });

  test("worktree-cwd session that eventually produces assistant → normal completion, NO stall", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: [{}, {}, {}, {}],
      messagesScript: [
        [userMsg("u1")],
        [userMsg("u1")],
        [userMsg("u1"), asstFinished("a1", "worktree done")],
        [userMsg("u1"), asstFinished("a1", "worktree done")],
      ],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 6_000,
    });
    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, "worktree done",
      "presence of assistant message exempts session from message_stall");
  });

  test("tool-call stall and message stall use independent thresholds", async () => {
    const clock = fakeClock();
    const client = makeClient({
      statusScript: Array.from({ length: 10 }, () => ({ s1: { type: "busy" } })),
      messagesScript: Array.from({ length: 10 }, () => [userMsg()]),
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      toolCallStallThresholdMs: 30_000,
      messageStallThresholdMs: 4_000,
    });
    assert.equal(outcome.kind, "session_gone");
    assert.equal(outcome.reason, "message_stall",
      "message stall triggers at its own threshold independent of toolCallStallThresholdMs");
  });

  test("pollOutcomeToLegacy formats message_stall variant distinctly", () => {
    const legacy = pollOutcomeToLegacy({
      kind: "session_gone",
      polls: 5,
      elapsedMs: 65_000,
      reason: "message_stall",
    });
    assert.equal(legacy.success, false);
    assert.match(legacy.text, /message_stall/);
    assert.match(legacy.text, /LLM API hang/);
  });

  test("pollOutcomeToLegacy still supports status-absent session_gone (no reason)", () => {
    const legacy = pollOutcomeToLegacy({
      kind: "session_gone",
      polls: 3,
      elapsedMs: 6_000,
    });
    assert.equal(legacy.success, false);
    assert.match(legacy.text, /disappeared from status map/);
    assert.doesNotMatch(legacy.text, /message_stall/);
  });

  test("mid-stream LLM inference hang — assistant produced then froze while status=busy → message_stall fires", async () => {
    const clock = fakeClock();
    const busy = { s1: { type: "busy" } };
    const scriptStatus = [
      busy, busy, busy, busy, busy, busy, busy, busy, busy, busy,
    ];
    const streamed = [
      userMsg("u1"),
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ type: "text", text: "partial thought before hang" }],
      },
    ];
    const messagesScript = [
      [userMsg("u1")],
      streamed,
      streamed, streamed, streamed, streamed, streamed, streamed, streamed, streamed,
    ];
    const client = makeClient({ statusScript: scriptStatus, messagesScript });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 10_000,
    });
    assert.equal(outcome.kind, "session_gone");
    assert.equal(outcome.reason, "message_stall",
      "assistant exists but no progress for threshold duration + status=busy → message_stall (LLM inference hang)");
    assert.ok(outcome.elapsedMs >= 10_000,
      `must wait at least the threshold before firing (got ${outcome.elapsedMs}ms)`);
  });

  test("mid-stream LLM hang exempted while hasPendingToolCall=true (heavy tool executing)", async () => {
    const clock = fakeClock();
    const busy = { s1: { type: "busy" } };
    const scriptStatus = Array.from({ length: 20 }, () => busy);
    const heavyTool = [
      userMsg("u1"),
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          { type: "text", text: "Running gradle build" },
          { type: "tool_call", tool: "bash", input: { command: "./gradlew build" } },
        ],
      },
    ];
    const messagesScript = Array.from({ length: 19 }, () => heavyTool);
    messagesScript.push([userMsg("u1"), asstFinished("a1", "build ok")]);

    const client = makeClient({ statusScript: scriptStatus, messagesScript });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 10_000,
      toolCallStallThresholdMs: 120_000,
    });
    assert.equal(outcome.kind, "text",
      "pending tool_call must exempt message_stall check even when no progress for threshold duration");
    assert.equal(outcome.text, "build ok");
  });

  test("mid-stream: streaming text append (content-signature progress) resets stall timer", async () => {
    const clock = fakeClock();
    const busy = { s1: { type: "busy" } };
    const scriptStatus = Array.from({ length: 30 }, () => busy);
    scriptStatus.push({ s1: { type: "idle" } });

    const messagesScript = [];
    for (let i = 0; i < 30; i++) {
      messagesScript.push([
        userMsg("u1"),
        {
          info: { id: "a1", role: "assistant" },
          parts: [{ type: "text", text: "x".repeat(200 + i * 30) }],
        },
      ]);
    }
    messagesScript.push([userMsg("u1"), asstFinished("a1", "streamed final")]);

    const client = makeClient({ statusScript: scriptStatus, messagesScript });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 300_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 5_000,
    });
    assert.equal(outcome.kind, "text",
      "each poll's text append is a progress signal → message_stall never fires");
    assert.equal(outcome.text, "streamed final");
  });
});

describe("pollSubSession — preambleOnlyTextThreshold", () => {
  test("short preamble text with no tool_call → reclassified as empty(preamble_only)", async () => {
    const clock = fakeClock();
    const preamble = "좋습니다! 이제 PR 본문을 작성하겠습니다:";
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [[userMsg("u1"), asstFinished("a1", preamble)]],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      preambleOnlyTextThreshold: 200,
    });
    assert.equal(outcome.kind, "empty",
      "short preamble with no work should be reclassified");
    assert.equal(outcome.reason, "preamble_only");
  });

  test("long substantive text passes through as text", async () => {
    const clock = fakeClock();
    const longBody = "PR body:\n\n" + "완결된 작업 내용을 상세히 설명한다. ".repeat(30);
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [[userMsg("u1"), asstFinished("a1", longBody)]],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      preambleOnlyTextThreshold: 200,
    });
    assert.equal(outcome.kind, "text");
    assert.ok(outcome.text.length > 200);
  });

  test("short text WITH pending tool_call is NOT reclassified (tool still running)", async () => {
    const clock = fakeClock();
    const messages = [
      userMsg("u1"),
      {
        info: { id: "a1", role: "assistant", finish: { reason: "stop" } },
        parts: [
          { type: "text", text: "짧은 텍스트" },
          { type: "tool_call", tool: "bash", input: { command: "echo hi" } },
        ],
      },
    ];
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [messages],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
      preambleOnlyTextThreshold: 200,
      toolCallStallThresholdMs: 5_000,
    });
    assert.notEqual(outcome.kind, "empty",
      "pending tool_call should exempt preamble-only reclassification");
  });

  test("threshold undefined disables the check (backward compatible)", async () => {
    const clock = fakeClock();
    const preamble = "짧음";
    const client = makeClient({
      statusScript: [{ s1: { type: "idle" } }],
      messagesScript: [[userMsg("u1"), asstFinished("a1", preamble)]],
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 60_000,
      pollIntervalMs: 2_000,
    });
    assert.equal(outcome.kind, "text");
    assert.equal(outcome.text, preamble);
  });
});

// ── 실행 중인 툴 호출 감지 (SDK part 타입 정합) ──
//
// `hasPendingToolCall` 은 "지금 무거운 툴이 돌고 있으니 stall 로 오판하지 말라" 는
// 면제 신호다. 그런데 판정 집합이 {"tool_call","tool-call","tool_use"} 였고
// opencode SDK 의 실제 타입은 **"tool"** 이다 (@opencode-ai/sdk 의 ToolPart:
// `type: "tool"`, `state: ToolState`). 즉 이 값이 **프로덕션에서 항상 false** 라
// 면제가 한 번도 걸리지 않았고, docker/gradle 처럼 수 분 걸리는 빌드를 도는 정상
// 세션이 MESSAGE_STALL 로 abort → 재디스패치됐다. 배포 대상이 JVM(sbt) 저장소라
// 정면으로 걸리는 경로다.
//
// 반대 방향도 같이 고정한다: 타입만 보고 판정하면 이미 끝난 툴 파트까지 세어
// 값이 항상 true 가 되고, 그러면 stall 감지 자체가 꺼진다. state.status 로
// 진행 중인 것만 세야 한다.
describe("pollSubSession — 실행 중 툴 호출은 stall 판정에서 면제된다", () => {
  const toolPart = (status) => ({
    type: "tool",
    state: { status, input: {}, raw: "" },
  });
  const asstWithTool = (status, id = "a1") => ({
    info: { id, role: "assistant" },
    parts: [{ type: "text", text: "빌드를 시작합니다" }, toolPart(status)],
  });

  for (const status of ["pending", "running"]) {
    test(`state.status="${status}" 이면 message stall 로 죽이지 않는다`, async () => {
      let aborted = false;
      const clock = fakeClock();
      const client = makeClient({
        statusScript: Array.from({ length: 10 }, () => ({ s1: { type: "busy" } })),
        messagesScript: Array.from({ length: 10 }, () => [userMsg(), asstWithTool(status)]),
        onAbort: () => { aborted = true; },
      });
      const outcome = await pollSubSession(client, "s1", {
        ...clock,
        timeoutMs: 30_000,
        pollIntervalMs: 2_000,
        messageStallThresholdMs: 6_000,
      });
      assert.notEqual(outcome.reason, "message_stall",
        "실행 중인 툴이 있는데 stall 로 판정했다 — 긴 빌드가 강제 종료된다");
      assert.equal(outcome.kind, "timeout", "면제되면 절대 타임아웃까지 기다린다");
      assert.ok(!aborted || outcome.kind === "timeout");
    });
  }

  for (const status of ["completed", "error"]) {
    test(`state.status="${status}" 는 끝난 툴이므로 면제하지 않는다`, async () => {
      const clock = fakeClock();
      const client = makeClient({
        statusScript: Array.from({ length: 10 }, () => ({ s1: { type: "busy" } })),
        messagesScript: Array.from({ length: 10 }, () => [userMsg(), asstWithTool(status)]),
      });
      const outcome = await pollSubSession(client, "s1", {
        ...clock,
        timeoutMs: 60_000,
        pollIntervalMs: 2_000,
        messageStallThresholdMs: 6_000,
      });
      assert.equal(outcome.reason, "message_stall",
        "끝난 툴 파트까지 면제하면 stall 감지가 통째로 꺼진다");
    });
  }

  test("state 가 없는 알 수 없는 shape 은 보수적으로 실행 중으로 본다", async () => {
    // 미탐(살아있는 세션을 죽임)이 오탐(절대 타임아웃까지 기다림)보다 비싸다.
    const clock = fakeClock();
    const client = makeClient({
      statusScript: Array.from({ length: 10 }, () => ({ s1: { type: "busy" } })),
      messagesScript: Array.from({ length: 10 }, () => [
        userMsg(),
        { info: { id: "a1", role: "assistant" }, parts: [{ type: "tool_use" }] },
      ]),
    });
    const outcome = await pollSubSession(client, "s1", {
      ...clock,
      timeoutMs: 30_000,
      pollIntervalMs: 2_000,
      messageStallThresholdMs: 6_000,
    });
    assert.notEqual(outcome.reason, "message_stall");
  });
});
