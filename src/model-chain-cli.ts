// model-chain-cli.ts — tiny CLI that emits an agent's model fallback chain as JSON.
// Used by scripts/with-fallback.sh. Keeps the chain definition single-sourced
// in model-fallback-policy.ts.
//
// Usage: node dist/model-chain-cli.js <agent-id>
import { POLICIES, applyConfigOverrides } from "./model-fallback-policy.ts";
import { loadConfig } from "./config.ts";

const _cfg = loadConfig();
applyConfigOverrides(_cfg.agents, _cfg.model_policy);

const agent = process.argv[2];
if (!agent) {
  console.error("usage: cli-chain.ts <agent-id>");
  process.exit(2);
}
const policy = POLICIES[agent];
if (!policy) {
  console.log("[]");
  process.exit(0);
}
const chain = [policy.primary, ...policy.fallbacks];
console.log(JSON.stringify(chain));
