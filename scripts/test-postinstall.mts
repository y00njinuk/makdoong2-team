#!/usr/bin/env node
// scripts/test-postinstall.mts — integration test for npm install -g postinstall hook
//
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
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string> {
  const result = spawnSync(cmd, args, { ...opts, stdio: "pipe", encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function assert(cond: unknown, msg: string): void {
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
if (!tarballLine) {
  console.error("npm pack produced no tarball name on stdout");
  process.exit(1);
}
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
  // 격리는 HOME 만으로 부족하다. resolveConfigDir() 은 XDG_CONFIG_HOME 을 HOME
  // 보다 **먼저** 보고, seedOpencodeCache() 는 XDG_CACHE_HOME 을 본다. `npm test`
  // 가 두 변수를 임시 디렉토리로 고정하므로, 상속하면 배포가 tmpHome 이 아니라
  // 그 임시 디렉토리로 가서 "npm install -g 는 성공했는데 configDir 이 비어 있다"
  // 가 된다 — 단독 실행(`npm run test:postinstall`)에서는 두 변수가 없어 통과하고
  // 스위트 안에서만 실패하는 형태라 원인을 찾기 어렵다.
  const installEnv = {
    ...process.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: join(tmpHome, ".config"),
    XDG_CACHE_HOME: join(tmpHome, ".cache"),
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
  // 플러그인 ref 는 **npm 패키지 이름**이다. 예전에는 src/opencode-plugin.ts 를
  // 가리키는 절대 경로였고 이 단언도 그 시절 형태로 남아 있었다 — 즉 이 테스트는
  // 지금 돌리면 실패한다. STEPS 에 등록돼 있지 않아 아무도 몰랐다.
  // (install-lib 의 pluginRef() / isLegacyPluginEntry() 가 계약의 출처다.)
  const PKG_NAME = "makdoong2-team";
  const matchesRef = (v: unknown): boolean =>
    typeof v === "string" && (v === PKG_NAME || v.startsWith(`${PKG_NAME}@`));
  assert(
    Array.isArray(oc.plugin) && oc.plugin.some((p: unknown) =>
      matchesRef(p) || (Array.isArray(p) && matchesRef(p[0]))
    ),
    `opencode.json has plugin ref (${PKG_NAME})`
  );
  assert(
    !JSON.stringify(oc.plugin).includes("opencode-plugin.ts"),
    "opencode.json has no legacy path-based plugin ref"
  );
  assert(oc.tools?.verify_stage === true, "opencode.json has tools");

  // makdoong2-team doctor
  console.log("\n[5/6] Running makdoong2-team doctor...");
  const doctorResult = run(binPath, ["doctor"], { env: installEnv });
  assert(doctorResult.status === 0, "makdoong2-team doctor exits 0");

  // 5) Re-install (idempotency test)
  console.log("\n[6/6] Re-installing (idempotency check)...");
  const beforeOcBackups = readdirSync(configDir).filter((f: string) => f.startsWith("opencode.json.bak."));
  const reinstallResult = run("npm", ["install", "-g", tarball], { env: installEnv });
  assert(reinstallResult.status === 0, "re-install succeeds");

  const afterOcBackups = readdirSync(configDir).filter((f: string) => f.startsWith("opencode.json.bak."));
  assert(
    afterOcBackups.length === beforeOcBackups.length,
    `no new opencode.json backups on re-install (idempotent): ${beforeOcBackups.length} → ${afterOcBackups.length}`
  );

  // 6) legacy secrets.env cleanup
  //
  // 종전 이 블록은 "secrets.env 가 보존된다" 를 단언했다. 현행 install() 은 정반대로
  // 동작한다 — 자격증명은 makdoong2-team.json .secrets.* 하나로 옮겨졌고, 남아 있는
  // 레거시 파일은 백업 후 **삭제**하는 것이 계약이다 (install-lib 의
  // cleanupLegacySecretsEnv). 규약이 뒤집혔는데 테스트가 따라오지 않았다.
  console.log("\n[Bonus] Testing legacy secrets.env cleanup...");
  const secretsPath = join(configDir, "skills", "jira-research", "secrets.env");
  writeFileSync(secretsPath, "JIRA_TOKEN=test123");

  const reinstall2Result = run("npm", ["install", "-g", tarball], { env: installEnv });
  assert(reinstall2Result.status === 0, "third install succeeds");

  assert(!existsSync(secretsPath), "legacy secrets.env removed on re-install");
  const backups = readdirSync(join(configDir, "skills", "jira-research"))
    .filter((f: string) => f.startsWith("secrets.env.bak."));
  assert(backups.length >= 1, "legacy secrets.env backed up before removal");

  // 자격증명의 새 자리가 실제로 만들어져 있어야 한다.
  const cfg = JSON.parse(readFileSync(join(configDir, "makdoong2-team.json"), "utf8"));
  assert(cfg.secrets && typeof cfg.secrets === "object", "makdoong2-team.json has .secrets scaffolding");
  assert("JIRA_API_TOKEN" in cfg.secrets, "makdoong2-team.json .secrets has JIRA_API_TOKEN key");

  console.log("\n✅ [test-postinstall] All checks passed!");

  // Cleanup
  rmSync(tmpHome, { recursive: true, force: true });
} finally {
  // Cleanup tarball
  if (existsSync(tarball)) rmSync(tarball);
}
