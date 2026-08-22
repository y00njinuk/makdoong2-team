import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionIndex,
  lookupSessionFromIndex,
  findWorktreeRoot,
} from "../dist/session-index.js";

function makeGitRepo() {
  const wt = mkdtempSync(join(tmpdir(), "session-idx-"));
  mkdirSync(join(wt, ".git"));
  writeFileSync(join(wt, ".git", "HEAD"), "ref: refs/heads/main\n");
  return wt;
}

describe("session index — append/lookup roundtrip", () => {
  test("appendSessionIndex creates .makdoong2-team/<issue>/session-index.ndjson", () => {
    const wt = makeGitRepo();
    try {
      appendSessionIndex({
        sessionID: "ses_abc123",
        agent: "makdoong2-engineer",
        worktree: wt,
        issue: "PROJ-100",
        stage: "2_implementation.dev",
        createdAt: new Date().toISOString(),
      });
      const raw = readFileSync(join(wt, ".makdoong2-team", "PROJ-100", "session-index.ndjson"), "utf8");
      const line = raw.trim().split("\n").pop();
      const parsed = JSON.parse(line);
      assert.equal(parsed.sessionID, "ses_abc123");
      assert.equal(parsed.agent, "makdoong2-engineer");
      assert.equal(parsed.issue, "PROJ-100");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("lookupSessionFromIndex finds session by ID across multiple issues", () => {
    const wt = makeGitRepo();
    try {
      appendSessionIndex({
        sessionID: "ses_aaa",
        agent: "makdoong2-engineer",
        worktree: wt,
        issue: "PROJ-100",
        createdAt: new Date().toISOString(),
      });
      appendSessionIndex({
        sessionID: "ses_bbb",
        agent: "makdoong2-publisher",
        worktree: wt,
        issue: "PROJ-200",
        createdAt: new Date().toISOString(),
      });
      appendSessionIndex({
        sessionID: "ses_ccc",
        agent: "makdoong2-verifier",
        worktree: wt,
        issue: "PROJ-100",
        createdAt: new Date().toISOString(),
      });

      const b = lookupSessionFromIndex(wt, "ses_bbb");
      assert.ok(b);
      assert.equal(b.issue, "PROJ-200");
      assert.equal(b.agent, "makdoong2-publisher");

      const c = lookupSessionFromIndex(wt, "ses_ccc");
      assert.ok(c);
      assert.equal(c.issue, "PROJ-100");

      const missing = lookupSessionFromIndex(wt, "ses_nonexistent");
      assert.equal(missing, null);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("lookupSessionFromIndex handles malformed lines gracefully", () => {
    const wt = makeGitRepo();
    try {
      const dir = join(wt, ".makdoong2-team", "PROJ-100");
      mkdirSync(dir, { recursive: true });
      const idx = join(dir, "session-index.ndjson");
      appendFileSync(idx, "not-valid-json\n");
      appendFileSync(idx, JSON.stringify({ sessionID: "ses_ok", agent: "x", worktree: wt, issue: "PROJ-100", createdAt: "t" }) + "\n");
      appendFileSync(idx, "{malformed\n");
      const found = lookupSessionFromIndex(wt, "ses_ok");
      assert.ok(found);
      assert.equal(found.sessionID, "ses_ok");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("lookupSessionFromIndex returns null when directory absent", () => {
    const wt = makeGitRepo();
    try {
      const found = lookupSessionFromIndex(wt, "ses_any");
      assert.equal(found, null);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("findWorktreeRoot — walk-up detection", () => {
  test("finds git repo root from nested file path", () => {
    const wt = makeGitRepo();
    try {
      mkdirSync(join(wt, "src", "todo"), { recursive: true });
      writeFileSync(join(wt, "src", "todo", "cli.py"), "print('hi')\n");
      const root = findWorktreeRoot(join(wt, "src", "todo", "cli.py"));
      assert.equal(root, wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("finds git repo root from file at repo top", () => {
    const wt = makeGitRepo();
    try {
      writeFileSync(join(wt, "README.md"), "hello\n");
      const root = findWorktreeRoot(join(wt, "README.md"));
      assert.equal(root, wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("returns null when no .git ancestor exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      writeFileSync(join(dir, "orphan.txt"), "x\n");
      const root = findWorktreeRoot(join(dir, "orphan.txt"));
      assert.equal(root, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session index — recovery scenario (PROJ-40406 plugin reinit)", () => {
  test("dispatch_stage writes index → auto-git-add hook in new plugin instance reads it back", () => {
    const wt = makeGitRepo();
    try {
      appendSessionIndex({
        sessionID: "ses_engineer_1",
        agent: "makdoong2-engineer",
        worktree: wt,
        issue: "PROJ-40406",
        stage: "2_implementation.dev",
        createdAt: new Date().toISOString(),
      });

      mkdirSync(join(wt, "todo"), { recursive: true });
      const filePath = join(wt, "todo", "cli.py");
      writeFileSync(filePath, "def main():\n    pass\n");

      const foundRoot = findWorktreeRoot(filePath);
      assert.equal(foundRoot, wt);
      const indexed = lookupSessionFromIndex(foundRoot, "ses_engineer_1");
      assert.ok(indexed);
      assert.equal(indexed.worktree, wt);
      assert.equal(indexed.issue, "PROJ-40406");
      assert.equal(indexed.agent, "makdoong2-engineer");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
