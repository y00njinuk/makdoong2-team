import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_SH = resolve(HERE, "..", "scripts", "state.sh");

function makeWorktree() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-init-review-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}

function stateSh(wt, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd: wt, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function readState(wt, issue) {
  const p = join(wt, ".makdoong2-team", issue, "state.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("state.sh init — review substage schema (post-Option-B expansion)", () => {
  test("review substage contains comments_per_commit, plan_path, all_comments_inline", () => {
    const wt = makeWorktree();
    try {
      const r = stateSh(wt, "init", "TEST-1", wt);
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      const s = readState(wt, "TEST-1");
      const review = s.stages["3_delivery"].substages.review;
      assert.equal(review.comments, 0);
      assert.deepEqual(review.comments_per_commit, {},
        "comments_per_commit must init as empty object");
      assert.equal(review.plan_path, null,
        "plan_path must init as null");
      assert.equal(review.all_comments_inline, false,
        "all_comments_inline must init as false");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("review schema fields are queryable via state.sh get (hierarchical path)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-2", wt);
      const q1 = stateSh(wt, "get", "TEST-2",
        '.stages."3_delivery".substages."review".comments_per_commit');
      assert.equal(q1.code, 0);
      assert.equal(q1.stdout, "{}");

      const q2 = stateSh(wt, "get", "TEST-2",
        '.stages."3_delivery".substages."review".plan_path');
      assert.equal(q2.code, 0, "state.sh get returns 0 for successfully evaluated values (including null)");
      assert.equal(q2.stdout, "null");

      const q3 = stateSh(wt, "get", "TEST-2",
        '.stages."3_delivery".substages."review".all_comments_inline');
      assert.equal(q3.code, 0);
      assert.equal(q3.stdout, "false");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("comments_per_commit accepts per-SHA count map", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-3", wt);
      const setR = stateSh(wt, "set", "TEST-3",
        '.stages."3_delivery".substages."review".comments_per_commit',
        '{"abc1234":2,"def5678":1}');
      assert.equal(setR.code, 0, `stderr=${setR.stderr}`);
      const s = readState(wt, "TEST-3");
      assert.deepEqual(s.stages["3_delivery"].substages.review.comments_per_commit,
        { abc1234: 2, def5678: 1 });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
