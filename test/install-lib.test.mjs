// test/install-lib.test.mjs — Unit tests for scripts/install-lib.mjs
//
// Uses Node.js built-in test runner (node:test).
// Run via: node test/install-lib.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  install,
  resolveConfigDir,
  computeExternalDirPaths,
  parseJsonc,
  readCachedVersion,
} from "../scripts/install-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

describe("install-lib", () => {
  test("install() deploys agents + research skills to configDir, others stay in pkgRoot", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    
    try {
      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });
      
      // Deployed to configDir: agents + research skills only (NO makdoong2-team skill)
      assert.ok(existsSync(join(configDir, "agents/makdoong2-team-leader.md")), "agents deployed to configDir");
      assert.ok(!existsSync(join(configDir, "skills/makdoong2-team")), "makdoong2-team skill NOT deployed (workflow is agent-only)");
      assert.ok(existsSync(join(configDir, "skills/jira-research/SKILL.md")), "research skill deployed to configDir");
      assert.ok(existsSync(join(configDir, "skills/_lib/load-secret.sh")), "_lib helper deployed to configDir");
      assert.ok(existsSync(join(configDir, "skills/makdoong2-issue-reporter/SKILL.md")), "issue-reporter utility skill deployed to configDir");
      assert.ok(existsSync(join(configDir, "command/makdoong2-issue-reporter.md")), "issue-reporter command deployed to configDir");
      
      // Exist in pkgRoot (not deployed, stay there): gates, stages, scripts, plugin
      assert.ok(existsSync(join(PKG_ROOT, "gates")), "gates exist in pkgRoot");
      assert.ok(existsSync(join(PKG_ROOT, "stages")), "stages exist in pkgRoot");
      assert.ok(existsSync(join(PKG_ROOT, "scripts/state.sh")), "state.sh exists in pkgRoot");
      assert.ok(existsSync(join(PKG_ROOT, "scripts/model-policy.mjs")), "model-policy.mjs exists in pkgRoot");
      assert.ok(existsSync(join(PKG_ROOT, "src/opencode-plugin.ts")), "plugin source exists in pkgRoot");
      
      // Config file in configDir
      assert.ok(existsSync(join(configDir, "makdoong2-team.json")), "config seeded in configDir");
      
      assert.ok(result.deployed.length > 0, "result.deployed populated");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("force=false preserves user-authored top-level keys while scaffolding secrets", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const cfgPath = join(configDir, "makdoong2-team.json");
    const original = { custom: "user-data" };
    writeFileSync(cfgPath, JSON.stringify(original, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const after = JSON.parse(readFileSync(cfgPath, "utf8"));
      assert.equal(after.custom, "user-data", "user-authored top-level key preserved");
      assert.ok(after.secrets && typeof after.secrets === "object", ".secrets scaffolding added");
      for (const key of ["BITBUCKET_API_TOKEN", "JIRA_API_TOKEN", "CONFLUENCE_API_TOKEN", "BAMBOO_TOKEN"]) {
        assert.equal(after.secrets[key], "", `.secrets.${key} seeded to empty string`);
      }
      assert.ok(after.logging && typeof after.logging === "object", ".logging scaffolding added");
      assert.equal(after.logging.level, "error", ".logging.level seeded to default 'error'");
      assert.equal(after.logging.mode, "stdin", ".logging.mode seeded to default 'stdin'");
      assert.equal(after.logging.path, null, ".logging.path seeded to null");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("logging scaffolding preserves user-set level, seeds missing mode/path", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const cfgPath = join(configDir, "makdoong2-team.json");
    writeFileSync(cfgPath, JSON.stringify({ logging: { level: "debug" } }, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const after = JSON.parse(readFileSync(cfgPath, "utf8"));
      assert.equal(after.logging.level, "debug", "user-set logging.level preserved");
      assert.equal(after.logging.mode, "stdin", "logging.mode seeded to default");
      assert.equal(after.logging.path, null, "logging.path seeded to null");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("logging scaffolding preserves full user-set logging block (mode=file + path)", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const cfgPath = join(configDir, "makdoong2-team.json");
    const userCfg = {
      logging: { level: "info", mode: "file", path: "/var/log/mkd2.log" },
    };
    writeFileSync(cfgPath, JSON.stringify(userCfg, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const after = JSON.parse(readFileSync(cfgPath, "utf8"));
      assert.equal(after.logging.level, "info");
      assert.equal(after.logging.mode, "file");
      assert.equal(after.logging.path, "/var/log/mkd2.log");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("force=true backs up + overwrites makdoong2-team.json", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    
    const cfgPath = join(configDir, "makdoong2-team.json");
    const originalContent = JSON.stringify({ custom: "user-data" }, null, 2);
    writeFileSync(cfgPath, originalContent);
    
    try {
      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: true,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });
      
      const afterContent = readFileSync(cfgPath, "utf8");
      assert.notEqual(afterContent, originalContent, "config overwritten when force=true");
      
      // Verify backup created
      assert.ok(result.backedUp.some(p => p.includes("makdoong2-team.json")), "backup created");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("legacy skills/<skill>/secrets.env from previous installs is backed up + removed", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");

    try {
      const dir = join(configDir, "skills/jira-research");
      mkdirSync(dir, { recursive: true });
      const legacyPath = join(dir, "secrets.env");
      writeFileSync(legacyPath, "JIRA_API_TOKEN=stale-legacy-token\n");

      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      assert.ok(!existsSync(legacyPath), "legacy secrets.env removed");
      assert.ok(
        result.backedUp.some(p => p.includes("skills/jira-research/secrets.env")),
        "legacy secrets.env backed up before removal"
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("legacy secrets.env value is NOT migrated into makdoong2-team.json (backup+delete only)", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(join(configDir, "skills/jira-research"), { recursive: true });

    const legacyPath = join(configDir, "skills/jira-research/secrets.env");
    writeFileSync(legacyPath, "JIRA_API_TOKEN=stale-legacy-value\n");

    try {
      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const cfg = JSON.parse(readFileSync(join(configDir, "makdoong2-team.json"), "utf8"));
      assert.equal(cfg.secrets.JIRA_API_TOKEN, "",
        "JIRA_API_TOKEN stays empty — install never copies legacy env values into JSON");
      assert.ok(!existsSync(legacyPath), "legacy file still removed");
      assert.ok(
        result.backedUp.some(p => p.includes("skills/jira-research/secrets.env")),
        "legacy file backed up before deletion so users can recover manually",
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("legacy secrets.env cleanup is a no-op when files absent (idempotent)", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");

    try {
      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const legacyBackups = result.backedUp.filter(p => /skills\/[a-z-]+\/secrets\.env/.test(p));
      assert.equal(legacyBackups.length, 0, "no legacy backups when files absent");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("shared skills/_lib/load-secret.sh helper deployed and executable", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const helperPath = join(configDir, "skills/_lib/load-secret.sh");
      assert.ok(existsSync(helperPath), "load-secret.sh deployed");
      const mode = statSync(helperPath).mode & 0o111;
      assert.notEqual(mode, 0, "load-secret.sh has exec bit");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("patchOpencode: idempotent is no-op when plugin ref already present", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    
    const ocPath = join(configDir, "opencode.json");
    const pluginPath = "makdoong2-team";
    const existingOc = {
      plugin: [pluginPath],
      tools: { verify_stage: true, dispatch_stage: true, dispatch_verifier: true, dispatch_research: true, auto_advance_stage: true, get_fallback_model: true },
    };
    writeFileSync(ocPath, JSON.stringify(existingOc, null, 2));
    
    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "idempotent",
        logger: { log: () => {}, warn: () => {} },
      });
      
      const afterOc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.deepEqual(afterOc.plugin, existingOc.plugin, "plugin array unchanged (idempotent)");
      assert.deepEqual(afterOc.tools, existingOc.tools, "tools unchanged (idempotent)");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("patchOpencode: always rewrites opencode.json", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    
    const ocPath = join(configDir, "opencode.json");
    const existingOc = { plugin: [], tools: {} };
    writeFileSync(ocPath, JSON.stringify(existingOc, null, 2));
    
    try {
      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "always",
        logger: { log: () => {}, warn: () => {} },
      });
      
      const afterOc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.ok(afterOc.plugin.includes("makdoong2-team"), "plugin ref added as npm package name");
      assert.ok(afterOc.tools.verify_stage === true, "tools added");
      assert.ok(result.backedUp.some(p => p.includes("opencode.json")), "backup created on always");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("patchOpencode: skip leaves opencode.json untouched", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    
    const ocPath = join(configDir, "opencode.json");
    const existingOc = { custom: "data" };
    writeFileSync(ocPath, JSON.stringify(existingOc, null, 2));
    
    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });
      
      const afterOc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.deepEqual(afterOc, existingOc, "opencode.json untouched when patchOpencode=skip");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("chmod 755 applied to gates/*.sh, scripts/* (allow-list), bin/with-fallback.sh in pkgRoot", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    
    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });
      
      // Check gates/*.sh in pkgRoot (should have exec bit from source)
      const gateScript = join(PKG_ROOT, "gates/00-primary-only.sh");
      if (existsSync(gateScript)) {
        const stat = statSync(gateScript);
        assert.ok((stat.mode & 0o111) !== 0, "gate script has exec bit");
      }
      
      // Check scripts/state.sh in pkgRoot (should have exec bit from source)
      const stateScript = join(PKG_ROOT, "scripts/state.sh");
      if (existsSync(stateScript)) {
        const stat = statSync(stateScript);
        assert.ok((stat.mode & 0o111) !== 0, "state.sh has exec bit");
      }
      
      // Check bin/with-fallback.sh in pkgRoot (should have exec bit from source)
      const fallbackScript = join(PKG_ROOT, "bin/with-fallback.sh");
      if (existsSync(fallbackScript)) {
        const stat = statSync(fallbackScript);
        assert.ok((stat.mode & 0o111) !== 0, "with-fallback.sh has exec bit");
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  
  test("prunes stale makdoong2-* agent files removed from source", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    const stale = join(agentsDir, "makdoong2-jira.md");
    const userOwned = join(agentsDir, "my-custom-agent.md");
    writeFileSync(stale, "# old jira agent");
    writeFileSync(userOwned, "# user agent");

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      assert.ok(!existsSync(stale), "stale makdoong2-jira.md pruned");
      assert.ok(existsSync(userOwned), "non-makdoong2 agent files preserved");
      assert.ok(existsSync(join(agentsDir, "makdoong2-team-leader.md")), "fresh agent deployed");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("patchOpencode adds custom tools to opencode-tool-search alwaysLoad", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const ocPath = join(configDir, "opencode.json");
    writeFileSync(ocPath, JSON.stringify({
      plugin: [["opencode-tool-search@0.4.3", { alwaysLoad: ["bash", "read"] }]],
      tools: {},
    }, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "always",
        logger: { log: () => {}, warn: () => {} },
      });

      const oc = JSON.parse(readFileSync(ocPath, "utf8"));
      const ts = oc.plugin.find(p => Array.isArray(p) && p[0].startsWith("opencode-tool-search"));
      assert.ok(ts, "tool-search plugin entry preserved");
      const al = ts[1].alwaysLoad;
      for (const t of ["verify_stage", "dispatch_stage", "dispatch_verifier", "dispatch_research", "auto_advance_stage", "get_fallback_model"]) {
        assert.ok(al.includes(t), `${t} added to alwaysLoad`);
      }
      assert.ok(al.includes("bash"), "existing alwaysLoad entries preserved");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("install seeds .secrets scaffolding into fresh makdoong2-team.json", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const cfg = JSON.parse(readFileSync(join(configDir, "makdoong2-team.json"), "utf8"));
      assert.ok(cfg.secrets && typeof cfg.secrets === "object", ".secrets object present");
      for (const key of ["BITBUCKET_API_TOKEN", "JIRA_API_TOKEN", "CONFLUENCE_API_TOKEN", "BAMBOO_TOKEN"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(cfg.secrets, key), `.secrets.${key} scaffolded`);
        assert.equal(cfg.secrets[key], "", `.secrets.${key} default is empty string`);
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("install adds missing .secrets keys without touching user-authored tokens", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const cfgPath = join(configDir, "makdoong2-team.json");
    writeFileSync(cfgPath, JSON.stringify({
      agents: {},
      secrets: { BITBUCKET_API_TOKEN: "user-token-do-not-touch" },
    }, null, 2) + "\n");

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });

      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      assert.equal(cfg.secrets.BITBUCKET_API_TOKEN, "user-token-do-not-touch",
        "existing user token preserved");
      assert.equal(cfg.secrets.JIRA_API_TOKEN, "", "missing key scaffolded to empty string");
      assert.equal(cfg.secrets.CONFLUENCE_API_TOKEN, "", "missing key scaffolded to empty string");
      assert.equal(cfg.secrets.BAMBOO_TOKEN, "", "missing key scaffolded to empty string");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("install does NOT add permission.read glob for legacy skill secrets.env", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const ocPath = join(configDir, "opencode.json");
    writeFileSync(ocPath, JSON.stringify({ plugin: [], tools: {} }, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "always",
        logger: { log: () => {}, warn: () => {} },
      });

      const oc = JSON.parse(readFileSync(ocPath, "utf8"));
      const legacyGlob = "~/.config/opencode/skills/*/secrets.env";
      assert.ok(
        !oc.permission?.read || !Object.prototype.hasOwnProperty.call(oc.permission.read, legacyGlob),
        "legacy secrets.env read glob not added",
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("install strips pre-existing legacy permission.read secrets.env glob", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const ocPath = join(configDir, "opencode.json");
    writeFileSync(ocPath, JSON.stringify({
      plugin: [],
      tools: {},
      permission: {
        bash: { "*": "allow" },
        read: { "~/.config/opencode/skills/*/secrets.env": "allow" },
      },
    }, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "always",
        logger: { log: () => {}, warn: () => {} },
      });

      const oc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.ok(
        !oc.permission?.read || !Object.prototype.hasOwnProperty.call(oc.permission.read || {}, "~/.config/opencode/skills/*/secrets.env"),
        "legacy read glob removed",
      );
      assert.equal(oc.permission?.bash?.["*"], "allow", "unrelated permission.bash preserved");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("idempotent still re-patches when the stale secrets.env read glob lingers", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const ocPath = join(configDir, "opencode.json");
    const configuredWithStaleGlob = {
      plugin: [
        ["opencode-tool-search@0.4.3", {
          alwaysLoad: ["verify_stage", "dispatch_stage", "dispatch_verifier", "dispatch_research", "auto_advance_stage", "get_fallback_model"],
        }],
        "makdoong2-team",
      ],
      tools: { verify_stage: true, dispatch_stage: true, dispatch_verifier: true, dispatch_research: true, auto_advance_stage: true, get_fallback_model: true },
      permission: { read: { "~/.config/opencode/skills/*/secrets.env": "allow" } },
    };
    writeFileSync(ocPath, JSON.stringify(configuredWithStaleGlob, null, 2) + "\n");

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "idempotent",
        logger: { log: () => {}, warn: () => {} },
      });

      const oc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.ok(
        !oc.permission?.read || !Object.prototype.hasOwnProperty.call(oc.permission.read || {}, "~/.config/opencode/skills/*/secrets.env"),
        "stale glob stripped during idempotent re-patch",
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("idempotent is a true no-op when opencode.json already matches the current shape", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const ocPath = join(configDir, "opencode.json");
    const fullyConfigured = {
      plugin: [
        ["opencode-tool-search@0.4.3", {
          alwaysLoad: ["verify_stage", "dispatch_stage", "dispatch_verifier", "dispatch_research", "auto_advance_stage", "get_fallback_model"],
        }],
        "makdoong2-team",
      ],
      tools: { verify_stage: true, dispatch_stage: true, dispatch_verifier: true, dispatch_research: true, auto_advance_stage: true, get_fallback_model: true },
      permission: { external_directory: Object.fromEntries(computeExternalDirPaths(PKG_ROOT, configDir).map(p => [p, "allow"])) },
    };
    writeFileSync(ocPath, JSON.stringify(fullyConfigured, null, 2) + "\n");
    const before = readFileSync(ocPath, "utf8");

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "idempotent",
        logger: { log: () => {}, warn: () => {} },
      });
      const after = readFileSync(ocPath, "utf8");
      assert.equal(after, before, "opencode.json untouched when already in the current shape");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("legacy plugin refs are migrated to the published npm package name", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const ocPath = join(configDir, "opencode.json");
    const legacyOc = {
      plugin: [
        "./plugins/makdoong2-team/src/opencode-plugin.ts",
        "/usr/local/lib/node_modules/makdoong2-team/src/opencode-plugin.ts",
        "@local/makdoong2-team",
        "@local/makdoong2-team@0.2.1",
        "makdoong2-team@0.1.0",
        "opencode-claude-auth@1.5.4",
      ],
      tools: {},
    };
    writeFileSync(ocPath, JSON.stringify(legacyOc, null, 2));

    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "always",
        logger: { log: () => {}, warn: () => {} },
      });

      const oc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.ok(!oc.plugin.includes("./plugins/makdoong2-team/src/opencode-plugin.ts"), "relative legacy ref stripped");
      assert.ok(!oc.plugin.some(p => typeof p === "string" && p.endsWith("/src/opencode-plugin.ts")), "absolute legacy ref stripped");
      assert.ok(!oc.plugin.includes("@local/makdoong2-team"), "legacy @local-scoped name stripped");
      assert.ok(!oc.plugin.includes("@local/makdoong2-team@0.2.1"), "legacy @local-scoped name with version stripped");
      assert.ok(!oc.plugin.includes("makdoong2-team@0.1.0"), "version-pinned ref normalised to the bare name");
      assert.ok(oc.plugin.includes("makdoong2-team"), "published npm package name inserted");
      assert.ok(oc.plugin.includes("opencode-claude-auth@1.5.4"), "unrelated plugin entries preserved");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });



  test("backup files named *.bak.<timestamp> format", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-install-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    
    const cfgPath = join(configDir, "makdoong2-team.json");
    writeFileSync(cfgPath, JSON.stringify({ old: "data" }, null, 2));
    
    try {
      const result = install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: true,
        patchOpencode: "skip",
        logger: { log: () => {}, warn: () => {} },
      });
      
      const backupFile = result.backedUp.find(p => p.includes("makdoong2-team.json"));
      assert.ok(backupFile, "backup file created");
      assert.ok(/\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(backupFile), "backup follows *.bak.<ISO-timestamp> format");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("resolveConfigDir - path resolution", () => {
  test("no flag → returns XDG_CONFIG_HOME/opencode or $HOME/.config/opencode", () => {
    const result = resolveConfigDir(undefined);
    const expected = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode");
    assert.equal(result, expected);
  });

  test("explicit --config flag returns resolved absolute path", () => {
    const customPath = "/custom/config/path";
    const result = resolveConfigDir(customPath);
    assert.equal(result, resolve(customPath));
  });
});

describe("install-lib — JSONC tolerance for opencode.json", () => {
  test("parseJsonc accepts trailing commas and comments that opencode allows", () => {
    const jsonc = [
      "{",
      "  // line comment",
      '  "plugin": [',
      '    "oh-my-openagent@latest",',
      "  ],",
      "  /* block comment */",
      '  "permission": {',
      '    "bash": { "*": "allow" },',
      "  },",
      "}",
    ].join("\n");
    const parsed = parseJsonc(jsonc);
    assert.deepEqual(parsed.plugin, ["oh-my-openagent@latest"]);
    assert.deepEqual(parsed.permission, { bash: { "*": "allow" } });
  });

  test("parseJsonc never mangles comment-like or comma-like text inside strings", () => {
    const parsed = parseJsonc('{ "a": "http://x//y", "b": "trailing , }", "c": "/* not a comment */" }');
    assert.equal(parsed.a, "http://x//y");
    assert.equal(parsed.b, "trailing , }");
    assert.equal(parsed.c, "/* not a comment */");
  });

  test("parseJsonc still rejects genuinely broken JSON", () => {
    assert.throws(() => parseJsonc("{ not json"));
  });

  test("install() patches a trailing-comma opencode.json instead of silently skipping it", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-jsonc-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      '{\n  "plugin": [\n    "oh-my-openagent@latest",\n  ],\n}\n',
    );
    try {
      install({
        configDir,
        pkgRoot: PKG_ROOT,
        force: false,
        patchOpencode: "always",
        logger: { log: () => {}, warn: () => {} },
      });
      const oc = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"));
      assert.ok(
        oc.plugin.some((p) => String(Array.isArray(p) ? p[0] : p).includes("makdoong2-team")),
        "plugin ref must be added — a trailing comma must not abort the patch",
      );
      assert.ok(oc.plugin.includes("oh-my-openagent@latest"), "existing plugin entries preserved");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("install() fails loudly when opencode.json cannot be parsed at all", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mkd2-badjson-"));
    const configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), "{ this is not json at all");
    try {
      assert.throws(
        () => install({
          configDir,
          pkgRoot: PKG_ROOT,
          force: false,
          patchOpencode: "always",
          logger: { log: () => {}, warn: () => {} },
        }),
        /could not be parsed/,
        "a broken config must abort the install rather than report success",
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("install-lib — opencode plugin cache version drift", () => {
  test("readCachedVersion reads the version of a cached copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkd2-cachever-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.2" }));
      assert.equal(readCachedVersion(dir), "1.0.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readCachedVersion returns null for a directory without a readable package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkd2-cachever-"));
    try {
      assert.equal(readCachedVersion(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a real cache directory holding an older version is detected as stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkd2-cachever-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.2" }));
      const current = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
      assert.notEqual(readCachedVersion(dir), current,
        "version mismatch is what must trigger replacement instead of the old unconditional skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 자격증명 파일 권한 ──
//
// makdoong2-team.json 은 `.secrets.*` 에 Jira / Confluence / Bitbucket / Bamboo
// PAT 를 **평문**으로 담는다. 그런데 종전에는 기본 umask 로 생성돼 world-readable
// (0644/0666) 이었다. 같은 리포의 src/logger.ts 는 훅 로그가 자격증명을 흘릴 수
// 있다는 이유로 이미 로그 파일에 0600 을 강제한다 — 정작 토큰 원본이 든 파일이
// 더 느슨했다.
describe("install-lib — 자격증명 파일 권한", () => {
  const mode = (p) => statSync(p).mode & 0o777;

  test("최초 설치가 makdoong2-team.json 을 0600 으로 만든다", () => {
    const configDir = mkdtempSync(join(tmpdir(), "makdoong2-perm-"));
    try {
      install({
        configDir, pkgRoot: PKG_ROOT, force: true, patchOpencode: "skip",
        logger: { log() {}, warn() {} },
      });
      const cfg = join(configDir, "makdoong2-team.json");
      assert.ok(existsSync(cfg));
      assert.equal(mode(cfg), 0o600, `평문 토큰이 든 파일이 ${mode(cfg).toString(8)} 이다`);
      // 실제로 토큰 자리가 있는 파일인지 확인 (그래야 이 테스트가 의미 있다)
      const parsed = JSON.parse(readFileSync(cfg, "utf8"));
      assert.ok(parsed.secrets && "JIRA_API_TOKEN" in parsed.secrets);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("이미 있는 느슨한 파일도 재설치로 0600 이 된다", () => {
    // 예전 설치가 만든 world-readable 파일이 그대로 남는 것을 install 로 고칠 수 있어야 한다.
    const configDir = mkdtempSync(join(tmpdir(), "makdoong2-perm2-"));
    try {
      install({
        configDir, pkgRoot: PKG_ROOT, force: true, patchOpencode: "skip",
        logger: { log() {}, warn() {} },
      });
      const cfg = join(configDir, "makdoong2-team.json");
      chmodSync(cfg, 0o644);
      assert.equal(mode(cfg), 0o644, "선행 조건: 느슨한 권한으로 되돌렸다");

      install({
        configDir, pkgRoot: PKG_ROOT, force: false, patchOpencode: "skip",
        logger: { log() {}, warn() {} },
      });
      assert.equal(mode(cfg), 0o600, "재설치가 권한을 좁히지 않았다");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
