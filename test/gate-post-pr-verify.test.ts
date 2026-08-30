/**
 * stage7-post-pr-verify.sh — completion condition gate for 3_delivery.pr
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

function makeRepo() {
  const parent = mkdtempSync(join(tmpdir(), "makdoong2-post-pr-"));
  const main = join(parent, "main");
  const wt = join(parent, "main-TEST");
  mkdirSync(main, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: main });
  spawnSync("git", ["config", "user.name", "t"], { cwd: main });
  spawnSync("bash", ["-c", 'echo x > f && git add f && git commit -q -m init'], { cwd: main });
  spawnSync("git", ["worktree", "add", "-b", "feature/TEST", wt], { cwd: main });
  spawnSync("git", ["-C", wt, "remote", "add", "origin", main]);
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

function setupFullMarkers(wt) {
  stateSh(wt, "init", "TEST", wt);
  stateSh(wt, "set", "TEST", '.worktree', `"${wt}"`);
  stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".draft_url',
    '"https://repos.example.com/projects/A/repos/b/pull-requests/1"');
  stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".body_validation',
    '{"no_orphan_scenarios":true,"template_match":true,"section_content_match":true}');
  stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".reviewer_added', "true");
  stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".done', "true");
}

function push(wt, main) {
  spawnSync("bash", ["-c", `git push -q origin HEAD`], { cwd: wt });
}

describe("stage7-post-pr-verify — happy path and each failure mode", () => {
  test("PASS when all markers present and origin/BR exists", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      push(wt, main);
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 0,
        `expected pass, stderr=${r.stderr}\nstdout=${r.stdout}`);
      assert.match(r.stdout, /MAKDOONG2-POSTGATE OK: 3_delivery\.pr_post/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when origin/BR does not exist (push not performed)", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /remote 에 push 되지 않음/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when draft_url is not HTTPS", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      push(wt, main);
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".draft_url', '"not-a-url"');
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /draft_url 이 유효한 HTTPS URL/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when body_validation has a false", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      push(wt, main);
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".body_validation',
        '{"no_orphan_scenarios":false,"template_match":true,"section_content_match":true}');
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /body_validation\.no_orphan_scenarios=false/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when reviewer markers both true (mutex violation)", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      push(wt, main);
      stateSh(wt, "set", "TEST",
        '.stages."3_delivery".substages."pr".reviewer_self_skipped', "true");
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /상호 배타 위반/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when neither reviewer marker set", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      push(wt, main);
      stateSh(wt, "set", "TEST",
        '.stages."3_delivery".substages."pr".reviewer_added', "false");
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /reviewer 마커 미기록/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("FAIL when pr.done is not true", () => {
    const { parent, main, wt } = makeRepo();
    try {
      setupFullMarkers(wt);
      push(wt, main);
      stateSh(wt, "set", "TEST", '.stages."3_delivery".substages."pr".done', "false");
      const r = verify(wt, "TEST", "3_delivery.pr_post");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /pr\.done 이 true 아님/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
