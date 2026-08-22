/**
 * Regression: chicken-and-egg entry gate deadlock (Option B — Sisyphus, 2026-07)
 *
 * BEFORE FIX: stage7-pr-verify.sh required `origin/<BR>` (push must exist);
 *             stage8-review-verify.sh required `.comments >= 1`.
 *             Both were completion conditions misplaced as entry checks.
 *             Publisher was never spawned because dispatch_stage blocked at gate.
 *
 * AFTER FIX:  entry gates check preconditions only. First-entry passes.
 *             Completion conditions moved to stage7-post-pr-verify.sh /
 *             stage8-post-review-verify.sh (called by publisher post-execution).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const STATE_SH = join(REPO, "scripts", "state.sh");
const VERIFY_SH = join(REPO, "gates", "verify.sh");

function makeMainRepoWithSiblingWt() {
  const parent = mkdtempSync(join(tmpdir(), "makdoong2-hybrid-entry-"));
  const main = join(parent, "main");
  const wt = join(parent, "main-TEST");
  mkdirSync(main, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: main });
  spawnSync("git", ["config", "user.name", "t"], { cwd: main });
  spawnSync("bash", ["-c", 'echo x > f && git add f && git commit -q -m init'], { cwd: main });
  spawnSync("git", ["worktree", "add", "-b", "feature/TEST", wt], { cwd: main });
  return { parent, main, wt };
}

function stateSh(cwd, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function verify(cwd, issue, stage) {
  const r = spawnSync("bash", [VERIFY_SH, issue, stage], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function primeCommitDone(wt, issue) {
  stateSh(wt, "set", issue, '.stages."3_delivery".substages."commit".done', "true");
}

function primePrMarkers(wt, issue, { withReviewer = "added" } = {}) {
  stateSh(wt, "set", issue, '.stages."3_delivery".substages."pr".draft_url',
    '"https://example.com/pr/1"');
  stateSh(wt, "set", issue, '.stages."3_delivery".substages."pr".body_validation',
    '{"no_orphan_scenarios":true,"template_match":true,"section_content_match":true}');
  if (withReviewer === "added") {
    stateSh(wt, "set", issue, '.stages."3_delivery".substages."pr".reviewer_added', "true");
  } else if (withReviewer === "self_skipped") {
    stateSh(wt, "set", issue, '.stages."3_delivery".substages."pr".reviewer_self_skipped', "true");
  }
  stateSh(wt, "set", issue, '.policy',
    '{"category":"minor","auto_approve":{"3_delivery.pr":true}}');
}

describe("stage7-pr-verify.sh — entry gate accepts first-entry (no origin/BR yet)", () => {
  test("passes when commit.done=true and worktree clean, even though branch not pushed", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      primeCommitDone(wt, "TEST");
      const r = verify(wt, "TEST", "3_delivery.pr");
      assert.equal(r.code, 0,
        `expected pass (no origin/BR requirement anymore).\nstderr=${r.stderr}\nstdout=${r.stdout}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK: 3_delivery\.pr/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("still blocks when commit.done is not true (precondition remains)", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      const r = verify(wt, "TEST", "3_delivery.pr");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /commit substage 미완료/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("still blocks on uncommitted changes (precondition remains)", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      primeCommitDone(wt, "TEST");
      spawnSync("bash", ["-c", "echo change >> f"], { cwd: wt });
      const r = verify(wt, "TEST", "3_delivery.pr");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /uncommitted 변경/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("stage8-review-verify.sh — entry gate accepts first-entry (comments=0 default)", () => {
  test("passes with default comments=0 when pr markers present and auto_approve set", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      primeCommitDone(wt, "TEST");
      primePrMarkers(wt, "TEST", { withReviewer: "added" });
      const r = verify(wt, "TEST", "3_delivery.review");
      assert.equal(r.code, 0,
        `expected pass with comments=0 (no completion check in entry).\nstderr=${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK: 3_delivery\.review/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("still blocks when pr.draft_url missing (precondition remains)", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      primeCommitDone(wt, "TEST");
      const r = verify(wt, "TEST", "3_delivery.review");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /pr substage \(Draft PR\) 미생성/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("still blocks when body_validation incomplete", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      primeCommitDone(wt, "TEST");
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".draft_url',
        '"https://example.com/pr/1"');
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".body_validation',
        '{"no_orphan_scenarios":true,"template_match":false,"section_content_match":true}');
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".reviewer_added', "true");
      const r = verify(wt, "TEST", "3_delivery.review");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /body_validation\.template_match=false/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("still blocks when reviewer markers both missing", () => {
    const { parent, main, wt } = makeMainRepoWithSiblingWt();
    try {
      stateSh(wt, "init", "TEST", wt);
      stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
      primeCommitDone(wt, "TEST");
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".draft_url',
        '"https://example.com/pr/1"');
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".body_validation',
        '{"no_orphan_scenarios":true,"template_match":true,"section_content_match":true}');
      const r = verify(wt, "TEST", "3_delivery.review");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /reviewer 미추가/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
