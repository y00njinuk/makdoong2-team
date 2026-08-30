// test/gate-missing-state-sentinel.test.mjs — 게이트가 "state.json 부재/손상" 을
// 실제로 감지하는지 고정한다.
//
// ── 결함 ──
// 게이트들은 상태를 이렇게 읽었다:
//
//     q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }
//
// 그런데 `state.sh get` 은 실패해도 **stdout 에 "null" 한 줄을 찍고 exit 1** 한다
// (게이트들이 의존하는 명시적 계약이다). 따라서 `|| echo "__MISSING__"` 은 그 위에
// 한 줄을 덧붙일 뿐이고, 명령 치환 결과는 `"null\n__MISSING__"` 두 줄이 된다.
//
// 그 값은 `[ "$X" = "null" ]` 에도 `[ "$X" = "__MISSING__" ]` 에도 걸리지 않는다.
// 즉 **부재/손상이 "값이 있음" 으로 통과**했고, 게이트는 쓰레기 값을 그대로 들고
// 다음 검사로 넘어가 엉뚱한 진단을 내렸다. 12개 게이트가 같은 한 줄을 복제하고
// 있었으므로 전부 같은 상태였다.
//
// `stage-analysis-verify.sh` 는 `|| echo ""` 변형이라 결과가 `"null"` 이 되고,
// `[ -n "$(q '.issue')" ]` 존재 검사가 **항상 참**이었다 — state.json 이 없어도
// 통과한 뒤 "1_planning.scope 미완료 (done=null)" 로 차단됐다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const GATES = join(REPO, "gates");

function emptyRepo() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-sentinel-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}

const runGate = (gate, wt, ...args) =>
  spawnSync("bash", [join(GATES, gate), ...args], { cwd: wt, encoding: "utf8" });

describe("q() 헬퍼 — 실패 시 sentinel 하나만 낸다", () => {
  test("state.json 이 없을 때 q() 가 정확히 '__MISSING__' 을 낸다", () => {
    const wt = emptyRepo();
    const script = `
      HERE="${GATES}"
      ISSUE="PROJ-1"
      q(){ local __v; if __v="$("$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null)"; then printf "%s" "$__v"; else printf "__MISSING__"; fi; }
      printf '[%s]' "$(q '.a')"
    `;
    const r = spawnSync("bash", ["-c", script], { cwd: wt, encoding: "utf8" });
    assert.equal(r.stdout, "[__MISSING__]");
  });

  test("종전 관용구는 두 줄을 내어 어느 비교에도 걸리지 않았다 — 회귀 기준선", () => {
    const wt = emptyRepo();
    const script = `
      HERE="${GATES}"
      ISSUE="PROJ-1"
      q(){ "$HERE/../scripts/state.sh" get "$ISSUE" "$1" 2>/dev/null || echo "__MISSING__"; }
      V="$(q '.a')"
      [ "$V" = "null" ] && echo "MATCHED_NULL"
      [ "$V" = "__MISSING__" ] && echo "MATCHED_SENTINEL"
      printf '[%s]' "$V"
    `;
    const r = spawnSync("bash", ["-c", script], { cwd: wt, encoding: "utf8" });
    assert.doesNotMatch(r.stdout, /MATCHED_NULL/, "이 케이스가 매치되면 결함이 재현되지 않은 것");
    assert.doesNotMatch(r.stdout, /MATCHED_SENTINEL/);
    assert.match(r.stdout, /\[null\n__MISSING__\]/, "두 줄이 나와야 결함이 재현된 것");
  });

  test("모든 게이트의 q() 정의가 동일하다 (12곳 복제)", () => {
    const defs = new Map();
    for (const f of readdirSync(GATES).filter((n) => n.endsWith(".sh"))) {
      const src = readFileSync(join(GATES, f), "utf8");
      const noComments = src.replace(/^\s*#.*$/gm, "");
      // q() **함수 정의**가 있는 게이트만 본다 (주석 안의 언급은 제외).
      if (!/^\s*q\(\)\s*\{/m.test(noComments)) continue;
      // 옛 관용구가 남아 있으면 실패
      assert.doesNotMatch(
        noComments,
        /\|\|\s*echo\s+"(__MISSING__|)"/,
        `${f}: 종전 관용구가 남아 있다 (실패 출력에 sentinel 을 덧붙이는 형태)`,
      );
      defs.set(f, /if\s+__v=/.test(src));
    }
    const bad = [...defs.entries()].filter(([, ok]) => !ok).map(([f]) => f);
    assert.deepEqual(bad, [], "q() 가 성공 출력만 취하는 if 형태가 아니다");
    assert.ok(defs.size >= 11, `q() 게이트를 ${defs.size}개만 찾았다 — 12곳 근처여야 한다`);
  });
});

describe("게이트가 state.json 부재를 정확히 진단한다", () => {
  const CASES = [
    ["stage-analysis-verify.sh", /state\.json 없음|판독 불가/],
    ["stage4-dev-verify.sh", /state\.json 없음/],
  ];

  for (const [gate, expected] of CASES) {
    test(`${gate} — 부재를 다른 원인으로 오진하지 않는다`, () => {
      const wt = emptyRepo();
      const r = runGate(gate, wt, "PROJ-1");
      assert.notEqual(r.status, 0, "차단되어야 한다");
      assert.match(r.stderr, expected, `실제 출력: ${r.stderr.trim()}`);
      assert.doesNotMatch(
        r.stderr, /scope 미완료/,
        "부재를 'scope 미완료' 로 오진하면 복구 방향이 어긋난다",
      );
    });
  }
});

describe("HITL 승인 게이트의 fail-open/closed 방향", () => {
  test("네 게이트 모두 `!= \"true\"` (미설정이면 사람 승인 필요)", () => {
    // `state.sh init` 은 `"policy": null` 을 심는다. 따라서 `= "false"` 로 쓰면
    // 기본 상태에서 HITL 블록 전체가 건너뛰어진다 — commit 게이트만 그랬고,
    // 하필 가장 중대한 단계(커밋 생성)였다.
    const files = [
      "stage3-scope-verify.sh",
      "stage4-dev-verify.sh",
      "stage6-commit-verify.sh",
      "stage8-review-verify.sh",
    ];
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(join(GATES, f), "utf8");
      const lines = src.split("\n").filter(
        (l) => !/^\s*#/.test(l) && /auto_approve/.test(l) && /^\s*if\s+\[/.test(l),
      );
      assert.equal(lines.length, 1, `${f}: auto_approve 분기를 정확히 하나 기대했다`);
      if (!/!=\s*"true"/.test(lines[0])) offenders.push(`${f}: ${lines[0].trim()}`);
    }
    assert.deepEqual(offenders, [], "미설정(null)에서 승인 게이트가 꺼지는 방향이다");
  });

  test("기본 state 의 .policy 는 null 이다 (위 방향이 중요한 이유)", () => {
    const wt = emptyRepo();
    spawnSync("bash", [join(REPO, "scripts", "state.sh"), "init", "PROJ-1"], { cwd: wt });
    const state = JSON.parse(
      readFileSync(join(wt, ".makdoong2-team", "PROJ-1", "state.json"), "utf8"),
    );
    assert.equal(state.policy, null);
  });
});
