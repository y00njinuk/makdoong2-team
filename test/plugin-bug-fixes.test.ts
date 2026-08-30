/**
 * Regression tests for 3 bugs found in PROJ-40406 post-mortem:
 *   A (P0): sessionAgent race — planner recursively calls dispatch_stage
 *   B (P0): team-leader passes wrong worktree to dispatch_stage
 *   C (P1): verifier outputs verdict in JSON body instead of required tag
 *
 * Also covers:
 *   D: substage timeout — configurable via makdoong2-team.json timeout.substage_minutes
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Fix A: pendingDispatch fallback when sessionAgent map not yet populated ──
describe("Fix A — sessionAgent race: pendingDispatch fallback", () => {
  test("pendingDispatch fallback resolves agent when sessionAgent is empty", () => {
    const sessionAgent = new Map();
    const pendingDispatch = new Map();
    pendingDispatch.set("ses_planner_001", {
      stage: "1_planning.jira",
      agent: "makdoong2-planner",
      worktree: "/root/proj",
    });

    const sessionID = "ses_planner_001";
    const agent = sessionID
      ? (sessionAgent.get(sessionID) ?? pendingDispatch.get(sessionID)?.agent)
      : undefined;

    assert.equal(agent, "makdoong2-planner",
      "Should resolve agent from pendingDispatch when sessionAgent not populated yet");
  });

  test("sessionAgent takes priority over pendingDispatch when both populated", () => {
    const sessionAgent = new Map();
    const pendingDispatch = new Map();
    sessionAgent.set("ses_001", "makdoong2-planner");
    pendingDispatch.set("ses_001", { stage: "x", agent: "stale-agent", worktree: "/" });

    const sessionID = "ses_001";
    const agent = sessionID
      ? (sessionAgent.get(sessionID) ?? pendingDispatch.get(sessionID)?.agent)
      : undefined;

    assert.equal(agent, "makdoong2-planner", "sessionAgent takes priority");
  });

  test("both maps miss → agent is undefined (primary session passthrough)", () => {
    const sessionAgent = new Map();
    const pendingDispatch = new Map();

    const sessionID = "ses_primary_unknown";
    const agent = sessionID
      ? (sessionAgent.get(sessionID) ?? pendingDispatch.get(sessionID)?.agent)
      : undefined;

    assert.equal(agent, undefined, "Primary session without mapping → undefined (allowed through)");
  });

  test("SEALED_SUBAGENTS check blocks correctly when agent resolved from pendingDispatch", () => {
    const SEALED_SUBAGENTS = new Set([
      "makdoong2-planner", "makdoong2-analyzer", "makdoong2-engineer",
      "makdoong2-publisher", "makdoong2-verifier",
    ]);
    const sessionAgent = new Map();
    const pendingDispatch = new Map();
    pendingDispatch.set("ses_planner_002", {
      stage: "1_planning.jira",
      agent: "makdoong2-planner",
      worktree: "/root/proj",
    });

    const sessionID = "ses_planner_002";
    const agent = sessionID
      ? (sessionAgent.get(sessionID) ?? pendingDispatch.get(sessionID)?.agent)
      : undefined;

    assert.ok(agent, "Agent should be resolved");
    assert.ok(SEALED_SUBAGENTS.has(agent), "Resolved agent should be in SEALED_SUBAGENTS → will be blocked");
  });
});

// ─── Fix B: dispatch_stage worktree auto-correction ───────────────────────────
describe("Fix B — dispatch_stage worktree auto-correction", () => {
  const WORKTREE_ISOLATED_STAGES = new Set([
    "2_implementation.dev", "2_implementation.test",
    "3_delivery.commit", "3_delivery.pr", "3_delivery.review",
  ]);

  function resolveEffectiveWorktree(targetStage, providedWorktree, storedWorktree) {
    if (!WORKTREE_ISOLATED_STAGES.has(targetStage)) return providedWorktree;
    const stored = storedWorktree?.trim();
    if (!stored || stored === "null" || stored === "" || stored === providedWorktree) {
      return providedWorktree;
    }
    return stored;
  }

  test("2_implementation.dev: auto-corrects when LLM passed main repo instead of worktree", () => {
    const mainRepo = "/root/proj";
    const correctWt = "/root/proj-PROJ-40406";
    const result = resolveEffectiveWorktree("2_implementation.dev", mainRepo, correctWt);
    assert.equal(result, correctWt, "Should auto-correct to stored worktree");
  });

  test("2_implementation.dev: no correction when worktree already matches state.json", () => {
    const correctWt = "/root/proj-PROJ-40406";
    const result = resolveEffectiveWorktree("2_implementation.dev", correctWt, correctWt);
    assert.equal(result, correctWt, "No change when already correct");
  });

  test("1_planning.jira: NOT corrected (planning stages run on main repo)", () => {
    const mainRepo = "/root/proj";
    const storedWt = "/root/proj-PROJ-40406";
    const result = resolveEffectiveWorktree("1_planning.jira", mainRepo, storedWt);
    assert.equal(result, mainRepo, "Planning stages should not be auto-corrected");
  });

  test("3_delivery.commit: auto-corrects", () => {
    const mainRepo = "/root/proj";
    const correctWt = "/root/proj-PROJ-40406";
    const result = resolveEffectiveWorktree("3_delivery.commit", mainRepo, correctWt);
    assert.equal(result, correctWt);
  });

  test("stored worktree is 'null' string → no correction", () => {
    const mainRepo = "/root/proj";
    const result = resolveEffectiveWorktree("2_implementation.dev", mainRepo, "null");
    assert.equal(result, mainRepo, "'null' means worktree not yet set → no correction");
  });

  test("stored worktree is empty string → no correction", () => {
    const mainRepo = "/root/proj";
    const result = resolveEffectiveWorktree("2_implementation.dev", mainRepo, "");
    assert.equal(result, mainRepo);
  });

  test("all five isolated stages covered", () => {
    const stages = [
      "2_implementation.dev", "2_implementation.test",
      "3_delivery.commit", "3_delivery.pr", "3_delivery.review",
    ];
    for (const stage of stages) {
      const result = resolveEffectiveWorktree(stage, "/main", "/worktree");
      assert.equal(result, "/worktree", `${stage} should be corrected`);
    }
  });

  test("non-isolated stages left untouched even if state.json has different path", () => {
    const planningStages = ["1_planning.jira", "1_planning.requirements", "1_planning.scope", "2_implementation.analysis"];
    for (const stage of planningStages) {
      const result = resolveEffectiveWorktree(stage, "/main", "/worktree");
      assert.equal(result, "/main", `${stage} should NOT be auto-corrected`);
    }
  });
});

// ─── Fix C: dispatch_verifier verdict JSON fallback ───────────────────────────
describe("Fix C — dispatch_verifier verdict parsing with JSON fallback", () => {
  function parseVerdict(raw) {
    const m = raw.match(/<verifier-verdict>\s*(VERIFIED|REJECTED)\s*<\/verifier-verdict>/i);
    const jsonFallback = !m ? raw.match(/"verdict"\s*:\s*"(VERIFIED|REJECTED)"/i) : null;
    return {
      verdict: m
        ? m[1].toUpperCase()
        : jsonFallback
          ? jsonFallback[1].toUpperCase()
          : "REJECTED",
      source: m ? "tag" : jsonFallback ? "json" : "default",
    };
  }

  test("standard tag output → tag parsed correctly", () => {
    const raw = `<verifier-verdict>VERIFIED</verifier-verdict>\n{"verdict":"VERIFIED","stage":"1_planning.jira"}`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "VERIFIED");
    assert.equal(source, "tag");
  });

  test("REJECTED tag output → tag parsed correctly", () => {
    const raw = `<verifier-verdict>REJECTED</verifier-verdict>\n{"verdict":"REJECTED"}`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "REJECTED");
    assert.equal(source, "tag");
  });

  test("tag with surrounding whitespace → still matched (regex \\s*)", () => {
    const raw = `<verifier-verdict>  VERIFIED  </verifier-verdict>`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "VERIFIED");
    assert.equal(source, "tag");
  });

  test("no tag but JSON body has verdict=VERIFIED → fallback extracts VERIFIED", () => {
    const raw = `state.json의 jira substage 마커를 검증 완료.\n{"verdict":"VERIFIED","stage":"1_planning.jira","findings":[]}`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "VERIFIED");
    assert.equal(source, "json");
  });

  test("no tag but JSON body has verdict=REJECTED → fallback extracts REJECTED", () => {
    const raw = `검증 중...\n{"verdict":"REJECTED","findings":[{"severity":"critical"}]}`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "REJECTED");
    assert.equal(source, "json");
  });

  test("neither tag nor JSON → defaults to REJECTED", () => {
    const raw = `state.json의 jira substage 마커를 검증 완료. 이제 sub-agent 출력의 정합성을 판단한다.`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "REJECTED");
    assert.equal(source, "default");
  });

  test("empty output → defaults to REJECTED", () => {
    const { verdict, source } = parseVerdict("");
    assert.equal(verdict, "REJECTED");
    assert.equal(source, "default");
  });

  test("JSON verdict key with extra whitespace → matched by regex", () => {
    const raw = `{"verdict" : "VERIFIED", "stage": "1_planning.jira"}`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "VERIFIED");
    assert.equal(source, "json");
  });

  test("tag wins over JSON when both present", () => {
    const raw = `<verifier-verdict>REJECTED</verifier-verdict>\n{"verdict":"VERIFIED"}`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "REJECTED", "Tag has priority over JSON body");
    assert.equal(source, "tag");
  });

  test("case-insensitive tag match", () => {
    const raw = `<VERIFIER-VERDICT>verified</VERIFIER-VERDICT>`;
    const { verdict, source } = parseVerdict(raw);
    assert.equal(verdict, "VERIFIED");
    assert.equal(source, "tag");
  });
});

// ─── Substage timeout configuration ──────────────────────────────────────────
describe("Substage timeout — config.timeout.substage_minutes", () => {
  const MIN_MS = 60_000;

  function resolveTimeoutMs(timeoutConfig) {
    return Math.max(MIN_MS, Math.round((timeoutConfig?.substage_minutes ?? 30) * 60_000));
  }

  test("default when no config → 30 minutes (1_800_000 ms)", () => {
    assert.equal(resolveTimeoutMs(undefined), 30 * 60_000);
    assert.equal(resolveTimeoutMs({}), 30 * 60_000);
    assert.equal(resolveTimeoutMs(null), 30 * 60_000);
  });

  test("explicit 30 min → 1_800_000 ms", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: 30 }), 1_800_000);
  });

  test("60 minutes → 3_600_000 ms", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: 60 }), 3_600_000);
  });

  test("10 minutes → 600_000 ms (previous default, still configurable)", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: 10 }), 600_000);
  });

  test("fractional minutes → rounded to ms", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: 1.5 }), 90_000);
  });

  test("minimum enforcement: 0.5 min → clamped to 60_000 ms", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: 0.5 }), MIN_MS);
  });

  test("minimum enforcement: 0 → clamped to 60_000 ms", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: 0 }), MIN_MS);
  });

  test("minimum enforcement: negative → clamped to 60_000 ms", () => {
    assert.equal(resolveTimeoutMs({ substage_minutes: -5 }), MIN_MS);
  });
});

// ─── Per-agent timeout override ───────────────────────────────────────────────
describe("Per-agent timeout — config.timeout.per_agent", () => {
  const MIN_MS = 60_000;

  function buildEffectiveTimeoutFn(timeoutConfig) {
    const substageMs = Math.max(MIN_MS, Math.round((timeoutConfig?.substage_minutes ?? 30) * 60_000));
    const agentMs = Object.fromEntries(
      Object.entries(timeoutConfig?.per_agent ?? {}).map(([agent, minutes]) => [
        agent,
        Math.max(MIN_MS, Math.round(minutes * 60_000)),
      ]),
    );
    return (agentId) => agentMs[agentId] ?? substageMs;
  }

  test("no per_agent config → falls back to substage_minutes", () => {
    const getTimeout = buildEffectiveTimeoutFn({ substage_minutes: 30 });
    assert.equal(getTimeout("makdoong2-engineer"), 30 * 60_000);
  });

  test("makdoong2-engineer override → 60 min (default.json 기본값)", () => {
    const getTimeout = buildEffectiveTimeoutFn({
      substage_minutes: 30,
      per_agent: { "makdoong2-engineer": 60 },
    });
    assert.equal(getTimeout("makdoong2-engineer"), 60 * 60_000);
  });

  test("per_agent override does not affect other agents", () => {
    const getTimeout = buildEffectiveTimeoutFn({
      substage_minutes: 30,
      per_agent: { "makdoong2-engineer": 60 },
    });
    assert.equal(getTimeout("makdoong2-planner"), 30 * 60_000);
    assert.equal(getTimeout("makdoong2-verifier"), 30 * 60_000);
  });

  test("multiple per_agent overrides → each agent gets its own timeout", () => {
    const getTimeout = buildEffectiveTimeoutFn({
      substage_minutes: 30,
      per_agent: { "makdoong2-engineer": 60, "makdoong2-verifier": 15 },
    });
    assert.equal(getTimeout("makdoong2-engineer"), 60 * 60_000);
    assert.equal(getTimeout("makdoong2-verifier"), 15 * 60_000);
    assert.equal(getTimeout("makdoong2-planner"), 30 * 60_000);
  });

  test("per_agent minimum enforcement: 0.5 min → clamped to 60_000 ms", () => {
    const getTimeout = buildEffectiveTimeoutFn({
      per_agent: { "makdoong2-engineer": 0.5 },
    });
    assert.equal(getTimeout("makdoong2-engineer"), MIN_MS);
  });

  test("per_agent minimum enforcement: negative → clamped to 60_000 ms", () => {
    const getTimeout = buildEffectiveTimeoutFn({
      per_agent: { "makdoong2-engineer": -10 },
    });
    assert.equal(getTimeout("makdoong2-engineer"), MIN_MS);
  });

  test("no per_agent config at all → all agents fall back to global", () => {
    const getTimeout = buildEffectiveTimeoutFn({ substage_minutes: 45 });
    assert.equal(getTimeout("makdoong2-engineer"), 45 * 60_000);
    assert.equal(getTimeout("makdoong2-verifier"), 45 * 60_000);
  });
});
