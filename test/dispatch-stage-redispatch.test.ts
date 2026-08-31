/**
 * Regression tests for message-stall auto-redispatch in dispatch_stage
 * (introduced alongside pollSubSession messageStallThresholdMs).
 *
 * The plugin's dispatch_stage retry loop cannot be exercised in isolation
 * (it depends on the live opencode server), so these tests cover the pure
 * pieces the loop derives from `attempt`:
 *   1. Exponential backoff array shape and per-attempt lookup semantics.
 *   2. Resume prompt injection — attempts > 1 must include the state.json
 *      resume instructions so the fresh sub-session skips completed markers.
 *   3. MAX_ATTEMPTS=3 loop upper bound.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldEscalateStall } from "../dist/stall-escalation.js";
import { DEFAULT_STALL_ESCALATE_THRESHOLD } from "../dist/config.js";

const MAX_ATTEMPTS = 3;
const MAX_FALLBACK_ATTEMPTS = 2;
const MESSAGE_STALL_BACKOFF_MS = [300_000, 600_000, 1_200_000];
const VERIFIER_STALL_THRESHOLD_MS = MESSAGE_STALL_BACKOFF_MS[MESSAGE_STALL_BACKOFF_MS.length - 1];

function pickBackoff(attempt) {
  return MESSAGE_STALL_BACKOFF_MS[Math.min(attempt - 1, MESSAGE_STALL_BACKOFF_MS.length - 1)];
}

function buildResumePromptText({ attempt, priorSessionIds, issue, scriptsDir, workingDir, specPath }) {
  const base = [
    `Working directory (ABSOLUTE): ${workingDir}`,
    `Scripts directory (ABSOLUTE): ${scriptsDir}`,
    `Issue: ${issue}`,
    `Stage spec: read ${specPath} and follow it strictly.`,
  ];
  if (attempt > 1) {
    base.push(
      `\n=== 재개(resume) 지시 — 이전 세션 중단됨 ===`,
      `이전 세션 ID: ${priorSessionIds.join(", ")} (attempt ${attempt - 1})`,
      `중단 원인: 이전 sub-session이 stall/gone 감지되어 새 세션으로 이어서 진행합니다.`,
      `첫 번째 필수 작업:`,
      `  1) bash ${scriptsDir}/state.sh get ${issue} '.' 로 현재 상태 전량 조회`,
      `  2) 이미 done=true 로 기록된 substage / 마커는 재실행하지 말고 skip`,
      `  3) 미완료 substage 부터 stage spec 순서대로 이어서 진행`,
    );
  }
  return base.join("\n");
}

describe("dispatch_stage — message-stall exponential backoff array", () => {
  test("MESSAGE_STALL_BACKOFF_MS follows 5min → 10min → 20min (base=5min, mult=2)", () => {
    assert.deepEqual(MESSAGE_STALL_BACKOFF_MS, [300_000, 600_000, 1_200_000]);
    assert.equal(MESSAGE_STALL_BACKOFF_MS[1] / MESSAGE_STALL_BACKOFF_MS[0], 2);
    assert.equal(MESSAGE_STALL_BACKOFF_MS[2] / MESSAGE_STALL_BACKOFF_MS[1], 2);
  });

  test("attempt 1 uses first backoff (300s = 5min)", () => {
    assert.equal(pickBackoff(1), 300_000);
  });

  test("attempt 2 uses second backoff (600s = 10min)", () => {
    assert.equal(pickBackoff(2), 600_000);
  });

  test("attempt 3 uses third backoff (1200s = 20min)", () => {
    assert.equal(pickBackoff(3), 1_200_000);
  });

  test("attempt beyond MAX_ATTEMPTS clamps to last backoff (defensive)", () => {
    assert.equal(pickBackoff(4), 1_200_000);
    assert.equal(pickBackoff(99), 1_200_000);
  });

  test("MAX_ATTEMPTS matches backoff array length (exactly 3 tries)", () => {
    assert.equal(MAX_ATTEMPTS, 3);
    assert.equal(MESSAGE_STALL_BACKOFF_MS.length, MAX_ATTEMPTS);
  });

  test("verifier single-attempt uses the max backoff value (20min)", () => {
    assert.equal(VERIFIER_STALL_THRESHOLD_MS, 1_200_000);
    assert.equal(VERIFIER_STALL_THRESHOLD_MS,
      MESSAGE_STALL_BACKOFF_MS[MESSAGE_STALL_BACKOFF_MS.length - 1]);
  });
});

describe("dispatch_stage — resume prompt on retry", () => {
  const common = {
    issue: "PROJ-40406",
    scriptsDir: "/opt/mkd2/scripts",
    workingDir: "/root/wt",
    specPath: "/opt/mkd2/stages/04-dev.md",
  };

  test("attempt=1 → prompt has NO resume instructions", () => {
    const text = buildResumePromptText({ ...common, attempt: 1, priorSessionIds: [] });
    assert.doesNotMatch(text, /재개\(resume\)/);
    assert.doesNotMatch(text, /이전 세션 ID/);
    assert.doesNotMatch(text, /state\.sh get/);
  });

  test("attempt=2 → prompt includes resume block with prior session id", () => {
    const text = buildResumePromptText({
      ...common,
      attempt: 2,
      priorSessionIds: ["ses_first_attempt"],
    });
    assert.match(text, /재개\(resume\) 지시/);
    assert.match(text, /이전 세션 ID: ses_first_attempt/);
    assert.match(text, /attempt 1/);
    assert.match(text, /state\.sh get PROJ-40406 '\.'/);
    assert.match(text, /done=true 로 기록된 substage/);
    assert.match(text, /미완료 substage 부터/);
  });

  test("attempt=3 → prompt lists all prior session ids joined by comma", () => {
    const text = buildResumePromptText({
      ...common,
      attempt: 3,
      priorSessionIds: ["ses_first", "ses_second"],
    });
    assert.match(text, /이전 세션 ID: ses_first, ses_second/);
    assert.match(text, /attempt 2/);
  });

  test("resume block references correct SCRIPTS_DIR (no hardcoded paths)", () => {
    const text = buildResumePromptText({
      ...common,
      attempt: 2,
      priorSessionIds: ["ses_x"],
      scriptsDir: "/custom/path/scripts",
    });
    assert.match(text, /bash \/custom\/path\/scripts\/state\.sh/);
    assert.doesNotMatch(text, /\/opt\/mkd2\/scripts\/state\.sh/);
  });

  test("resume block references correct issue key", () => {
    const text = buildResumePromptText({
      ...common,
      attempt: 2,
      priorSessionIds: ["ses_x"],
      issue: "PROJ-99999",
    });
    assert.match(text, /state\.sh get PROJ-99999/);
    assert.doesNotMatch(text, /PROJ-40406/);
  });
});

describe("dispatch_stage — retry termination invariants", () => {
  test("loop guard `attempt < MAX_ATTEMPTS` allows exactly 3 iterations from attempt=0", () => {
    const iterationsSeen = [];
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      iterationsSeen.push(attempt);
    }
    assert.deepEqual(iterationsSeen, [1, 2, 3]);
  });

  test("session_gone at attempt=1,2 → continue; at attempt=3 → final failure", () => {
    let attempt = 0;
    let finalized = null;
    while (attempt < MAX_ATTEMPTS && finalized === null) {
      attempt++;
      const gone = true;
      if (gone) {
        if (attempt < MAX_ATTEMPTS) {
          continue;
        }
        finalized = { kind: "final_failure", attempts: attempt };
      }
    }
    assert.deepEqual(finalized, { kind: "final_failure", attempts: 3 });
  });
});

/**
 * PROJ-40406 fix — fallback_model auto-switch after MAX_ATTEMPTS on primary.
 *
 * The real dispatch_stage loop depends on the opencode server so we simulate
 * only the retry-budget/switch decision math. Contract mirrored:
 *   - primary uses MAX_ATTEMPTS(3), fallback uses MAX_FALLBACK_ATTEMPTS(2)
 *   - switch requires: activeFallbackDepth === 0 && !isMessageStall && !userOverride
 *   - after switch, attempt resets to 0 and only 2 additional attempts allowed
 *   - switch happens at most once (activeFallbackDepth 0 → 1)
 */
function simulateDispatchLoop({
  outcomeSequence,
  userOverride = null,
  primaryModel = "local/qwen3.6-27b",
  fallbackModel = "anthropic/claude-haiku-4-5",
}) {
  const events = [];
  let attempt = 0;
  let activeFallbackDepth = 0;
  let activeModel = userOverride ?? primaryModel;
  let finalized = null;
  let outcomeIdx = 0;

  const maxAttemptsForCurrentModel = () =>
    activeFallbackDepth === 0 ? MAX_ATTEMPTS : MAX_FALLBACK_ATTEMPTS;

  while (attempt < maxAttemptsForCurrentModel() && finalized === null) {
    attempt++;
    const outcome = outcomeSequence[outcomeIdx++] ?? { kind: "session_gone", reason: "status_absent" };
    events.push({ attempt, activeFallbackDepth, activeModel, outcome_kind: outcome.kind, gone_reason: outcome.reason });

    if (outcome.kind === "text") {
      finalized = { ok: true, model: activeModel, attempts: attempt, fallback_depth: activeFallbackDepth };
      break;
    }
    if (outcome.kind === "session_gone") {
      const isMessageStall = outcome.reason === "message_stall";
      if (attempt < maxAttemptsForCurrentModel()) continue;

      if (
        activeFallbackDepth === 0 &&
        !isMessageStall &&
        !userOverride
      ) {
        activeModel = fallbackModel;
        activeFallbackDepth = 1;
        attempt = 0;
        events.push({ type: "FALLBACK_SWITCH", to: fallbackModel });
        continue;
      }
      finalized = {
        ok: false,
        model: activeModel,
        attempts: attempt,
        fallback_depth: activeFallbackDepth,
        gone_reason: isMessageStall ? "message_stall" : "status_absent",
      };
    }
  }
  return { events, finalized };
}

describe("dispatch_stage — fallback model auto-switch", () => {
  test("primary status_absent x3 → FALLBACK_SWITCH → fallback status_absent x2 → terminal failure", () => {
    const { events, finalized } = simulateDispatchLoop({
      outcomeSequence: [
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
      ],
    });
    const switches = events.filter(e => e.type === "FALLBACK_SWITCH");
    assert.equal(switches.length, 1, "fallback switch must fire exactly once");
    assert.equal(switches[0].to, "anthropic/claude-haiku-4-5");
    assert.deepEqual(finalized, {
      ok: false,
      model: "anthropic/claude-haiku-4-5",
      attempts: MAX_FALLBACK_ATTEMPTS,
      fallback_depth: 1,
      gone_reason: "status_absent",
    });
  });

  test("primary status_absent x3 → fallback text on first attempt → success", () => {
    const { events, finalized } = simulateDispatchLoop({
      outcomeSequence: [
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
        { kind: "text" },
      ],
    });
    const switches = events.filter(e => e.type === "FALLBACK_SWITCH");
    assert.equal(switches.length, 1);
    assert.deepEqual(finalized, {
      ok: true,
      model: "anthropic/claude-haiku-4-5",
      attempts: 1,
      fallback_depth: 1,
    });
  });

  test("primary message_stall x3 → NO fallback switch (LLM API hang stays on same model)", () => {
    const { events, finalized } = simulateDispatchLoop({
      outcomeSequence: [
        { kind: "session_gone", reason: "message_stall" },
        { kind: "session_gone", reason: "message_stall" },
        { kind: "session_gone", reason: "message_stall" },
      ],
    });
    const switches = events.filter(e => e.type === "FALLBACK_SWITCH");
    assert.equal(switches.length, 0,
      "message_stall must NOT trigger fallback switch (different model unlikely to help)");
    assert.deepEqual(finalized, {
      ok: false,
      model: "local/qwen3.6-27b",
      attempts: MAX_ATTEMPTS,
      fallback_depth: 0,
      gone_reason: "message_stall",
    });
  });

  test("user model_override present → NO fallback switch (explicit user choice preserved)", () => {
    const { events, finalized } = simulateDispatchLoop({
      outcomeSequence: [
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
        { kind: "session_gone", reason: "status_absent" },
      ],
      userOverride: "github-copilot/claude-opus-4.5",
    });
    const switches = events.filter(e => e.type === "FALLBACK_SWITCH");
    assert.equal(switches.length, 0,
      "model_override must be respected — no auto-switch to fallback");
    assert.deepEqual(finalized, {
      ok: false,
      model: "github-copilot/claude-opus-4.5",
      attempts: MAX_ATTEMPTS,
      fallback_depth: 0,
      gone_reason: "status_absent",
    });
  });

  test("fallback attempt budget is exactly 2 (MAX_FALLBACK_ATTEMPTS < MAX_ATTEMPTS)", () => {
    assert.equal(MAX_FALLBACK_ATTEMPTS, 2);
    assert.ok(MAX_FALLBACK_ATTEMPTS < MAX_ATTEMPTS,
      "fallback budget must be strictly smaller than primary to bound total attempts");
    const { events } = simulateDispatchLoop({
      outcomeSequence: Array.from({ length: 10 }, () => ({ kind: "session_gone", reason: "status_absent" })),
    });
    const attemptsAfterSwitch = events.filter(
      e => e.type !== "FALLBACK_SWITCH" && e.activeFallbackDepth === 1,
    );
    assert.equal(attemptsAfterSwitch.length, MAX_FALLBACK_ATTEMPTS,
      `after fallback switch, exactly ${MAX_FALLBACK_ATTEMPTS} attempts must run`);
  });
});

describe("dispatch_stage — cross-call stall escalation cap", () => {
  const THRESHOLD = 5;

  test("MAX_ATTEMPTS alone cannot bound a re-calling orchestrator", () => {
    // Each dispatch_stage call gets a fresh budget, so N calls yield N*MAX_ATTEMPTS
    // hangs. This is the loop the cap exists to break.
    let hangs = 0;
    for (let call = 0; call < 4; call++) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) hangs++;
    }
    assert.equal(hangs, 12, "per-call budget resets — unbounded without a persisted cap");
  });

  test("blocks once accumulated hang_history reaches the threshold", () => {
    assert.equal(shouldEscalateStall(THRESHOLD, THRESHOLD), true);
    assert.equal(shouldEscalateStall(THRESHOLD + 3, THRESHOLD), true);
  });

  test("allows dispatch while below the threshold", () => {
    assert.equal(shouldEscalateStall(0, THRESHOLD), false);
    assert.equal(shouldEscalateStall(THRESHOLD - 1, THRESHOLD), false);
  });

  test("fail-open when hang_history length is unreadable (NaN)", () => {
    assert.equal(shouldEscalateStall(Number.NaN, THRESHOLD), false,
      "an unreadable state.json must not deadlock the whole workflow");
    assert.equal(shouldEscalateStall(10, Number.NaN), false);
  });

  test("threshold default is 5 and stays independent of MAX_ATTEMPTS", () => {
    assert.equal(DEFAULT_STALL_ESCALATE_THRESHOLD, 5);
    assert.ok(DEFAULT_STALL_ESCALATE_THRESHOLD > MAX_ATTEMPTS,
      "cap must allow at least one full in-call retry cycle before escalating");
  });
});

describe("dispatch_stage — hang_history 리셋은 substage done=true 일 때만 (issue #8)", () => {
  // 종전 리셋 조건은 "dispatch 정상 반환"(세션이 텍스트를 뱉음)이었다. 그래서
  // 초안 파일 생성에 실패하고 done=false 로 끝난 세션도 리셋을 유발했고,
  // 재-dispatch 를 반복하는 동안 이력이 매번 비워져 stall_escalate_threshold 가
  // 사실상 도달 불가였다 — 실측: done=false 인데 "substage succeeded" 리셋 로그
  // 3건 (issue #8 부수 관찰). 정적 검사로 소스의 게이트 형태를 고정한다.
  const pluginSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "opencode-plugin.ts"),
    "utf8",
  );

  // issue #9 에서 이 판정이 `classifyStageCompletion` (src/stage-completion.ts) 으로
  // 옮겨졌다. 불변식은 그대로다 — 리셋은 .done 을 다시 읽어 정확히 "true" 일 때만
  // 한다. 값 자체의 매핑은 test/stage-completion.test.ts 가 단위로 검증한다.
  const completionBlock = pluginSrc.slice(
    pluginSrc.indexOf("const readMarker ="),
    pluginSrc.indexOf("const retryDisallowed ="),
  );

  test("리셋 직전에 .done 마커를 읽어 판정한다", () => {
    assert.ok(completionBlock.length > 0, "완료 판정 블록을 찾을 수 없다");
    assert.match(completionBlock, /readMarker\("done"\)/, "리셋 전에 .done 마커를 조회해야 한다");
    assert.match(completionBlock, /classifyStageCompletion\(/,
      "판정은 순수 함수 classifyStageCompletion 이 한다");
    assert.match(completionBlock, /if \(completion\.resetHangHistory\)/,
      "리셋은 판정 결과로만 게이트되어야 한다 — dispatch 정상 반환이 아니라");
  });

  test("리셋 경로의 state.json 접근은 effectiveWorktree cwd 를 쓴다", () => {
    // 한 substage 의 state.json 접근은 전부 같은 cwd(effectiveWorktree)여야 한다.
    // args.worktree 를 쓰면 자동 교정 발동 시 다른 파일에 리셋이 기록된다 (hardrule).
    assert.ok(!/cwd\(args\.worktree\)/.test(completionBlock),
      "완료 판정·리셋 블록이 args.worktree cwd 를 쓰고 있다 — effectiveWorktree 로 통일할 것");
    assert.match(completionBlock, /cwd\(effectiveWorktree\)/);
  });

  test("done=false 리셋 스킵이 로그로 관측 가능하다", () => {
    assert.match(pluginSrc, /\[hang_history\] reset skipped/,
      "스킵 경로에 debug 로그가 없으면 임계 미도달 원인을 추적할 수 없다");
  });
});
