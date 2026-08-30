import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WITH_FALLBACK_SH = resolve(HERE, "..", "scripts", "with-fallback.sh");

// makdoong2-engineer is a known entry in POLICIES (model-fallback-policy.ts)
// with 2-entry chain: github-copilot/gpt-5.6-luna → github-copilot/claude-haiku-4.5
const TEST_AGENT = "makdoong2-engineer";

describe("with-fallback.sh — bun 없는 환경에서 node dist/model-chain-cli.js 체인 조회", () => {
  test("bun을 PATH에서 제거해도 [with-fallback] attempt 1/ 출력 (체인 정상 조회)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-no-bun-"));
    try {
      const fakeBin = join(tmpDir, "fake-bin");
      mkdirSync(fakeBin);

      // Fake opencode: exits 0 so the script terminates cleanly after attempt 1.
      // The key observable is whether stderr contains "[with-fallback] attempt 1/"
      // (written before opencode is called), which proves the chain was read.
      const fakeOpencode = join(fakeBin, "opencode");
      writeFileSync(fakeOpencode, "#!/bin/bash\nexit 0\n");
      spawnSync("chmod", ["+x", fakeOpencode]);

      // Build a PATH that: (a) prepends fakeBin so our fake opencode wins, and
      // (b) explicitly excludes any bun installation directories so the test is
      // hermetic on machines that DO have bun installed.
      const scrubbedPath = [
        fakeBin,
        ...(process.env.PATH || "")
          .split(":")
          .filter((p) => !p.toLowerCase().includes("bun")),
      ].join(":");

      const result = spawnSync(
        "bash",
        [WITH_FALLBACK_SH, TEST_AGENT, "--", "run", "--agent", TEST_AGENT, "test-prompt"],
        {
          encoding: "utf8",
          env: {
            HOME: process.env.HOME,
            PATH: scrubbedPath,
          },
        }
      );

      assert.match(
        result.stderr,
        /\[with-fallback\] attempt 1\//,
        `expected "[with-fallback] attempt 1/" in stderr — chain should have been read via node.\nActual stderr:\n${result.stderr}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
