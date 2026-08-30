import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeVerdictHash } from "../dist/verdict-hash.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_SH = resolve(HERE, "..", "scripts", "state.sh");

function stateSh(cwd, ...args) {
  return spawnSync("bash", [STATE_SH, ...args], { cwd, encoding: "utf8" });
}
function makeWorktree() {
  const wt = mkdtempSync(join(tmpdir(), "verdict-injection-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  return wt;
}
function readState(wt, issue) {
  return JSON.parse(readFileSync(join(wt, ".makdoong2-team", issue, "state.json"), "utf8"));
}

function stagePathToStage(stagePath) {
  const m = stagePath.match(/\.stages\."([^"]+)"\.substages\."([^"]+)"/);
  return m ? `${m[1]}.${m[2]}` : "unknown.unknown";
}

function simulateVerifierRejection(wt, issue, stagePath, reasonRaw, prevHashArg, prevStreakArg, prevCountArg) {
  const reasonText = reasonRaw.trim().slice(0, 4000);
  const reasonHash = computeVerdictHash(reasonRaw, stagePathToStage(stagePath));
  const prevHash = prevHashArg ?? "";
  const prevStreak = prevStreakArg ?? 0;
  const prevCount = prevCountArg ?? 0;
  const newStreak = prevHash === reasonHash ? prevStreak + 1 : 1;
  const newCount = prevCount + 1;
  const nowIso = new Date().toISOString();
  stateSh(wt, "set", issue, `${stagePath}.last_verdict_reason`, JSON.stringify(reasonText));
  stateSh(wt, "set", issue, `${stagePath}.last_verdict_reason_hash`, JSON.stringify(reasonHash));
  stateSh(wt, "set", issue, `${stagePath}.last_verdict_at`, JSON.stringify(nowIso));
  stateSh(wt, "set", issue, `${stagePath}.same_reason_streak`, String(newStreak));
  stateSh(wt, "set", issue, `${stagePath}.rejected_count`, String(newCount));
  return { reasonHash, newStreak, newCount, streakExceeded: newStreak >= 5 };
}

describe("dispatch_verifier — REJECTED reason state.json 등록", () => {
  test("첫 REJECTED: reason·hash·streak=1·rejected_count=1 기록", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-100", wt);
      const raw = '<verifier-verdict>REJECTED</verifier-verdict>\n{"finding": "atomic_review.count_commits mismatch"}';
      const result = simulateVerifierRejection(wt, "PROJ-100", '.stages."3_delivery".substages."commit"', raw);
      const s = readState(wt, "PROJ-100");
      const commit = s.stages["3_delivery"].substages.commit;
      assert.equal(commit.last_verdict_reason_hash, result.reasonHash);
      assert.equal(commit.same_reason_streak, 1);
      assert.equal(commit.rejected_count, 1);
      assert.equal(result.streakExceeded, false);
      assert.match(commit.last_verdict_reason, /REJECTED/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("동일 사유 5회 연속 → same_reason_streak_exceeded=true", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-101", wt);
      const raw = '<verifier-verdict>REJECTED</verifier-verdict>\n{"finding": "identical failure"}';
      const stagePath = '.stages."3_delivery".substages."commit"';
      let prevHash = "";
      let prevStreak = 0;
      let prevCount = 0;
      let lastResult;
      for (let i = 1; i <= 5; i++) {
        lastResult = simulateVerifierRejection(wt, "PROJ-101", stagePath, raw, prevHash, prevStreak, prevCount);
        prevHash = lastResult.reasonHash;
        prevStreak = lastResult.newStreak;
        prevCount = lastResult.newCount;
        assert.equal(lastResult.newStreak, i, `iter ${i}: streak`);
        assert.equal(lastResult.newCount, i, `iter ${i}: count`);
      }
      assert.equal(lastResult.streakExceeded, true, "5회 도달 시 streakExceeded=true");
      const s = readState(wt, "PROJ-101");
      assert.equal(s.stages["3_delivery"].substages.commit.same_reason_streak, 5);
      assert.equal(s.stages["3_delivery"].substages.commit.rejected_count, 5);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("사유가 다르면 streak 이 1 로 리셋 (rejected_count 는 누적)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-102", wt);
      const stagePath = '.stages."3_delivery".substages."commit"';
      const raw1 = "<verifier-verdict>REJECTED</verifier-verdict>\n{finding: A}";
      const raw2 = "<verifier-verdict>REJECTED</verifier-verdict>\n{finding: B}";
      const r1 = simulateVerifierRejection(wt, "PROJ-102", stagePath, raw1);
      const r2 = simulateVerifierRejection(wt, "PROJ-102", stagePath, raw2, r1.reasonHash, r1.newStreak, r1.newCount);
      assert.equal(r2.newStreak, 1, "다른 hash → streak=1");
      assert.equal(r2.newCount, 2, "rejected_count 는 누적");
      assert.notEqual(r1.reasonHash, r2.reasonHash);
      assert.equal(r2.streakExceeded, false);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("VERIFIED 후 last_verdict_reason=null / streak=0 리셋", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-103", wt);
      const stagePath = '.stages."3_delivery".substages."commit"';
      simulateVerifierRejection(wt, "PROJ-103", stagePath, "REJECT");
      stateSh(wt, "set", "PROJ-103", `${stagePath}.last_verdict_reason`, "null");
      stateSh(wt, "set", "PROJ-103", `${stagePath}.last_verdict_reason_hash`, "null");
      stateSh(wt, "set", "PROJ-103", `${stagePath}.same_reason_streak`, "0");
      const s = readState(wt, "PROJ-103");
      const c = s.stages["3_delivery"].substages.commit;
      assert.equal(c.last_verdict_reason, null);
      assert.equal(c.last_verdict_reason_hash, null);
      assert.equal(c.same_reason_streak, 0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("특수문자 포함 reason 도 JSON.stringify 로 안전 저장 (quotes/newlines/backslash)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-104", wt);
      const stagePath = '.stages."3_delivery".substages."commit"';
      const tricky = 'REJECTED: "quoted" text\nwith newlines\nand \\backslash';
      simulateVerifierRejection(wt, "PROJ-104", stagePath, tricky);
      const s = readState(wt, "PROJ-104");
      const stored = s.stages["3_delivery"].substages.commit.last_verdict_reason;
      assert.equal(stored, tricky, "특수문자가 안전하게 라운드트립되어야 한다");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("dispatch_stage — last_verdict_reason 읽기 (state.sh get 계약)", () => {
  test("set/get 라운드트립: JSON.stringify 로 저장된 문자열이 raw 로 정확히 복원 (다중 라인·따옴표 포함)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-200", wt);
      const stagePath = '.stages."3_delivery".substages."commit"';
      const reason = 'REJECTED:\n"finding": {"item": "3_delivery.commit.multi_file_commit"}';
      stateSh(wt, "set", "PROJ-200", `${stagePath}.last_verdict_reason`, JSON.stringify(reason));
      const r = stateSh(wt, "get", "PROJ-200", `${stagePath}.last_verdict_reason`);
      assert.equal(r.status, 0, "set 된 값은 exit 0 으로 반환되어야 함");
      assert.equal(r.stdout.trimEnd(), reason);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("미기록 상태: stdout='null' 로 판정 (dispatch_stage 가 프롬프트 주입 skip)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-201", wt);
      const stagePath = '.stages."3_delivery".substages."commit"';
      const r = stateSh(wt, "get", "PROJ-201", `${stagePath}.last_verdict_reason`);
      assert.equal(r.status, 0,
        "state.sh get 은 성공적으로 평가된 모든 값(null 포함)에 대해 exit 0 반환 (post-PROJ-40406 contract)");
      assert.equal(r.stdout.trimEnd(), "null",
        "미기록 필드는 stdout='null' 로 반환 — opencode-plugin.ts 가 문자열 비교로 skip 판정");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("VERIFIED 후 null 재기록: stdout='null' 반환 (프롬프트 주입 skip)", () => {
    const wt = makeWorktree();
    try {
      stateSh(wt, "init", "PROJ-202", wt);
      const stagePath = '.stages."3_delivery".substages."commit"';
      stateSh(wt, "set", "PROJ-202", `${stagePath}.last_verdict_reason`, JSON.stringify("첫 REJECTED 사유"));
      stateSh(wt, "set", "PROJ-202", `${stagePath}.last_verdict_reason`, "null");
      const r = stateSh(wt, "get", "PROJ-202", `${stagePath}.last_verdict_reason`);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trimEnd(), "null",
        "null 재기록 후 stdout='null' — 소비자(opencode-plugin) 가 raw !== 'null' 체크로 injection skip");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
