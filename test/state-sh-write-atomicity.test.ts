// test/state-sh-write-atomicity.test.ts — state.sh 쓰기가 조용히 실패하지 않음을 고정한다.
//
// 결함(수정 전): set/append/migrate 가 전부 아래 형태였다.
//
//     tmp="$(mktemp)"; jq "$Q = $V" "$P" > "$tmp" && mv "$tmp" "$P"
//     echo "state[$ISSUE] $Q = $V"
//
// bash 의 errexit 는 `&&` 리스트의 왼쪽 피연산자 실패를 면제한다. 따라서
// state.json 이 없거나 값이 잘못된 JSON 이면 jq 가 죽어도 스크립트는 계속
// 진행해 **성공 메시지를 찍고 exit 0** 했다. 게이트·서브에이전트는 마커가
// 기록됐다고 믿고 넘어가지만 파일은 그대로 — 다음 게이트가 "마커 없음" 으로
// 하드 차단하는 issue #6-① 부류의 구조적 정지가 여기서 재생산된다.
//
// state.json 쓰기는 state.sh 를 통해서만 가능하다는 하드룰이 있으므로, 이 한
// 지점의 무성 실패는 워크플로우 전체의 마커 기록을 신뢰할 수 없게 만든다.
//
// 부수 결함: mktemp 가 $TMPDIR(보통 /tmp)에 파일을 만들고 저장소로 mv 했다.
// Ubuntu 24.04+ 의 /tmp 는 tmpfs 이고 WSL2 는 저장소가 /mnt/c 일 수 있어
// 파일시스템이 갈리면 mv 가 rename(2) 이 아니라 copy+unlink 가 된다 — 중간에
// 죽으면 state.json 이 잘린 채 남는다. 임시 파일을 대상과 같은 디렉터리에
// 만들어 해소했고, 아래 마지막 케이스가 그 위치를 고정한다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_SH = resolve(HERE, "..", "scripts", "state.sh");

function makeWorktree() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-atomic-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}

function stateSh(wt, ...args) {
  const r = spawnSync("bash", [STATE_SH, ...args], { cwd: wt, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

const statePath = (wt, issue) => join(wt, ".makdoong2-team", issue, "state.json");

describe("state.sh set/append — 실패는 큰 소리로 난다", () => {
  test("state.json 이 없으면 set 이 exit≠0 이고 성공 메시지를 찍지 않는다", () => {
    const wt = makeWorktree();
    const r = stateSh(wt, "set", "PROJ-1", '.stages."1_planning".substages."jira".done', "true");

    assert.notEqual(r.code, 0, "state.json 부재인데 exit 0 이면 호출자가 기록됐다고 오인한다");
    assert.doesNotMatch(r.stdout, /state\[PROJ-1\]/, "실패했는데 성공 메시지가 나갔다");
    assert.match(r.stderr, /state\.json 없음/);
    assert.match(r.stderr, /state\.sh init/, "복구 명령을 안내해야 한다");
  });

  test("값이 잘못된 JSON 이면 exit≠0 이고 state.json 은 무사하다", () => {
    const wt = makeWorktree();
    stateSh(wt, "init", "PROJ-1");
    const before = readFileSync(statePath(wt, "PROJ-1"), "utf8");

    // 'not-json' 은 jq 표현식으로도 JSON 리터럴로도 유효하지 않다.
    const r = stateSh(wt, "set", "PROJ-1", '.stages."1_planning".substages."jira".note', "not-json");

    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout, /state\[PROJ-1\]/);
    assert.equal(
      readFileSync(statePath(wt, "PROJ-1"), "utf8"), before,
      "실패한 쓰기가 state.json 을 건드렸다",
    );
    JSON.parse(readFileSync(statePath(wt, "PROJ-1"), "utf8")); // 여전히 유효 JSON
  });

  test("append 도 같은 계약을 지킨다", () => {
    const wt = makeWorktree();
    stateSh(wt, "init", "PROJ-1");
    const before = readFileSync(statePath(wt, "PROJ-1"), "utf8");

    const r = stateSh(wt, "append", "PROJ-1",
      '.stages."2_implementation".substages."dev".hang_history', "{oops");

    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout, /state\[PROJ-1\]/);
    assert.equal(readFileSync(statePath(wt, "PROJ-1"), "utf8"), before);
  });

  test("손상된 state.json 은 '부재' 와 구별해서 보고한다", () => {
    // state.sh status 가 exists/readable 을 나눈 것과 같은 이유다 — 부재는
    // init 으로 자동 복구할 수 있지만 손상은 에스컬레이션 대상이다.
    const wt = makeWorktree();
    stateSh(wt, "init", "PROJ-1");
    writeFileSync(statePath(wt, "PROJ-1"), "{ broken");

    const r = stateSh(wt, "set", "PROJ-1", ".a", "true");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /유효한 JSON 이 아니다/);
    assert.doesNotMatch(r.stderr, /state\.json 없음/, "손상을 부재로 오진하면 안 된다");
  });

  test("정상 경로는 그대로 동작한다 (set → get 왕복)", () => {
    const wt = makeWorktree();
    stateSh(wt, "init", "PROJ-1");

    const w = stateSh(wt, "set", "PROJ-1", '.stages."1_planning".substages."jira".done', "true");
    assert.equal(w.code, 0);
    assert.match(w.stdout, /state\[PROJ-1\]/);

    const r = stateSh(wt, "get", "PROJ-1", '.stages."1_planning".substages."jira".done');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "true");

    const a = stateSh(wt, "append", "PROJ-1",
      '.stages."2_implementation".substages."dev".hang_history', '{"at":"t1"}');
    assert.equal(a.code, 0);
    const got = stateSh(wt, "get", "PROJ-1",
      '.stages."2_implementation".substages."dev".hang_history');
    assert.deepEqual(JSON.parse(got.stdout), [{ at: "t1" }]);
  });

  test("실패해도 임시 파일이 남지 않는다", () => {
    const wt = makeWorktree();
    stateSh(wt, "init", "PROJ-1");
    stateSh(wt, "set", "PROJ-1", ".a", "not-json");

    const dir = dirname(statePath(wt, "PROJ-1"));
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(".state.json."));
    assert.deepEqual(leftovers, [], `임시 파일 잔존: ${leftovers.join(", ")}`);
  });

  test("임시 파일을 대상과 같은 디렉터리에 만든다 (크로스 디바이스 mv 방지)", () => {
    // TMPDIR 을 읽기 전용 경로로 몰아도 쓰기가 성공해야 한다 — 즉 mktemp 가
    // TMPDIR 을 쓰지 않는다는 뜻이다.
    const wt = makeWorktree();
    stateSh(wt, "init", "PROJ-1");

    const r = spawnSync("bash", [STATE_SH, "set", "PROJ-1", ".marker", '"ok"'], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: "/nonexistent-tmpdir-for-this-test" },
    });
    assert.equal(r.status, 0, `TMPDIR 이 없어도 성공해야 한다: ${r.stderr}`);
    assert.equal(JSON.parse(readFileSync(statePath(wt, "PROJ-1"), "utf8")).marker, "ok");
  });

  test("소스에 무성 실패 관용구 `… && mv` 가 남아 있지 않다", () => {
    // 새 쓰기 경로를 추가할 때 옛 관용구를 복사해 오는 것을 막는다.
    // 판별점은 리디렉션 자체가 아니라 **종료코드를 `&&` 로 삼키는 것**이다.
    // write_json_atomic 안의 `jq … > "${tmp}" || rc=$?` 는 명시적으로 받으므로
    // 이 패턴에 걸리지 않는다.
    const src = readFileSync(STATE_SH, "utf8");
    const offenders = src
      .split("\n")
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => !/^\s*#/.test(line) && /&&\s*mv\s/.test(line));
    assert.deepEqual(
      offenders.map((o) => `${o.n}: ${o.line.trim()}`), [],
      "`cmd > tmp && mv tmp target` 은 cmd 실패를 삼킨다 — write_json_atomic 을 쓸 것",
    );
  });

  test("write_json_atomic 이 jq 종료코드를 명시적으로 검사한다", () => {
    const src = readFileSync(STATE_SH, "utf8");
    assert.match(src, /write_json_atomic\(\)/, "헬퍼가 사라졌다");
    assert.match(src, /jq "\$@" "\$\{target\}" > "\$\{tmp\}" \|\| rc=\$\?/);
    assert.match(src, /mktemp "\$\{dir\}\//, "임시 파일은 대상과 같은 디렉터리에 만들어야 한다");
  });
});

describe("state.sh — 이슈 키 경로 검증", () => {
  test("경로 구분자·상위 참조가 든 이슈 키를 거부한다", () => {
    // 이슈 키는 LLM 이 만든 값일 수 있고 그대로 경로에 들어간다. 검증이 없으면
    // 저장소 밖에 쓰거나 읽을 수 있었다.
    const wt = makeWorktree();
    for (const bad of ["../../etc", "a/b", "..", "x/../../y"]) {
      const r = stateSh(wt, "get", bad, ".a");
      assert.notEqual(r.code, 0, `허용됨: ${bad}`);
      assert.match(r.stderr, /이슈 키에/, bad);
    }
  });

  test("정상 이슈 키는 그대로 동작한다", () => {
    const wt = makeWorktree();
    for (const ok of ["PROJ-1", "PROJ-40406", "ABC-123"]) {
      assert.equal(stateSh(wt, "init", ok).code, 0, ok);
    }
  });
});
