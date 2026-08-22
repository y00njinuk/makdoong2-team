#!/usr/bin/env node
// postinstall.mjs — Auto-install on npm install -g
//
// Runs ONLY when:
//   - npm_config_global === "true" (global install), OR
//   - MAKDOONG2_AUTO_INSTALL === "1" (opt-in for local-dep scenarios)
//
// Skips when:
//   - CI environment (unless MAKDOONG2_AUTO_INSTALL=1)
//   - Local install (unless MAKDOONG2_AUTO_INSTALL=1)
//
// On failure: warns and exits 0 (don't break npm install)

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { install, resolveConfigDir } from "./scripts/install-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function shouldRun() {
  const isGlobal = process.env.npm_config_global === "true";
  const optIn = process.env.MAKDOONG2_AUTO_INSTALL === "1";
  const isCI = process.env.CI === "true" || process.env.CONTINUOUS_INTEGRATION === "true";

  if (isCI && !optIn) {
    console.log("[makdoong2-team] postinstall: CI detected — skipping. Run `makdoong2-team install` manually.");
    return false;
  }
  if (!isGlobal && !optIn) {
    console.log("[makdoong2-team] postinstall: local install detected — skipping. Run `makdoong2-team install` to deploy, or set MAKDOONG2_AUTO_INSTALL=1.");
    return false;
  }
  return true;
}

function main() {
  if (!shouldRun()) return;

  try {
    const configDir = resolveConfigDir(undefined);
    console.log(`[makdoong2-team] postinstall: deploying to ${configDir}`);
    install({
      configDir,
      pkgRoot: HERE,
      force: false,
      patchOpencode: "idempotent",
    });
    console.log("[makdoong2-team] postinstall: done. Run `makdoong2-team doctor` to verify.");
  } catch (err) {
    console.warn(`[makdoong2-team] postinstall: ${err.message}`);
    console.warn("[makdoong2-team] postinstall: install incomplete — run `makdoong2-team install` to retry.");
    process.exit(0);
  }
}

main();
