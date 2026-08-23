// scripts/install-lib.mjs — Reusable install logic for CLI and postinstall.
//
// Extracted from bin/cli.js doInstall() to enable both:
//   1) Manual install via `makdoong2-team install` (CLI)
//   2) Automatic install via `npm install -g` (postinstall.mjs)
//
// Single source of truth for deployment logic.

import {
  cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, rmSync,
  symlinkSync, lstatSync, renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

// opencode parses its config as JSONC — comments and trailing commas are legal
// there. Using strict JSON.parse here silently skipped the whole opencode.json
// patch (plugin ref, tools, permissions) for anyone whose config had a trailing
// comma, so `install` reported success while deploying nothing. These two
// scanners strip JSONC syntax outside of string literals before parsing.
function stripJsoncComments(text) {
  let out = "";
  let inString = false, escaped = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = "";
  let inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(text)));
}

// Constants (extracted from bin/cli.js)
// Legacy plugin refs — kept for cleanup only. Two historical shapes exist:
//   1. Relative-path ref written when the plugin lived under
//      ~/.config/opencode/plugins/makdoong2-team/.
//   2. Absolute-path ref pointing at src/opencode-plugin.ts inside the npm
//      module (pre-dist-build era: opencode had to load raw TypeScript).
// Both are stripped from opencode.json on install and replaced with the npm
// package name (see currentPluginRef()) so the entry stays portable across
// nvm versions and reinstalls.
const LEGACY_RELATIVE_PLUGIN_REF = "./plugins/makdoong2-team/src/opencode-plugin.ts";
const LEGACY_ABSOLUTE_TS_SUFFIX = "/src/opencode-plugin.ts";
const LEGACY_SCOPED_NAME = "@local/makdoong2-team";
const PLUGIN_PACKAGE_NAME = "makdoong2-team";
const TOOLS = ["verify_stage", "dispatch_stage", "dispatch_verifier", "dispatch_research", "auto_advance_stage", "get_fallback_model"];
const TOOL_SEARCH_PLUGIN_PREFIX = "opencode-tool-search";
// UTIL_SCRIPTS is no longer deployed (scripts live inside the npm module).
// Retained for cleanup: older installs copied these into ~/.config/opencode/scripts/
// and we need the list to remove them without touching unrelated user scripts.
const UTIL_SCRIPTS = ["state.sh", "rollback-commits.sh", "wt-sync-ignored.sh", "log-event.sh", "config.sh", "model-policy.mjs"];
const RESEARCH_SKILLS = ["jira-research", "confluence-research", "bitbucket-research", "github-oss-research", "bamboo-ci"];

// Stale config-dir artifacts left behind by pre-refactor installs. Removed
// (with backup) at the start of install() so a re-run cleanly migrates users
// to the npm-module-based layout.
const STALE_PATHS = [
  "plugins/makdoong2-team",
  "gates",
  "stages",
  "references",
  "bin/with-fallback.sh",
  "makdoong2-team.schema.json",
];

/**
 * Plugin entry as written to opencode.json. Uses the npm package name so
 * opencode's loader resolves it via Node's standard module resolution
 * (package.json main/exports → dist/opencode-plugin.js). Matches the format
 * used by opencode-claude-auth, opencode-tool-search, oh-my-openagent.
 *
 * pkgRoot is accepted for signature stability with older callers but is not
 * consulted — the ref is portable across install locations.
 * @param {string} _pkgRoot - Kept for backward-compatible signature.
 * @returns {string}
 */
function pluginRef(_pkgRoot) {
  return PLUGIN_PACKAGE_NAME;
}

/**
 * True when the entry is a legacy plugin ref that must be stripped from
 * opencode.json before the current package-name ref is inserted. Recognises:
 *   1. Old relative path from the pre-npm-module install layout.
 *   2. Pre-dist absolute path pointing at src/opencode-plugin.ts.
 *   3. Old @local-scoped npm name used while the package lived on the internal
 *      Artifactory, before it was published to the public npm registry.
 *   4. Version-pinned form of the current name ("makdoong2-team@1.2.0"), which
 *      would freeze the plugin on one version across upgrades.
 * Cases 3 and 4 accept both the bare name and the "name@version" suffix form.
 * @param {unknown} entry - Element from opencode.json plugin[]
 * @returns {boolean}
 */
function isLegacyPluginEntry(entry) {
  if (typeof entry !== "string") return false;
  if (entry === LEGACY_RELATIVE_PLUGIN_REF) return true;
  if (entry.endsWith(LEGACY_ABSOLUTE_TS_SUFFIX)) return true;
  if (entry === LEGACY_SCOPED_NAME) return true;
  if (entry.startsWith(`${LEGACY_SCOPED_NAME}@`)) return true;
  if (entry.startsWith(`${PLUGIN_PACKAGE_NAME}@`)) return true;
  return false;
}

// Legacy per-skill secrets.env directories. Install backs up and removes
// these files on sight — credentials now live only in makdoong2-team.json
// .secrets.*, and the shipping runtime never reads secrets.env. No value
// migration: users on the new install (re)enter tokens directly in the JSON.
const LEGACY_SECRET_SKILL_DIRS = [
  "bitbucket-research",
  "jira-research",
  "confluence-research",
  "bamboo-ci",
];

// Legacy glob previously written into opencode.json permission.read so the
// UI would not prompt when a skill sourced its own secrets.env. Retained here
// so cleanup can strip stale entries.
const LEGACY_SKILL_SECRETS_GLOB = "~/.config/opencode/skills/*/secrets.env";

// Stale external_directory glob written by pre-0.13.5 installs. The single *
// doesn't match multi-segment paths, and even ** cannot traverse dot-directories
// (.nvm, .config) in opencode's glob engine. Retained here only for cleanup.
// Replaced by absolute-path entries computed from pkgRoot and configDir at
// install time (see computeExternalDirPaths).
const LEGACY_PKG_EXTERNAL_DIR_GLOB = "*/@local/makdoong2-team/**";

// Names of the four secret keys the schema recognises. Used to seed the
// scaffolding when an existing makdoong2-team.json is missing a `secrets` key.
const SECRET_KEYS = [
  "BITBUCKET_API_TOKEN",
  "JIRA_API_TOKEN",
  "CONFLUENCE_API_TOKEN",
  "BAMBOO_TOKEN",
];

// Default logging config values seeded when keys are missing from an existing
// makdoong2-team.json. Kept in sync with assets/makdoong2-team.default.json.
const DEFAULT_LOGGING_LEVEL = "error";
const DEFAULT_LOGGING_MODE = "stdin";
const DEFAULT_LOGGING_PATH = null;

/**
 * Resolve the opencode config directory.
 * @param {string|undefined} flag - Optional explicit path from CLI --config flag
 * @returns {string} Absolute path to config directory
 */
export function resolveConfigDir(flag) {
  if (flag) return resolve(flag);

  const base = (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim())
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "opencode");
}

/**
 * Deploy makdoong2-team to opencode config directory.
 *
 * Most runtime assets (plugin source, gates, stages, references, utility
 * scripts, schema, with-fallback wrapper) now ship inside the npm module and
 * are loaded from there directly — deploying them into ~/.config/opencode/
 * created duplicate copies that drifted from the module and confused users
 * about the source of truth. Only assets that opencode expects to find under
 * its config dir by convention (agents, skills) are still copied.
 *
 * Phases:
 *   0) Cleanup stale config-dir artifacts from pre-refactor installs (backup + rm)
 *   1) Agents (opencode convention: ~/.config/opencode/agents/)
 *   2) Skills (makdoong2-team entry + research skills)
 *   3) Remove legacy per-skill secrets.env files (moved to makdoong2-team.json)
 *   4) Config file (seed from default if absent, respect --force)
 *   4b) Ensure .secrets scaffolding present in makdoong2-team.json
 *   5) Patch opencode.json (add plugin ref + tools; strip legacy secrets glob)
 *
 * @param {Object} opts
 * @param {string} opts.configDir - Absolute path to config dir (default: resolveConfigDir(undefined))
 * @param {string} opts.pkgRoot - Absolute path to package root
 * @param {boolean} [opts.force=false] - Overwrite makdoong2-team.json if exists
 * @param {"idempotent"|"always"|"skip"} [opts.patchOpencode="idempotent"] - opencode.json patch strategy
 * @param {Object} [opts.logger=console] - Console-like logger
 * @returns {{deployed: string[], backedUp: string[], skipped: string[], warnings: string[]}}
 */
export function install(opts) {
  const {
    configDir,
    pkgRoot,
    force = false,
    patchOpencode = "idempotent",
    logger = console,
  } = opts;

  const result = {
    deployed: [],
    backedUp: [],
    skipped: [],
    warnings: [],
  };

  const ok = (m) => { logger.log(`  ✓ ${m}`); result.deployed.push(m); };
  const info = (m) => logger.log(m);
  const warn = (m) => { logger.warn(`  ! ${m}`); result.warnings.push(m); };

  function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  function backup(target) {
    if (!existsSync(target)) return;
    const bak = `${target}.bak.${timestamp()}`;
    cpSync(target, bak, { recursive: true });
    info(`    backup: ${target} → ${bak}`);
    result.backedUp.push(bak);
  }

  function copyInto(srcAbs, destAbs, { exec = false } = {}) {
    mkdirSync(dirname(destAbs), { recursive: true });
    cpSync(srcAbs, destAbs, { recursive: true });
    if (exec) chmodSync(destAbs, 0o755);
  }

  function chmodShAll(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".sh")) chmodSync(join(dir, name), 0o755);
    }
  }

  function pruneStaleAgents(srcDir, destDir, { info }) {
    if (!existsSync(destDir)) return;
    const fresh = new Set(readdirSync(srcDir).filter(n => n.endsWith(".md")));
    for (const name of readdirSync(destDir)) {
      if (!name.endsWith(".md")) continue;
      if (!name.startsWith("makdoong2-")) continue;
      if (!fresh.has(name)) {
        rmSync(join(destDir, name));
        info(`    pruned stale agent: ${name}`);
      }
    }
  }

  info(`[makdoong2-team] installing from ${pkgRoot} → ${configDir}`);

  // 0) Cleanup stale config-dir artifacts from pre-refactor installs.
  // Older versions of install() copied plugin source, gates, stages, references,
  // utility scripts, the with-fallback wrapper and the config schema into
  // ~/.config/opencode/. They now live inside the npm module, so stale copies
  // in the config dir would shadow the current versions or drift out of sync.
  // Backup each existing entry then remove it so a subsequent install run leaves
  // the config dir with only agents/skills/config/opencode.json.
  info("Cleaning up stale files from previous install...");
  for (const rel of STALE_PATHS) {
    const target = join(configDir, rel);
    if (!existsSync(target)) continue;
    backup(target);
    rmSync(target, { recursive: true, force: true });
    info(`    removed stale: ${target}`);
  }
  // `scripts/` needs special handling: it may contain non-makdoong2 scripts
  // that other tools installed into the shared config dir. Only remove the
  // known UTIL_SCRIPTS entries; leave everything else alone.
  const scriptsDir = join(configDir, "scripts");
  if (existsSync(scriptsDir)) {
    for (const name of UTIL_SCRIPTS) {
      const s = join(scriptsDir, name);
      if (!existsSync(s)) continue;
      backup(s);
      rmSync(s, { force: true });
      info(`    removed stale: ${s}`);
    }
  }

  // Create directory structure — only agents/ and research skills/ are deployed.
  // All other runtime assets (gates, scripts, stages, references) live in the
  // npm module and are referenced via resolvePaths() in src/config.ts.
  const skillDirs = RESEARCH_SKILLS.map((s) => `skills/${s}`);
  for (const d of ["agents", ...skillDirs]) {
    mkdirSync(join(configDir, d), { recursive: true });
  }

  // 1) Agents
  // Prune stale agent definitions before deploy so removed agents do not linger.
  // `cpSync({recursive:true})` only overwrites — it never deletes, which leaves
  // pre-refactor agents like makdoong2-jira behind and confuses the team-leader.
  pruneStaleAgents(join(pkgRoot, "agents"), join(configDir, "agents"), { info });
  copyInto(join(pkgRoot, "agents"), join(configDir, "agents"));
  ok("agent definitions");

  // 2) Research skills only (no makdoong2-team skill — workflow is agent-only)
  // Copy the shared _lib helpers (sourced by run-*.sh) first so downstream
  // skill dirs can reference ../_lib/load-secret.sh.
  const libSrc = join(pkgRoot, "skills", "_lib");
  if (existsSync(libSrc)) {
    const libDst = join(configDir, "skills", "_lib");
    mkdirSync(libDst, { recursive: true });
    for (const name of readdirSync(libSrc)) {
      cpSync(join(libSrc, name), join(libDst, name));
      if (name.endsWith(".sh")) chmodSync(join(libDst, name), 0o755);
    }
  }
  // Research skills — MCP-backed investigation tools, NOT the workflow orchestrator.
  for (const skill of RESEARCH_SKILLS) {
    const src = join(pkgRoot, "skills", skill);
    if (!existsSync(src)) continue;
    const dst = join(configDir, "skills", skill);
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      cpSync(join(src, name), join(dst, name));
      if (name.endsWith(".sh")) chmodSync(join(dst, name), 0o755);
    }
  }
  ok("research skills (jira/confluence/bitbucket/github-oss/bamboo)");

  // 3) Config file — seed from default ONLY if absent (never clobber user edits unless --force)
  const cfgPath = join(configDir, "makdoong2-team.json");
  if (!existsSync(cfgPath) || force) {
    if (existsSync(cfgPath)) backup(cfgPath);
    cpSync(join(pkgRoot, "assets/makdoong2-team.default.json"), cfgPath);
    ok(`config → ${cfgPath}`);
  } else {
    info(`  ! config exists, left as-is: ${cfgPath} (use --force to reset)`);
    result.skipped.push(cfgPath);
  }

  // 3b) Ensure .secrets scaffolding exists in makdoong2-team.json so users
  // upgrading from a pre-secrets version see the expected shape and can
  // fill in tokens without hunting for the schema. Idempotent additive merge.
  ensureSecretsScaffolding(cfgPath, { ok, info });

  // 3b') Same additive merge for .logging so users upgrading from a
  // pre-mode/path version see level+mode+path shape without manual editing.
  ensureLoggingScaffolding(cfgPath, { ok, info });

  // 3c) Back up and remove legacy per-skill secrets.env from previous installs.
  // No value migration — users on the new layout enter tokens directly in
  // makdoong2-team.json .secrets.*.
  cleanupLegacySecretsEnv(configDir, { info, backup });

  // 5) Patch opencode.json
  if (patchOpencode !== "skip") {
    patchOpencodeJson(configDir, pkgRoot, patchOpencode, { ok, info, warn, backup });
  }

  // 6) Seed opencode plugin cache directory.
  // The package now lives on the public registry.npmjs.org, so opencode's
  // internal npm client *can* fetch it — but that fetch resolves independently
  // of the globally installed module and can leave the session running a
  // different version than `npm ls -g` reports. We pre-populate
  // ~/.cache/opencode/packages/makdoong2-team@latest/ with a symlink to the
  // already-installed npm module so opencode skips the fetch and always loads
  // exactly the version that was just installed (also keeps installs offline-safe).
  seedOpencodeCache(pkgRoot, { ok, info, warn });

  return result;
}

/**
 * Patch opencode.json — add plugin ref + tools (seed from example if absent)
 * @param {string} configDir - Config directory
 * @param {string} pkgRoot - Package root
 * @param {"idempotent"|"always"} strategy - Patch strategy
 * @param {Object} helpers - Helper functions {ok, info, warn, backup}
 */
function patchOpencodeJson(configDir, pkgRoot, strategy, { ok, info, warn, backup }) {
  const ocPath = join(configDir, "opencode.json");
  const currentPluginRef = pluginRef(pkgRoot);
  let oc;

  const requiredExtDirPaths = computeExternalDirPaths(pkgRoot, configDir);

  if (existsSync(ocPath)) {
    try {
      oc = parseJsonc(readFileSync(ocPath, "utf8"));
    } catch (err) {
      throw new Error(
        `opencode.json could not be parsed (even allowing JSONC comments and trailing commas): ${ocPath}\n` +
        `  ${err.message}\n` +
        `  Fix the syntax and re-run the install — continuing would silently leave the plugin unregistered.`
      );
    }

    // Idempotent check: plugin ref + all tools enabled + alwaysLoad includes our
    // tools + no legacy plugin ref remnants + no stale globs + all required
    // absolute-path external_directory entries present.
    if (strategy === "idempotent") {
      const hasPlugin = Array.isArray(oc.plugin) && oc.plugin.includes(currentPluginRef);
      const hasLegacy = Array.isArray(oc.plugin) && oc.plugin.some(isLegacyPluginEntry);
      const hasAllTools = oc.tools && typeof oc.tools === "object" && TOOLS.every((t) => oc.tools[t] === true);
      const hasAlwaysLoad = TOOLS.every((t) => alwaysLoadIncludes(oc.plugin, t));
      const hasStaleReadGlob = oc.permission?.read && Object.prototype.hasOwnProperty.call(oc.permission.read, LEGACY_SKILL_SECRETS_GLOB);
      const hasStaleExtDirGlob = Object.prototype.hasOwnProperty.call(oc.permission?.external_directory ?? {}, LEGACY_PKG_EXTERNAL_DIR_GLOB);
      const hasAllExtDirPaths = requiredExtDirPaths.every(
        (p) => oc.permission?.external_directory?.[p] === "allow"
      );
      if (hasPlugin && !hasLegacy && hasAllTools && hasAlwaysLoad && !hasStaleReadGlob && !hasStaleExtDirGlob && hasAllExtDirPaths) {
        info(`  ! opencode.json already configured (idempotent skip)`);
        return;
      }
    }

    backup(ocPath);
  } else if (existsSync(join(pkgRoot, "opencode.json.example"))) {
    oc = JSON.parse(readFileSync(join(pkgRoot, "opencode.json.example"), "utf8"));
  } else {
    oc = {};
  }

  oc.plugin = Array.isArray(oc.plugin) ? oc.plugin : [];
  // Strip every legacy ref shape written by pre-refactor installs:
  //   - old relative path pointing at ~/.config/opencode/plugins/makdoong2-team/
  //   - old absolute path pointing at <npm-root>/src/opencode-plugin.ts
  // Leaving either behind either fails to resolve (relative) or pins the entry
  // to a specific nvm/node install (absolute), breaking portability. Replaced
  // with the npm package name inserted below.
  oc.plugin = oc.plugin.filter((entry) => !isLegacyPluginEntry(entry));
  if (!oc.plugin.includes(currentPluginRef)) oc.plugin.push(currentPluginRef);
  // Without this, opencode-tool-search hides our tools behind BM25 search, and
  // the leader's `tool_search("dispatch_stage")` returns no match — pushing it
  // to fall back on call_omo_agent loops that hang in stage 4.
  ensureToolsInAlwaysLoad(oc.plugin, TOOLS);
  oc.tools = oc.tools && typeof oc.tools === "object" ? oc.tools : {};
  for (const t of TOOLS) oc.tools[t] = true;
  // Strip the legacy secrets.env read permission — credentials no longer
  // live in per-skill secrets.env, so opencode does not need file-read
  // access to them. Idempotent (no-op when absent).
  removeLegacyReadPermission(oc);
  ensureExternalDirPaths(oc, requiredExtDirPaths);
  writeFileSync(ocPath, JSON.stringify(oc, null, 2) + "\n");
  ok(`opencode.json (plugin + ${TOOLS.length} tools)`);
}

/**
 * Strip the pre-secrets.env-migration read-permission glob from opencode.json.
 * The glob (${LEGACY_SKILL_SECRETS_GLOB}) was needed while credentials lived
 * in per-skill secrets.env; now that they live only in makdoong2-team.json,
 * the glob is redundant clutter that suggests stale files still matter.
 * Idempotent — no-op when absent.
 * @param {Object} oc - opencode.json config object (mutated in place)
 */
function removeLegacyReadPermission(oc) {
  const read = oc?.permission?.read;
  if (!read || typeof read !== "object") return;
  if (Object.prototype.hasOwnProperty.call(read, LEGACY_SKILL_SECRETS_GLOB)) {
    delete read[LEGACY_SKILL_SECRETS_GLOB];
  }
  if (Object.keys(read).length === 0) delete oc.permission.read;
  if (oc.permission && Object.keys(oc.permission).length === 0) delete oc.permission;
}

/**
 * Compute the external_directory allow paths to write into opencode.json.
 * Returns absolute-path entries (with trailing /**) for:
 *   - pkgRoot: the npm package tree (stage specs, gate scripts, references)
 *   - configDir: the opencode config directory (agents, skills)
 *
 * Absolute-path prefixes are used instead of glob patterns because
 * path.matchesGlob's "**" cannot traverse dot-directories (.nvm, .config),
 * making patterns like "**\/makdoong2-team\/**" ineffective in practice.
 *
 * @param {string} pkgRoot - npm module root (e.g. /root/.nvm/.../node_modules/makdoong2-team)
 * @param {string} configDir - opencode config dir (e.g. /root/.config/opencode)
 * @returns {string[]}
 */
export function computeExternalDirPaths(pkgRoot, configDir) {
  return [
    pkgRoot.replace(/\/+$/, "") + "/**",
    configDir.replace(/\/+$/, "") + "/**",
  ];
}

/**
 * Idempotently apply required external_directory allow entries to opencode.json.
 * Strips the legacy glob pattern (pre-0.13.5) and adds the absolute-path entries
 * computed by computeExternalDirPaths. Mutates oc in place.
 * @param {Object} oc - opencode.json config object
 * @param {string[]} paths - Absolute-path allow entries from computeExternalDirPaths
 */
function ensureExternalDirPaths(oc, paths) {
  oc.permission = oc.permission && typeof oc.permission === "object" ? oc.permission : {};
  oc.permission.external_directory =
    oc.permission.external_directory && typeof oc.permission.external_directory === "object"
      ? oc.permission.external_directory
      : {};
  if (Object.prototype.hasOwnProperty.call(oc.permission.external_directory, LEGACY_PKG_EXTERNAL_DIR_GLOB)) {
    delete oc.permission.external_directory[LEGACY_PKG_EXTERNAL_DIR_GLOB];
  }
  for (const p of paths) {
    oc.permission.external_directory[p] = "allow";
  }
}

/**
 * Back up and remove legacy per-skill secrets.env files under configDir.
 * Credentials now live only in makdoong2-team.json .secrets.*; no value
 * migration is performed. Users on the new layout re-enter their tokens
 * directly in the JSON config. Idempotent — no-op when files are absent.
 * @param {string} configDir
 * @param {Object} helpers
 */
function cleanupLegacySecretsEnv(configDir, { info, backup }) {
  let removed = 0;
  for (const skill of LEGACY_SECRET_SKILL_DIRS) {
    const target = join(configDir, "skills", skill, "secrets.env");
    if (!existsSync(target)) continue;
    backup(target);
    rmSync(target, { force: true });
    info(`    removed legacy secret file: skills/${skill}/secrets.env`);
    removed++;
  }
  if (removed > 0) {
    info(`  ! ${removed} legacy secrets.env file(s) backed up + removed — set tokens in makdoong2-team.json .secrets.*`);
  }
}

/**
 * Ensure `.secrets` object exists in makdoong2-team.json with the four
 * canonical token keys (empty string default). Idempotent additive merge —
 * preserves any user-authored token values, only fills missing keys.
 * Skips silently if the file is absent or unparseable.
 * @param {string} cfgPath
 * @param {Object} helpers
 */
function ensureSecretsScaffolding(cfgPath, { ok, info }) {
  if (!existsSync(cfgPath)) return;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    info(`  ! makdoong2-team.json not valid JSON — skipping secrets scaffolding`);
    return;
  }
  const before = cfg.secrets;
  if (!before || typeof before !== "object") cfg.secrets = {};
  let added = 0;
  for (const key of SECRET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(cfg.secrets, key)) {
      cfg.secrets[key] = "";
      added++;
    }
  }
  if (added === 0 && before && typeof before === "object") return;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  ok(`secrets scaffolding ensured (${added} key(s) seeded)`);
}

function ensureLoggingScaffolding(cfgPath, { ok, info }) {
  if (!existsSync(cfgPath)) return;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    info(`  ! makdoong2-team.json not valid JSON — skipping logging scaffolding`);
    return;
  }
  const before = cfg.logging;
  const hadLoggingBlock = before && typeof before === "object";
  if (!hadLoggingBlock) cfg.logging = {};
  let added = 0;
  if (!Object.prototype.hasOwnProperty.call(cfg.logging, "level")) {
    cfg.logging.level = DEFAULT_LOGGING_LEVEL;
    added++;
  }
  if (!Object.prototype.hasOwnProperty.call(cfg.logging, "mode")) {
    cfg.logging.mode = DEFAULT_LOGGING_MODE;
    added++;
  }
  if (!Object.prototype.hasOwnProperty.call(cfg.logging, "path")) {
    cfg.logging.path = DEFAULT_LOGGING_PATH;
    added++;
  }
  if (added === 0 && hadLoggingBlock) return;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  ok(`logging scaffolding ensured (${added} key(s) seeded; defaults: level="${DEFAULT_LOGGING_LEVEL}", mode="${DEFAULT_LOGGING_MODE}")`);
}

function findToolSearchEntry(pluginArr) {
  if (!Array.isArray(pluginArr)) return null;
  for (const entry of pluginArr) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].startsWith(TOOL_SEARCH_PLUGIN_PREFIX)) {
      return entry;
    }
  }
  return null;
}

function alwaysLoadIncludes(pluginArr, toolName) {
  const entry = findToolSearchEntry(pluginArr);
  if (!entry) return true; // tool-search not configured → all tools always visible
  const opts = entry[1];
  if (!opts || typeof opts !== "object") return true;
  const list = opts.alwaysLoad;
  if (!Array.isArray(list)) return true;
  return list.includes(toolName);
}

function ensureToolsInAlwaysLoad(pluginArr, toolNames) {
  const entry = findToolSearchEntry(pluginArr);
  if (!entry) return; // tool-search not configured; nothing to patch
  if (!entry[1] || typeof entry[1] !== "object") entry[1] = {};
  if (!Array.isArray(entry[1].alwaysLoad)) entry[1].alwaysLoad = [];
  for (const t of toolNames) {
    if (!entry[1].alwaysLoad.includes(t)) entry[1].alwaysLoad.push(t);
  }
}

/**
 * Resolve the cache root opencode uses to stage downloaded plugin packages.
 * Mirrors opencode's own logic: $XDG_CACHE_HOME/opencode/packages, falling
 * back to $HOME/.cache/opencode/packages.
 * @returns {string}
 */
export function opencodeCacheRoot() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".cache");
  return join(base, "opencode", "packages");
}

/**
 * Remove makdoong tools from opencode-tool-search alwaysLoad list.
 * No-op when opencode-tool-search is not configured (user doesn't use it).
 * @param {Array} pluginArr - opencode.json plugin array (mutated in place)
 * @param {string[]} toolNames - Tool IDs to remove
 * @returns {boolean} true if any entry was removed
 */
function removeToolsFromAlwaysLoad(pluginArr, toolNames) {
  const entry = findToolSearchEntry(pluginArr);
  if (!entry) return false; // opencode-tool-search not present — nothing to do
  const opts = entry[1];
  if (!opts || typeof opts !== "object" || !Array.isArray(opts.alwaysLoad)) return false;
  const before = opts.alwaysLoad.length;
  opts.alwaysLoad = opts.alwaysLoad.filter((t) => !toolNames.includes(t));
  return opts.alwaysLoad.length < before;
}

/**
 * Remove a directory only when it is empty (or does not exist). Silent on error.
 * @param {string} dir
 */
function tryCleanEmptyDir(dir) {
  try {
    if (!existsSync(dir)) return;
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Strip makdoong2-team entries from opencode.json:
 *   - plugin array entry (current package name + all legacy shapes)
 *   - tools section keys (verify_stage, dispatch_stage, …)
 *   - alwaysLoad entries from opencode-tool-search config (only when present)
 *   - pkgRoot/** entry from permission.external_directory
 *   - legacy glob from permission.external_directory
 *
 * configDir/** is intentionally left alone — it is a broad permission that
 * may legitimately be used by other tools.
 *
 * @param {string} configDir
 * @param {string} pkgRoot
 * @param {Object} helpers - {ok, skip, info, warn}
 * @returns {boolean} true if the file was modified
 */
function unpatchOpencodeJson(configDir, pkgRoot, { ok, skip, warn }) {
  const ocPath = join(configDir, "opencode.json");
  if (!existsSync(ocPath)) {
    skip("opencode.json not found — nothing to patch");
    return false;
  }

  let oc;
  try {
    oc = parseJsonc(readFileSync(ocPath, "utf8"));
  } catch (err) {
    warn(`opencode.json could not be parsed — leaving untouched: ${ocPath} (${err.message})`);
    return false;
  }

  let changed = false;

  // — Plugin array —
  if (Array.isArray(oc.plugin)) {
    const before = oc.plugin.length;
    oc.plugin = oc.plugin.filter((entry) => {
      if (typeof entry === "string") {
        return entry !== PLUGIN_PACKAGE_NAME && !isLegacyPluginEntry(entry);
      }
      return true; // keep array entries (tool-search config tuples, other plugins)
    });
    if (oc.plugin.length < before) changed = true;
  }

  // — alwaysLoad (only when opencode-tool-search is configured) —
  if (Array.isArray(oc.plugin) && removeToolsFromAlwaysLoad(oc.plugin, TOOLS)) changed = true;

  // — tools section —
  if (oc.tools && typeof oc.tools === "object") {
    for (const t of TOOLS) {
      if (Object.prototype.hasOwnProperty.call(oc.tools, t)) {
        delete oc.tools[t];
        changed = true;
      }
    }
    if (Object.keys(oc.tools).length === 0) delete oc.tools;
  }

  // — external_directory: pkgRoot/** entries and legacy glob —
  // We match by package-name suffix rather than exact pkgRoot prefix because the
  // uninstall may run from a different pkgRoot (e.g. dev checkout) than the one
  // that originally wrote the entry (npm global install path).  Any key that ends
  // with "makdoong2-team/**" is safe to remove — that suffix also matches the
  // legacy "@local/makdoong2-team/**" entries written by internal-registry installs.
  const extDir = oc.permission?.external_directory;
  if (extDir && typeof extDir === "object") {
    const pkgSuffix = `${PLUGIN_PACKAGE_NAME}/**`;  // "makdoong2-team/**"
    const pkgEntry  = pkgRoot.replace(/\/+$/, "") + "/**";
    for (const key of Object.keys(extDir)) {
      const isLegacyGlob = key === LEGACY_PKG_EXTERNAL_DIR_GLOB;
      const isCurrentPkg = key === pkgEntry;
      const isNpmPattern = key.endsWith(pkgSuffix);
      if (isLegacyGlob || isCurrentPkg || isNpmPattern) {
        delete extDir[key];
        changed = true;
      }
    }
    if (Object.keys(extDir).length === 0) {
      delete oc.permission.external_directory;
    }
    if (oc.permission && Object.keys(oc.permission).length === 0) {
      delete oc.permission;
    }
  }

  if (!changed) {
    skip("opencode.json: no makdoong2-team entries found");
    return false;
  }

  writeFileSync(ocPath, JSON.stringify(oc, null, 2) + "\n");
  ok(`opencode.json patched (plugin ref + ${TOOLS.length} tools removed)`);
  return true;
}

/**
 * Remove the opencode plugin cache symlinks created by seedOpencodeCache.
 * Only removes entries that are confirmed symlinks; leaves real content alone.
 *
 * @param {string} pkgRoot
 * @param {Object} helpers - {ok, skip, warn}
 */
function removeOpencodeCache(pkgRoot, { ok, skip, warn }) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  } catch (err) {
    warn(`cache removal skipped — cannot read package.json: ${err.message}`);
    return;
  }
  const { name, version } = pkg;
  if (!name || !version) {
    warn("cache removal skipped — package.json missing name/version");
    return;
  }

  const cacheRoot = opencodeCacheRoot();
  const tags = [`${name}@latest`, `${name}@${version}`];
  let removedCount = 0;

  for (const tag of tags) {
    const cacheDir = join(cacheRoot, tag);
    if (!existsSync(cacheDir)) continue;
    const modulesDir = join(cacheDir, "node_modules", name);
    if (!existsSync(modulesDir)) continue;
    try {
      if (lstatSync(modulesDir).isSymbolicLink()) {
        rmSync(modulesDir, { force: true });
        // Prune now-empty ancestor dirs. slice(0, -1) is empty for the current
        // unscoped name (scopeDir === node_modules); it still resolves the extra
        // scope level for caches left behind by the old @local-scoped installs.
        const scopeDir = join(cacheDir, "node_modules", ...name.split("/").slice(0, -1));
        tryCleanEmptyDir(scopeDir);
        tryCleanEmptyDir(join(cacheDir, "node_modules"));
        tryCleanEmptyDir(cacheDir);
        removedCount++;
      } else {
        warn(`cache entry at ${modulesDir} is not a symlink — leaving in place`);
      }
    } catch (err) {
      warn(`cache removal failed for ${tag}: ${err.message}`);
    }
  }

  if (removedCount > 0) ok(`opencode plugin cache symlinks removed (${tags.join(", ")})`);
  else skip("no opencode plugin cache symlinks to remove");
}

/**
 * Revert all config-dir and opencode.json changes made by install().
 *
 * What is removed (idempotent — absent targets are silently skipped):
 *   1. Agent definitions: agents/makdoong2-*.md
 *   2. Research skill directories: skills/jira-research, confluence-research, bitbucket-research,
 *      and skills/_lib/ (only when it contains solely our files)
 *   3. opencode.json: plugin ref, tools keys, alwaysLoad entries (when
 *      opencode-tool-search is configured), pkgRoot/** external_directory entry
 *   4. opencode plugin cache symlinks seeded by seedOpencodeCache()
 *
 * What is intentionally left in place:
 *   - makdoong2-team.json  (user credentials / config)
 *   - configDir/** from external_directory (broad permission; may be used by others)
 *   - The npm package itself (use npm uninstall -g makdoong2-team for that)
 *
 * @param {Object} opts
 * @param {string} opts.configDir - Absolute path to config dir
 * @param {string} opts.pkgRoot  - Absolute path to package root (npm module)
 * @param {Object} [opts.logger=console]
 * @returns {{removed: string[], skipped: string[], warnings: string[]}}
 */
export function uninstall(opts) {
  const {
    configDir,
    pkgRoot,
    logger = console,
  } = opts;

  const result = { removed: [], skipped: [], warnings: [] };

  const ok   = (m) => { logger.log(`  ✓ ${m}`); result.removed.push(m); };
  const skip = (m) => { logger.log(`  - ${m}`); result.skipped.push(m); };
  const info = (m) => logger.log(m);
  const warn = (m) => { logger.warn(`  ! ${m}`); result.warnings.push(m); };

  info(`[makdoong2-team] uninstall — ${configDir}`);

  // 1) Agent definitions
  info("Removing agent definitions...");
  const agentsDir = join(configDir, "agents");
  if (existsSync(agentsDir)) {
    let count = 0;
    for (const name of readdirSync(agentsDir)) {
      if (!name.startsWith("makdoong2-") || !name.endsWith(".md")) continue;
      rmSync(join(agentsDir, name), { force: true });
      count++;
    }
    if (count > 0) ok(`${count} agent definition(s) removed from agents/`);
    else           skip("agents/: no makdoong2-*.md files found");
  } else {
    skip("agents/: directory not found");
  }

  // 2) Research skill directories
  info("Removing research skills...");
  let skillsRemoved = 0;
  for (const skill of RESEARCH_SKILLS) {
    const skillDir = join(configDir, "skills", skill);
    if (!existsSync(skillDir)) continue;
    rmSync(skillDir, { recursive: true, force: true });
    skillsRemoved++;
  }
  // _lib — remove only when its contents are exclusively ours
  const libDir = join(configDir, "skills", "_lib");
  if (existsSync(libDir)) {
    const libFiles = readdirSync(libDir);
    const ourLibFiles = new Set(["load-secret.sh"]);
    if (libFiles.every((f) => ourLibFiles.has(f))) {
      rmSync(libDir, { recursive: true, force: true });
      skillsRemoved++;
    } else {
      warn("skills/_lib/ contains unrecognised files — leaving in place");
    }
  }
  if (skillsRemoved > 0) ok(`${skillsRemoved} research skill director(y/ies) removed`);
  else                   skip("skills/: no makdoong2-team skill directories found");

  // 3) opencode.json
  info("Patching opencode.json...");
  unpatchOpencodeJson(configDir, pkgRoot, { ok, skip, warn });

  // 4) opencode plugin cache symlinks
  info("Removing opencode cache entries...");
  removeOpencodeCache(pkgRoot, { ok, skip, warn });

  info("");
  info("[makdoong2-team] uninstall complete — restart opencode to apply changes.");
  info(`  makdoong2-team.json preserved at: ${join(configDir, "makdoong2-team.json")}`);
  info("  (Delete it manually if you no longer need the credentials stored there.)");

  return result;
}

/**
 * Pre-populate opencode's plugin cache with a symlink pointing at the
 * already-installed npm module for this package. Idempotent.
 *
 * Rationale: pins the session to the globally installed module instead of
 * whatever opencode's built-in npm client resolves from registry.npmjs.org on
 * its own. Without this step an upgrade can appear to succeed (`npm ls -g`
 * shows the new version) while opencode keeps loading a stale cached copy.
 *
 * @param {string} pkgRoot - Absolute path to this npm module's root (source of the symlink target)
 * @param {Object} helpers - {ok, info, warn} logger callbacks
 */
export function readCachedVersion(modulesDir) {
  try {
    return JSON.parse(readFileSync(join(modulesDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function seedOpencodeCache(pkgRoot, { ok, info, warn }) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  } catch (err) {
    warn(`opencode cache seed skipped — cannot read package.json: ${err.message}`);
    return;
  }
  const name = pkg.name;
  const version = pkg.version;
  if (!name || !version) {
    warn("opencode cache seed skipped — package.json missing name/version");
    return;
  }

  // opencode caches under `<name>@latest` (the tag it resolves) as well as
  // `<name>@<explicit-version>` for pinned refs. Seed both so opencode.json
  // entries in either shape ("makdoong2-team" or "makdoong2-team@0.2.1")
  // both hit the cache.
  const cacheRoot = opencodeCacheRoot();
  const tags = [`${name}@latest`, `${name}@${version}`];
  for (const tag of tags) {
    const cacheDir = join(cacheRoot, tag);
    const modulesDir = join(cacheDir, "node_modules", name);
    const parentDir = join(cacheDir, "node_modules", ...name.split("/").slice(0, -1));

    try {
      mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      warn(`opencode cache seed failed to mkdir ${parentDir}: ${err.message}`);
      continue;
    }

    // Remove existing symlink or empty dir before re-linking. A real directory
    // is an opencode-downloaded copy; unconditionally skipping it (the previous
    // behaviour) pinned `<name>@latest` to whatever version opencode fetched
    // first and made every later install a no-op — the plugin then kept loading
    // stale code while `npm ls -g` reported the new version. Replace it when the
    // version differs, and only skip when it already matches.
    if (existsSync(modulesDir)) {
      const st = lstatSync(modulesDir);
      if (st.isSymbolicLink()) {
        rmSync(modulesDir, { force: true });
      } else if (st.isDirectory() && readdirSync(modulesDir).length === 0) {
        rmSync(modulesDir, { recursive: true, force: true });
      } else {
        const cachedVersion = readCachedVersion(modulesDir);
        if (cachedVersion === version) {
          info(`  ! opencode cache already at v${version} for ${tag} — skipping`);
          continue;
        }
        const stale = `${modulesDir}.stale-${cachedVersion ?? "unknown"}`;
        rmSync(stale, { recursive: true, force: true });
        try {
          renameSync(modulesDir, stale);
        } catch (err) {
          warn(`opencode cache seed could not set aside stale ${cachedVersion ?? "unknown"} copy: ${err.message}`);
          continue;
        }
        ok(`opencode cache ${tag}: replaced stale v${cachedVersion ?? "unknown"} → v${version} (old copy kept at ${stale})`);
      }
    }

    try {
      symlinkSync(pkgRoot, modulesDir, "dir");
    } catch (err) {
      warn(`opencode cache symlink failed: ${err.message}`);
      continue;
    }

    // Write the minimal package.json opencode expects so its post-fetch
    // sanity check ("open .../node_modules/package.json") succeeds.
    const stubPath = join(cacheDir, "package.json");
    if (!existsSync(stubPath)) {
      writeFileSync(stubPath, JSON.stringify({ dependencies: { [name]: version } }, null, 2) + "\n");
    }
  }
  ok(`opencode plugin cache seeded (${tags.join(", ")})`);
}
