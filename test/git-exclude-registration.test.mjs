// test/git-exclude-registration.test.mjs — 플러그인 자기 상태 디렉터리의 git exclude 등록 회귀.
//
// 배경 (issue #6-②): 플러그인은 `.makdoong2-team/` 를 작업 트리 안에 만들면서
// git exclude 에는 등록하지 않았다. 그래서 그 패턴이 없는 저장소에서는
// `git status --porcelain` 이 항상 플러그인 자신의 파일을 보고했고, "git status 청결"
// 을 요구하는 2_implementation.analysis verifier 가 **항상 REJECTED** 를 냈다.
// 그 시점에 exclude 를 고칠 권한을 가진 역할이 파이프라인에 없어(analyzer 는 산출물
// 1개만 쓰기 가능 · team-leader 는 하드룰 2 로 차단 · engineer 는 analysis 통과 후
// 단계) 동일 사유 무한 루프가 됐고, 사용자가 직접 한 줄을 넣어야만 풀렸다.
//
// 이 스위트가 고정하는 계약:
//   ① state.sh init 이 상태 디렉터리를 만드는 그 자리에서 exclude 에 등록한다
//      (analysis 는 worktree 생성 전 main repo 단계라 wt-sync 는 아직 돌지 않는다)
//   ② wt-sync-ignored.sh 의 baseline 에도 있어서 worktree 경로에서도 등록된다
//   ③ 등록은 멱등이고, git 저장소가 아니어도 init 자체를 실패시키지 않는다

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");
const WT_SYNC = join(REPO_ROOT, "scripts", "wt-sync-ignored.sh");
const PATTERN = ".makdoong2-team/";

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo({ jvm = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mkd2-exclude-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n");
  if (jvm) writeFileSync(join(dir, "build.sbt"), 'name := "x"\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function excludeLines(dir) {
  const f = join(dir, ".git", "info", "exclude");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n") : [];
}

function porcelain(dir) {
  return (git(dir, "status", "--porcelain").stdout || "").trim();
}

describe("state.sh init — 상태 디렉터리 생성 시 git exclude 등록 (issue #6-②)", () => {
  test("init 이 .makdoong2-team/ 을 exclude 에 넣어 git status 를 깨끗하게 유지한다", () => {
    const dir = makeRepo();
    try {
      assert.ok(!excludeLines(dir).includes(PATTERN), "사전 조건: 아직 등록돼 있지 않다");
      const r = spawnSync("bash", [STATE_SH, "init", "PROJ-1", dir], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, `init 실패: ${r.stderr}`);
      assert.ok(excludeLines(dir).includes(PATTERN), ".makdoong2-team/ 가 exclude 에 등록되어야 한다");
      // 핵심 계약 — 이게 비어야 analysis verifier 가 통과한다.
      assert.equal(porcelain(dir), "", `git status 가 비어야 한다:\n${porcelain(dir)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("반복 실행해도 라인이 중복되지 않는다", () => {
    const dir = makeRepo();
    try {
      for (let i = 0; i < 3; i++) {
        spawnSync("bash", [STATE_SH, "init", "PROJ-1", dir], { cwd: dir, encoding: "utf8" });
      }
      const hits = excludeLines(dir).filter((l) => l === PATTERN).length;
      assert.equal(hits, 1, `정확히 1회만 있어야 한다 (실제 ${hits})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git 저장소가 아니어도 init 은 성공한다 — exclude 등록 실패가 워크플로우를 막지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkd2-norepo-"));
    try {
      const r = spawnSync("bash", [STATE_SH, "init", "PROJ-1", dir], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, `git 밖에서도 init 은 성공해야 한다: ${r.stderr}`);
      assert.ok(existsSync(join(dir, ".makdoong2-team", "PROJ-1", "state.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("이미 .gitignore 로 무시되는 저장소에서도 깨지지 않는다", () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), ".makdoong2-team/\n");
      git(dir, "add", ".gitignore");
      git(dir, "commit", "-qm", "ignore");
      const r = spawnSync("bash", [STATE_SH, "init", "PROJ-1", dir], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(porcelain(dir), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wt-sync-ignored.sh — worktree baseline 에도 상태 디렉터리가 있다 (issue #6-②)", () => {
  test("baseline 등록 후 worktree 의 git status 가 깨끗하다", () => {
    const main = makeRepo({ jvm: true });
    const wt = `${main}-PROJ-2`;
    try {
      const add = git(main, "worktree", "add", "-q", wt, "-b", "feature/PROJ-2");
      assert.equal(add.status, 0, `worktree 생성 실패: ${add.stderr}`);

      const r = spawnSync("bash", [WT_SYNC, wt, "PROJ-2"], { cwd: main, encoding: "utf8" });
      assert.equal(r.status, 0, `wt-sync 실패: ${r.stderr}`);

      // worktree 의 --git-common-dir 은 main repo 의 .git 이므로 같은 파일을 공유한다.
      const lines = excludeLines(main);
      assert.ok(lines.includes(PATTERN), ".makdoong2-team/ 가 baseline 에 있어야 한다");
      // 프로젝트 타입 감지(JVM)가 함께 살아 있는지도 확인 — 회귀 방지.
      assert.ok(lines.includes("target/") && lines.includes(".bloop/"), "JVM baseline 이 유지되어야 한다");

      mkdirSync(join(wt, ".makdoong2-team", "PROJ-2"), { recursive: true });
      writeFileSync(join(wt, ".makdoong2-team", "PROJ-2", "state.json"), "{}\n");
      assert.equal(porcelain(wt), "", `worktree git status 가 비어야 한다:\n${porcelain(wt)}`);
    } finally {
      git(main, "worktree", "remove", "--force", wt);
      rmSync(wt, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("verifier 기준 — 플러그인 자기 상태를 analyzer 위반으로 세지 않는다 (issue #6-②)", () => {
  // 이미 시작된 저장소(exclude 미등록 상태로 in-flight)는 위 두 경로로 구제되지 않는다.
  // verifier 쪽 이중 안전망이 없으면 그런 워크플로우는 계속 무한 REJECTED 다.
  const verifier = readFileSync(join(REPO_ROOT, "agents/makdoong2-verifier.md"), "utf8");

  test("analysis 의 git status 검사가 .makdoong2-team/ 을 제외한다", () => {
    assert.match(verifier, /git status --porcelain \| grep -v '\\\.makdoong2-team\//);
    assert.match(verifier, /플러그인 자신의 상태 디렉터리/);
  });

  test("제외 없는 종전 기준 문구가 남아 있지 않다", () => {
    assert.ok(
      !/- `git status --porcelain` 이 `workspace-analysis\.json` 외 다른 파일 변경\/신규를 보고하지 않음/.test(verifier),
      "제외 조건 없는 종전 기준이 남아 있으면 같은 무한 루프가 재현된다",
    );
  });
});

describe("git-exclude.sh 공용 헬퍼", () => {
  test("state.sh 와 wt-sync-ignored.sh 가 같은 구현을 쓴다", () => {
    // 두 곳이 각자 append 로직을 들고 있으면 한쪽만 고쳐지는 일이 반복된다.
    for (const rel of ["scripts/state.sh", "scripts/wt-sync-ignored.sh"]) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      assert.match(src, /lib\/git-exclude\.sh/, `${rel} 이 공용 헬퍼를 source 해야 한다`);
      assert.match(src, /ensure_git_exclude_lines/, `${rel} 이 공용 헬퍼를 호출해야 한다`);
    }
    const lib = readFileSync(join(REPO_ROOT, "scripts/lib/git-exclude.sh"), "utf8");
    assert.match(lib, /MAKDOONG2_STATE_DIR_PATTERN="\.makdoong2-team\/"/);
  });
});
