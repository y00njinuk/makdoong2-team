import { logger } from "./logger.ts";

// model-fallback-policy.ts — primary → fallback chain registry.
// Replaces oh-my-openagent's fallback_models / variant routing.
//
// Policy constraints (enforced by validatePolicies() at module load):
//   1. Primary model is one of ALLOWED_PRIMARIES — github-copilot/* + local/*
//      브랜드가 기본 허용 목록. makdoong2-team.json `model_policy.allowed_primaries`
//      로 확장 가능.
//   2. Every fallback tier is strictly lower than the primary tier.
//
// Plugin alone cannot intercept the actual LLM call, so we expose this
// table via a plugin tool. Two consumption paths:
//   (a) Agent reads `next_model(current, reason)` when it sees a 429/error
//       and re-invokes itself with the suggested model.
//   (b) External wrapper (scripts/with-fallback.sh) parses opencode exit
//       codes and re-runs with the next model. Production-ready path.

export type ModelTier = "low" | "medium" | "high" | "max";

export interface ModelSpec {
  id: string;             // provider/model
  variant?: "low" | "medium" | "high" | "xhigh" | "max";
  tier: ModelTier;
}

export interface AgentModelPolicy {
  primary: ModelSpec;
  fallbacks: ModelSpec[];  // tried in order; each tier must be < primary.tier
}

// Built-in primary allow-list. The runtime allow-list (`getAllowedPrimaries()`)
// is the union of these defaults and any extra IDs supplied by the user via
// `makdoong2-team.json` `model_policy.allowed_primaries`. Defaults are kept
// in the set so a typo in user config can never lock out the built-in primaries.
export const DEFAULT_ALLOWED_PRIMARIES: ReadonlySet<string> = new Set([
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

// Backwards-compat re-export (read-only snapshot of the *current* runtime set).
// External callers should prefer getAllowedPrimaries(); this binding stays
// in place for existing imports/tests.
export let ALLOWED_PRIMARIES: ReadonlySet<string> = new Set(DEFAULT_ALLOWED_PRIMARIES);

// User-supplied additions (from `model_policy.allowed_primaries`).
let _extraAllowedPrimaries: ReadonlySet<string> = new Set();

/** Current runtime allow-list (defaults ∪ extras). */
export function getAllowedPrimaries(): ReadonlySet<string> {
  return ALLOWED_PRIMARIES;
}

/** Tier rank for the "fallback strictly lower than primary" invariant. */
const TIER_RANK: Record<ModelTier, number> = { low: 1, medium: 2, high: 3, max: 4 };

/** Public read-only accessor — single place documenting tier ordering. */
export function tierRank(tier: ModelTier): number {
  return TIER_RANK[tier];
}

// Default chains. All agents now use github-copilot/gpt-5.6-luna (variant xhigh) as primary (medium tier).
// Fallback chain degrades to strictly lower tier. Override per-agent via 
// makdoong2-team.json `agents` block.
export const POLICIES: Record<string, AgentModelPolicy> = {
  "makdoong2-team-leader": {
    primary:   { id: "github-copilot/gpt-5.6-luna",          variant: "xhigh",  tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-analyzer": {
    primary:   { id: "github-copilot/gpt-5.6-luna",          variant: "xhigh",  tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  // Research fan-out worker — one session per source, spawned in parallel.
  "makdoong2-planner": {
    primary:   { id: "github-copilot/gpt-5.6-luna",          variant: "xhigh",  tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-engineer": {
    primary:   { id: "github-copilot/gpt-5.6-luna",          variant: "xhigh",  tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-publisher": {
    primary:   { id: "github-copilot/gpt-5.6-luna",          variant: "xhigh",  tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
  "makdoong2-verifier": {
    primary:   { id: "github-copilot/gpt-5.6-luna",          variant: "xhigh",  tier: "medium" },
    fallbacks: [{ id: "github-copilot/claude-haiku-4.5",                         tier: "low" }],
  },
};

export interface NextModelInput {
  agent: string;
  current: string;       // model id that just failed
  reason?: string;       // e.g., "rate_limit", "context_exceeded", "5xx"
}

export interface NextModelResult {
  next: ModelSpec | null;     // null => exhausted
  exhausted: boolean;
  chain: ModelSpec[];          // full chain for display
  reasonAccepted: string;
}

/** Picks the next model in the chain. Idempotent — call with the same `current` and you get the same `next`. */
export function nextModel(input: NextModelInput): NextModelResult {
  const policy = POLICIES[input.agent];
  if (!policy) return { next: null, exhausted: true, chain: [], reasonAccepted: "unknown agent" };
  const chain = [policy.primary, ...policy.fallbacks];
  const idx = chain.findIndex(m => m.id === input.current);
  // If current isn't in chain, start from the beginning. Otherwise advance.
  const nextIdx = idx < 0 ? 0 : idx + 1;
  if (nextIdx >= chain.length) {
    return { next: null, exhausted: true, chain, reasonAccepted: input.reason ?? "unknown" };
  }
  return { next: chain[nextIdx], exhausted: false, chain, reasonAccepted: input.reason ?? "unknown" };
}

/**
 * Validates the two policy invariants. Throws on violation so a malformed
 * default table or env override fails fast at plugin load.
 *   1. policy.primary.id ∈ ALLOWED_PRIMARIES (= defaults ∪ extras)
 *   2. ∀ fb ∈ policy.fallbacks: TIER_RANK[fb.tier] < TIER_RANK[policy.primary.tier]
 */
export function validatePolicies(policies: Record<string, AgentModelPolicy> = POLICIES): void {
  for (const [agent, policy] of Object.entries(policies)) {
    if (!ALLOWED_PRIMARIES.has(policy.primary.id)) {
      throw new Error(
        `[model-router] agent '${agent}' primary '${policy.primary.id}' violates policy ` +
        `(allowed: ${[...ALLOWED_PRIMARIES].join(", ")})`
      );
    }
    // tier 라벨 유효성을 먼저 확인한다. 이것이 없으면 `TIER_RANK["ultra"]` 가
    // undefined 가 되고 `NaN >= primaryRank` 는 **항상 false** 라서 "폴백은
    // primary 보다 엄격히 낮아야 한다" 는 불변식이 조용히 통과된다. 실측 확인:
    // 런타임이 {"tier":"ultra"} 를 그대로 수용했다. 미러(scripts/model-policy.mts)
    // 는 이 검사를 갖고 있어서 CLI 와 런타임의 판정이 갈렸다.
    const primaryRank = TIER_RANK[policy.primary.tier];
    if (primaryRank === undefined) {
      throw new Error(
        `[model-router] agent '${agent}' primary tier '${policy.primary.tier}' is not a valid tier ` +
        `(low | medium | high | max)`
      );
    }
    for (const fb of policy.fallbacks) {
      if (typeof fb.id !== "string" || fb.id.length === 0) {
        throw new Error(
          `[model-router] agent '${agent}' fallback 에 모델 id 가 없다: ${JSON.stringify(fb)}`
        );
      }
      const fbRank = TIER_RANK[fb.tier];
      if (fbRank === undefined) {
        throw new Error(
          `[model-router] agent '${agent}' fallback '${fb.id}' tier '${fb.tier}' is not a valid tier ` +
          `(low | medium | high | max)`
        );
      }
      if (fbRank >= primaryRank) {
        throw new Error(
          `[model-router] agent '${agent}' fallback '${fb.id}' (tier=${fb.tier}) is not ` +
          `strictly lower than primary (tier=${policy.primary.tier})`
        );
      }
    }
  }
}

/**
 * Fallback override spec — either a bare model ID (tier defaults to "low" for
 * backward compatibility) or an object with an explicit tier.
 */
export type FallbackOverride = string | { id: string; tier?: ModelTier };

/** omo-style flat per-agent override read from makdoong2-team.json `agents` block. */
export interface AgentOverrideInput {
  model?: string;
  variant?: ModelSpec["variant"];
  /** Either ID(s) (tier defaults to "low") or {id, tier?} objects. */
  fallback_models?: FallbackOverride | FallbackOverride[];
}

/** Site-level model policy overrides (extends built-in defaults). */
export interface ModelPolicyOverrideInput {
  /** Extra primary model IDs to allow on top of DEFAULT_ALLOWED_PRIMARIES. */
  allowed_primaries?: string[];
}

/**
 * Normalize a fallback override entry → { id, tier }.
 *
 * 입력은 사용자가 쓴 makdoong2-team.json 이라 타입을 신뢰할 수 없다. 종전 구현은
 * `entry.id` 를 검사하지 않아서 `fallback_models: [{}]` 이 `{id: undefined,
 * tier:"low"}` 가 됐고, 그것이 `dist/model-chain-cli.js` 를 거쳐
 * `scripts/with-fallback.sh` 의 `jq -r ".[$i].id"` 에서 `null` 로 나와
 * **`opencode --model null`** 이 실행됐다. 미러는 이 경우 throw 한다.
 */
function normalizeFallback(entry: FallbackOverride): { id: string; tier: ModelTier } {
  if (typeof entry === "string") return { id: entry, tier: "low" };
  if (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.length > 0) {
    return { id: entry.id, tier: entry.tier ?? "low" };
  }
  throw new Error(`[model-router] invalid fallback_models entry: ${JSON.stringify(entry)}`);
}

/** Deep snapshot of a policies dict so we can roll back on validation failure. */
function snapshotPolicies(src: Record<string, AgentModelPolicy>): Record<string, AgentModelPolicy> {
  const out: Record<string, AgentModelPolicy> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = {
      primary: { ...v.primary },
      fallbacks: v.fallbacks.map(f => ({ ...f })),
    };
  }
  return out;
}

/** Restore POLICIES in place from a snapshot (preserves the exported binding). */
function restorePolicies(snapshot: Record<string, AgentModelPolicy>): void {
  for (const k of Object.keys(POLICIES)) delete POLICIES[k];
  for (const [k, v] of Object.entries(snapshot)) POLICIES[k] = v;
}

/** Recompute the runtime ALLOWED_PRIMARIES (defaults ∪ extras). */
function recomputeAllowedPrimaries(): void {
  const merged = new Set<string>(DEFAULT_ALLOWED_PRIMARIES);
  for (const id of _extraAllowedPrimaries) merged.add(id);
  ALLOWED_PRIMARIES = merged;
}

/**
 * Apply per-agent overrides + model_policy overrides from makdoong2-team.json
 * onto POLICIES and the runtime ALLOWED_PRIMARIES, then re-validate.
 *
 * Atomicity: on any validation failure, BOTH POLICIES and ALLOWED_PRIMARIES
 * are restored to their pre-call snapshot so the runtime can keep loading
 * with the built-in defaults instead of a half-applied corrupt state.
 *
 * Kept dependency-free (the blocks are passed in by the caller, not read here)
 * so scripts/smoke-test.mjs can mirror this module without a config dependency.
 */
export function applyConfigOverrides(
  agents?: Record<string, AgentOverrideInput | undefined>,
  modelPolicy?: ModelPolicyOverrideInput,
): void {
  // Always snapshot — even a no-op call should leave defaults intact on early throw.
  const policiesSnapshot = snapshotPolicies(POLICIES);
  const extrasSnapshot = new Set(_extraAllowedPrimaries);
  const allowedSnapshot = ALLOWED_PRIMARIES;

  try {
    // 1) Site-level allow-list extension first, so per-agent overrides can
    //    legitimately reference newly-allowed primaries.
    if (modelPolicy?.allowed_primaries !== undefined) {
      // 종전에는 타입 검사 없이 `.filter` 를 불러서, 문자열 하나를 쓴 설정
      // (`"allowed_primaries": "provider/model"`) 이 TypeError → 전체 롤백을
      // 유발했다. 그런데 `npx makdoong2-team validate` 는 같은 설정에 OK ✓ 와
      // 적용된 체인을 출력했다 — CLI 가 실제로 쓰일 모델을 오보한 것이다.
      // 이제 두 구현이 같은 메시지로 거부한다.
      if (!Array.isArray(modelPolicy.allowed_primaries)) {
        throw new Error(
          `[model-router] model_policy.allowed_primaries 는 문자열 배열이어야 한다 ` +
          `(받은 값: ${JSON.stringify(modelPolicy.allowed_primaries)})`
        );
      }
      _extraAllowedPrimaries = new Set(modelPolicy.allowed_primaries.filter(s => typeof s === "string" && s.length > 0));
      recomputeAllowedPrimaries();
    }

    // 2) Per-agent overrides.
    if (agents) {
      for (const [agent, ov] of Object.entries(agents)) {
        if (!ov || !ov.model) continue;
        const existing = POLICIES[agent];
        const tier: ModelTier = existing?.primary.tier ?? "medium";
        const fbEntries: FallbackOverride[] =
          ov.fallback_models == null
            ? (existing?.fallbacks.map(f => ({ id: f.id, tier: f.tier })) ?? [])
            : Array.isArray(ov.fallback_models)
              ? ov.fallback_models
              : [ov.fallback_models];
        POLICIES[agent] = {
          primary: { id: ov.model, variant: ov.variant ?? existing?.primary.variant, tier },
          fallbacks: fbEntries.map(normalizeFallback),
        };
      }
    }

    validatePolicies();
  } catch (e) {
    // Roll back to the pre-call snapshot so callers see a clean, validated state.
    restorePolicies(policiesSnapshot);
    _extraAllowedPrimaries = extrasSnapshot;
    ALLOWED_PRIMARIES = allowedSnapshot;
    logger.error("[makdoong2-team] failed to apply overrides from makdoong2-team.json — defaults preserved:", e);
  }
}

// Fail fast at module load if the default table is malformed.
validatePolicies();
