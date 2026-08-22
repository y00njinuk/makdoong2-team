#!/usr/bin/env node
// scripts/test-postinstall.mjs — integration test for npm install -g postinstall hook
//
// Simulates global install in isolated HOME directory:
//   1) npm pack → produces tarball
//   2) npm install -g <tarball> with isolated HOME
//   3) Verify deployment artifacts
//   4) Verify idempotency (re-install doesn't create duplicate backups)
//   5) Verify secrets.env preservation

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  return result;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

console.log("[test-postinstall] Starting npm install -g smoke test");

// 1) npm pack
console.log("\n[1/6] Running npm pack...");
const packResult = run("npm", ["pack"], { cwd: PKG_ROOT });
if (packResult.status !== 0) {
  console.error("npm pack failed:", packResult.stderr);
  process.exit(1);
}
const tarballLine = packResult.stdout.trim().split("\n").pop();
const tarball = join(PKG_ROOT, tarballLine);
assert(existsSync(tarball), `tarball created: ${tarball}`);

try {
  // 2) Create isolated HOME
  console.log("\n[2/6] Setting up isolated HOME...");
  const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-postinstall-"));
  const npmPrefix = join(tmpHome, "npm");
  const configDir = join(tmpHome, ".config", "opencode");

  console.log(`  tmpHome: ${tmpHome}`);
  console.log(`  npmPrefix: ${npmPrefix}`);
  console.log(`  configDir: ${configDir}`);

  // 3) npm install -g with isolated env
  console.log("\n[3/6] Running npm install -g (first install)...");
  const installEnv = {
    ...process.env,
    HOME: tmpHome,
    npm_config_prefix: npmPrefix,
    npm_config_global: "true",
    CI: undefined,
    CONTINUOUS_INTEGRATION: undefined,
  };
  const installResult = run("npm", ["install", "-g", tarball], { env: installEnv });
  if (installResult.status !== 0) {
    console.error("npm install -g failed:", installResult.stderr);
    process.exit(1);
  }
  console.log("  npm install -g completed");

  // 4) Verify deployment artifacts
  console.log("\n[4/6] Verifying deployment artifacts...");

  // Binary shim
  const isWin = platform() === "win32";
  const binName = isWin ? "makdoong2-team.cmd" : "makdoong2-team";
  const binPath = join(npmPrefix, "bin", binName);
  assert(existsSync(binPath), `binary shim exists: ${binPath}`);

  // Agents in configDir
  const agentPath = join(configDir, "agents", "makdoong2-team-leader.md");
  assert(existsSync(agentPath), `agent deployed to configDir: ${agentPath}`);

  // Skills in configDir
  const skillPath = join(configDir, "skills", "jira-research", "SKILL.md");
  assert(existsSync(skillPath), `skill deployed to configDir: ${skillPath}`);

  // opencode.json plugin ref (relative path to npm module)
  const ocPath = join(configDir, "opencode.json");
  assert(existsSync(ocPath), `opencode.json created: ${ocPath}`);
  const oc = JSON.parse(readFileSync(ocPath, "utf8"));
  assert(
    Array.isArray(oc.plugin) && oc.plugin.some(p => 
      (typeof p === "string" && p.includes("opencode-plugin.ts")) ||
      (Array.isArray(p) && p[0].includes("opencode-plugin.ts"))
    ),
    "opencode.json has plugin ref"
  );
  assert(oc.tools?.verify_stage === true, "opencode.json has tools");

  // makdoong2-team doctor
  console.log("\n[5/6] Running makdoong2-team doctor...");
  const doctorResult = run(binPath, ["doctor"], { env: installEnv });
  assert(doctorResult.status === 0, "makdoong2-team doctor exits 0");

  // 5) Re-install (idempotency test)
  console.log("\n[6/6] Re-installing (idempotency check)...");
  const beforeOcBackups = readdirSync(configDir).filter(f => f.startsWith("opencode.json.bak."));
  const reinstallResult = run("npm", ["install", "-g", tarball], { env: installEnv });
  assert(reinstallResult.status === 0, "re-install succeeds");

  const afterOcBackups = readdirSync(configDir).filter(f => f.startsWith("opencode.json.bak."));
  assert(
    afterOcBackups.length === beforeOcBackups.length,
    `no new opencode.json backups on re-install (idempotent): ${beforeOcBackups.length} → ${afterOcBackups.length}`
  );

  // 6) secrets.env preservation
  console.log("\n[Bonus] Testing secrets.env preservation...");
  const secretsPath = join(configDir, "skills", "jira-research", "secrets.env");
  const secretContent = "JIRA_TOKEN=test123";
  writeFileSync(secretsPath, secretContent);

  const reinstall2Result = run("npm", ["install", "-g", tarball], { env: installEnv });
  assert(reinstall2Result.status === 0, "third install succeeds");

  const afterSecrets = readFileSync(secretsPath, "utf8");
  assert(afterSecrets === secretContent, "secrets.env preserved across re-install");

  console.log("\n✅ [test-postinstall] All checks passed!");

  // Cleanup
  rmSync(tmpHome, { recursive: true, force: true });
} finally {
  // Cleanup tarball
  if (existsSync(tarball)) rmSync(tarball);
}
