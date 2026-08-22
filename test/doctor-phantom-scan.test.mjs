import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "bin", "cli.js");

function setupWorktree(contamination) {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-doctor-test-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });

  const issueDir = join(wt, ".makdoong2-team", "TEST-99");
  mkdirSync(issueDir, { recursive: true });

  const state = {
    issue: "TEST-99",
    worktree: wt,
    stages: {
      "1_planning": { done: false, substages: { jira: { done: false } } },
      "2_implementation": { done: false, substages: { dev: { done: false } } },
      "3_delivery": { done: false, substages: { commit: { done: false } } },
      ...(contamination || {}),
    },
    policy: null,
  };
  writeFileSync(join(issueDir, "state.json"), JSON.stringify(state, null, 2));

  const opencodeDir = join(wt, ".opencode-fake");
  mkdirSync(opencodeDir, { recursive: true });
  return { wt, opencodeDir };
}

function runDoctor(cwd, configDir) {
  const r = spawnSync("node", [CLI, "doctor", "--config", configDir], {
    cwd,
    encoding: "utf8",
  });
  return {
    code: r.status,
    stdout: (r.stdout || "") + (r.stderr || ""),
  };
}

describe("doctor — phantom-key contamination scan", () => {
  test("clean state passes the phantom-key check", () => {
    const { wt, opencodeDir } = setupWorktree(null);
    try {
      const r = runDoctor(wt, opencodeDir);
      assert.match(r.stdout, /no phantom-key contamination/);
      assert.doesNotMatch(r.stdout, /phantom keys:/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("contaminated state is detected and reported with fix hint", () => {
    const { wt, opencodeDir } = setupWorktree({
      "1_planning.jira":          { done: true },
      "1_planning.requirements":  { done: true, self_check: { a: true } },
      "3_delivery.commit":        { done: true },
    });
    try {
      const r = runDoctor(wt, opencodeDir);
      assert.match(r.stdout, /1 state\.json file\(s\) contain flat-notation phantom keys/);
      assert.match(r.stdout, /phantom keys:.*1_planning\.jira/);
      assert.match(r.stdout, /phantom keys:.*1_planning\.requirements/);
      assert.match(r.stdout, /phantom keys:.*3_delivery\.commit/);
      assert.match(r.stdout, /state\.sh migrate/);
      assert.notEqual(r.code, 0, "doctor exits non-zero when contamination found");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("scan skips node_modules and .git directories", () => {
    const { wt, opencodeDir } = setupWorktree(null);
    try {
      const junkDir = join(wt, "node_modules", ".makdoong2-team", "GHOST-1");
      mkdirSync(junkDir, { recursive: true });
      writeFileSync(join(junkDir, "state.json"),
        JSON.stringify({ stages: { "1_planning.jira": { done: true } } }));
      const r = runDoctor(wt, opencodeDir);
      assert.doesNotMatch(r.stdout, /GHOST-1/,
        "must not descend into node_modules");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
