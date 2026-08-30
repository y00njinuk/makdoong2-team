#!/usr/bin/env node
// postinstall.mts — Auto-install on npm install -g
//
// 산출물은 같은 자리의 postinstall.mjs 다 (`npm run build:entry`). 그 .mjs 를
// 직접 편집하지 말 것 — 다음 빌드가 덮어쓴다.
//
// **이 파일은 반드시 패키지 루트에 있어야 한다.** pkgRoot = 자기 디렉토리
// (`..` 없음)가 계약이라, 한 단계라도 깊어지면 agents/skills 복사가 ENOENT 로
// 죽고 external_directory 에 <pkg>/dist/** 를 심어 gates/stages 읽기를 조용히
// 차단하며 캐시 심링크가 dist 를 가리킨다.
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
    if (!shouldRun())
        return;
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
    }
    catch (err) {
        console.warn(`[makdoong2-team] postinstall: ${err instanceof Error ? err.message : String(err)}`);
        console.warn("[makdoong2-team] postinstall: install incomplete — run `makdoong2-team install` to retry.");
        process.exit(0);
    }
}
main();
