import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");
const VERIFY_SH = join(REPO_ROOT, "gates", "verify.sh");

function makeWorktree() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-gate-done-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}

function stateSh(wt, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd: wt, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function verify(wt, issue, stage) {
  const r = spawnSync("bash", [VERIFY_SH, issue, stage], { cwd: wt, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function markDone(wt, issue, jqPath) {
  const r = stateSh(wt, "set", issue, `${jqPath}.done`, "true");
  assert.equal(r.code, 0, `state.sh set failed: ${r.stderr}`);
}

describe("gate — already-done blocking (regression: PROJ-40406)", () => {
  test("1_planning.jira blocks when jira.done=true", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."1_planning".substages."jira"');
      const r = verify(wt, "TEST-1", "1_planning.jira");
      assert.equal(r.code, 2, `expected BLOCKED exit=2, got ${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /이미 done=true/);
      assert.match(r.stderr, /auto_advance_stage/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("1_planning.jira passes when jira.done=false (default)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = verify(wt, "TEST-1", "1_planning.jira");
      assert.equal(r.code, 0, `expected OK exit=0, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("1_planning.requirements blocks when requirements.done=true (even if jira.done=true)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."1_planning".substages."jira"');
      markDone(wt, "TEST-1", '.stages."1_planning".substages."requirements"');
      const r = verify(wt, "TEST-1", "1_planning.requirements");
      assert.equal(r.code, 2, `expected BLOCKED exit=2, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /이미 done=true/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("1_planning.requirements passes when jira.done=true and requirements.done=false", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."1_planning".substages."jira"');
      const r = verify(wt, "TEST-1", "1_planning.requirements");
      assert.equal(r.code, 0, `expected OK, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("1_planning.scope blocks when scope.done=true", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."1_planning".substages."jira"');
      markDone(wt, "TEST-1", '.stages."1_planning".substages."requirements"');
      markDone(wt, "TEST-1", '.stages."1_planning".substages."scope"');
      const r = verify(wt, "TEST-1", "1_planning.scope");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /이미 done=true/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("2_implementation.analysis blocks when analysis.done=true", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."1_planning".substages."scope"');
      markDone(wt, "TEST-1", '.stages."2_implementation".substages."analysis"');
      const r = verify(wt, "TEST-1", "2_implementation.analysis");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /이미 done=true/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("2_implementation.dev blocks when dev.done=true", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."1_planning".substages."scope"');
      markDone(wt, "TEST-1", '.stages."2_implementation".substages."analysis"');
      markDone(wt, "TEST-1", '.stages."2_implementation".substages."dev"');
      const r = verify(wt, "TEST-1", "2_implementation.dev");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /이미 done=true/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("2_implementation.test blocks when test.done=true", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      markDone(wt, "TEST-1", '.stages."2_implementation".substages."dev"');
      markDone(wt, "TEST-1", '.stages."2_implementation".substages."test"');
      const r = verify(wt, "TEST-1", "2_implementation.test");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /이미 done=true/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
