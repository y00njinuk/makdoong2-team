/**
 * issue #11 회귀 — `2_implementation.dev` 의 테스트 동반 원칙이
 * `1_planning.requirements` 가 승인·동결한 테스트 범위 선언을 따르는지.
 *
 * 종전에는 dev 완료 체크리스트 항목 3("테스트 동반 원칙")과 verifier 기준이
 * requirements 의 scope-out 결정을 조회하는 경로를 갖고 있지 않아, 순수 설정·
 * 인프라 전환 작업에서 REJECTED 가 반복되고 결국 engineer 가 승인된 스코프 밖의
 * 테스트 코드를 추가했다. 같은 재시도 구간에서 team-leader 의 `state.sh set` cwd
 * (main repo)와 dispatch_stage 가 보는 사본(worktree)이 갈려 `already_done: true`
 * 오차단이 2회 함께 관측됐다.
 *
 * 세 축을 함께 고정한다:
 *   1. 게이트(stage4-dev-post-verify.sh)의 판정 분기
 *   2. 마커 정의 3곳 일치 — stage spec self_check · 게이트 · verifier
 *   3. 사본 분리 진단 — state.sh set 경고 + dispatch_stage 정방향 동기화
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");
const POST_GATE = join(REPO_ROOT, "gates", "stage4-dev-post-verify.sh");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

const REQ_TEST_SCOPE = '.stages."1_planning".substages."requirements".test_scope';
const DEV = '.stages."2_implementation".substages."dev"';

function sh(cwd: string, args: string[]) {
  const r = spawnSync("bash", args, { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** dev_post 게이트가 실제로 판정할 수 있는 최소 worktree 를 만든다. */
function makeDevWorktree(selfCheck: Record<string, boolean> | null) {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-testscope-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: wt });
  spawnSync("git", ["config", "user.name", "t"], { cwd: wt });
  sh(wt, [STATE_SH, "init", "TEST-11", wt]);
  // 게이트의 1~3번(worktree 존재 · staged 파일 · untracked 0)을 통과시켜 두어야
  // 4번(테스트 동반 원칙) 분기가 실제로 평가된다.
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "app.txt"), "x\n");
  spawnSync("git", ["add", "src/app.txt"], { cwd: wt });
  if (selfCheck) {
    sh(wt, [STATE_SH, "set", "TEST-11", `${DEV}.self_check`, JSON.stringify(selfCheck)]);
  }
  return wt;
}

const PASSING = {
  scope_met: true, existing_tests_pass: true, new_tests_added: true,
  type_lint_clean: true, no_secrets: true, all_writes_staged: true,
};
const NO_NEW_TESTS = { ...PASSING, new_tests_added: false };

function gate(wt: string) {
  return sh(wt, [POST_GATE, "TEST-11"]);
}

describe("dev_post 게이트 — 테스트 동반 원칙은 requirements 선언을 따른다", () => {
  test("선언 마커가 없으면 테스트 추가가 요구된다 (fail-closed)", () => {
    const wt = makeDevWorktree(NO_NEW_TESTS);
    try {
      const r = gate(wt);
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /테스트 동반 원칙 미충족/);
      // 부재가 "면제" 로 둔갑하면 안 된다는 것이 이 테스트의 요지다.
      assert.match(r.stderr, /부재\/null 은 true 로 간주/);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });

  test("new_tests_required=true 인데 테스트를 안 붙였으면 BLOCK", () => {
    const wt = makeDevWorktree(NO_NEW_TESTS);
    try {
      sh(wt, [STATE_SH, "set", "TEST-11", REQ_TEST_SCOPE,
        '{"new_tests_required":true,"rationale":"기능 변경"}']);
      const r = gate(wt);
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\n${r.stderr}`);
      assert.match(r.stderr, /테스트 동반 원칙 미충족/);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });

  test("new_tests_required=false + waived 마커면 테스트 없이 통과한다", () => {
    const wt = makeDevWorktree(NO_NEW_TESTS);
    try {
      sh(wt, [STATE_SH, "set", "TEST-11", REQ_TEST_SCOPE,
        '{"new_tests_required":false,"rationale":"배포 설정 전환 — 단위 테스트 대상 없음"}']);
      sh(wt, [STATE_SH, "set", "TEST-11", `${DEV}.new_tests_waived`, "true"]);
      const r = gate(wt);
      assert.equal(r.code, 0, `expected OK, got ${r.code}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /MAKDOONG2-GATE OK/);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });

  test("new_tests_required=false 인데 waived 마커가 없으면 BLOCK (슬립과 면제를 구분한다)", () => {
    const wt = makeDevWorktree(NO_NEW_TESTS);
    try {
      sh(wt, [STATE_SH, "set", "TEST-11", REQ_TEST_SCOPE,
        '{"new_tests_required":false,"rationale":"설정 전환"}']);
      const r = gate(wt);
      assert.equal(r.code, 2, `expected BLOCKED, got ${r.code}\n${r.stderr}`);
      assert.match(r.stderr, /new_tests_waived/);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });

  test("new_tests_added=true 면 선언과 무관하게 통과한다", () => {
    const wt = makeDevWorktree(PASSING);
    try {
      const r = gate(wt);
      assert.equal(r.code, 0, `expected OK, got ${r.code}\n${r.stderr}`);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });

  test("self_check 자체가 없는 구형 state 는 검사하지 않는다 (기존 동작 보존)", () => {
    const wt = makeDevWorktree(null);
    try {
      const r = gate(wt);
      assert.equal(r.code, 0, `expected OK, got ${r.code}\n${r.stderr}`);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });
});

describe("마커 정의 3곳 일치 — stage spec · 게이트 · verifier", () => {
  const SPECS = ["stages/02-requirements.md", "stages/01-planning.md"];
  for (const p of SPECS) {
    test(`${p} 가 test_scope 마커 기록을 지시한다`, () => {
      const t = read(p);
      assert.match(t, /substages\."requirements"\.test_scope/, "test_scope 기록 지시가 없다");
      assert.match(t, /new_tests_required/, "new_tests_required 필드 정의가 없다");
      assert.ok(t.includes("fail-closed") || t.includes("true 로 간주"),
        "마커 부재 시 기본값(true) 규약이 없다");
    });
  }

  test("dev stage spec 이 선언을 조회하고 조건부로 적용한다", () => {
    const t = read("stages/05-worktree-dev.md");
    assert.match(t, /test_scope\.new_tests_required/, "dev spec 이 선언을 조회하지 않는다");
    assert.match(t, /new_tests_waived/, "면제 마커 기록 절차가 없다");
    // 무조건 적용으로 되돌아가지 않았는지 — 항목 3 이 조건부임을 명시해야 한다.
    assert.match(t, /`new_tests_required=true` 인 경우에만/,
      "체크리스트 항목 3 이 다시 무조건 요구로 되돌아갔다");
  });

  test("게이트가 같은 선언을 본다", () => {
    const g = read("gates/stage4-dev-post-verify.sh");
    assert.match(g, /test_scope\.new_tests_required/);
    assert.match(g, /new_tests_waived/);
    assert.match(g, /self_check\.new_tests_added/);
  });

  test("verifier 가 같은 선언을 보고, output 문구 검색으로 반려하지 않는다", () => {
    const v = read("agents/makdoong2-verifier.md");
    assert.match(v, /test_scope\.new_tests_required/, "verifier 기준에 선언 조회가 없다");
    assert.match(v, /new_tests_waived/, "verifier 가 면제 마커를 확인하지 않는다");
    // 종전 기준 문장이 되살아나면 같은 무한 반려가 재현된다.
    assert.ok(!/sub-agent output에 "테스트 추가" 명시 \/ 5체크/.test(v),
      "verifier 가 output 문구 검색 기준으로 되돌아갔다");
    assert.match(v, /output 이 비어 있거나 특정 문구가 없다는 사실만으로 REJECTED 하지 않는다/);
  });

  test("engineer 프롬프트에 선언 조회 지시가 주입된다", () => {
    const src = read("src/opencode-plugin.ts");
    assert.match(src, /테스트 동반 원칙은 requirements 의 선언을 따른다/);
    assert.match(src, /substages\."1_planning"[\s\S]{0,120}test_scope|test_scope/);
  });
});

describe("state.json 사본 분리 진단", () => {
  test("state.sh set — worktree 가 따로 있는데 main repo cwd 에서 쓰면 경고한다", () => {
    const base = mkdtempSync(join(tmpdir(), "makdoong2-split-"));
    const main = join(base, "main");
    const wt = join(base, "main-TEST-11");
    try {
      mkdirSync(main, { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: main });
      spawnSync("git", ["config", "user.email", "t@t"], { cwd: main });
      spawnSync("git", ["config", "user.name", "t"], { cwd: main });
      spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
      sh(main, [STATE_SH, "init", "TEST-11", main]);
      const add = spawnSync("git", ["worktree", "add", "-q", wt, "-b", "feature/TEST-11"], { cwd: main });
      assert.equal(add.status, 0, `git worktree add failed: ${add.stderr}`);
      sh(main, [STATE_SH, "set", "TEST-11", ".worktree", JSON.stringify(wt)]);

      const fromMain = sh(main, [STATE_SH, "set", "TEST-11", `${DEV}.done`, "false"]);
      assert.equal(fromMain.code, 0, "경고는 쓰기를 막지 않는다 (종료 코드 불변)");
      assert.match(fromMain.stdout, /state\[TEST-11\]/, "stdout 계약이 바뀌면 안 된다");
      assert.match(fromMain.stderr, /전용 worktree 사본이 아니다/);
      assert.ok(fromMain.stderr.includes(wt), "경고에 worktree 경로가 없다");

      // worktree cwd 에서 쓰면 조용해야 한다 — 상시 경고는 신호가 아니라 소음이다.
      mkdirSync(join(wt, ".makdoong2-team", "TEST-11"), { recursive: true });
      writeFileSync(
        join(wt, ".makdoong2-team", "TEST-11", "state.json"),
        readFileSync(join(main, ".makdoong2-team", "TEST-11", "state.json"), "utf8"),
      );
      const fromWt = sh(wt, [STATE_SH, "set", "TEST-11", `${DEV}.done`, "false"]);
      assert.equal(fromWt.code, 0);
      assert.ok(!/전용 worktree 사본이 아니다/.test(fromWt.stderr),
        `worktree cwd 에서 경고가 났다: ${fromWt.stderr}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("worktree 가 없는 planning 단계에서는 경고하지 않는다", () => {
    const wt = mkdtempSync(join(tmpdir(), "makdoong2-nosplit-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: wt });
      sh(wt, [STATE_SH, "init", "TEST-11", wt]);
      const r = sh(wt, [STATE_SH, "set", "TEST-11", '.stages."1_planning".substages."jira".done', "true"]);
      assert.equal(r.code, 0);
      assert.ok(!/전용 worktree 사본이 아니다/.test(r.stderr), `불필요한 경고: ${r.stderr}`);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });

  test("dispatch_stage 가 done 검사 전에 정방향 동기화를 한다", () => {
    const src = read("src/opencode-plugin.ts");
    const fwdIdx = src.indexOf("caller=dispatch_stage stage=${args.target_stage}`,\n            );\n            const fwdSync");
    const doneIdx = src.indexOf("already_done: true,");
    assert.ok(fwdIdx > 0, "dispatch_stage 의 정방향 wt-sync 가 없다 — main repo 의 done 재설정이 영영 반영되지 않는다");
    assert.ok(fwdIdx < doneIdx, "정방향 동기화가 done 검사보다 뒤에 있다 — 순서가 뒤집히면 효과가 없다");
  });

  test("already_done 응답이 사본 불일치를 관측해서 알린다", () => {
    const src = read("src/opencode-plugin.ts");
    assert.match(src, /state_copy_mismatch/, "사본 불일치 신호 필드가 없다");
    assert.match(src, /main_repo_done/, "main repo 사본 값을 보고하지 않는다");
    assert.match(src, /worktree_done/);
    // state_unreadable 이 이미 안내하는 원인을 already_done 도 알려야 한다.
    assert.match(src, /다른 cwd\(main repo\)에서 ?\n? *`?state\.json`? ?을 조작|다른 cwd\(main repo\)에서 /);
  });
});
