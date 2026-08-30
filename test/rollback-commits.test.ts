import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLLBACK_SH = resolve(HERE, "..", "scripts", "rollback-commits.sh");
const STATE_SH = resolve(HERE, "..", "scripts", "state.sh");

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}
function stateSh(cwd, ...args) {
  return spawnSync("bash", [STATE_SH, ...args], { cwd, encoding: "utf8" });
}
function runRollback(cwd, issue) {
  return spawnSync("bash", [ROLLBACK_SH, issue], { cwd, encoding: "utf8" });
}

function makeWorktreeWithCommits(issue = "PROJ-1") {
  const wt = mkdtempSync(join(tmpdir(), "rollback-test-"));
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.email", "t@t");
  git(wt, "config", "user.name", "t");
  writeFileSync(join(wt, ".gitkeep"), "");
  git(wt, "add", ".gitkeep");
  git(wt, "commit", "-q", "-m", "init");
  stateSh(wt, "init", issue, wt);
  const base = git(wt, "rev-parse", "HEAD").stdout.trim();
  stateSh(wt, "set", issue,
    '.stages."3_delivery".substages."commit".base_sha', `"${base}"`);
  writeFileSync(join(wt, "a.txt"), "a");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-q", "-m", "Feat: PROJ-1 - a", "-m", "[RV] PROJ-1\n[AI] 100%");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "b.txt");
  git(wt, "commit", "-q", "-m", "Feat: PROJ-1 - b", "-m", "[RV] PROJ-1\n[AI] 100%");
  return { wt, issue, base };
}

describe("rollback-commits.sh — publisher 재작업 진입 시 실행 가능성", () => {
  test("base_sha..HEAD 커밋 취소 + working tree 파일은 보존 (soft reset)", () => {
    const ctx = makeWorktreeWithCommits("PROJ-1");
    try {
      const beforeCount = parseInt(
        git(ctx.wt, "rev-list", "--count", `${ctx.base}..HEAD`).stdout.trim(),
        10);
      assert.equal(beforeCount, 2, "rollback 전 2개 커밋");
      const r = runRollback(ctx.wt, "PROJ-1");
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.match(r.stdout, /soft-reset 완료/);
      const afterCount = parseInt(
        git(ctx.wt, "rev-list", "--count", `${ctx.base}..HEAD`).stdout.trim(),
        10);
      assert.equal(afterCount, 0, "rollback 후 base_sha == HEAD");
      const stagedFiles = git(ctx.wt, "diff", "--cached", "--name-only").stdout
        .split("\n").filter(Boolean).sort();
      assert.deepEqual(stagedFiles, ["a.txt", "b.txt"], "index 는 보존");
      assert.equal(readFileSync(join(ctx.wt, "a.txt"), "utf8"), "a",
        "working tree 파일 내용 보존");
    } finally {
      rmSync(ctx.wt, { recursive: true, force: true });
    }
  });

  test("rollback 후 commit substage 마커가 리셋 (done=false, atomic_review=null, head_sha=null)", () => {
    const ctx = makeWorktreeWithCommits("PROJ-2");
    try {
      stateSh(ctx.wt, "set", "PROJ-2", '.stages."3_delivery".substages."commit".done', "true");
      stateSh(ctx.wt, "set", "PROJ-2",
        '.stages."3_delivery".substages."commit".atomic_review',
        '{"all_atomic": true, "one_file_per_commit": true, "count_commits": 2}');
      stateSh(ctx.wt, "set", "PROJ-2",
        '.stages."3_delivery".substages."commit".head_sha',
        `"${git(ctx.wt, "rev-parse", "HEAD").stdout.trim()}"`);
      const r = runRollback(ctx.wt, "PROJ-2");
      assert.equal(r.status, 0);
      const state = JSON.parse(
        readFileSync(join(ctx.wt, ".makdoong2-team", "PROJ-2", "state.json"), "utf8"));
      const c = state.stages["3_delivery"].substages.commit;
      assert.equal(c.done, false);
      assert.equal(c.atomic_review, null);
      assert.equal(c.head_sha, null);
      assert.equal(c.base_sha, ctx.base, "base_sha 는 보존");
    } finally {
      rmSync(ctx.wt, { recursive: true, force: true });
    }
  });

  test("base_sha 미기록 시 rollback 거부 (파괴적 명령 실행 방지)", () => {
    const wt = mkdtempSync(join(tmpdir(), "rollback-nobase-"));
    try {
      git(wt, "init", "-q", "-b", "main");
      git(wt, "config", "user.email", "t@t");
      git(wt, "config", "user.name", "t");
      writeFileSync(join(wt, "x"), "");
      git(wt, "add", "x");
      git(wt, "commit", "-q", "-m", "init");
      stateSh(wt, "init", "PROJ-3", wt);
      const headBefore = git(wt, "rev-parse", "HEAD").stdout.trim();
      const r = runRollback(wt, "PROJ-3");
      assert.notEqual(r.status, 0, "base_sha 없이 rollback 시도는 반드시 non-zero exit");
      const headAfter = git(wt, "rev-parse", "HEAD").stdout.trim();
      assert.equal(headAfter, headBefore, "HEAD 가 변경되지 않아야 (파괴적 reset 실행 안됨)");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("base_sha 가 현재 HEAD 조상이 아니면 rollback 거부", () => {
    const ctx = makeWorktreeWithCommits("PROJ-4");
    try {
      stateSh(ctx.wt, "set", "PROJ-4",
        '.stages."3_delivery".substages."commit".base_sha', '"deadbeef"');
      const r = runRollback(ctx.wt, "PROJ-4");
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /조상이 아님/);
    } finally {
      rmSync(ctx.wt, { recursive: true, force: true });
    }
  });
});
