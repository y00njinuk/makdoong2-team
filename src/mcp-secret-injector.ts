// mcp-secret-injector.ts — inject makdoong2-team.json .secrets.* into opencode's
// MCP env at plugin `config` hook time.
//
// **Motivation**
// opencode reads `mcp.<name>.environment.<VAR>` from opencode.json once and
// snapshots it as env when spawning the MCP subprocess. That value is *frozen*
// for the lifetime of the process. makdoong2-team.json (SSoT for secrets)
// therefore cannot influence direct MCP tool calls (`repos_*`, `works_*`, …)
// unless we override the config *before* MCP initialization.
//
// **Mechanism (opencode 1.4.14+)**
// The `config` plugin hook receives the shared Config object *by reference*
// (Config.get() returns `s.config` directly, and Config.Info is DeepMutable
// on purpose). MCP.state() later calls the same cfgSvc.get() and reads
// `cfg.mcp[key].environment` on connectLocal(). Mutating `cfg.mcp[k].environment.<VAR>`
// in the `config` hook therefore reaches the MCP spawn call site.
//
// **Coexistence with non-makdoong2 users**
// - If makdoong2-team.json is absent or `.secrets.<VAR>` is empty/null, we
//   leave opencode.json's `environment.<VAR>` alone → other plugins /
//   standalone opencode users are unaffected.
// - If both differ, makdoong2-team.json wins (SSoT) and a warning is emitted
//   so the user can reconcile — same policy as skills/_lib/load-secret.sh
//   already enforces for the skill_mcp code path.
//
// **Scope**
// Only the four MCPs that makdoong2-team manages credentials for. Foreign MCPs
// (chrome-devtools-mcp, site-wide entries, user's own) are untouched.

/**
 * Which MCP server key in opencode.json's `mcp` object maps to which
 * (env-var name, secrets.<key> name) pair. This is the same variable name
 * both in opencode.json environment and in makdoong2-team.json .secrets.
 */
export interface McpSecretMapping {
  /** opencode.json's `mcp.<key>` — e.g. "repos" */
  mcpKey: string;
  /** env var name injected into MCP process, and .secrets.<varName> lookup key */
  varName: string;
}

/**
 * Fixed mapping — one row per MCP that makdoong2-team owns credentials for.
 *
 * Do NOT extend this list to arbitrary MCPs. If a user adds their own MCP to
 * opencode.json, we leave it alone (unmanaged). Only these four are considered
 * SSoT-managed because their tokens are declared in makdoong2-team.json.
 */
export const MCP_SECRET_MAPPINGS: readonly McpSecretMapping[] = [
  { mcpKey: "repos", varName: "BITBUCKET_API_TOKEN" },
  { mcpKey: "works", varName: "JIRA_API_TOKEN" },
  { mcpKey: "docs", varName: "CONFLUENCE_API_TOKEN" },
  { mcpKey: "bamboo", varName: "BAMBOO_TOKEN" },
] as const;

export type SecretsSource = Readonly<Record<string, string | undefined>>;

/**
 * `status` semantics (consumers branch on these):
 * - "injected":         secret was written (fresh or matched existing)
 * - "overridden":       secret differed from opencode.json's value; replaced
 * - "skipped-no-secret": makdoong2-team.json had no value → left alone
 * - "skipped-no-mcp":   opencodeConfig.mcp[key] not present → nothing to do
 *
 * `tokenPrefix` is the first 8 chars of the applied token — safe to log for
 * audit; never contains a full secret.
 */
export interface InjectResult {
  mcpKey: string;
  varName: string;
  status:
    | "injected"
    | "overridden"
    | "skipped-no-secret"
    | "skipped-no-mcp";
  tokenPrefix?: string;
}

/**
 * Apply one mapping in-place to the given opencodeConfig object.
 *
 * SAFETY: this function is `any`-typed on purpose. opencode does not export
 * a stable public schema for its config object, and we only touch a narrow
 * `mcp[key].environment[varName]` path. We defensively ensure the parent
 * objects exist before writing.
 *
 * Returns a summary so the caller can log a coherent audit line.
 */
export function injectOneSecret(
  opencodeConfig: any,
  secrets: SecretsSource,
  mapping: McpSecretMapping,
): InjectResult {
  const { mcpKey, varName } = mapping;

  const token = secrets[varName];
  if (typeof token !== "string" || token.length === 0) {
    return { mcpKey, varName, status: "skipped-no-secret" };
  }

  const mcpBlock = opencodeConfig?.mcp;
  if (!mcpBlock || typeof mcpBlock !== "object") {
    return { mcpKey, varName, status: "skipped-no-mcp" };
  }
  const entry = mcpBlock[mcpKey];
  if (!entry || typeof entry !== "object") {
    return { mcpKey, varName, status: "skipped-no-mcp" };
  }

  if (!entry.environment || typeof entry.environment !== "object") {
    entry.environment = {};
  }
  const existing = entry.environment[varName];
  const wasDifferent =
    typeof existing === "string" && existing.length > 0 && existing !== token;

  entry.environment[varName] = token;

  return {
    mcpKey,
    varName,
    status: wasDifferent ? "overridden" : "injected",
    tokenPrefix: token.slice(0, 8),
  };
}

/**
 * Apply every known mapping to the shared config object. Idempotent.
 *
 * Ordering: mappings are applied in declaration order. Missing MCPs and
 * missing secrets are silently skipped — MCP entries opencode-side is the
 * user's responsibility (they must have added the MCP to opencode.json for
 * makdoong2-team to be able to override its token).
 */
export function injectAllSecrets(
  opencodeConfig: any,
  secrets: SecretsSource,
): InjectResult[] {
  return MCP_SECRET_MAPPINGS.map((m) =>
    injectOneSecret(opencodeConfig, secrets, m),
  );
}
