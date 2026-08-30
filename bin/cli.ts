#!/usr/bin/env node
// bin/cli.ts — makdoong2-team installer & doctor.
//
// 편집하지 말 것 — 다음 빌드가 덮어쓴다.
//
// **dist/ 를 import 하지 않는다.** doctor/validate 는 설치가 깨졌을 때 실행하는
// 진단 도구인데 dist/ 는 .gitignore 대상이고, src/model-fallback-policy.ts 가
// 끌고 오는 logger→config 체인은 진단 대상 설정(logging.mode="file" + path 누락)
// 에서 throw 한다. 그래서 정책은 scripts/model-policy.mts(순수 미러)를 쓴다.
//
//   npx makdoong2-team install [--config <dir>] [--force]
//   npx makdoong2-team doctor  [--config <dir>]
//   npx makdoong2-team --version | --help
//
// Replaces the old bash install.sh. Zero runtime dependencies (plain Node ESM)
// so `npx` runs instantly with nothing to resolve first. Settings are NOT
// passed as flags — everything is controlled by ~/.config/opencode/makdoong2-team.json.

import {
  existsSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildPoliciesFromConfig, DEFAULT_ALLOWED_PRIMARIES,
} from "../scripts/model-policy.mts";
import type { AgentModelPolicy } from "../scripts/model-policy.mts";
import {
  install,
  uninstall,
  resolveConfigDir,
  parseJsonc,
  readCachedVersion,
  opencodeCacheRoot,
} from "../scripts/install-lib.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

const TOOLS = ["verify_stage", "dispatch_stage", "dispatch_verifier", "dispatch_research", "auto_advance_stage", "get_fallback_model"];

// Skill directories that used to ship a per-skill secrets.env under
// ${configDir}/skills/<skill>/. Credentials are now sourced only from
// makdoong2-team.json .secrets.*; doctor warns when the legacy file lingers.
const LEGACY_SECRET_SKILL_DIRS = [
  "bitbucket-research",
  "jira-research",
  "confluence-research",
  "bamboo-ci",
];

// Names of the secret keys the schema recognises. Doctor reports which of
// these are unset so the user knows exactly which research skills are inert.
const SECRET_KEYS = [
  "BITBUCKET_API_TOKEN",
  "JIRA_API_TOKEN",
  "CONFLUENCE_API_TOKEN",
  "BAMBOO_TOKEN",
];

// ── tiny output helpers (no deps) ──
const ok = (m: string): void => console.log(`  ✓ ${m}`);
const info = (m: string): void => console.log(m);
const warn = (m: string): void => console.warn(`  ! ${m}`);

/** CLI 플래그. `--config <dir>` / `--force` / `--help`. */
interface Flags {
  config?: string;
  force?: boolean;
  help?: boolean;
}

function parseFlags(args: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") f.config = args[++i];
    else if (args[i] === "--force") f.force = true;
    else if (args[i] === "--help" || args[i] === "-h") f.help = true;
  }
  return f;
}

function doInstall(flags: Flags): void {
  const configDir = resolveConfigDir(flags.config);
  const result = install({
    configDir,
    pkgRoot: PKG_ROOT,
    force: flags.force,
    patchOpencode: "always",  // preserve current CLI behavior (always patch)
  });

  // Dependency sanity check
  const missing = ["jq", "git"].filter((b) => !hasBinary(b));
  if (missing.length) warn(`missing runtime dependencies: ${missing.join(", ")}`);
  else ok("runtime dependencies (jq, git) present");

  const cfgPath = join(configDir, "makdoong2-team.json");
  info("");
  info("Next steps:");
  info(`  1) Edit settings in ${cfgPath}`);
  info("  2) Restart opencode so the plugin and agents load");
  info(`  3) Sanity check:  npx makdoong2-team doctor`);
  info("");
  info("[makdoong2-team] install complete — 막둥이들 출근 준비 끝");
}

function hasBinary(bin: string): boolean {
  try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function doDoctor(flags: Flags): never {
  const DEST = resolveConfigDir(flags.config);
  info(`[makdoong2-team] doctor — ${DEST}`);
  let problems = 0;
  const check = (cond: unknown, good: string, bad: string): void => { if (cond) ok(good); else { warn(bad); problems++; } };

  for (const b of ["jq", "git"]) check(hasBinary(b), `${b} present`, `${b} missing on PATH`);

  const cfgPath = join(DEST, "makdoong2-team.json");
  let cfgOk = false;
  let cfgParsed: Record<string, any> | null = null;
  if (existsSync(cfgPath)) {
    try { cfgParsed = JSON.parse(readFileSync(cfgPath, "utf8")); cfgOk = true; } catch { /* invalid */ }
  }
  check(cfgOk, `config valid: ${cfgPath}`, `config missing or invalid: ${cfgPath} (run: npx makdoong2-team install)`);

  if (cfgOk) {
    let modelOk = false, modelErr = "";
    try {
      buildPoliciesFromConfig({ agents: cfgParsed?.agents, model_policy: cfgParsed?.model_policy });
      modelOk = true;
    } catch (e) { modelErr = e instanceof Error ? e.message : String(e); }
    check(modelOk, "model policy invariants pass",
          `model policy invalid: ${modelErr} (run: npx makdoong2-team validate)`);
  }

   // Config dir checks (agents & skills)
   const configDirChecks = ["agents", "skills/jira-research", "skills/confluence-research", "skills/bitbucket-research", "skills/github-oss-research", "skills/bamboo-ci", "skills/makdoong2-issue-reporter", "command/makdoong2-issue-reporter.md"];
   for (const d of configDirChecks) {
     check(existsSync(join(DEST, d)), `${d}/ in config dir`, `${d}/ missing in config dir (run: npx makdoong2-team install)`);
   }

   // Package root checks (gates, stages, scripts, src)
   const pkgRootChecks = ["gates", "stages", "scripts", "src"];
   for (const d of pkgRootChecks) {
     check(existsSync(join(PKG_ROOT, d)), `${d}/ in package`, `${d}/ missing in package (reinstall: npm install -g makdoong2-team)`);
   }

    const ocPath = join(DEST, "opencode.json");
    let pluginOk = false, toolsOk = false, ocParseOk = false, ocParseErr = "";
    if (existsSync(ocPath)) {
      try {
        const oc = parseJsonc(readFileSync(ocPath, "utf8"));
        ocParseOk = true;
        const pkgName = PKG.name;
        const matchesEntry = (p: unknown): boolean => {
          if (typeof p !== "string") return false;
          return p === pkgName || p.startsWith(`${pkgName}@`);
        };

        pluginOk = Array.isArray(oc.plugin) && oc.plugin.some((p: unknown) => {
          if (matchesEntry(p)) return true;
          if (Array.isArray(p) && matchesEntry(p[0])) return true;
          return false;
        });
        const ocTools = oc.tools;
        toolsOk = !!ocTools && TOOLS.every((t) => ocTools[t] === true);
      } catch (e) { ocParseErr = e instanceof Error ? e.message : String(e); }
    }
   check(!existsSync(ocPath) || ocParseOk, "opencode.json parses (JSONC tolerated)",
         `opencode.json is unparseable — install silently skips patching it: ${ocParseErr}`);
   check(pluginOk, "opencode.json registers the plugin", "opencode.json missing the plugin entry");
   check(toolsOk, "opencode.json enables custom tools", "opencode.json missing custom tools");

   // The plugin opencode actually loads lives in the `<name>@latest` cache dir,
   // not in the globally installed npm module. When those drift the user runs
   // old code while `npm ls -g` reports the new version — invisible without
   // this check.
   const cachedDir = join(opencodeCacheRoot(), `${PKG.name}@latest`, "node_modules", PKG.name);
   const cachedVersion = existsSync(cachedDir) ? readCachedVersion(cachedDir) : null;
   check(cachedVersion === null || cachedVersion === PKG.version,
         `opencode plugin cache matches installed version (v${PKG.version})`,
         `opencode plugin cache is stale: ${cachedDir} has v${cachedVersion} but this package is v${PKG.version} ` +
         `— opencode loads the CACHED copy (run: npx makdoong2-team install)`);

   if (cfgOk && Array.isArray(cfgParsed?.model_policy?.allowed_primaries)
       && cfgParsed.model_policy.allowed_primaries.length === 0) {
     warn(`model_policy.allowed_primaries is [] — this means "add nothing", not "allow everything"`);
     warn(`  the runtime allow-list stays at the built-in defaults; remove the key or list the extra model ids`);
     problems++;
   }

  // Detect legacy secrets.env residue. These files predate the makdoong2-team.json
  // .secrets.* migration and can silently override the new source of truth
  // if any run-*.sh regressed to sourcing them.
  const legacySecrets = LEGACY_SECRET_SKILL_DIRS
    .map(skill => join(DEST, "skills", skill, "secrets.env"))
    .filter((p: string) => existsSync(p));
  if (legacySecrets.length === 0) {
    ok("no legacy skills/*/secrets.env files (credentials sourced from makdoong2-team.json)");
  } else {
    warn(`${legacySecrets.length} legacy secrets.env file(s) still present — migrate their values to makdoong2-team.json .secrets.* then delete:`);
    for (const p of legacySecrets.slice(0, 8)) warn(`  ${p}`);
    warn(`  fix: npx makdoong2-team install    (backs up + removes them automatically)`);
    problems++;
  }

  // Report which .secrets.* keys are unset so the user sees at a glance which
  // research skills will refuse to spawn. Missing config file already reported above.
  if (cfgOk) {
    const secretsObj = cfgParsed?.secrets;
    if (!secretsObj || typeof secretsObj !== "object") {
      warn(`makdoong2-team.json has no "secrets" block — research skills will fail to spawn`);
      warn(`  fix: npx makdoong2-team install    (adds the scaffolding)`);
      problems++;
    } else {
      const missing = SECRET_KEYS.filter(k => !secretsObj[k] || typeof secretsObj[k] !== "string" || secretsObj[k].trim() === "");
      if (missing.length === 0) {
        ok(`all ${SECRET_KEYS.length} research-skill secret(s) configured`);
      } else {
        warn(`${missing.length}/${SECRET_KEYS.length} research-skill secret(s) unset in makdoong2-team.json: ${missing.join(", ")}`);
        warn(`  edit ${cfgPath} and fill in the tokens, then restart opencode`);
      }
    }
  }

  if (cfgOk) {
    const loggingCfg = cfgParsed?.logging;
    if (loggingCfg && typeof loggingCfg === "object") {
      const mode = loggingCfg.mode;
      if (mode !== undefined && mode !== "stdin" && mode !== "file") {
        warn(`logging.mode invalid: "${mode}" (must be "stdin" or "file")`);
        problems++;
      }
      if (mode === "file") {
        const p = loggingCfg.path;
        if (typeof p !== "string" || p.trim() === "") {
          warn(`logging.mode="file" but logging.path is missing/empty — plugin will refuse to start`);
          problems++;
        } else {
          ok(`logging.mode="file" → ${p}`);
        }
      }
    }
  }

  const contaminated = scanContaminatedStates();
  if (contaminated.length === 0) {
    ok("no phantom-key contamination in .makdoong2-team/*/state.json");
  } else {
    warn(`${contaminated.length} state.json file(s) contain flat-notation phantom keys`);
    for (const { path, keys } of contaminated.slice(0, 5)) {
      warn(`  ${path}`);
      warn(`    phantom keys: ${keys.join(", ")}`);
    }
    if (contaminated.length > 5) {
      warn(`  ... and ${contaminated.length - 5} more`);
    }
    warn(`  fix: bash <SCRIPTS_DIR>/state.sh migrate <ISSUE_KEY>`);
    warn(`       (or trigger via 'bash <SCRIPTS_DIR>/state.sh init <ISSUE_KEY>' — init auto-migrates)`);
    problems++;
  }

  info("");
  info(problems === 0 ? "[makdoong2-team] doctor: all good ✓" : `[makdoong2-team] doctor: ${problems} problem(s) found`);
  process.exit(problems === 0 ? 0 : 1);
}

const FLAT_STAGE_KEY_RE = /^[0-9]+_[a-z_]+\.[a-z]+$/;

/** flat 표기 유령 키가 섞인 state.json 한 건. */
interface ContaminatedState {
  path: string;
  keys: string[];
}

function scanContaminatedStates(): ContaminatedState[] {
  const results: ContaminatedState[] = [];
  const searchRoots = [process.cwd(), PKG_ROOT];
  const seenPaths = new Set<string>();

  for (const root of searchRoots) {
    walkForStateFiles(root, seenPaths, results, 0);
  }
  return results;
}

function walkForStateFiles(dir: string, seen: Set<string>, results: ContaminatedState[], depth: number): void {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }

  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name.startsWith(".cache")) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;

    if (name === ".makdoong2-team") {
      inspectMakdoongDir(full, seen, results);
      continue;
    }
    walkForStateFiles(full, seen, results, depth + 1);
  }
}

function inspectMakdoongDir(mkDir: string, seen: Set<string>, results: ContaminatedState[]): void {
  let issueDirs;
  try { issueDirs = readdirSync(mkDir); } catch { return; }
  for (const issue of issueDirs) {
    const p = join(mkDir, issue, "state.json");
    if (seen.has(p) || !existsSync(p)) continue;
    seen.add(p);
    try {
      const obj = JSON.parse(readFileSync(p, "utf8"));
      const stages = obj && typeof obj === "object" ? obj.stages : null;
      if (!stages || typeof stages !== "object") continue;
      const phantomKeys = Object.keys(stages).filter(k => FLAT_STAGE_KEY_RE.test(k));
      if (phantomKeys.length > 0) {
        results.push({ path: p, keys: phantomKeys });
      }
    } catch { /* unreadable/invalid JSON — skip silently */ }
  }
}

function doUninstall(flags: Flags): void {
  const configDir = resolveConfigDir(flags.config);
  uninstall({ configDir, pkgRoot: PKG_ROOT });
}

function doValidate(flags: Flags): never {
  const DEST = resolveConfigDir(flags.config);
  const cfgPath = join(DEST, "makdoong2-team.json");
  info(`[makdoong2-team] validate — ${cfgPath}`);

  if (!existsSync(cfgPath)) {
    warn(`config not found at ${cfgPath} — defaults are in effect (nothing to validate)`);
    process.exit(0);
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e) {
    console.error(`  \u2717 invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  ok("JSON parses");

  let result;
  try {
    result = buildPoliciesFromConfig({ agents: cfg.agents, model_policy: cfg.model_policy });
  } catch (e) {
    console.error(`  \u2717 model policy invariants violated:`);
    console.error(`      ${e instanceof Error ? e.message : String(e)}`);
    console.error("");
    console.error("  Hints:");
    console.error("    - Primary must be in allowed_primaries (defaults: " +
         [...DEFAULT_ALLOWED_PRIMARIES].join(", ") + ").");
    console.error("    - To add a new primary, set model_policy.allowed_primaries: [\"<provider/model>\"].");
    console.error("    - Each fallback tier must be strictly lower than its primary tier (low < medium < high < max).");
    process.exit(1);
  }
  ok("policy invariants pass (primary allow-list + fallback tier ordering)");

  const overriddenAgents = cfg.agents
    ? Object.keys(cfg.agents).filter(a => cfg.agents[a] && cfg.agents[a].model)
    : [];
  if (overriddenAgents.length) {
    ok(`overrides applied for: ${overriddenAgents.join(", ")}`);
  } else {
    info("  - no per-agent overrides set (built-in POLICIES in effect)");
  }

  const extraPrimaries = Array.isArray(cfg?.model_policy?.allowed_primaries)
    ? cfg.model_policy.allowed_primaries.filter((s: unknown): s is string => typeof s === "string" && !DEFAULT_ALLOWED_PRIMARIES.has(s))
    : [];
  if (extraPrimaries.length) {
    ok(`extra allowed primaries: ${extraPrimaries.join(", ")}`);
  }

  info("");
  info("Resolved chain (primary \u2192 fallbacks):");
  for (const [agent, pol] of Object.entries(result.policies)) {
    const fbStr = pol.fallbacks.length
      ? pol.fallbacks.map(f => `${f.id} (${f.tier})`).join(" \u2192 ")
      : "(none, primary-only)";
    info(`  ${agent.padEnd(26)} ${pol.primary.id} (${pol.primary.tier}) \u2192 ${fbStr}`);
  }
  info("");
  info("[makdoong2-team] validate: OK \u2713");
  process.exit(0);
}

function printHelp(): void {
  info(`makdoong2-team ${PKG.version}\n`);
  info("Usage:");
  info("  npx makdoong2-team install   [--config <dir>] [--force]   Install plugin, agents, skills + patch opencode.json");
  info("  npx makdoong2-team uninstall [--config <dir>]             Remove agents, skills + revert opencode.json patches");
  info("  npx makdoong2-team doctor    [--config <dir>]             Diagnose an existing install");
  info("  npx makdoong2-team validate  [--config <dir>]             Validate makdoong2-team.json model policy");
  info("");
  info("  npx makdoong2-team --version");
  info("");
  info("All settings are controlled by <configDir>/makdoong2-team.json");
  info("(default configDir: ${XDG_CONFIG_HOME:-$HOME/.config}/opencode).");
  info("");
  info("Note: uninstall preserves makdoong2-team.json (credentials).");
  info("      Remove it manually if no longer needed.");
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = parseFlags(argv.slice(1));
switch (cmd) {
  case "install":   doInstall(flags);   break;
  case "uninstall": doUninstall(flags); break;
  case "doctor":    doDoctor(flags);    break;
  case "validate":  doValidate(flags);  break;
  case "-v": case "--version": case "version": info(PKG.version); break;
  case undefined: case "help": case "-h": case "--help": printHelp(); break;
  default: console.error(`unknown command: ${cmd}\n`); printHelp(); process.exit(1);
}
