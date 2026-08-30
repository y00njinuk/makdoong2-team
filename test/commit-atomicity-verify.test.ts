import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, "..", "gates", "stage6-post-commit-verify.sh");
const STATE_SH = resolve(HERE, "..", "scripts", "state.sh");

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}
function stateSh(cwd, ...args) {
  return spawnSync("bash", [STATE_SH, ...args], { cwd, encoding: "utf8" });
}
function runGate(cwd, issue) {
  return spawnSync("bash", [GATE, issue], { cwd, encoding: "utf8" });
}

function makeSiblingWorktrees(issue = "PROJ-1") {
  const parent = mkdtempSync(join(tmpdir(), "commit-atomicity-"));
  const main = join(parent, "repo-main");
  const wt = join(parent, `repo-${issue}`);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, ".gitkeep"), "");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", `feature/${issue}`, wt);
  stateSh(wt, "init", issue, wt);
  return { parent, main, wt, issue };
}

function recordCommitMarkers(wt, issue, base, head, count) {
  stateSh(wt, "set", issue, '.stages."3_delivery".substages."commit".base_sha', `"${base}"`);
  stateSh(wt, "set", issue, '.stages."3_delivery".substages."commit".head_sha', `"${head}"`);
  stateSh(wt, "set", issue,
    '.stages."3_delivery".substages."commit".atomic_review',
    `{"all_atomic": true, "one_file_per_commit": true, "count_commits": ${count}}`);
  stateSh(wt, "set", issue, '.stages."3_delivery".substages."commit".done', "true");
}

describe("stage6-post-commit-verify.sh — 1 파일/commit hardrule", () => {
  test("통과: 파일별 1개씩 commit + 올바른 메시지 형식", () => {
    const ctx = makeSiblingWorktrees("PROJ-1");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "a.txt"), "a");
      git(ctx.wt, "add", "a.txt");
      git(ctx.wt, "commit", "-q", "-m", "Feat: PROJ-1 - a 파일 추가", "-m", "본문\n\n[RV] PROJ-1\n[AI] 100%");
      writeFileSync(join(ctx.wt, "b.txt"), "b");
      git(ctx.wt, "add", "b.txt");
      git(ctx.wt, "commit", "-q", "-m", "Fix: PROJ-1 - b 파일 수정", "-m", "이유\n\n[RV] PROJ-1\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-1", base, head, 2);

      const r = runGate(ctx.wt, "PROJ-1");
      assert.equal(r.status, 0, `expected pass but stderr=${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: 1 commit 에 2개 파일 포함", () => {
    const ctx = makeSiblingWorktrees("PROJ-2");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "a.txt"), "a");
      writeFileSync(join(ctx.wt, "b.txt"), "b");
      git(ctx.wt, "add", "a.txt", "b.txt");
      git(ctx.wt, "commit", "-q", "-m", "Feat: PROJ-2 - 두 파일 추가", "-m", "[RV] PROJ-2\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-2", base, head, 1);

      const r = runGate(ctx.wt, "PROJ-2");
      assert.equal(r.status, 2, "expected exit 2 for multi-file commit");
      assert.match(r.stderr, /1 파일 = 1 commit 원칙 위반/);
      assert.match(r.stderr, /파일수=2/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: 커밋 메시지 형식 불일치 (Type 누락)", () => {
    const ctx = makeSiblingWorktrees("PROJ-3");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "x.txt"), "x");
      git(ctx.wt, "add", "x.txt");
      git(ctx.wt, "commit", "-q", "-m", "잘못된 형식 커밋", "-m", "[RV] PROJ-3\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-3", base, head, 1);

      const r = runGate(ctx.wt, "PROJ-3");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /형식 불일치/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: 잘못된 Type (Foo)", () => {
    const ctx = makeSiblingWorktrees("PROJ-4");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "y.txt"), "y");
      git(ctx.wt, "add", "y.txt");
      git(ctx.wt, "commit", "-q", "-m", "Foo: PROJ-4 - 잘못된 타입", "-m", "[RV] PROJ-4\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-4", base, head, 1);

      const r = runGate(ctx.wt, "PROJ-4");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /형식 불일치/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: 잘못된 이슈키 (다른 이슈)", () => {
    const ctx = makeSiblingWorktrees("PROJ-5");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "z.txt"), "z");
      git(ctx.wt, "add", "z.txt");
      git(ctx.wt, "commit", "-q", "-m", "Feat: OTHER-99 - 다른 이슈키", "-m", "[RV] OTHER-99\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-5", base, head, 1);

      const r = runGate(ctx.wt, "PROJ-5");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /형식 불일치/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: 제목 끝 마침표", () => {
    const ctx = makeSiblingWorktrees("PROJ-6");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "p.txt"), "p");
      git(ctx.wt, "add", "p.txt");
      git(ctx.wt, "commit", "-q", "-m", "Feat: PROJ-6 - 마침표.", "-m", "[RV] PROJ-6\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-6", base, head, 1);

      const r = runGate(ctx.wt, "PROJ-6");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /마침표 금지/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: 본문이 있는데 이슈 참조 키워드 누락", () => {
    const ctx = makeSiblingWorktrees("PROJ-7");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "k.txt"), "k");
      git(ctx.wt, "add", "k.txt");
      git(ctx.wt, "commit", "-q", "-m", "Feat: PROJ-7 - 키워드 누락", "-m", "본문만 있고 키워드 없음");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      recordCommitMarkers(ctx.wt, "PROJ-7", base, head, 1);

      const r = runGate(ctx.wt, "PROJ-7");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /이슈 참조 마커 누락/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });

  test("REJECT: atomic_review.one_file_per_commit 마커 누락", () => {
    const ctx = makeSiblingWorktrees("PROJ-8");
    try {
      const base = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(ctx.wt, "m.txt"), "m");
      git(ctx.wt, "add", "m.txt");
      git(ctx.wt, "commit", "-q", "-m", "Feat: PROJ-8 - 단일 파일", "-m", "[RV] PROJ-8\n[AI] 100%");
      const head = git(ctx.wt, "rev-parse", "HEAD").stdout.trim();
      stateSh(ctx.wt, "set", "PROJ-8", '.stages."3_delivery".substages."commit".base_sha', `"${base}"`);
      stateSh(ctx.wt, "set", "PROJ-8", '.stages."3_delivery".substages."commit".head_sha', `"${head}"`);
      stateSh(ctx.wt, "set", "PROJ-8",
        '.stages."3_delivery".substages."commit".atomic_review',
        `{"all_atomic": true, "count_commits": 1}`);
      stateSh(ctx.wt, "set", "PROJ-8", '.stages."3_delivery".substages."commit".done', "true");

      const r = runGate(ctx.wt, "PROJ-8");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /one_file_per_commit/);
    } finally {
      rmSync(ctx.parent, { recursive: true, force: true });
    }
  });
});
