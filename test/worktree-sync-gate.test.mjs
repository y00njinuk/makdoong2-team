/**
 * Regression tests for worktree state.json 동기화 타이밍 버그
 *
 * 버그: createWorktree() 내부에서 wt-sync-ignored.sh(forward sync)가
 * state.sh set .worktree 보다 먼저 실행되어, worktree state.json에
 * 구버전 .worktree 값(메인 repo 경로)이 남는다. 이후 gate 스크립트가
 * worktree CWD에서 실행되면 stale한 값을 읽어 오류 발생.
 *
 * 수정 방안: C + B 조합
 *   C — createWorktree()에서 wt-sync-ignored.sh 제거
 *   B — auto_advance_stage에서 resolvedWt 확정 이후, verify.sh 호출 직전에
 *       pre-gate forward sync 추가
 *
 * 이 테스트는 script-level 불변식을 검증한다:
 *   - stage4-dev-verify.sh가 stale .worktree 값을 감지해 차단하는지
 *   - wt-sync-ignored.sh forward sync 이후 state.json이 올바르게 전파되는지
 *   - forward sync 후 gate가 통과하는지
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");
const GATE4_SH = join(REPO_ROOT, "gates", "stage4-dev-verify.sh");
const WTI_SH = join(REPO_ROOT, "scripts", "wt-sync-ignored.sh");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** 메인 repo 생성: git init + 최초 커밋 (worktree add에 커밋 필요) */
function makeMainRepo() {
  // realpathSync is required, not cosmetic: on macOS os.tmpdir() is /var/folders/…
  // and /var is a symlink to /private/var, so git reports the resolved path while
  // mkdtempSync returns the unresolved one. The gate compares .worktree against
  // `git worktree list` as plain strings, so the two forms never match and the
  // stale-path check silently passes. Linux /tmp is a real directory, which is why
  // this only diverges on macOS.
  const main = realpathSync(mkdtempSync(join(tmpdir(), "makdoong2-wt-sync-main-")));
  spawnSync("git", ["init", "-q"], { cwd: main, env: GIT_ENV });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: main, env: GIT_ENV });
  spawnSync("git", ["config", "user.name", "test"], { cwd: main, env: GIT_ENV });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: main, env: GIT_ENV });
  return main;
}

/** sibling worktree 생성 및 경로 반환 */
function makeWorktree(main, issue) {
  const parentDir = dirname(main);
  const repoName = basename(main);
  const wtPath = join(parentDir, `${repoName}-${issue}`);
  const r = spawnSync("git", ["worktree", "add", wtPath, "-b", `feature/${issue}`], {
    cwd: main,
    env: GIT_ENV,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `git worktree add 실패: ${r.stderr}`);
  return wtPath;
}

function stateSh(cwd, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd, encoding: "utf8", env: GIT_ENV });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function runGate4(cwd, issue) {
  const r = spawnSync("bash", [GATE4_SH, issue], { cwd, encoding: "utf8", env: GIT_ENV });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function runWtSync(cwd, ...args) {
  const r = spawnSync("bash", [WTI_SH, ...args], { cwd, encoding: "utf8", env: GIT_ENV });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** state.json 초기화 및 planning substages 완료 마킹 + policy bypass 설정 */
function setupPlanningDone(main, issue) {
  // init state.json
  const r = stateSh(main, "init", issue, main);
  assert.equal(r.code, 0, `state.sh init 실패: ${r.stderr}`);

  // scope done = true (gate4 prerequisite)
  const scope = stateSh(main, "set", issue, '.stages."1_planning".substages."scope".done', "true");
  assert.equal(scope.code, 0, `scope done 설정 실패: ${scope.stderr}`);

  // analysis done = true (skipped도 done=true로 처리)
  const analysis = stateSh(main, "set", issue, '.stages."2_implementation".substages."analysis".done', "true");
  assert.equal(analysis.code, 0, `analysis done 설정 실패: ${analysis.stderr}`);

  // auto_approve scope — approved_by_user 체크 우회
  const policy = stateSh(main, "set", issue, '.policy.auto_approve."1_planning.scope"', "true");
  assert.equal(policy.code, 0, `policy 설정 실패: ${policy.stderr}`);
}

describe("worktree-sync-gate — 동기화 타이밍 버그 회귀 테스트", () => {

  // ── Test 1: 버그 재현 ───────────────────────────────────────────────────────
  // worktree state.json의 .worktree = main-repo-path(stale)인 상태에서
  // stage4-dev-verify.sh가 "worktree가 메인 repo와 동일 경로" 오류로 차단하는지 확인.
  test("버그 재현: stale .worktree 값으로 gate가 차단된다", () => {
    const ISSUE = "TEST-WTS-1";
    const main = makeMainRepo();
    let wt;
    try {
      wt = makeWorktree(main, ISSUE);
      setupPlanningDone(main, ISSUE);

      // worktree .makdoong2-team 디렉토리에 main state.json을 복사 (stale 상태 시뮬레이션)
      // .worktree 값을 main-repo-path로 설정 (구버전 state.json의 값)
      const wtStateDir = join(wt, ".makdoong2-team", ISSUE);
      mkdirSync(wtStateDir, { recursive: true });

      // main state.json을 worktree에 복사 (이 시점 .worktree = main-path — stale)
      const mainStateDir = join(main, ".makdoong2-team", ISSUE);
      const mainState = JSON.parse(
        spawnSync("cat", [join(mainStateDir, "state.json")], { encoding: "utf8" }).stdout,
      );
      // .worktree를 main-repo-path로 명시 (stale 시뮬레이션)
      mainState.worktree = main;
      writeFileSync(join(wtStateDir, "state.json"), JSON.stringify(mainState, null, 2));

      // gate 실행 — worktree CWD
      const r = runGate4(wt, ISSUE);

      assert.equal(r.code, 2,
        `gate가 차단되어야 함 (exit 2), 실제: ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /worktree가 메인 repo와 동일 경로/,
        `stale .worktree로 인한 오류 메시지 기대\nstderr: ${r.stderr}`);
    } finally {
      if (wt) rmSync(wt, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });

  // ── Test 2: 수정 검증 ───────────────────────────────────────────────────────
  // wt-sync-ignored.sh forward sync 이후 stage4-dev-verify.sh가 통과하는지 확인.
  // 이것이 Fix B(pre-gate forward sync)가 해결하는 동작과 동일하다.
  test("수정 검증: forward sync 후 gate가 통과한다", () => {
    const ISSUE = "TEST-WTS-2";
    const main = makeMainRepo();
    let wt;
    try {
      wt = makeWorktree(main, ISSUE);
      setupPlanningDone(main, ISSUE);

      // main state.json에 올바른 .worktree 값 설정 (Fix B에서 state.sh set이 하는 일)
      const setWt = stateSh(main, "set", ISSUE, ".worktree", `"${wt}"`);
      assert.equal(setWt.code, 0, `state.sh set .worktree 실패: ${setWt.stderr}`);

      // forward sync (Fix B의 pre-gate sync와 동일)
      const sync = runWtSync(main, wt, ISSUE);
      assert.equal(sync.code, 0, `wt-sync-ignored.sh 실패: ${sync.stderr}`);

      // gate 실행 — worktree CWD
      const r = runGate4(wt, ISSUE);

      assert.equal(r.code, 0,
        `gate가 통과해야 함 (exit 0), 실제: ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK/,
        `게이트 OK 메시지 기대\nstdout: ${r.stdout}`);
    } finally {
      if (wt) rmSync(wt, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });

  // ── Test 3: forward sync 필드 전파 검증 ─────────────────────────────────────
  // main state.json에 올바른 .worktree 값이 있을 때 forward sync가
  // worktree state.json의 .worktree를 올바르게 업데이트하는지 확인.
  test("forward sync: main state.json의 .worktree 값이 worktree로 전파된다", () => {
    const ISSUE = "TEST-WTS-3";
    const main = makeMainRepo();
    let wt;
    try {
      wt = makeWorktree(main, ISSUE);
      setupPlanningDone(main, ISSUE);

      // main state.json에 stale 값 설정
      const setStale = stateSh(main, "set", ISSUE, ".worktree", `"${main}"`);
      assert.equal(setStale.code, 0);

      // worktree에 stale 상태 복사
      const wtStateDir = join(wt, ".makdoong2-team", ISSUE);
      mkdirSync(wtStateDir, { recursive: true });
      const staleSync = runWtSync(main, wt, ISSUE);
      assert.equal(staleSync.code, 0);

      // worktree state.json의 .worktree = main (stale 확인)
      const beforeR = stateSh(wt, "get", ISSUE, ".worktree");
      assert.equal(beforeR.stdout.replace(/^"|"$/g, ""), main,
        `forward sync 전 worktree state.json의 .worktree는 main-path여야 함`);

      // main state.json에 올바른 값으로 업데이트
      const setCorrect = stateSh(main, "set", ISSUE, ".worktree", `"${wt}"`);
      assert.equal(setCorrect.code, 0, `state.sh set .worktree 실패: ${setCorrect.stderr}`);

      // forward sync 재실행
      const correctSync = runWtSync(main, wt, ISSUE);
      assert.equal(correctSync.code, 0, `wt-sync-ignored.sh 실패: ${correctSync.stderr}`);

      // worktree state.json의 .worktree = wt (올바른 값으로 업데이트됐는지 확인)
      const afterR = stateSh(wt, "get", ISSUE, ".worktree");
      const wtValue = afterR.stdout.replace(/^"|"$/g, "");
      assert.equal(wtValue, wt,
        `forward sync 후 worktree state.json의 .worktree는 worktree-path여야 함\n실제: ${wtValue}`);
    } finally {
      if (wt) rmSync(wt, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });
});
