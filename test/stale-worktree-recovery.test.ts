import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeDir() {
  return mkdtempSync(join(tmpdir(), "stale-wt-"));
}

describe("needsWorktree — stale path detection (P0-1)", () => {
  test("existingWt 가 파일 시스템에 없으면 needsWorktree=true", () => {
    const nonExistent = "/tmp/definitely-does-not-exist-stale-wt-12345";
    const existingWt = nonExistent;
    const mainRepoPath = "/root/proj/repo";
    const effectiveCwd = "/root/proj/repo";

    const isWorktreeMissing = !existingWt || existingWt === "__MISSING__" || existingWt === "null";
    const isWorktreePathGone = Boolean(existingWt && !isWorktreeMissing && !existsSync(existingWt));
    const isWorktreePointingToMainRepo = existingWt === mainRepoPath || existingWt === effectiveCwd;
    const needsWorktree = isWorktreeMissing || isWorktreePathGone || isWorktreePointingToMainRepo;

    assert.equal(isWorktreePathGone, true, "존재하지 않는 경로는 pathGone=true");
    assert.equal(needsWorktree, true, "pathGone 이므로 needsWorktree=true");
  });

  test("existingWt 가 실제 존재하면 needsWorktree=false (정상 경로)", () => {
    const realDir = makeDir();
    try {
      const existingWt = realDir;
      const mainRepoPath = "/root/proj/repo";
      const effectiveCwd = "/root/proj/repo";

      const isWorktreeMissing = !existingWt || existingWt === "__MISSING__" || existingWt === "null";
      const isWorktreePathGone = Boolean(existingWt && !isWorktreeMissing && !existsSync(existingWt));
      const isWorktreePointingToMainRepo = existingWt === mainRepoPath || existingWt === effectiveCwd;
      const needsWorktree = isWorktreeMissing || isWorktreePathGone || isWorktreePointingToMainRepo;

      assert.equal(isWorktreePathGone, false, "존재하는 경로는 pathGone=false");
      assert.equal(needsWorktree, false, "정상 경로는 needsWorktree=false");
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  test("existingWt=null 문자열 → isWorktreeMissing=true (기존 동작 유지)", () => {
    const existingWt = "null";
    const isWorktreeMissing = !existingWt || existingWt === "__MISSING__" || existingWt === "null";
    assert.equal(isWorktreeMissing, true);
  });

  test("existingWt=__MISSING__ → isWorktreeMissing=true (기존 동작 유지)", () => {
    const existingWt = "__MISSING__";
    const isWorktreeMissing = !existingWt || existingWt === "__MISSING__" || existingWt === "null";
    assert.equal(isWorktreeMissing, true);
  });

  test("existingWt 가 mainRepo 와 같으면 needsWorktree=true (기존 동작 유지)", () => {
    const mainRepo = "/root/proj/repo";
    const existingWt = mainRepo;
    const isWorktreeMissing = !existingWt || existingWt === "__MISSING__" || existingWt === "null";
    const isWorktreePathGone = Boolean(existingWt && !isWorktreeMissing && !existsSync(existingWt));
    const isWorktreePointingToMainRepo = existingWt === mainRepo || existingWt === mainRepo;
    const needsWorktree = isWorktreeMissing || isWorktreePathGone || isWorktreePointingToMainRepo;
    assert.equal(needsWorktree, true, "mainRepo 와 같으면 needsWorktree=true");
  });
});

describe("runScriptCwd — ENOENT 구조화 (P1-2)", () => {
  test("존재하지 않는 cwd 에서 구조화된 error 반환", async () => {
    const nonExistent = "/tmp/runscript-no-such-dir-99999";

    const runScriptCwdSimulated = async (runCwd) => {
      if (!existsSync(runCwd)) {
        return { ok: false, code: -1, stdout: "", stderr: `worktree_path_missing: ${runCwd}` };
      }
      return { ok: true, code: 0, stdout: "ok", stderr: "" };
    };

    const result = await runScriptCwdSimulated(nonExistent);
    assert.equal(result.ok, false);
    assert.equal(result.code, -1);
    assert.ok(result.stderr.includes("worktree_path_missing"),
      "stderr 에 worktree_path_missing 포함");
  });

  test("존재하는 cwd 에서 정상 실행 경로 진입", async () => {
    const realDir = makeDir();
    try {
      const runScriptCwdSimulated = async (runCwd) => {
        if (!existsSync(runCwd)) {
          return { ok: false, code: -1, stdout: "", stderr: `worktree_path_missing: ${runCwd}` };
        }
        return { ok: true, code: 0, stdout: "ok", stderr: "" };
      };

      const result = await runScriptCwdSimulated(realDir);
      assert.equal(result.ok, true, "존재하는 cwd 는 정상 경로 진입");
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

describe("dispatch_stage worktree_missing early return (P1-1)", () => {
  test("storedWt 가 args.worktree 와 다르고 존재하지 않으면 early return 구조 검증", () => {
    const argsWorktree = "/root/proj/repo";
    const storedWt = "/root/proj/repo-PROJ-100";

    let earlyReturnPayload = null;

    if (storedWt && storedWt !== "null" && storedWt !== "" && storedWt !== argsWorktree) {
      if (!existsSync(storedWt)) {
        earlyReturnPayload = {
          ok: false,
          error: "worktree_missing",
          state_worktree: storedWt,
          reason: `state.json worktree "${storedWt}" 가 파일 시스템에 존재하지 않습니다.`,
          next_action: `auto_advance_stage(issue: "PROJ-100") 를 호출하면 worktree 를 자동 재생성합니다.`,
        };
      }
    }

    assert.ok(earlyReturnPayload !== null, "missing worktree 시 early return 발생해야 함");
    assert.equal(earlyReturnPayload.ok, false);
    assert.equal(earlyReturnPayload.error, "worktree_missing");
    assert.ok(earlyReturnPayload.next_action.includes("auto_advance_stage"),
      "next_action 에 auto_advance_stage 재호출 지시 포함");
    assert.ok(!earlyReturnPayload.next_action.includes("dispatch_stage 를 호출하지 마세요"),
      "team-leader 의 선택지를 막는 부정 지시 없어야 함");
  });

  test("storedWt 가 실제 존재하면 early return 없이 계속 진행", () => {
    const realDir = makeDir();
    try {
      const argsWorktree = "/root/proj/repo";
      const storedWt = realDir;

      let earlyReturnPayload = null;
      let effectiveWorktree = argsWorktree;

      if (storedWt && storedWt !== "null" && storedWt !== "" && storedWt !== argsWorktree) {
        if (!existsSync(storedWt)) {
          earlyReturnPayload = { ok: false, error: "worktree_missing" };
        } else {
          effectiveWorktree = storedWt;
        }
      }

      assert.equal(earlyReturnPayload, null, "존재하는 worktree 는 early return 없음");
      assert.equal(effectiveWorktree, realDir, "effectiveWorktree 가 storedWt 로 교체됨");
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

describe("next_action recovery instruction (P0-3)", () => {
  test("ENOENT 오류 시 next_action 에 auto_advance_stage 재호출 지시 포함", () => {
    const reason = "worktree_path_missing: /some/path";
    const issue = "PROJ-999";
    const isWorktreePathMissing = reason.includes("No such file or directory")
      || reason.includes("worktree_path_missing");

    const next_action = isWorktreePathMissing
      ? `Worktree 경로가 파일 시스템에 없습니다. auto_advance_stage(issue: "${issue}") 를 재호출하면 자동 재생성됩니다.`
      : `게이트 차단: ${reason}. 이 사유를 사용자에게 그대로 보고하고 dispatch_stage를 호출하지 마세요.`;

    assert.ok(next_action.includes("auto_advance_stage"),
      "recovery 지시에 auto_advance_stage 포함");
    assert.ok(!next_action.includes("dispatch_stage를 호출하지 마세요"),
      "team-leader 를 막는 부정 지시가 없어야 함");
  });

  test("일반 게이트 오류 시 기존 next_action 형식 유지", () => {
    const reason = "worktree 경로가 형제 디렉토리가 아님";
    const isWorktreePathMissing = reason.includes("No such file or directory")
      || reason.includes("worktree_path_missing");

    const next_action = isWorktreePathMissing
      ? `auto_advance_stage 재호출`
      : `게이트 차단: ${reason}. 이 사유를 사용자에게 그대로 보고하고 dispatch_stage를 호출하지 마세요.`;

    assert.ok(next_action.includes("게이트 차단"),
      "일반 게이트 오류는 기존 형식 유지");
  });
});
