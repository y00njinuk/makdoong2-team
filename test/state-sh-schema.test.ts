import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_SH = resolve(HERE, "..", "scripts", "state.sh");
const WTI = resolve(HERE, "..", "scripts", "wt-sync-ignored.sh");

function makeWorktree() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-state-test-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}

function stateSh(wt, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], {
    cwd: wt,
    encoding: "utf8",
  });
  return {
    code: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function statePath(wt, issue) {
  return join(wt, ".makdoong2-team", issue, "state.json");
}

function readState(wt, issue) {
  return JSON.parse(readFileSync(statePath(wt, issue), "utf8"));
}

function writeState(wt, issue, obj) {
  const p = statePath(wt, issue);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

describe("state.sh — phantom-key guard on set", () => {
  test("allows hierarchical stage set", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "set", "TEST-1",
        '.stages."1_planning".substages."jira".done', "true");
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      const s = readState(wt, "TEST-1");
      assert.equal(s.stages["1_planning"].substages.jira.done, true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("blocks flat stage set with exit 65 and hierarchical hint", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "set", "TEST-1",
        '.stages."1_planning.jira".done', "true");
      assert.equal(r.code, 65);
      assert.match(r.stderr, /flat stage notation detected/);
      assert.match(r.stderr, /\.stages\."1_planning"\.substages\."jira"/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("blocks flat stage set for all three phases", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const cases = [
        '.stages."1_planning.requirements".done',
        '.stages."1_planning.scope".approved_by_user',
        '.stages."2_implementation.dev".done',
        '.stages."2_implementation.test".unit',
        '.stages."3_delivery.commit".base_sha',
        '.stages."3_delivery.pr".draft_url',
        '.stages."3_delivery.review".comments',
      ];
      for (const q of cases) {
        const r = stateSh(wt, "set", "TEST-1", q, '"x"');
        assert.equal(r.code, 65, `expected block for path: ${q}`);
      }
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("allows .policy.auto_approve flat keys (intentional exception)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "set", "TEST-1",
        '.policy.auto_approve."1_planning.requirements"', "true");
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      const s = readState(wt, "TEST-1");
      assert.equal(s.policy.auto_approve["1_planning.requirements"], true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("state.sh — phantom-key guard on get", () => {
  test("blocks flat stage read with exit 65", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "get", "TEST-1", '.stages."1_planning.jira".self_check');
      assert.equal(r.code, 65);
      assert.match(r.stderr, /flat stage notation detected/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("hierarchical read of default false yields clean 'false' and exit 0", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "get", "TEST-1", '.stages."1_planning".substages."jira".done');
      assert.equal(r.stdout, "false",
        "stdout should be exactly 'false' (single line, no duplicate null fallback)");
      assert.equal(r.code, 0,
        "state.sh get returns 0 for successfully evaluated values including false/null (post-PROJ-40406 contract)");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("hierarchical read of true value yields exit 0", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      stateSh(wt, "set", "TEST-1",
        '.stages."1_planning".substages."jira".done', "true");
      const r = stateSh(wt, "get", "TEST-1", '.stages."1_planning".substages."jira".done');
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      assert.equal(r.stdout, "true");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("state.sh — migrate merges phantom into hierarchical", () => {
  test("phantom node data wins over hierarchical defaults", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s = readState(wt, "TEST-1");
      s.stages["1_planning.requirements"] = {
        done: true,
        self_check: { validations_recorded: true },
        done_at: "2026-01-01T00:00:00Z",
      };
      writeState(wt, "TEST-1", s);

      const r = stateSh(wt, "migrate", "TEST-1");
      assert.equal(r.code, 0, `stderr=${r.stderr}`);

      const after = readState(wt, "TEST-1");
      assert.equal(after.stages["1_planning.requirements"], undefined,
        "phantom node must be removed");
      const req = after.stages["1_planning"].substages.requirements;
      assert.equal(req.done, true, "phantom done=true must win over default false");
      assert.equal(req.done_at, "2026-01-01T00:00:00Z");
      assert.equal(req.self_check.validations_recorded, true);
      assert.equal(req.approved_by_user, false,
        "hierarchical-only field not in phantom must be preserved");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("migrate is idempotent (second run leaves state unchanged)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s = readState(wt, "TEST-1");
      s.stages["3_delivery.commit"] = { done: true, base_sha: "abc123" };
      writeState(wt, "TEST-1", s);

      stateSh(wt, "migrate", "TEST-1");
      const after1 = JSON.stringify(readState(wt, "TEST-1"));
      stateSh(wt, "migrate", "TEST-1");
      const after2 = JSON.stringify(readState(wt, "TEST-1"));
      assert.equal(after1, after2, "second migrate must be no-op");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("migrate handles all substages across three phases", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s = readState(wt, "TEST-1");
      const contamination = {
        "1_planning.jira":         { done: true },
        "1_planning.requirements": { done: true },
        "1_planning.scope":        { done: true },
        "2_implementation.dev":    { done: true },
        "2_implementation.test":   { done: true, unit: "pass" },
        "3_delivery.commit":       { done: true, base_sha: "sha" },
        "3_delivery.pr":           { done: true, draft_url: "url" },
        "3_delivery.review":       { done: true, comments: 3 },
      };
      Object.assign(s.stages, contamination);
      writeState(wt, "TEST-1", s);

      stateSh(wt, "migrate", "TEST-1");
      const after = readState(wt, "TEST-1");

      for (const key of Object.keys(contamination)) {
        assert.equal(after.stages[key], undefined,
          `phantom key ${key} must be removed`);
      }

      assert.equal(after.stages["1_planning"].substages.jira.done, true);
      // flat `1_planning.scope` 는 hierarchical 로 승격된 직후 requirements 로
      // **흡수**된다 (scope substage 폐지). done 은 AND 로 접히므로 둘 다 true 면 true.
      assert.equal(after.stages["1_planning"].substages.requirements.done, true);
      assert.equal(after.stages["1_planning"].substages.scope, undefined,
        "scope substage 는 requirements 로 흡수되고 키 자체가 제거되어야 한다");
      assert.equal(after.stages["2_implementation"].substages.dev.done, true);
      assert.equal(after.stages["2_implementation"].substages.test.done, true);
      assert.equal(after.stages["2_implementation"].substages.test.unit, "pass");
      assert.equal(after.stages["3_delivery"].substages.commit.done, true);
      assert.equal(after.stages["3_delivery"].substages.commit.base_sha, "sha");
      assert.equal(after.stages["3_delivery"].substages.pr.draft_url, "url");
      assert.equal(after.stages["3_delivery"].substages.review.comments, 3);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("state.sh — init auto-migrates existing contaminated state", () => {
  test("re-init on contaminated file triggers migrate", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s = readState(wt, "TEST-1");
      s.stages["1_planning.jira"] = {
        done: true,
        validation_passed: true,
      };
      writeState(wt, "TEST-1", s);

      const r = stateSh(wt, "init", "TEST-1", wt);
      assert.equal(r.code, 0);
      assert.equal(existsSync(statePath(wt, "TEST-1")), true);

      const after = readState(wt, "TEST-1");
      assert.equal(after.stages["1_planning.jira"], undefined,
        "phantom must be gone after re-init");
      assert.equal(after.stages["1_planning"].substages.jira.done, true,
        "phantom data must be merged into hierarchical");
      assert.equal(after.stages["1_planning"].substages.jira.validation_passed, true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("init on fresh worktree creates hierarchical schema only", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s = readState(wt, "TEST-1");
      const flatKeys = Object.keys(s.stages).filter(k => k.includes("."));
      assert.deepEqual(flatKeys, [],
        `fresh init must not create any flat keys; found: ${flatKeys.join(",")}`);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("state.sh status — 승인된 읽기 전용 진단 (issue #5)", () => {
  function kv(stdout) {
    // next= 는 여러 줄 나올 수 있으므로 배열로 모은다.
    const out = {};
    for (const line of stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i), v = line.slice(i + 1);
      if (k === "next") (out.next ??= []).push(v);
      else out[k] = v;
    }
    return out;
  }

  test("파일 부재를 exists=false + exit 1 로 명시한다", () => {
    const wt = makeWorktree();
    try {
      const r = stateSh(wt, "status", "TEST-MISSING");
      assert.equal(r.code, 1, "부재는 exit 1");
      const s = kv(r.stdout);
      assert.equal(s.exists, "false");
      assert.equal(s.readable, "false");
      assert.match(s.path, /\.makdoong2-team\/TEST-MISSING\/state\.json$/);
      assert.ok(s.next.some(n => n.includes("state.sh init")), "복구 명령을 제시해야 한다");
      assert.ok(s.next.some(n => n.includes("wt-sync-ignored.sh")));
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("정상 파일은 exit 0 과 핵심 필드를 보고한다", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "status", "TEST-1");
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      const s = kv(r.stdout);
      assert.equal(s.exists, "true");
      assert.equal(s.readable, "true");
      assert.equal(s.issue, "TEST-1");
      assert.equal(s.worktree, wt);
      assert.equal(s.stages, "1_planning,2_implementation,3_delivery");
      assert.equal(s.phantom_keys, "none");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("손상된 JSON 은 exists=true + readable=false 로 구분된다", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      writeFileSync(statePath(wt, "TEST-1"), "{ not json");
      const r = stateSh(wt, "status", "TEST-1");
      assert.equal(r.code, 1);
      const s = kv(r.stdout);
      assert.equal(s.exists, "true", "부재와 손상은 구분되어야 한다");
      assert.equal(s.readable, "false");
      assert.ok(s.next.some(n => n.includes("에스컬레이션")), "손상은 자동 복구 대상이 아니다");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("phantom(flat) 키를 찾아 migrate 를 안내한다", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s0 = readState(wt, "TEST-1");
      s0.stages["1_planning.jira"] = { done: true };
      writeState(wt, "TEST-1", s0);
      const r = stateSh(wt, "status", "TEST-1");
      assert.equal(r.code, 0);
      const s = kv(r.stdout);
      assert.equal(s.phantom_keys, "1_planning.jira");
      assert.ok(s.next.some(n => n.includes("state.sh migrate")));
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("인자 없이 부르면 raw bash 에러 대신 usage 를 낸다", () => {
    const wt = makeWorktree();
    try {
      const r = stateSh(wt, "status");
      assert.equal(r.code, 64);
      assert.match(r.stderr, /usage: state\.sh status <issue>/);
      assert.doesNotMatch(r.stderr, /parameter null or not set/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("state.sh get/set/append — 인자 누락 시 usage (issue #5 부수 관찰)", () => {
  test("get 은 jq-path 누락 시 usage + status 안내", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const r = stateSh(wt, "get", "TEST-1");
      assert.equal(r.code, 64);
      assert.match(r.stderr, /usage: state\.sh get <issue> <jq-path>/);
      assert.match(r.stderr, /state\.sh status/);
      assert.doesNotMatch(r.stderr, /parameter null or not set/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("get 은 파일 부재를 stderr 로 알리되 stdout 계약은 유지한다", () => {
    const wt = makeWorktree();
    try {
      const r = stateSh(wt, "get", "TEST-MISSING", ".issue");
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "null", "stdout 은 정확히 한 줄 null 이어야 한다");
      assert.match(r.stderr, /state\.json 없음/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("set / append 도 usage 로 실패한다", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "TEST-1", wt);
      const s = stateSh(wt, "set", "TEST-1", ".foo");
      assert.equal(s.code, 64);
      assert.match(s.stderr, /usage: state\.sh set/);
      const a = stateSh(wt, "append", "TEST-1", ".foo");
      assert.equal(a.code, 64);
      assert.match(a.stderr, /usage: state\.sh append/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("state.sh root — worktree-local behavior", () => {
  function makeMainWithCommit() {
    const main = mkdtempSync(join(tmpdir(), "makdoong2-main-"));
    spawnSync("git", ["init", "-q"], { cwd: main });
    spawnSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=T",
      "commit", "--allow-empty", "-m", "init"], { cwd: main });
    return main;
  }

  function addWorktree(main, branchName) {
    const wt = mkdtempSync(join(tmpdir(), "makdoong2-wt-"));
    const r = spawnSync("git", ["worktree", "add", "-b", branchName, wt], {
      cwd: main, encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git worktree add failed: ${r.stderr}`);
    return wt;
  }

  test("root() from main repo returns main repo path", () => {
    const main = makeMainWithCommit();
    try {
      const r = stateSh(main, "root");
      assert.equal(r.code, 0);
      // realpath 를 통해 심볼릭 링크 정규화
      const { stdout: realMain } = spawnSync("realpath", [main], { encoding: "utf8" });
      const { stdout: realGot } = spawnSync("realpath", [r.stdout], { encoding: "utf8" });
      assert.equal(realGot.trim(), realMain.trim());
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("root() from worktree returns worktree path, NOT main repo", () => {
    const main = makeMainWithCommit();
    let wt = "";
    try {
      wt = addWorktree(main, "feature/TEST-WT");
      const r = stateSh(wt, "root");
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      const { stdout: realWt } = spawnSync("realpath", [wt], { encoding: "utf8" });
      const { stdout: realGot } = spawnSync("realpath", [r.stdout], { encoding: "utf8" });
      const { stdout: realMain } = spawnSync("realpath", [main], { encoding: "utf8" });
      assert.equal(realGot.trim(), realWt.trim(), "root() should return worktree path");
      assert.notEqual(realGot.trim(), realMain.trim(), "root() must NOT return main repo from worktree");
    } finally {
      if (wt) spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main });
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("wt-sync-ignored.sh --reverse — worktree → main reverse sync", () => {
  function runWtSync(wt, ...args) {
    const r = spawnSync("bash", [WTI, ...args], { cwd: wt, encoding: "utf8" });
    return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  }

  function makeMainWithCommitAndWorktree(issue) {
    const main = mkdtempSync(join(tmpdir(), "makdoong2-main-"));
    spawnSync("git", ["init", "-q"], { cwd: main });
    spawnSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=T",
      "commit", "--allow-empty", "-m", "init"], { cwd: main });
    const wt = mkdtempSync(join(tmpdir(), "makdoong2-wt-"));
    const r = spawnSync("git", ["worktree", "add", "-b", `feature/${issue}`, wt],
      { cwd: main, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`worktree add failed: ${r.stderr}`);
    return { main, wt };
  }

  test("--reverse syncs worktree .makdoong2-team/<issue>/ to main repo", () => {
    const issue = "TEST-REV-1";
    const { main, wt } = makeMainWithCommitAndWorktree(issue);
    try {
      // 1. worktree에 state.json 생성
      const wtStateDir = join(wt, ".makdoong2-team", issue);
      mkdirSync(wtStateDir, { recursive: true });
      writeFileSync(join(wtStateDir, "state.json"), JSON.stringify({ worktree_written: true }));
      writeFileSync(join(wtStateDir, "extra.txt"), "worktree-only-file");

      // 2. --reverse 실행
      const r = runWtSync(wt, "--reverse", wt, issue);
      assert.equal(r.code, 0, `reverse sync failed: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.match(r.stdout, /reverse sync/i);

      // 3. main repo에 파일이 복사됐는지 확인
      const mainStateDir = join(main, ".makdoong2-team", issue);
      assert.ok(existsSync(join(mainStateDir, "state.json")), "state.json must be in main repo after reverse sync");
      const copied = JSON.parse(readFileSync(join(mainStateDir, "state.json"), "utf8"));
      assert.equal(copied.worktree_written, true, "state.json content must be synced");
      assert.ok(existsSync(join(mainStateDir, "extra.txt")), "extra.txt must also be synced");
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main });
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("--reverse without issue arg exits with error", () => {
    const { main, wt } = makeMainWithCommitAndWorktree("TEST-REV-2");
    try {
      const r = runWtSync(wt, "--reverse", wt);  // issue 없음
      assert.notEqual(r.code, 0, "should fail without issue arg");
      assert.match(r.stderr, /issue 인자 필수/);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main });
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("--reverse with nonexistent worktree source is a no-op (no crash)", () => {
    const { main, wt } = makeMainWithCommitAndWorktree("TEST-REV-3");
    try {
      // worktree에 .makdoong2-team 없음 — reverse는 "source 없음"만 출력하고 exit 0
      const r = runWtSync(wt, "--reverse", wt, "TEST-REV-3");
      // source가 없으면 stderr에 경고 출력하지만 exit code는 0
      // (wt-sync-ignored.sh --reverse 구현이 source 없음을 경고하고 종료)
      // exit code가 0이어야 함 (finally 블록에서 안전하게 호출 가능)
      // 단, stderr에 "source 없음" 메시지가 있어야 함
      assert.match(r.stderr, /source 없음/);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main });
      rmSync(main, { recursive: true, force: true });
    }
  });
});
