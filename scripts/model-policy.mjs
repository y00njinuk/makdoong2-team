// model-policy.mjs — JS mirror of src/model-fallback-policy.ts.
//
// Why mirror: bin/cli.js and scripts/smoke-test.mjs need to run under plain
// `node` (no bun, no transpile) — npx-friendly. The TS source is the canonical
// definition; this mirror MUST be kept structurally in sync. The smoke test
// asserts the mirror matches the runtime behavior described in the TS source.
//
// Shared by:
//   - scripts/smoke-test.mjs (chain logic tests)
//   - bin/cli.js (`validate` subcommand — checks user config without bun)



export const DEFAULT_ALLOWED_PRIMARIES = new Set([
  "github-copilot/claude-haiku-4.5",
  "github-copilot/claude-opus-4.5",
  "github-copilot/claude-opus-4.6",
  "github-copilot/claude-opus-4.6-fast",
  "github-copilot/claude-opus-4.7",
  "github-copilot/claude-opus-4.7-fast",
  "github-copilot/claude-opus-4.8",
  "github-copilot/claude-opus-4.8-fast",
  "github-copilot/claude-opus-41",
  "github-copilot/claude-sonnet-4",
  "github-copilot/claude-sonnet-4.5",
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/claude-sonnet-5",
  "github-copilot/gemini-2.5-pro",
  "github-copilot/gemini-3-flash-preview",
  "github-copilot/gemini-3-pro-preview",
  "github-copilot/gemini-3.1-pro-preview",
  "github-copilot/gemini-3.5-flash",
  "github-copilot/gpt-4.1",
  "github-copilot/gpt-4o",
  "github-copilot/gpt-5",
  "github-copilot/gpt-5-mini",
  "github-copilot/gpt-5.1",
  "github-copilot/gpt-5.1-codex",
  "github-copilot/gpt-5.1-codex-max",
  "github-copilot/gpt-5.1-codex-mini",
  "github-copilot/gpt-5.2",
  "github-copilot/gpt-5.2-codex",
  "github-copilot/gpt-5.3-codex",
  "github-copilot/gpt-5.4",
  "github-copilot/gpt-5.4-mini",
  "github-copilot/gpt-5.5",
  "github-copilot/gpt-5.6-luna",
  "github-copilot/gpt-5.6-sol",
  "github-copilot/gpt-5.6-terra",
  "github-copilot/grok-code-fast-1",
  "github-copilot/kimi-k2.7-code",
  "github-copilot/mai-code-1-flash-picker",
  "local/qwen3.6-27b",
  "local/qwen3.6-35b-a3b",
]);

export const TIER_RANK = { low: 1, medium: 2, high: 3, max: 4 };

// Mirrors POLICIES in src/model-fallback-policy.ts. 5 agents matching
// agent-stage-config.ts (team-leader + planner/engineer/publisher/verifier).
export const DEFAULT_POLICIES = Object.freeze({
  "makdoong2-team-leader": {
    primary:   { id: "local/qwen3.6-27b",                    variant: "high",   tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-analyzer": {
    primary:   { id: "local/qwen3.6-27b",                    variant: "high",   tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-planner": {
    primary:   { id: "local/qwen3.6-27b",                    variant: "high",   tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-engineer": {
    primary:   { id: "local/qwen3.6-27b",                    variant: "medium", tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-publisher": {
    primary:   { id: "local/qwen3.6-27b",                    variant: "high",   tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-verifier": {
    primary:   { id: "local/qwen3.6-27b",                                        tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
});

function clonePolicies(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = { primary: { ...v.primary }, fallbacks: v.fallbacks.map(f => ({ ...f })) };
  }
  return out;
}

export function nextModel({ agent, current, reason }, policies) {
  const pol = (policies ?? DEFAULT_POLICIES)[agent];
  if (!pol) return { next: null, exhausted: true, chain: [], reasonAccepted: "unknown agent" };
  const chain = [pol.primary, ...pol.fallbacks];
  const idx = chain.findIndex(m => m.id === current);
  const nextIdx = idx < 0 ? 0 : idx + 1;
  if (nextIdx >= chain.length) {
    return { next: null, exhausted: true, chain, reasonAccepted: reason ?? "unknown" };
  }
  return { next: chain[nextIdx], exhausted: false, chain, reasonAccepted: reason ?? "unknown" };
}

export function validatePolicies(policies, allowedPrimaries) {
  const allowed = allowedPrimaries ?? DEFAULT_ALLOWED_PRIMARIES;
  for (const [agent, pol] of Object.entries(policies)) {
    if (!allowed.has(pol.primary.id)) {
      throw new Error(
        `agent '${agent}' primary '${pol.primary.id}' violates policy ` +
        `(allowed: ${[...allowed].join(", ")})`
      );
    }
    const primaryRank = TIER_RANK[pol.primary.tier];
    if (primaryRank === undefined) {
      throw new Error(`agent '${agent}' primary tier '${pol.primary.tier}' is not a valid tier`);
    }
    for (const fb of pol.fallbacks) {
      const r = TIER_RANK[fb.tier];
      if (r === undefined) {
        throw new Error(`agent '${agent}' fallback '${fb.id}' tier '${fb.tier}' is not a valid tier`);
      }
      if (r >= primaryRank) {
        throw new Error(
          `agent '${agent}' fallback '${fb.id}' (tier=${fb.tier}) is not strictly lower than ` +
          `primary (tier=${pol.primary.tier})`
        );
      }
    }
  }
}

function normalizeFallback(entry) {
  if (typeof entry === "string") return { id: entry, tier: "low" };
  if (entry && typeof entry === "object" && typeof entry.id === "string") {
    return { id: entry.id, tier: entry.tier ?? "low" };
  }
  throw new Error(`invalid fallback_models entry: ${JSON.stringify(entry)}`);
}

/**
 * Apply agents + model_policy overrides to a fresh copy of DEFAULT_POLICIES.
 * Returns { policies, allowed } on success.
 * Throws on validation failure (CALLER must decide whether to surface or roll back).
 *
 * This mirrors src/model-fallback-policy.ts:applyConfigOverrides except it
 * returns a new structure instead of mutating module-level state — CLI tools
 * need pure functions for "validate-without-applying" semantics.
 */
export function buildPoliciesFromConfig({ agents, model_policy } = {}) {
  const policies = clonePolicies(DEFAULT_POLICIES);
  const allowed = new Set(DEFAULT_ALLOWED_PRIMARIES);

  if (model_policy && Array.isArray(model_policy.allowed_primaries)) {
    for (const id of model_policy.allowed_primaries) {
      if (typeof id === "string" && id.length > 0) allowed.add(id);
    }
  }

  if (agents && typeof agents === "object") {
    for (const [agent, ov] of Object.entries(agents)) {
      if (!ov || typeof ov !== "object" || !ov.model) continue;
      const existing = policies[agent];
      const tier = existing?.primary.tier ?? "medium";
      const rawFb =
        ov.fallback_models == null
          ? (existing?.fallbacks.map(f => ({ id: f.id, tier: f.tier })) ?? [])
          : Array.isArray(ov.fallback_models)
            ? ov.fallback_models
            : [ov.fallback_models];
      policies[agent] = {
        primary: { id: ov.model, variant: ov.variant ?? existing?.primary.variant, tier },
        fallbacks: rawFb.map(normalizeFallback),
      };
    }
  }

  validatePolicies(policies, allowed);
  return { policies, allowed };
}
