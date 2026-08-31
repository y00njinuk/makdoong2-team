/**
 * Regression tests for substage completion classification (GitHub issue #9).
 *
 * The incident: a planner sub-session burned 27 minutes, produced a final turn
 * saying "조기종료 — 마커 기록 없음", and dispatch_stage reported `ok:true` with
 * `outcome_kind:"text"`. state.json was byte-identical afterwards, hang_history
 * stayed empty (so the cross-call stall ceiling could never arm), and the
 * orchestrator relayed the prose to the user as progress.
 *
 * Two halves are pinned here:
 *   1. `classifyStageCompletion` — the pure marker→verdict mapping.
 *   2. The wiring in opencode-plugin.ts, asserted at source level because the
 *      dispatch_stage retry loop needs a live opencode server (same approach as
 *      test/dispatch-stage-redispatch.test.ts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = resolve(HERE, "..", "src", "opencode-plugin.ts");
const LEADER_MD = resolve(HERE, "..", "agents", "makdoong2-team-leader.md");

const { classifyStageCompletion, INCOMPLETE_HANG_REASON } = await import(
  "../dist/stage-completion.js"
);

const base = { outcomeKind: "text", success: true };

describe("classifyStageCompletion — marker beats prose", () => {
  test("done=true → done, ok, resets hang_history, records nothing", () => {
    const r = classifyStageCompletion({ ...base, doneValue: "true" });
    assert.equal(r.completion, "done");
    assert.equal(r.stageDone, true);
    assert.equal(r.ok, true);
    assert.equal(r.resetHangHistory, true);
    assert.equal(r.recordHang, false);
  });

  test("done=false with no pause marker → incomplete, ok:false, records hang", () => {
    const r = classifyStageCompletion({ ...base, doneValue: "false" });
    assert.equal(r.completion, "incomplete");
    assert.equal(r.stageDone, false);
    assert.equal(r.ok, false,
      "a text turn without a done marker must not be reported as success — that is the whole bug");
    assert.equal(r.resetHangHistory, false);
    assert.equal(r.recordHang, true,
      "hang_history is the only counter that survives across dispatch_stage calls; " +
      "without an entry here stall_escalate_threshold can never arm for this failure mode");
    assert.ok(r.incompleteReason);
    assert.ok(r.nextAction);
  });

  test("interview_required=true → paused, ok stays true, no hang entry", () => {
    const r = classifyStageCompletion({
      ...base,
      doneValue: "false",
      interviewRequiredValue: "true",
    });
    assert.equal(r.completion, "paused");
    assert.equal(r.ok, true,
      "an intentional interview stop is not a failure — the orchestrator interviews and re-dispatches");
    assert.equal(r.recordHang, false,
      "a deliberate pause must not accumulate toward the stall ceiling");
    assert.match(r.nextAction, /인터뷰/);
  });

  test("done=true wins over interview_required=true", () => {
    const r = classifyStageCompletion({
      ...base,
      doneValue: "true",
      interviewRequiredValue: "true",
    });
    assert.equal(r.completion, "done");
    assert.equal(r.resetHangHistory, true);
  });

  test("unreadable marker fails open — never turns finished work into a retry loop", () => {
    for (const doneValue of [null, "null", "", "  ", "jq: error"]) {
      const r = classifyStageCompletion({ ...base, doneValue });
      assert.equal(r.completion, "unknown", `doneValue=${JSON.stringify(doneValue)}`);
      assert.equal(r.stageDone, null);
      assert.equal(r.ok, true, "an unreadable state.json must not be reported as a stage failure");
      assert.equal(r.recordHang, false);
      assert.equal(r.resetHangHistory, false);
    }
  });

  test("marker parsing is whitespace- and case-tolerant", () => {
    assert.equal(classifyStageCompletion({ ...base, doneValue: " TRUE\n" }).completion, "done");
    assert.equal(classifyStageCompletion({ ...base, doneValue: "False " }).completion, "incomplete");
  });

  test("success=false leaves the existing failure paths alone", () => {
    const r = classifyStageCompletion({
      outcomeKind: "timeout",
      success: false,
      doneValue: "false",
    });
    assert.equal(r.ok, false);
    assert.equal(r.recordHang, false,
      "session_gone/timeout paths build their own hang_history entries — no double counting");
    assert.equal(r.resetHangHistory, false);
  });

  test("session_gone done-override still classifies as done", () => {
    const r = classifyStageCompletion({
      outcomeKind: "session_gone",
      success: true,
      doneValue: "true",
    });
    assert.equal(r.completion, "done");
    assert.equal(r.ok, true);
  });

  test("hang reason constant is stable (state.json consumers read it)", () => {
    assert.equal(INCOMPLETE_HANG_REASON, "no_done_marker");
  });
});

describe("opencode-plugin.ts — dispatch_stage wiring", () => {
  const src = readFileSync(PLUGIN_SRC, "utf8");

  test("imports the classifier from its own module (never re-exported from the entry file)", () => {
    assert.match(
      src,
      /import\s*\{[^}]*classifyStageCompletion[^}]*\}\s*from\s*"\.\/stage-completion\.ts"/,
      "the opencode plugin loader calls every named export of the entry file as a factory; " +
      "helpers must be imported from src/*.ts (see test/plugin-exports-shape.test.ts)",
    );
  });

  test("dispatch_stage's ok comes from the classifier, not the legacy success flag", () => {
    // Scope to dispatch_stage's tail — dispatch_verifier has its own unrelated `ok: success`.
    const tail = src.slice(src.indexOf("const readMarker ="), src.indexOf("} finally {", src.indexOf("const readMarker =")));
    assert.ok(tail.length > 0, "dispatch_stage tail must be locatable");
    assert.match(tail, /ok:\s*completion\.ok,/,
      "dispatch_stage must report the marker-derived verdict");
    assert.ok(!/ok:\s*success,/.test(tail),
      "`ok: success` is the pre-issue-#9 behaviour — a text turn reported as a completed substage");
  });

  test("result JSON carries stage_done and completion", () => {
    assert.match(src, /stage_done:\s*completion\.stageDone/);
    assert.match(src, /completion:\s*completion\.completion/);
  });

  test("an incomplete outcome appends to hang_history with the shared reason constant", () => {
    assert.match(src, /completion\.recordHang/);
    assert.match(src, /reason:\s*INCOMPLETE_HANG_REASON/);
    assert.match(src, /state\.sh append[^\n]*\$\{incompleteJqPath\}/,
      "must append to the substage's hang_history via state.sh (hardrule: no direct writes)");
  });

  test("marker reads use effectiveWorktree, not args.worktree", () => {
    const readMarker = src.slice(src.indexOf("const readMarker ="), src.indexOf("const completion ="));
    assert.ok(readMarker.length > 0, "readMarker helper must exist");
    assert.match(readMarker, /\.cwd\(effectiveWorktree\)/,
      "state.sh root() resolves from cwd — a substage's state.json accesses must all share one cwd " +
      "(ARCHITECTURE.md §10.2)");
    assert.ok(!/args\.worktree/.test(readMarker));
  });

  test("hang_history reset is gated on the classifier, not on plain dispatch success", () => {
    assert.match(src, /if\s*\(completion\.resetHangHistory\)/);
  });
});

describe("opencode-plugin.ts — 80% nudge must not forbid the marker writes it demands", () => {
  const src = readFileSync(PLUGIN_SRC, "utf8");
  const nudge = src.slice(src.indexOf("const nudgeText = ["), src.indexOf('].join("\\n");', src.indexOf("const nudgeText = [")));

  test("nudge text block is found", () => {
    assert.ok(nudge.length > 0);
  });

  test("marker recording is named an explicit exception to the tool-call ban", () => {
    assert.match(nudge, /예외/,
      "the old text demanded state.sh writes and then banned new tool calls; a planner read the ban " +
      "and exited with zero markers after 27 minutes (issue #9)");
    assert.ok(!/금지:\s*새 tool 호출 추가/.test(nudge),
      "the blanket '새 tool 호출 추가 금지' line contradicts the marker-recording step");
  });

  test("nudge states the cost of exiting without markers", () => {
    assert.match(nudge, /재실행|버려진다/);
  });
});

describe("makdoong2-team-leader.md — stage_done hardrule", () => {
  const md = readFileSync(LEADER_MD, "utf8");

  test("documents completion/stage_done as the completion verdict", () => {
    assert.match(md, /stage_done/, "leader must be told which field decides completion");
    assert.match(md, /`incomplete`/);
    assert.match(md, /`paused`/);
    assert.match(md, /`unknown`/);
  });

  test("forbids reporting an incomplete substage as complete", () => {
    assert.match(md, /완료.*로 보고하지 않는다|완료.*보고하지 말 것/);
  });

  test("warns that ok:true alone is not completion", () => {
    assert.match(md, /`ok: true` 만 보고/);
  });
});

/**
 * Regression: the 80% NUDGE prompt omitted `agent`, so opencode ran that turn as
 * its default agent and `chat.params` overwrote sessionAgent[sid] with "build".
 * From that point the sub-session was no longer recognised as a sealed sub-agent,
 * silently disarming the outer-world delegation block and the artifact-path
 * restriction for the rest of the session (GitHub issue #9, 부수 관찰 2).
 */
describe("sealed sub-agent identity survives the NUDGE (issue #9)", () => {
  const src = readFileSync(PLUGIN_SRC, "utf8");

  test("every session prompt body carries an agent field", () => {
    // Each `.prompt({`/`.promptAsync({` body must name the agent it runs as.
    const calls = [...src.matchAll(/\.(prompt|promptAsync)\(\{[\s\S]{0,900}?\n\s*\}\)/g)];
    assert.ok(calls.length >= 4, `expected several prompt call sites, found ${calls.length}`);
    for (const c of calls) {
      assert.match(c[0], /agent:\s*\w+/,
        `a session prompt body has no agent field — opencode falls back to its default agent ` +
        `and chat.params overwrites the session's sealed identity:\n${c[0].slice(0, 300)}`);
    }
  });

  test("the nudge call site specifically names the dispatched agent", () => {
    const nudgeCall = src.slice(src.indexOf("const engineerNudge ="), src.indexOf("const messageStallForAttempt ="));
    assert.ok(nudgeCall.length > 0, "nudge call site must be locatable");
    assert.match(nudgeCall, /promptAsync\(/);
    assert.match(nudgeCall, /agent:\s*spec\.id/,
      "the nudge must run as the dispatched agent, not opencode's default");
  });

  test("chat.params refuses to downgrade a known sealed identity", () => {
    const hook = src.slice(src.indexOf('"chat.params"'), src.indexOf('"tool.execute.before"'));
    assert.ok(hook.length > 0, "chat.params hook must be locatable");
    assert.match(hook, /SEALED_SUBAGENTS\.has\(known\)/,
      "second line of defence: one prompt missing `agent` must not unseal the session");
    assert.match(hook, /!SEALED_SUBAGENTS\.has\(input\.agent\)/);
    assert.match(hook, /logger\.warn/,
      "a downgrade attempt must be observable at the default logging level");
  });
});
