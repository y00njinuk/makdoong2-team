import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");
const VERIFY_SH = join(REPO_ROOT, "gates", "verify.sh");

const REQ = '.stages."1_planning".substages."requirements"';

function makeWorktree() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-gate-reqq-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}

function stateSh(wt, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd: wt, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function verifyScope(wt, issue) {
  const r = spawnSync("bash", [VERIFY_SH, issue, "1_planning.scope"], { cwd: wt, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function setupRequirementsDone(wt, issue) {
  stateSh(wt, "init", issue, wt);
  stateSh(wt, "set", issue, `${REQ}.done`, "true");
  stateSh(
    wt,
    "set",
    issue,
    ".policy",
    JSON.stringify({
      category: "minor",
      auto_approve: { "1_planning.requirements": true, "1_planning.scope": true },
    }),
  );
}

function makeDraft(wt, issue, content) {
  const rel = `.makdoong2-team/${issue}/requirements-draft.md`;
  mkdirSync(join(wt, `.makdoong2-team/${issue}`), { recursive: true });
  writeFileSync(join(wt, rel), content);
  return rel;
}

function sha256Of(wt, rel) {
  return createHash("sha256").update(readFileSync(join(wt, rel))).digest("hex");
}

describe("gate — requirements 품질 게이트 (ambiguity score + spec_hash)", () => {
  test("구형 state 호환: 신규 마커 없이도 scope 진입 통과", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-1");
      const r = verifyScope(wt, "TEST-1");
      assert.equal(r.code, 0, `expected OK, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("ambiguity_score > 0.2 이면 차단", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-1");
      stateSh(wt, "set", "TEST-1", `${REQ}.ambiguity_score`, "0.5");
      const r = verifyScope(wt, "TEST-1");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /ambiguity_score=0\.5 > 0\.2/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("ambiguity_score ≤ 0.2 이면 통과", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-1");
      stateSh(wt, "set", "TEST-1", `${REQ}.ambiguity_score`, "0.13");
      const r = verifyScope(wt, "TEST-1");
      assert.equal(r.code, 0, `expected OK, got ${r.code}\nstderr=${r.stderr}`);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("spec_hash 일치하면 통과", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-1");
      const rel = makeDraft(wt, "TEST-1", "# spec\n## 확정 명세 (Crystallized)\n1. AC-1\n");
      stateSh(wt, "set", "TEST-1", `${REQ}.draft_path`, JSON.stringify(rel));
      stateSh(wt, "set", "TEST-1", `${REQ}.spec_hash`, JSON.stringify(sha256Of(wt, rel)));
      const r = verifyScope(wt, "TEST-1");
      assert.equal(r.code, 0, `expected OK, got ${r.code}\nstderr=${r.stderr}`);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("동결 후 draft 변경 시 spec drift 차단", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-1");
      const rel = makeDraft(wt, "TEST-1", "# spec\n## 확정 명세 (Crystallized)\n1. AC-1\n");
      stateSh(wt, "set", "TEST-1", `${REQ}.draft_path`, JSON.stringify(rel));
      stateSh(wt, "set", "TEST-1", `${REQ}.spec_hash`, JSON.stringify(sha256Of(wt, rel)));
      appendFileSync(join(wt, rel), "몰래 추가된 요구사항\n");
      const r = verifyScope(wt, "TEST-1");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /spec drift/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("spec_hash 기록됐는데 draft 파일 없으면 차단", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-1");
      stateSh(wt, "set", "TEST-1", `${REQ}.draft_path`, JSON.stringify(".makdoong2-team/TEST-1/requirements-draft.md"));
      stateSh(wt, "set", "TEST-1", `${REQ}.spec_hash`, JSON.stringify("deadbeef"));
      const r = verifyScope(wt, "TEST-1");
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /확정 명세 파일 없음/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
