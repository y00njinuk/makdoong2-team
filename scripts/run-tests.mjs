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
// 종료 코드: 실패 단계가 하나라도 있으면 1.

import { spawnSync } from "node:child_process";

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
  "node --test test/example-config-portability.test.mjs"
];

const results = [];
for (const [i, step] of STEPS.entries()) {
  const [cmd, ...args] = step.split(" ");
  process.stdout.write(`\n\u001b[36m[${String(i + 1).padStart(2)}/${STEPS.length}]\u001b[0m ${step}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  const code = r.status === null ? 1 : r.status;
  results.push({ step, code });
}

const failed = results.filter((r) => r.code !== 0);
process.stdout.write(`\n${"=".repeat(70)}\n`);
if (failed.length === 0) {
  process.stdout.write(`\u001b[32m[run-tests] ${results.length}개 단계 전부 통과\u001b[0m\n`);
  process.exit(0);
}
process.stdout.write(`\u001b[31m[run-tests] ${failed.length}/${results.length} 단계 실패:\u001b[0m\n`);
for (const f of failed) process.stdout.write(`  \u001b[31m\u2716\u001b[0m ${f.step}  (exit ${f.code})\n`);
process.exit(1);
