/**
 * stage8-post-review-verify.sh — completion condition gate for 3_delivery.review
 * Enforces "per-commit >= 1 inline comment" rule (mirrors 1-file-1-commit atomic rule).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const STATE_SH = join(REPO, "scripts", "state.sh");
const VERIFY_SH = join(REPO, "gates", "verify.sh");

function makeRepo() {
  const parent = mkdtempSync(join(tmpdir(), "makdoong2-post-review-"));
  const main = join(parent, "main");
  mkdirSync(main, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  return { parent, main };
}

function stateSh(cwd, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function verify(cwd, issue, stage) {
  const r = spawnSync("bash", [VERIFY_SH, issue, stage], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function writePlan(wt, obj) {
  const planDir = join(wt, ".makdoong2-team", "TEST");
  mkdirSync(planDir, { recursive: true });
  const p = join(planDir, "review-comment-plan.json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function primeReviewMarkers(wt, { commitCount = 2, planPath, cpc, comments, allInline = true, done = true } = {}) {
  stateSh(wt, "init", "TEST", wt);
  stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
  stateSh(wt, "set", "TEST",
    '.stages."3_delivery".substages."commit".atomic_review',
    `{"all_atomic":true,"count_commits":${commitCount},"one_file_per_commit":true}`);
  if (planPath) {
    stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."review".plan_path',
      `"${planPath}"`);
  }
  if (cpc) {
    stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."review".comments_per_commit', cpc);
  }
  if (comments !== undefined) {
    stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."review".comments', `${comments}`);
  }
  stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."review".all_comments_inline',
    allInline ? "true" : "false");
  stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."review".done',
    done ? "true" : "false");
}

describe("stage8-post-review-verify — per-commit ≥1 rule and marker integrity", () => {
  test("PASS when all markers align (2 commits, per-commit=1, plan valid)", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "aaaa", head_sha: "bbbb", commit_count: 2,
        plan: [
          { commit_sha: "abc1234", commit_subject: "s1", changed_file: "a",
            comments: [{ anchor: { filePath: "a", line: 1, lineType: "ADDED" }, text_plan: "x", status: "posted", comment_id: 101 }] },
          { commit_sha: "def5678", commit_subject: "s2", changed_file: "b",
            comments: [{ anchor: { filePath: "b", line: 1, lineType: "ADDED" }, text_plan: "y", status: "posted", comment_id: 102 }] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 2, planPath,
        cpc: '{"abc1234":1,"def5678":1}',
        comments: 2,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
      assert.match(r.stdout, /MAKDOONG2-POSTGATE OK: 3_delivery\.review_post/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when plan file missing", () => {
    const { parent, main } = makeRepo();
    try {
      primeReviewMarkers(main, {
        commitCount: 2, planPath: `${main}/nonexistent.json`,
        cpc: '{"a":1,"b":1}', comments: 2,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /review-comment-plan\.json 파일 없음/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when plan.commit_count mismatches atomic_review.count_commits", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "a", head_sha: "b", commit_count: 3,
        plan: [
          { commit_sha: "x", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "y", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "z", commit_subject: "s", changed_file: "f", comments: [{}] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 2, planPath,
        cpc: '{"x":1,"y":1}', comments: 2,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /plan\.commit_count.*!=.*atomic_review\.count_commits/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when a commit has zero comments in plan (per-commit rule at planning)", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "a", head_sha: "b", commit_count: 2,
        plan: [
          { commit_sha: "x", commit_subject: "s", changed_file: "f",
            comments: [{ anchor: { filePath: "f", line: 1, lineType: "ADDED" }, text_plan: "t" }] },
          { commit_sha: "y", commit_subject: "s", changed_file: "f", comments: [] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 2, planPath,
        cpc: '{"x":1,"y":1}', comments: 2,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /계획 단계에서 1 개 커밋에 코멘트가 0개/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when comments_per_commit has a value <1", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "a", head_sha: "b", commit_count: 2,
        plan: [
          { commit_sha: "x", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "y", commit_subject: "s", changed_file: "f", comments: [{}] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 2, planPath,
        cpc: '{"x":1,"y":0}', comments: 1,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /1 개 커밋의 실제 앵커 코멘트 수가 0개/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when comments != Σ comments_per_commit (sum integrity)", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "a", head_sha: "b", commit_count: 2,
        plan: [
          { commit_sha: "x", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "y", commit_subject: "s", changed_file: "f", comments: [{}] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 2, planPath,
        cpc: '{"x":2,"y":3}', comments: 4,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /review\.comments\(4\) != Σcomments_per_commit\(5\)/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when all_comments_inline is false", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "a", head_sha: "b", commit_count: 2,
        plan: [
          { commit_sha: "x", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "y", commit_subject: "s", changed_file: "f", comments: [{}] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 2, planPath,
        cpc: '{"x":1,"y":1}', comments: 2,
        allInline: false,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /all_comments_inline=false/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when comments_per_commit item count != atomic_review.count_commits", () => {
    const { parent, main } = makeRepo();
    try {
      const planPath = writePlan(main, {
        base_sha: "a", head_sha: "b", commit_count: 3,
        plan: [
          { commit_sha: "x", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "y", commit_subject: "s", changed_file: "f", comments: [{}] },
          { commit_sha: "z", commit_subject: "s", changed_file: "f", comments: [{}] },
        ],
      });
      primeReviewMarkers(main, {
        commitCount: 3, planPath,
        cpc: '{"x":1,"y":1}', comments: 2,
      });
      const r = verify(main, "TEST", "3_delivery.review_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /comments_per_commit 항목 수.*!=.*count_commits/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
