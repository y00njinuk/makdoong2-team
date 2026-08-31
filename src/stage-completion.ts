// stage-completion.ts — did the dispatched substage actually finish?
//
// Why a separate module: the opencode plugin loader calls EVERY named export of
// the entry file as a plugin factory (ARCHITECTURE.md §2), so new helpers must
// live outside opencode-plugin.ts and be imported. `test/plugin-exports-shape.test.ts`
// pins the entry file's export set.
//
// The problem this solves (GitHub #9): `pollSubSession` returning `kind:"text"`
// means "the sub-session produced a final assistant turn", NOT "the substage is
// done". A planner that burned its whole budget on research and exited with the
// words "조기종료 — 마커 기록 없음" produces exactly the same outcome kind as one
// that completed every phase. dispatch_stage reported `ok:true` for the former,
// team-leader read the prose and told the user the stage had progressed, and
// 27 minutes of wall clock left `state.json` byte-identical.
//
// The authoritative completion signal is the substage's own `.done` marker —
// the same value the gates and the verifier read. Everything here is a pure
// function of the markers so the classification is unit-testable without
// spawning sessions.

/**
 * - `done`       — `.done=true`. The substage finished; hang_history resets.
 * - `paused`     — the sub-agent stopped on purpose and recorded why
 *                  (`interview_required=true`). Not a failure: the orchestrator
 *                  runs the interview and re-dispatches with `context`.
 * - `incomplete` — a final turn, but `.done=false` and no pause marker. The
 *                  session spent its budget and left nothing behind.
 * - `unknown`    — the marker could not be read. Never downgraded to a failure:
 *                  an unreadable state.json must not turn finished work into a
 *                  retry loop (same fail-open reasoning as `shouldEscalateStall`).
 */
export type StageCompletion = "done" | "paused" | "incomplete" | "unknown";

/** hang_history `reason` for a text-but-no-marker exit. */
export const INCOMPLETE_HANG_REASON = "no_done_marker";

export interface StageCompletionInput {
  /** `pollSubSession` outcome kind of the final turn (`text` / `empty` / …). */
  outcomeKind: string;
  /** dispatch_stage's legacy success flag (final text turn, or a done-override). */
  success: boolean;
  /**
   * Raw stdout of `state.sh get <stage>.done`, trimmed — or `null` when the read
   * failed. `state.sh get` prints the literal `null` on a missing key, so `"null"`
   * and `null` both mean "not readable as a decision", never "false".
   */
  doneValue: string | null;
  /** Raw stdout of `state.sh get <stage>.interview_required`, trimmed, or `null`. */
  interviewRequiredValue?: string | null;
}

export interface StageCompletionResult {
  completion: StageCompletion;
  /** `true` only on a marker we actually read as `true`; `null` when unreadable. */
  stageDone: boolean | null;
  /** Should dispatch_stage report `ok:true` to the orchestrator? */
  ok: boolean;
  /** Reset the substage's `hang_history` (only a real completion clears it). */
  resetHangHistory: boolean;
  /**
   * Append a `hang_history` entry. hang_history is the ONLY counter that survives
   * across dispatch_stage calls, so an incomplete exit has to land there or the
   * cross-call `stall_escalate_threshold` can never arm for this failure mode —
   * the substage re-dispatches forever, each call burning a full timeout.
   */
  recordHang: boolean;
  /** One-line cause, surfaced as `reason` when `ok` is false. */
  incompleteReason?: string;
  /** Literal instruction for team-leader. Hardrule 4 says it follows this verbatim. */
  nextAction?: string;
}

/**
 * Classify a dispatch_stage outcome by the substage's markers.
 *
 * Only a definite `"false"` flips `ok` to false. A read failure (`null`) or a
 * literal `"null"` leaves `ok` alone and reports `unknown` — see StageCompletion.
 */
export function classifyStageCompletion(input: StageCompletionInput): StageCompletionResult {
  const done = normalizeMarker(input.doneValue);
  const interview = normalizeMarker(input.interviewRequiredValue ?? null);

  if (!input.success) {
    // The failure paths (session_gone / timeout / empty) already build their own
    // reason and their own hang_history entries. Nothing to add or reset here.
    return {
      completion: done === true ? "done" : "incomplete",
      stageDone: done,
      ok: false,
      resetHangHistory: false,
      recordHang: false,
    };
  }

  if (done === true) {
    return { completion: "done", stageDone: true, ok: true, resetHangHistory: true, recordHang: false };
  }

  if (interview === true) {
    return {
      completion: "paused",
      stageDone: false,
      ok: true,
      resetHangHistory: false,
      recordHang: false,
      nextAction:
        "서브에이전트가 interview_required=true 를 기록하고 의도적으로 중단했다. 재dispatch 전에 " +
        "사용자 인터뷰를 먼저 수행하고, 답변을 dispatch_stage 의 context 파라미터에 실어 재호출하라.",
    };
  }

  if (done === false) {
    return {
      completion: "incomplete",
      stageDone: false,
      ok: false,
      resetHangHistory: false,
      recordHang: true,
      incompleteReason:
        "sub-session 은 최종 텍스트를 남겼지만 substage 의 .done 마커가 false 다 — 작업이 완료되지 않았다. " +
        "출력 문구가 아니라 이 필드가 완료 판정의 근거다.",
      nextAction:
        "이 substage 는 완료되지 않았다. 사용자에게 '완료' 로 보고하지 말 것. " +
        "output 의 미완료 사유를 읽고 (a) 해결 가능하면 context 에 지시를 실어 dispatch_stage 를 재호출하거나, " +
        "(b) 사용자 개입이 필요하면 소요 시간과 미완료 사유를 그대로 보고하고 대기하라. " +
        "hang_history 에 기록되므로 반복하면 stall_escalate_threshold 에서 차단된다.",
    };
  }

  return {
    completion: "unknown",
    stageDone: null,
    ok: true,
    resetHangHistory: false,
    recordHang: false,
    nextAction:
      "substage 의 .done 마커를 읽지 못했다. 다음 단계로 넘어가기 전에 " +
      "`bash <SCRIPTS_DIR>/state.sh status <이슈키>` 로 state.json 상태를 먼저 확인하라.",
  };
}

/** `"true"` / `"false"` → boolean. Everything else (`"null"`, `null`, 잡음) → null. */
function normalizeMarker(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}
