// test/sync-state-commit-detection.test.mjs — PostToolUse 훅이 커밋 완료를
// **실제로 일어났을 때만** 기록하는지 고정한다.
//
// ── 결함 ──
// `src/hooks/sync-state.sh` 는 명령 문자열만 보고 done 을 세웠다:
//
//     if printf '%s' "$CMD" | grep -qE 'git(\s+\S+)*\s+commit(\s|$)'; then
//       S '.stages."3_delivery".substages."commit".done' 'true'
//     fi
//
// 출력(`$OUT`)은 인자로 받으면서 한 번도 보지 않는다. 그래서 아래가 전부 done 을
// 세웠다 (전부 실측 확인):
//   - 실패한 `git commit` (staged 없음 · 훅 거부 · 메시지 형식 위반)
//   - `git commit --dry-run`
//   - `echo "git commit 하는 법"` — 명령이 아니라 **문자열 안의 언급**
//
// 왜 심각한가: `3_delivery.commit.done=true` 는 dispatch_stage 의 "이미 done →
// 재-dispatch 차단" 가드를 발동시킨다. 즉 **실패한 커밋이 그 단계로의 재진입을
// 영구히 막는다** — 사람이 state.json 을 손대야 풀리는 정지다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const HOOK = join(REPO, "src", "hooks", "sync-state.sh");
const STATE_SH = join(REPO, "scripts", "state.sh");

const DONE_PATH = '.stages."3_delivery".substages."commit".done';

function freshRepo() {
  const wt = mkdtempSync(join(tmpdir(), "makdoong2-sync-"));
  spawnSync("git", ["init", "-q"], { cwd: wt });
  spawnSync("bash", [STATE_SH, "init", "PROJ-1"], { cwd: wt });
  return wt;
}

function runHook(wt, cmd, out) {
  spawnSync("bash", [HOOK, cmd, out, "PROJ-1"], { cwd: wt, encoding: "utf8" });
  const r = spawnSync("bash", [STATE_SH, "get", "PROJ-1", DONE_PATH], {
    cwd: wt, encoding: "utf8",
  });
  return (r.stdout || "").trim();
}

/** git 이 커밋 성공 시 찍는 확인 줄. 브랜치 표기는 번역되지만 구조는 고정이다. */
const SUCCESS_OUT = "[master (최상위-커밋) 7461bcb] Feat: PROJ-1 - 테스트\n 1 file changed, 1 insertion(+)";

describe("sync-state.sh — 커밋 완료 기록은 성공했을 때만", () => {
  test("성공한 커밋은 done=true 로 기록한다", () => {
    const wt = freshRepo();
    assert.equal(runHook(wt, 'git commit -m "Feat: PROJ-1 - 테스트"', SUCCESS_OUT), "true");
  });

  test("실패한 커밋은 기록하지 않는다", () => {
    const wt = freshRepo();
    const failOut = "현재 브랜치 master\n추적하지 않는 파일:\n  a.txt";
    assert.equal(runHook(wt, 'git commit -m "x"', failOut), "false",
      "실패한 커밋이 done 을 세우면 그 단계로 재진입할 수 없게 된다");
  });

  test("--dry-run 은 기록하지 않는다", () => {
    const wt = freshRepo();
    assert.equal(runHook(wt, "git commit --dry-run", "[master abc1234] x"), "false");
  });

  test("문자열 안의 언급은 명령이 아니다", () => {
    const wt = freshRepo();
    for (const cmd of [
      'echo "git commit 하는 법"',
      `grep -rn 'git commit' docs/`,
      'printf "%s" "먼저 git commit 을 실행하세요"',
    ]) {
      assert.equal(runHook(freshRepo(), cmd, ""), "false", cmd);
    }
    assert.equal(runHook(wt, 'echo "git commit"', ""), "false");
  });

  test("출력이 비어 있으면 기록하지 않는다 (fail-closed)", () => {
    // 권위 있는 기록은 publisher 의 명시적 state.sh set 이고
    // stage6-post-commit-verify.sh 가 최종 검증한다. 이 훅은 보조일 뿐이라
    // 확신이 없으면 기록하지 않는 쪽이 옳다.
    const wt = freshRepo();
    assert.equal(runHook(wt, 'git commit -m "Feat: PROJ-1 - 테스트"', ""), "false");
  });

  test("`git -C <path> commit` 형태도 인식한다", () => {
    const wt = freshRepo();
    assert.equal(runHook(wt, 'git -C /w commit -m "Feat: PROJ-1 - x"', SUCCESS_OUT), "true");
  });

  test("훅 소스가 출력을 실제로 검사한다", () => {
    const src = spawnSync("cat", [HOOK], { encoding: "utf8" }).stdout;
    const active = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.match(active, /\$OUT/, "출력을 보지 않으면 성공 여부를 알 수 없다");
    assert.match(active, /dry-run/, "--dry-run 제외가 없다");
  });
});
