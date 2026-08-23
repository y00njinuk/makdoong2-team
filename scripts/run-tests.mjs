#!/usr/bin/env node
// scripts/run-tests.mjs — 전체 테스트를 순차 실행하고 실패를 모아서 보고한다.
//
// 왜 `&&` 체인을 대체하는가:
//   기존 test:all 은 42개 단계를 `&&` 로 이어 붙였다. 앞 단계가 하나라도 실패하면
//   뒤 단계는 아예 실행되지 않는다. 실제로 tmux-monitor 실패가 그 뒤의
//   rollback-commits / worktree-sync-gate 실패를 오래 가려왔고, gate-policy-test 가
//   깨져 있던 동안에는 사실상 전 구간이 미실행 상태였다.
//
//   순차 실행은 유지한다 (병렬화하지 않는다). npm test 가 XDG_CONFIG_HOME 을 단일
//   임시 디렉토리로 고정하므로, 설치 계열 테스트를 동시에 돌리면 서로의 config 를
//   덮어써 경합이 난다.
//
// 2단계 구성:
//   1) 호스트 단계 — STEPS 를 순차 실행한다.
//   2) Linux 교차 검증 — 호스트가 Linux 가 아니면 같은 스위트를 Ubuntu 컨테이너에서
//      한 번 더 돌린다. 별도 명령을 기억할 필요 없이 npm test 만으로 두 플랫폼이
//      함께 검증된다.
//
// 호스트 단계를 컨테이너 실행으로 "대체" 하지 않는 이유: 실제로 잡힌 결함 중
// 하나(rollback-commits.sh 의 unbraced 변수)는 Darwin libc 에서만 재현된다.
// 컨테이너로 갈아타면 그 부류가 영구히 은폐된다. 두 번 돌려야 둘 다 잡힌다.
//
// 종료 코드: 실패 단계가 하나라도 있으면 1.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STEPS = [
  "bash scripts/lint-agent-prompts.sh",
  "node --test test/shell-portability.test.mjs",
  "node scripts/smoke-test.mjs",
  "bash scripts/gate-policy-test.sh",
  "node test/install-lib.test.mjs",
  "node test/skill-mcp-registry.test.mjs",
  "node --test test/state-write-guard.test.mjs",
  "node --test test/state-sh-schema.test.mjs",
  "node --test test/state-sh-init-review-shape.test.mjs",
  "node --test test/doctor-phantom-scan.test.mjs",
  "node --test test/mcp-secret-injector.test.mjs",
  "node --test test/poll-sub-session.test.mjs",
  "node --test test/tmux-monitor.test.mjs",
  "node --test test/gate-already-done-block.test.mjs",
  "node --test test/gate-hybrid-first-entry.test.mjs",
  "node --test test/gate-post-pr-verify.test.mjs",
  "node --test test/gate-post-review-verify.test.mjs",
  "node --test test/gate-requirements-quality.test.mjs",
  "node --test test/worktree-sync-gate.test.mjs",
  "node --test test/planner-prompt-early-exit.test.mjs",
  "node --test test/plugin-bug-fixes.test.mjs",
  "node --test test/omo-tmux-detection.test.mjs",
  "node --test test/empty-output-done-override.test.mjs",
  "node --test test/tmux-monitor-orphan.test.mjs",
  "node --test test/poll-permission-scope.test.mjs",
  "node --test test/dispatch-review-fixes.test.mjs",
  "node --test test/dispatch-stage-redispatch.test.mjs",
  "node --test test/dispatch-stage-dev-resume-prompt.test.mjs",
  "node --test test/logger.test.mjs",
  "node --test test/redact-secrets.test.mjs",
  "node --test test/commit-atomicity-verify.test.mjs",
  "node --test test/verdict-reason-injection.test.mjs",
  "node --test test/verdict-hash-normalize.test.mjs",
  "node --test test/session-index-fallback.test.mjs",
  "node --test test/plugin-exports-shape.test.mjs",
  "node --test test/stale-worktree-recovery.test.mjs",
  "node --test test/rollback-commits.test.mjs",
  "node --test test/config-dir-home-fallback.test.mjs",
  "node --test test/state-path-migration.test.mjs",
  "node --test test/state-path-relative.test.mjs",
  "node --test test/with-fallback-no-bun.test.mjs",
  "node --test test/doctor-exit-code.test.mjs",
  "node --test test/example-config-portability.test.mjs",
  "node --test test/research-fanout.test.mjs"
];

const CYAN = "\u001b[36m", GREEN = "\u001b[32m", RED = "\u001b[31m", YELLOW = "\u001b[33m", OFF = "\u001b[0m";
const say = (s) => process.stdout.write(s);

// ── 1단계: 호스트 ──
const results = [];
for (const [i, step] of STEPS.entries()) {
  const [cmd, ...args] = step.split(" ");
  say(`\n${CYAN}[${String(i + 1).padStart(2)}/${STEPS.length}]${OFF} ${step}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  results.push({ step, code: r.status === null ? 1 : r.status });
}

// ── 2단계: Linux 교차 검증 ──
/**
 * 컨테이너 교차 검증을 돌려야 하는지 판단한다.
 * @returns {{run: true} | {run: false, reason: string, loud: boolean}}
 */
function linuxCheckPlan() {
  // 컨테이너 안에서 다시 컨테이너를 띄우지 않는다 (무한 재귀 방지).
  if (process.env.MAKDOONG2_IN_TEST_CONTAINER === "1") {
    return { run: false, reason: "이미 테스트 컨테이너 안", loud: false };
  }
  // 호스트가 Linux 면 방금 돌린 것이 곧 Linux 결과다.
  if (process.platform === "linux") {
    return { run: false, reason: "호스트가 이미 Linux", loud: false };
  }
  if (process.env.MAKDOONG2_SKIP_LINUX_CHECK === "1") {
    return { run: false, reason: "MAKDOONG2_SKIP_LINUX_CHECK=1", loud: true };
  }
  if (!existsSync(join(REPO_ROOT, "Dockerfile.test"))) {
    return { run: false, reason: "Dockerfile.test 없음 (배포 tarball 등)", loud: false };
  }
  if (spawnSync("docker", ["--version"], { stdio: "ignore" }).status !== 0) {
    return { run: false, reason: "docker 없음 — Linux 전용 회귀를 놓칠 수 있다", loud: true };
  }
  return { run: true };
}

const plan = linuxCheckPlan();
let linuxResult = null;

if (plan.run) {
  say(`\n${CYAN}[linux]${OFF} Ubuntu 컨테이너에서 교차 검증 (${process.platform} 호스트)\n`);
  const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "test-ubuntu.sh")], { stdio: "inherit" });
  linuxResult = { step: "linux 교차 검증 (scripts/test-ubuntu.sh)", code: r.status === null ? 1 : r.status };
  results.push(linuxResult);
} else if (plan.loud) {
  say(`\n${YELLOW}[linux] 교차 검증 건너뜀 — ${plan.reason}${OFF}\n`);
}

// ── 요약 ──
const failed = results.filter((r) => r.code !== 0);
say(`\n${"=".repeat(70)}\n`);
if (failed.length === 0) {
  const suffix = linuxResult ? " (호스트 + Ubuntu 교차 검증)" : "";
  say(`${GREEN}[run-tests] ${results.length}개 단계 전부 통과${suffix}${OFF}\n`);
  process.exit(0);
}
say(`${RED}[run-tests] ${failed.length}/${results.length} 단계 실패:${OFF}\n`);
for (const f of failed) say(`  ${RED}\u2716${OFF} ${f.step}  (exit ${f.code})\n`);
process.exit(1);
