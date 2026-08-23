// smoke-test.mjs — Node 18+ compatible smoke test for the model-fallback-policy logic.
// Mirrors src/model-fallback-policy.ts via scripts/model-policy.mjs so we can
// validate without bun/typescript installed.
//
// Run: node scripts/smoke-test.mjs
// Exits 0 on all-pass, 1 on any failure.

import {
  DEFAULT_ALLOWED_PRIMARIES,
  DEFAULT_POLICIES,
  nextModel,
  validatePolicies,
  buildPoliciesFromConfig,
} from "./model-policy.mjs";

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    got:      ${JSON.stringify(a)}`);
  }
};
const assertThrows = (fn, matcher, msg) => {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(`${msg}: expected throw, got none`);
  if (matcher && !matcher.test(thrown.message)) {
    throw new Error(`${msg}: message did not match ${matcher}\n    got: ${thrown.message}`);
  }
};

console.log("\n[smoke-test] model-fallback-policy chain logic\n");

// ── Default chain semantics ──

t("makdoong2-team-leader: gpt-5.6-luna → haiku on first failure", () => {
  const r = nextModel({ agent: "makdoong2-team-leader", current: "github-copilot/gpt-5.6-luna", reason: "rate_limit" });
  eq(r.exhausted, false, "should not be exhausted");
  eq(r.next.id, "github-copilot/claude-haiku-4.5", "next should be haiku-4.5");
});

t("makdoong2-team-leader: haiku → exhausted after second failure", () => {
  const r = nextModel({ agent: "makdoong2-team-leader", current: "github-copilot/claude-haiku-4.5" });
  eq(r.exhausted, true, "should be exhausted");
  eq(r.next, null, "next should be null");
});

t("makdoong2-planner: gpt-5.6-luna → haiku", () => {
  const r = nextModel({ agent: "makdoong2-planner", current: "github-copilot/gpt-5.6-luna", reason: "5xx" });
  eq(r.next.id, "github-copilot/claude-haiku-4.5", "planner fallback should be haiku");
});

t("makdoong2-engineer: gpt-5.6-luna → haiku (lower-tier degrade)", () => {
  const r = nextModel({ agent: "makdoong2-engineer", current: "github-copilot/gpt-5.6-luna", reason: "context_exceeded" });
  eq(r.next.id, "github-copilot/claude-haiku-4.5", "engineer fallback should be haiku");
});

t("makdoong2-publisher: gpt-5.6-luna → haiku", () => {
  const r = nextModel({ agent: "makdoong2-publisher", current: "github-copilot/gpt-5.6-luna" });
  eq(r.next.id, "github-copilot/claude-haiku-4.5", "publisher fallback should be haiku");
});

t("makdoong2-verifier: gpt-5.6-luna → haiku", () => {
  const r = nextModel({ agent: "makdoong2-verifier", current: "github-copilot/gpt-5.6-luna" });
  eq(r.next.id, "github-copilot/claude-haiku-4.5", "verifier fallback should be haiku");
});

t("unknown agent returns exhausted", () => {
  const r = nextModel({ agent: "stage99-fictional", current: "any" });
  eq(r.exhausted, true, "unknown agent should be exhausted");
});

t("unknown current model starts from primary", () => {
  const r = nextModel({ agent: "makdoong2-team-leader", current: "anthropic/claude-fictional" });
  eq(r.next.id, "github-copilot/gpt-5.6-luna", "unknown current should start at primary");
});

t("all default primaries are in DEFAULT_ALLOWED_PRIMARIES", () => {
  for (const [agent, policy] of Object.entries(DEFAULT_POLICIES)) {
    if (!DEFAULT_ALLOWED_PRIMARIES.has(policy.primary.id)) {
      throw new Error(`'${agent}' primary '${policy.primary.id}' is not allowed`);
    }
  }
});

t("all fallback tiers are strictly lower than primary tier", () => {
  validatePolicies(DEFAULT_POLICIES, DEFAULT_ALLOWED_PRIMARIES);
});

// ── Config-driven overrides ──

t("agents block: primary + fallback override (string form, backward-compat)", () => {
  const { policies } = buildPoliciesFromConfig({
    agents: {
      "makdoong2-engineer": {
        model: "github-copilot/claude-sonnet-4.6",
        fallback_models: ["github-copilot/claude-haiku-4.5"],
      },
    },
  });
  eq(policies["makdoong2-engineer"].primary.id, "github-copilot/claude-sonnet-4.6", "primary updated");
  eq(policies["makdoong2-engineer"].fallbacks.map(f => f.id), ["github-copilot/claude-haiku-4.5"], "fallbacks set");
  eq(policies["makdoong2-engineer"].fallbacks[0].tier, "low", "string-form fallback defaults to tier=low");
});

t("agents block: fallback object form {id, tier} accepted", () => {
  const { policies } = buildPoliciesFromConfig({
    agents: {
      "makdoong2-planner": {
        model: "github-copilot/claude-sonnet-4.6",
        fallback_models: [{ id: "github-copilot/claude-haiku-4.5", tier: "low" }],
      },
    },
  });
  eq(policies["makdoong2-planner"].fallbacks[0], { id: "github-copilot/claude-haiku-4.5", tier: "low" }, "object-form preserved");
});

t("model_policy.allowed_primaries: extends default allow-list", () => {
  const { policies, allowed } = buildPoliciesFromConfig({
    model_policy: { allowed_primaries: ["custom-provider/custom-model"] },
    agents: {
      "makdoong2-engineer": {
        model: "custom-provider/custom-model",
        fallback_models: ["github-copilot/claude-haiku-4.5"],
      },
    },
  });
  eq(allowed.has("custom-provider/custom-model"), true, "extra primary allowed");
  eq(allowed.has("local/qwen3.6-27b"), true, "built-in defaults preserved");
  eq(policies["makdoong2-engineer"].primary.id, "custom-provider/custom-model", "custom primary set");
});

t("validation rejects primary outside allow-list (no model_policy extension)", () => {
  assertThrows(
    () => buildPoliciesFromConfig({
      agents: { "makdoong2-engineer": { model: "rogue-provider/rogue-model" } },
    }),
    /violates policy/,
    "should reject unlisted primary",
  );
});

t("validation rejects fallback tier >= primary tier", () => {
  assertThrows(
    () => buildPoliciesFromConfig({
      agents: {
        "makdoong2-engineer": {
          model: "local/qwen3.6-27b",
          fallback_models: [{ id: "github-copilot/claude-haiku-4.5", tier: "medium" }],
        },
      },
    }),
    /not strictly lower/,
    "fallback at primary tier must be rejected",
  );
});

t("validation rejects invalid tier label", () => {
  assertThrows(
    () => buildPoliciesFromConfig({
      agents: {
        "makdoong2-engineer": {
          model: "local/qwen3.6-27b",
          fallback_models: [{ id: "github-copilot/claude-haiku-4.5", tier: "ultra" }],
        },
      },
    }),
    /not a valid tier/,
    "unknown tier must be rejected",
  );
});

t("build is pure: invalid config throws but does not mutate DEFAULT_POLICIES", () => {
  const before = JSON.stringify(DEFAULT_POLICIES);
  try {
    buildPoliciesFromConfig({
      agents: { "makdoong2-engineer": { model: "rogue-provider/rogue-model" } },
    });
  } catch { /* expected */ }
  const after = JSON.stringify(DEFAULT_POLICIES);
  eq(after, before, "DEFAULT_POLICIES must remain untouched after a failed override");
});

t("empty config returns defaults verbatim", () => {
  const { policies, allowed } = buildPoliciesFromConfig({});
  eq(Object.keys(policies).sort(), Object.keys(DEFAULT_POLICIES).sort(), "same agent set");
  eq(allowed.size, DEFAULT_ALLOWED_PRIMARIES.size, "no extra primaries added");
});

console.log(`\n[smoke-test] ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
