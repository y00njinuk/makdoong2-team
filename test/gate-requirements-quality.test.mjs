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
      assert.match(r.stderr, /마커는 있으나 파일이 없다/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("gate — draft_path 마커 누락 진단 (issue #6-①)", () => {
  // 게이트는 spec_hash 가 있으면 draft_path 마커를 하드 요구하는데, 종전 메시지는
  // "확정 명세 파일 없음" 하나로 뭉뚱그려서 파일은 멀쩡히 있고 마커만 빠진 흔한
  // 경우에 무엇을 해야 하는지 알 수 없었다. 실제로 워크플로우가 여기서 정지했다.
  test("마커만 없고 파일은 있으면 — 파일 존재를 알리고 복구 3단계를 제시한다", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-D1");
      const rel = makeDraft(wt, "TEST-D1", "spec body\n");
      stateSh(wt, "set", "TEST-D1", `${REQ}.spec_hash`, `"${sha256Of(wt, rel)}"`);
      // draft_path 는 기록하지 않는다 — #6-① 의 상태 그대로.
      const r = verifyScope(wt, "TEST-D1");
      assert.notEqual(r.code, 0, "draft_path 마커가 없으면 차단되어야 한다");
      assert.match(r.stderr, /draft_path 마커가 없다/);
      assert.match(r.stderr, /파일은 .*requirements-draft\.md 에 있다/);
      assert.match(r.stderr, /sha256sum/, "해시 대조 절차를 제시해야 한다");
      assert.match(r.stderr, /state\.sh set/, "마커 기록 명령을 제시해야 한다");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("마커도 파일도 없으면 — 재작업을 지시한다 (복구 절차가 아니라)", () => {
    const wt = makeWorktree();
    try {
      setupRequirementsDone(wt, "TEST-D2");
      stateSh(wt, "set", "TEST-D2", `${REQ}.spec_hash`, '"deadbeef"');
      const r = verifyScope(wt, "TEST-D2");
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /draft_path 마커도 확정 명세 파일도 없다/);
      assert.match(r.stderr, /재작업/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

});

describe("스펙 정합 — draft_path 는 게이트·self_check·verifier 세 곳에 모두 있어야 한다 (issue #6-①)", () => {
  // 세 곳 중 하나만 빠지면 substage 가 done=true + VERIFIED 로 끝난 뒤 다음 게이트가
  // 하드 차단하는 정지가 재현된다. 한 곳만 고치는 수정을 막기 위한 테스트다.
  const gate = readFileSync(join(REPO_ROOT, "gates/stage3-scope-verify.sh"), "utf8");
  const stageSpec = readFileSync(join(REPO_ROOT, "stages/02-requirements.md"), "utf8");
  const verifier = readFileSync(join(REPO_ROOT, "agents/makdoong2-verifier.md"), "utf8");

  test("게이트가 draft_path 를 요구한다", () => {
    assert.match(gate, /draft_path/);
  });

  test("stage spec 의 self_check 이 draft_recorded 를 포함한다", () => {
    assert.match(stageSpec, /"draft_recorded":\s*true/, "self_check JSON 에 draft_recorded 가 없다");
    assert.match(stageSpec, /\|\s*9\s*\|.*draft_path/, "자가검증 표에 draft_path 행이 없다");
    // 항목 수 문구와 표 행 수가 어긋나면 planner 가 표를 끝까지 읽지 않는다.
    assert.match(stageSpec, /다음 9항목을 자체 확인/);
  });

  test("verifier 가 파일 존재가 아니라 마커를 검사한다", () => {
    assert.match(verifier, /2-4\. 1_planning\.requirements 전용: draft_path 마커 재검증/);
    assert.match(verifier, /requirements\.draft_path_missing/);
    // "requirements-draft.md 존재" 만 보던 종전 기준이 남아 있으면 마커 누락을 통과시킨다.
    assert.ok(
      !/`requirements`: `done=true`.*`requirements-draft\.md` 존재/.test(verifier),
      "파일 존재만 보는 종전 기준이 남아 있다",
    );
  });
});

describe("스펙 정합 — 통합 경로(01-planning)와 분리 경로(02-requirements)가 같은 마커를 남긴다", () => {
  // 두 파일은 같은 substage(`1_planning.requirements`)의 스펙이다:
  //   STAGE_SPEC_FILES["1_planning.jira"]         = 01-planning.md  (3 substage 통합 처리)
  //   STAGE_SPEC_FILES["1_planning.requirements"] = 02-requirements.md
  //
  // stage3-scope-verify.sh 의 품질 게이트(ambiguity_score ≤ 0.2, spec_hash 동결)는
  // **마커가 있을 때만** 검사하는 조건부 검사다(구형 state 호환). 그래서 통합 경로가
  // 마커를 남기지 않으면 그 경로에서만 품질 게이트가 통째로 사문화된다 — 같은
  // 워크플로우인데 어느 스펙을 탔느냐에 따라 검증 강도가 달라지는 비대칭이 생긴다.
  const combined = readFileSync(join(REPO_ROOT, "stages/01-planning.md"), "utf8");
  const split = readFileSync(join(REPO_ROOT, "stages/02-requirements.md"), "utf8");
  const gate = readFileSync(join(REPO_ROOT, "gates/stage3-scope-verify.sh"), "utf8");

  const MARKERS = ["draft_path", "ambiguity_score", "spec_hash"];

  for (const marker of MARKERS) {
    test(`게이트가 보는 '${marker}' 를 두 스펙 모두 기록한다`, () => {
      assert.match(gate, new RegExp(marker), `게이트가 ${marker} 를 안 본다면 이 테스트가 낡았다`);
      const setRe = new RegExp(`state\\.sh set[\\s\\S]{0,200}${marker}`);
      assert.match(split, setRe, `02-requirements.md 가 ${marker} 를 기록하지 않는다`);
      assert.match(combined, setRe, `01-planning.md 가 ${marker} 를 기록하지 않는다`);
    });
  }

  test("통합 경로의 self_check 이 품질 마커 3종을 선언한다", () => {
    const m = /"requirements"\.self_check'[\s\S]{0,80}?'(\{[^']*\})'/.exec(combined);
    assert.ok(m, "01-planning.md 에서 requirements self_check JSON 을 찾지 못했다");
    const selfCheck = JSON.parse(m[1]);
    for (const key of ["ambiguity_scored", "spec_frozen", "draft_recorded"]) {
      assert.equal(selfCheck[key], true, `self_check 에 ${key} 가 없다`);
    }
  });

  test("마커를 중복 기록하지 않는다 (같은 값을 두 번 쓰면 어느 쪽이 정본인지 모호해진다)", () => {
    // `set` 만 센다. §2-5b 의 확인용 `get` 은 정상이므로 세지 않는다.
    const setCount = (marker, text) =>
      (text.match(new RegExp(`state\\.sh set[^\\n]*(\\\\\\n\\s*)?'\\.stages\\."1_planning"\\.substages\\."requirements"\\.${marker}'`, "g")) ?? []).length;
    for (const marker of MARKERS) {
      const n = setCount(marker, combined);
      assert.equal(n, 1, `01-planning.md 의 ${marker} set 이 ${n}회 — 정확히 1회여야 한다`);
    }
  });
});
