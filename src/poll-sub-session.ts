// poll-sub-session.ts — pure, testable polling primitive for sub-sessions.
//
// Extracted from opencode-plugin.ts so that end-conditions (idle, finish,
// timeout, transient failures, empty parts) can be unit-tested with a mock
// client. The plugin passes its real `client` at call sites; tests inject a
// scripted mock via the same shape.
//
// Design invariants (see AGENTS.md and Oracle diagnosis for rationale):
//   INV-1: `!status` alone must never mean "idle". A missing status entry can
//          equally mean "session not registered yet" or "session cleaned up".
//          Idle is confirmed only by `status.type === "idle"` AFTER we have
//          seen the session appear in the status map at least once.
//   INV-2: transient `session.status()` / `session.messages()` failures must
//          be retried, not silently treated as "no messages". They advance
//          `transientFailures` counter and are surfaced when polling ends.
//   INV-3: ordering is derived from message array index, not from lexicographic
//          ID comparison. Message IDs may be UUIDs (non-monotonic strings).
//   INV-4: the result must distinguish (a) sub-agent produced text, (b) idle
//          but no text (still an error case for callers), (c) transient
//          failure timeout, (d) hard timeout. Callers set `success` per this
//          discrimination.

import { matchesGlob } from "node:path";

export type MessagePartLike = { type: string; text?: string };
export type MessageInfoLike = { id?: string; role: string; finish?: unknown };
export type MessageLike = { info: MessageInfoLike; parts: MessagePartLike[] };
export type StatusEntryLike = { type: string };

export type PermissionRequestLike = { id: string; sessionID: string; permission: string; patterns: string[] };

export interface PollClientLike {
  session: {
    status: () => Promise<{ data?: Record<string, StatusEntryLike> } | null | undefined>;
    messages: (req: { path: { id: string } }) => Promise<{ data?: MessageLike[] } | null | undefined>;
    abort: (req: { path: { id: string } }) => Promise<unknown>;
  };
  permission?: {
    list: () => Promise<{ data?: PermissionRequestLike[] } | null | undefined>;
    reply: (req: { path: { requestID: string }; body: { reply: string } }) => Promise<unknown>;
  };
}

export type PollOutcome =
  | { kind: "text"; text: string; polls: number; elapsedMs: number }
  | { kind: "empty"; reason: string; polls: number; elapsedMs: number }
  | { kind: "timeout"; polls: number; elapsedMs: number; transientFailures: number }
  | { kind: "aborted"; reason: string; polls: number; elapsedMs: number }
  | { kind: "permission_stall"; polls: number; elapsedMs: number; stalledMs: number; permissionID?: string; permissionType?: string }
  // 세션이 등장 후 사라진 케이스 (sessionEverAppeared=true → 3회 연속 status absent + no new messages)
  // 또는 message stall 케이스 (sessionEverAppeared=true → busy 지속 + assistant message 0건 + messageStallThresholdMs 초과).
  // 호출자는 session.abort() 를 "실제 gone" 인 경우에만 skip 해야 한다 (skipSessionOps 플래그로 전달).
  // 실제 disappeared 케이스는 opencode 가 NotFoundError 이벤트를 부모 세션에 fire 하여 hang 을 유발하므로
  // pane kill + 즉시 redispatch 만 안전. message stall 케이스는 세션이 여전히 존재하므로 abort() 가능하다.
  // reason 필드는 두 경로 구분에 사용된다:
  //   - reason 미설정 또는 "status_absent": 세션이 실제로 사라짐. skipSessionOps=true 로 호출.
  //   - reason "message_stall": LLM API hang. abort() 안전, redispatch 시 새 세션 정상 생성 가능.
  | { kind: "session_gone"; polls: number; elapsedMs: number; reason?: string };

export interface PollOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  pollSafetyMargin?: number;
  permissionCheckIntervalPolls?: number;
  allowedWorktree?: string;
  configuredAllowPatterns?: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  // Tool-call stall: sub-agent has a pending tool_call part that has not made
  // progress for this long. Triggers `permission_stall` (auto-reject + abort).
  // Distinct from messageStallThresholdMs which detects LLM inference hang
  // before any assistant message is produced. Default: 60_000ms.
  toolCallStallThresholdMs?: number;
  // Message stall: session appeared (sessionEverAppeared=true) and stays busy
  // while making no progress for this long. Progress is signaled either by a
  // new message OR by content-signature change on the last assistant message
  // (see the `messagesChanged` computation). This detects two failure modes
  // that no other path catches:
  //   (a) bootstrap hang — LLM never produces the first assistant message
  //       (upstream provider silent, quota exhausted, local server crash);
  //   (b) mid-stream LLM inference hang — assistant appeared but then froze
  //       for the threshold duration while status stayed busy. Without this,
  //       hung inference on a session that already produced text (and thus
  //       does not fit status_absent gone `!status` or message_stall's old
  //       `!lastAssistant` gate) would wait for the full 30-minute timeout.
  // The check is skipped while `hasPendingToolCall` is true so heavy tool
  // executions (docker/gradle builds spanning minutes) are not misclassified.
  // Returns `session_gone` outcome (kind reused so dispatch_stage's retry
  // loop kicks in with a fresh sub-session). Undefined disables the check —
  // dispatch_stage opts in per-attempt with exponential backoff. Default: undefined.
  messageStallThresholdMs?: number;
  // Status-absent gone grace period. When the session was previously present
  // in the status map but has since disappeared (and no new messages, no
  // pending tool_call), we wait this long before declaring `session_gone`.
  // Historical value was 3 consecutive polls (~8 s at pollIntervalMs=2000)
  // which produced heavy false positives on slow-first-token models
  // (qwen3.6-27b, etc.) — the server transiently stops pushing status events
  // during long tool-heavy substages while the session is very much alive.
  // Default: 300_000 ms (5 min) — matches the observed maximum gap between
  // tool executions during heavy engineer work.
  statusAbsentGraceMs?: number;
  // Alive signal callback. Invoked once per poll before gone-admission. If it
  // returns true, gone-admission is skipped entirely (the counter is also
  // reset). Intended to be wired to an external liveness source such as the
  // opencode plugin's `tool.execute.before` hook, which observes tool activity
  // that pollSubSession's message polling cannot see for several seconds due
  // to server-side batching. Returning false (or omitting the callback) keeps
  // the pre-existing behavior. Default: undefined.
  isRecentlyActive?: () => boolean;
  // Content-stable completion inference. When set, a sub-session that (a) has
  // produced at least one assistant message, (b) has no pending tool_call, and
  // (c) has not advanced content (no length or signature change) for this many
  // milliseconds is treated as complete — even when the server's status map
  // never transitions to `idle` (worktree-CWD sessions, filtered status maps)
  // and the assistant message never carries a `finish` field (some providers).
  // This is the third-arm completion signal alongside `statusIdle` and
  // `finishComplete`. Wired by dispatch_stage (default 300_000ms = 5min) to
  // prevent false SESSION_GONE / MESSAGE_STALL fires on sessions that actually
  // finished but did not signal completion through the two canonical paths.
  // The 5-minute window accommodates Claude-family models that pause between
  // tool calls for extended internal reasoning without emitting new message
  // parts. Local qwen-family models hit their true idle much earlier (10-30s),
  // so 5min never truncates them; only content-stable-inferred completion is
  // affected. Undefined disables the inference (backward-compatible).
  // Default: undefined.
  contentStableCompletionMs?: number;
  // Preamble-only detection threshold. When set to a positive number,
  // pollSubSession reclassifies text outcomes as "empty" (reason:
  // "preamble_only") if the final assistant text is shorter than this many
  // characters AND no pending tool call remains. Guards against local models
  // (and occasionally Claude) that emit a short intro ("좋습니다! 이제 ...:")
  // and end the turn without executing the actual substage work. When
  // reclassified, dispatch_stage's empty-output-retry path takes over,
  // sending a strong re-prompt to force the sub-agent to invoke tools.
  // Undefined or 0 disables the check. Default: undefined.
  preambleOnlyTextThreshold?: number;
  nudgeAtFraction?: number;
  onNudge?: (sessionId: string, elapsedMs: number) => Promise<void>;
}

const TOOL_CALL_PART_TYPES = new Set(["tool_call", "tool-call", "tool_use"]);

// path.posix.dirname is used directly so the module works in both Node and test
// environments without importing 'path'. The separator is always '/' because
// opencode worktree paths are POSIX.
function posixDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

// Returns true when every permission pattern resides within the allowed scope,
// defined as the parent directory of the worktree (siblings are the main repo
// and other worktrees — all legitimate access targets for engineers).
// Trailing glob suffixes (/* , /*/ , /**/ , /**) are stripped before prefix check.
export function isWithinWorktreeScope(patterns: string[], worktree: string): boolean {
  if (!worktree || patterns.length === 0) return false;
  const scope = posixDirname(worktree);
  return patterns.every(pat => {
    const base = pat.replace(/\/?(\*+\/?)+$/, "");
    return base === scope || base.startsWith(scope + "/");
  });
}

// Returns true when every permission pattern is covered by at least one
// configured allow glob from opencode.json's external_directory section.
//
// Deliberately uses prefix comparison rather than path.matchesGlob because
// matchesGlob's "**" does NOT traverse dot-prefixed directories (.nvm, .config).
// opencode.json patterns that contain dot-directories must therefore be written
// as absolute-path prefixes (e.g. "/root/.nvm/**") rather than middle-wildcard
// globs ("**/@local/**") to work reliably in both opencode and this function.
export function isMatchedByConfiguredRules(patterns: string[], allowedGlobs: string[]): boolean {
  if (patterns.length === 0 || allowedGlobs.length === 0) return false;
  return patterns.every(pat => {
    const base = pat.replace(/\/?(\*+\/?)+$/, "");
    return allowedGlobs.some(glob => {
      const globBase = glob.replace(/\/?(\*+\/?)+$/, "");
      return base === globBase || base.startsWith(globBase + "/");
    });
  });
}

/**
 * Poll a sub-session until it becomes idle (or times out) and extract the
 * last assistant response as plain text.
 *
 * The returned {@link PollOutcome} discriminates four terminal states so that
 * callers can set the "success" flag correctly:
 *
 *   - `text`     : sub-agent produced final text output. success=true.
 *   - `empty`    : sub-agent completed but produced no text parts. success=false.
 *   - `timeout`  : deadline exceeded. abort() invoked. success=false.
 *   - `aborted`  : safety limit hit (maxPolls). abort() invoked. success=false.
 *
 * Callers previously conflated "text" and "empty" via a fallback string
 * `"(session complete, no text output)"`, which made the orchestrator report
 * success even when the sub-agent produced nothing. This function forces the
 * distinction so `dispatch_stage` can return `ok:false` on empty output.
 */
export async function pollSubSession(
  client: PollClientLike,
  sessionId: string,
  options: PollOptions = {},
): Promise<PollOutcome> {
  const timeoutMs = options.timeoutMs ?? 1_800_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const pollSafetyMargin = options.pollSafetyMargin ?? 10;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const dbg = options.logger?.debug;
  const err = options.logger?.error ?? ((msg: string) => console.error(msg));

  const startTime = now();
  const deadline = startTime + timeoutMs;
  const expectedPolls = Math.ceil(timeoutMs / pollIntervalMs);
  const maxPolls = expectedPolls + pollSafetyMargin;

  const toolCallStallThresholdMs = options.toolCallStallThresholdMs ?? 60_000;
  const messageStallThresholdMs = options.messageStallThresholdMs;
  const statusAbsentGraceMs = options.statusAbsentGraceMs ?? 300_000;
  const contentStableCompletionMs = options.contentStableCompletionMs;
  const preambleOnlyTextThreshold = options.preambleOnlyTextThreshold;
  const isRecentlyActive = options.isRecentlyActive;
  const permissionCheckIntervalPolls = options.permissionCheckIntervalPolls ?? 5;

  let pollCount = 0;
  let transientFailures = 0;
  let sessionEverAppeared = false;
  let hasProducedAssistantMessage = false;
  let lastProgressAt = startTime;
  let lastSeenMessageCount = -1;
  let lastAssistantSig = "";
  let nudged = false;
  let firstGoneObservedAt: number | null = null;

  dbg?.(`[pollSubSession] START session=${sessionId} timeoutMs=${timeoutMs}`);

  while (now() < deadline) {
    await sleep(pollIntervalMs);
    pollCount++;

    if (pollCount > maxPolls) {
      err(`[pollSubSession] ABORT session=${sessionId} reason=max_polls_exceeded count=${pollCount}/${maxPolls}`);
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      return {
        kind: "aborted",
        reason: `exceeded max polling attempts ${pollCount}/${maxPolls}`,
        polls: pollCount,
        elapsedMs: now() - startTime,
      };
    }

    let statusFailed = false;
    const statusResult = await client.session.status().catch((e: unknown) => {
      err(`[pollSubSession] session.status() FAILED session=${sessionId} poll=${pollCount} error=${e}`);
      statusFailed = true;
      return null;
    });
    const allStatuses = statusResult?.data as Record<string, StatusEntryLike> | undefined;
    const status = allStatuses?.[sessionId];

    if (status) sessionEverAppeared = true;
    if (statusFailed) transientFailures++;

    let messagesFailed = false;
    const msgResult = await client.session
      .messages({ path: { id: sessionId } })
      .catch((e: unknown) => {
        err(`[pollSubSession] session.messages() FAILED session=${sessionId} poll=${pollCount} error=${e}`);
        messagesFailed = true;
        return null;
      });
    const messages = (msgResult?.data as MessageLike[] | undefined) ?? [];
    if (messagesFailed) transientFailures++;

    // INV-2: transient failures do not advance completion detection. Just retry.
    if (statusFailed || messagesFailed) {
      dbg?.(`[pollSubSession] TRANSIENT session=${sessionId} poll=${pollCount} statusFailed=${statusFailed} messagesFailed=${messagesFailed}`);
      continue;
    }

    const lengthChanged = messages.length !== lastSeenMessageCount;
    if (lengthChanged) lastSeenMessageCount = messages.length;

    // sessionEverAppeared stays strict (status-map only). A second liveness
    // signal, sessionAliveByMessages, unlocks defense paths for worktree-CWD
    // sessions where the server's status map is CWD-filtered and never
    // contains the sessionId. Keeping the two signals separate lets
    // session_gone (status_absent) fire immediately for the strict case
    // (status was present, then disappeared — real disappearance) while
    // requiring an additional hasProducedAssistantMessage gate for the loose
    // case (worktree — session was never in status map, so we can't
    // distinguish bootstrap from real gone without prior output evidence).
    const sessionAliveByMessages = messages.length > 0;

    // INV-3: ordering is derived from array index, not lexicographic ID compare.
    let lastAssistantIdx = -1;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (lastAssistantIdx < 0 && messages[i].info.role === "assistant") lastAssistantIdx = i;
      if (lastUserIdx < 0 && messages[i].info.role === "user") lastUserIdx = i;
      if (lastAssistantIdx >= 0 && lastUserIdx >= 0) break;
    }
    const lastAssistant = lastAssistantIdx >= 0 ? messages[lastAssistantIdx] : undefined;
    if (lastAssistant) hasProducedAssistantMessage = true;

    // Content signature captures streaming text appends and new part additions
    // that leave messages.length unchanged. Without this, an assistant that
    // streams a 5-minute reasoning block into a single message would appear
    // frozen to length-only comparison and could trigger status_absent gone
    // (Oracle-flagged risk #1). Combining length-change with signature-change
    // gives the correct "any progress?" signal for both single-message
    // streaming and normal multi-message flows.
    const lastAsstTextLen = lastAssistant?.parts
      ? lastAssistant.parts.reduce((s, p) => s + (typeof p.text === "string" ? p.text.length : 0), 0)
      : 0;
    const lastAsstPartsLen = lastAssistant?.parts?.length ?? 0;
    const currentAsstSig = lastAssistant
      ? `${lastAssistant.info?.id ?? ""}:${lastAsstPartsLen}:${lastAsstTextLen}`
      : "";
    const contentChanged = currentAsstSig !== "" && currentAsstSig !== lastAssistantSig;
    const messagesChanged = lengthChanged || contentChanged;
    if (messagesChanged) {
      lastAssistantSig = currentAsstSig;
      lastProgressAt = now();
    }

    const properOrdering =
      lastAssistant && lastUserIdx >= 0
        ? lastAssistantIdx > lastUserIdx
        : Boolean(lastAssistant);

    const hasFinish = lastAssistant?.info?.finish != null;
    const hasPendingToolCall = !!lastAssistant?.parts?.some(
      p => TOOL_CALL_PART_TYPES.has(p.type),
    );

    const stalledMs = now() - lastProgressAt;

    // session_gone (status_absent) has two admission paths with different
    // strictness:
    //   strict — status was previously present (opencode confirmed the
    //     session, then it vanished from the map).
    //   loose — worktree-CWD case, status never present. Requires prior
    //     assistant output to guard against slow-first-token bootstrap
    //     false-positive; the correct path for bootstrap hang is
    //     message_stall (opt-in threshold), not gone-detection.
    //
    // Both paths ALSO require `!isRecentlyActive()` — an external liveness
    // callback (typically wired to the opencode plugin's tool.execute.before
    // hook) that observes tool activity even when server-side status pushes
    // stall. Recent tool activity resets both the admission and the
    // grace-period timer, so a session that fires tools every few seconds
    // will never be classified gone regardless of how long the status map
    // lags behind.
    //
    // Once admitted, the outcome is not fired until `statusAbsentGraceMs`
    // has elapsed since the FIRST admission observation (not since start of
    // poll). Historical logic used a 3-poll counter (~8 s) which produced
    // heavy false positives on slow-first-token models. The grace-period
    // model keeps timing decoupled from poll frequency and yields intuitive
    // wall-clock semantics.
    const activeSignal = isRecentlyActive?.() === true;
    const goneAdmitted =
      !activeSignal &&
      !hasPendingToolCall &&
      !messagesChanged &&
      !status &&
      (sessionEverAppeared || (sessionAliveByMessages && hasProducedAssistantMessage));
    if (goneAdmitted) {
      if (firstGoneObservedAt === null) {
        firstGoneObservedAt = now();
        dbg?.(
          `[pollSubSession] GONE_ADMIT session=${sessionId} poll=${pollCount} ` +
          `sig="${currentAsstSig}" pending_tool=${hasPendingToolCall} ` +
          `session_ever_appeared=${sessionEverAppeared} alive_by_msgs=${sessionAliveByMessages} ` +
          `messages=${messages.length} grace_ms=${statusAbsentGraceMs} ` +
          `— gone admission started; will fire in ${statusAbsentGraceMs}ms if condition persists`,
        );
      }
      const goneElapsedMs = now() - firstGoneObservedAt;
      if (goneElapsedMs >= statusAbsentGraceMs) {
        err(
          `[pollSubSession] SESSION_GONE session=${sessionId} polls=${pollCount} ` +
          `gone_elapsed_ms=${goneElapsedMs} grace_ms=${statusAbsentGraceMs} ` +
          `sig="${currentAsstSig}" messages=${messages.length} ` +
          `— status disappeared after appearing, no new messages, no recent tool activity`,
        );
        return {
          kind: "session_gone",
          polls: pollCount,
          elapsedMs: now() - startTime,
        };
      }
    } else {
      if (firstGoneObservedAt !== null) {
        dbg?.(
          `[pollSubSession] GONE_ADMIT_RESET session=${sessionId} poll=${pollCount} ` +
          `active_signal=${activeSignal} pending_tool=${hasPendingToolCall} ` +
          `messages_changed=${messagesChanged} status=${status?.type ?? "absent"} ` +
          `— gone admission cleared before grace elapsed`,
        );
      }
      firstGoneObservedAt = null;
    }

    if (client.permission && pollCount % permissionCheckIntervalPolls === 0) {
      const permResult = await client.permission.list().catch(() => null);
      const pending = (permResult?.data ?? []).filter(p => p.sessionID === sessionId);
      for (const p of pending) {
        const withinScope =
          p.permission === "external_directory" && (
            (!!options.allowedWorktree && isWithinWorktreeScope(p.patterns, options.allowedWorktree)) ||
            isMatchedByConfiguredRules(p.patterns, options.configuredAllowPatterns ?? [])
          );

        if (withinScope) {
          dbg?.(
            `[pollSubSession] PERMISSION_ALLOW session=${sessionId} polls=${pollCount}` +
            ` permissionID=${p.id} type=${p.permission} patterns=${JSON.stringify(p.patterns)}` +
            ` scope=dirname(${options.allowedWorktree})`
          );
          await client.permission
            .reply({ path: { requestID: p.id }, body: { reply: "once" } })
            .catch(() => undefined);
        } else {
          err(
            `[pollSubSession] PERMISSION_STALL session=${sessionId} polls=${pollCount}` +
            ` permissionID=${p.id} type=${p.permission} patterns=${JSON.stringify(p.patterns)}` +
            ` — auto-rejecting (outside worktree scope or non-external_directory)`
          );
          await client.permission
            .reply({ path: { requestID: p.id }, body: { reply: "reject" } })
            .catch(() => undefined);
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          return {
            kind: "permission_stall",
            polls: pollCount,
            elapsedMs: now() - startTime,
            stalledMs,
            permissionID: p.id,
            permissionType: p.permission,
          };
        }
      }
    }

    if (hasPendingToolCall && stalledMs >= toolCallStallThresholdMs) {
      err(`[pollSubSession] PERMISSION_STALL session=${sessionId} polls=${pollCount} stalledMs=${stalledMs}`);
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      return {
        kind: "permission_stall",
        polls: pollCount,
        elapsedMs: now() - startTime,
        stalledMs,
      };
    }

    // Message stall: sub-agent registered (sessionEverAppeared) and appears
    // busy, but has made no progress within the configured threshold.
    // Progress = new message OR content-signature change on the last
    // assistant message (see the `messagesChanged` computation above).
    // Catches two hang modes:
    //   (a) bootstrap hang — no assistant message at all (upstream silent,
    //       quota exhausted, local server crash). `lastProgressAt` stays at
    //       startTime so `stalledFromProgress` grows monotonically.
    //   (b) mid-stream LLM inference hang — assistant appeared but then
    //       froze mid-response. `lastProgressAt` last advanced when the
    //       final signature change was seen; from that point onward the
    //       LLM is silent while status stays busy.
    // Heavy tool executions (docker/gradle builds spanning minutes) are
    // exempted via `!hasPendingToolCall` — pending tool call means the
    // sub-agent is waiting on our runtime, not on the LLM API. When the
    // caller opts in via messageStallThresholdMs (dispatch_stage passes
    // escalating per-attempt values), the check returns session_gone with
    // reason="message_stall" so the retry loop kicks in with a fresh
    // sub-session. abort() is safe here (session is real, just stalled on
    // the LLM API), so unlike status-absent session_gone we do NOT need
    // skipSessionOps handling downstream.
    //
    // Busy-signal detection: `status?.type === "busy"` is the primary
    // signal when the server's status map contains the sessionId. For
    // worktree-CWD sessions the map is CWD-filtered and never contains the
    // sessionId, so status is always absent — sessionAliveByMessages (loose
    // liveness) plus a busy indicator derived from messages.length become
    // equivalent.
    const elapsedFromStart = now() - startTime;
    const busyIndicated = status?.type === "busy" || (!status && messages.length > 0);
    const stalledFromProgress = now() - lastProgressAt;
    if (
      messageStallThresholdMs !== undefined &&
      (sessionEverAppeared || sessionAliveByMessages) &&
      busyIndicated &&
      !hasPendingToolCall &&
      stalledFromProgress >= messageStallThresholdMs
    ) {
      const hangMode = lastAssistant ? "mid_stream" : "bootstrap";
      err(
        `[pollSubSession] MESSAGE_STALL session=${sessionId} polls=${pollCount} ` +
        `mode=${hangMode} stalled_from_progress_ms=${stalledFromProgress} ` +
        `threshold_ms=${messageStallThresholdMs} elapsed_ms=${elapsedFromStart} ` +
        `messages=${messages.length} — LLM API hang suspected (no progress while status=busy)`,
      );
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      return {
        kind: "session_gone",
        polls: pollCount,
        elapsedMs: elapsedFromStart,
        reason: "message_stall",
      };
    }

    const finishComplete = hasFinish && !hasPendingToolCall && properOrdering;

    // INV-1: `!status` alone is not idle. Require `status.type === "idle"` AND
    // that we saw the session in the status map at least once (or that the
    // messages list already contains an assistant response).
    const statusIdle = !!status && status.type === "idle";
    // Content-stable third-arm completion (see contentStableCompletionMs docs
    // on PollOptions). Fires only when the sub-agent has produced at least
    // one assistant message, has no pending tool_call, and has not advanced
    // its content for the configured threshold. Prevents SESSION_GONE /
    // MESSAGE_STALL false-positives on providers/sessions where neither
    // statusIdle nor finishComplete ever fires (worktree-CWD, no finish field).
    const contentStable =
      contentStableCompletionMs !== undefined &&
      hasProducedAssistantMessage &&
      !hasPendingToolCall &&
      stalledFromProgress >= contentStableCompletionMs;
    const looksComplete = statusIdle || finishComplete || contentStable;

    dbg?.(
      `[pollSubSession] POLL session=${sessionId} poll=${pollCount} status=${status?.type ?? "absent"} ` +
      `messages=${messages.length} finishComplete=${finishComplete} statusIdle=${statusIdle} ` +
      `contentStable=${contentStable} sessionEverAppeared=${sessionEverAppeared}`,
    );

    if (!nudged && options.nudgeAtFraction != null && options.onNudge) {
      const elapsedMs = now() - startTime;
      if (elapsedMs >= options.nudgeAtFraction * timeoutMs) {
        // Guard: only NUDGE if the session appears alive (has messages or present in status).
        // Prevents NotFoundError on orphaned/gone sessions where tmux pane persists but
        // the OpenCode session was already deleted (bug #2: PROJ-40406 orphan scenario).
        const sessionLooksAlive = sessionAliveByMessages || status !== undefined;
        if (sessionLooksAlive) {
          nudged = true;
          dbg?.(`[pollSubSession] NUDGE session=${sessionId} elapsed=${elapsedMs}ms fraction=${options.nudgeAtFraction}`);
          await options.onNudge(sessionId, elapsedMs).catch(() => undefined);
        } else {
          dbg?.(
            `[pollSubSession] NUDGE_SKIP session=${sessionId} elapsed=${elapsedMs}ms ` +
            `reason=session_looks_dead (no_messages=${messages.length === 0} no_status=${!status})`,
          );
          nudged = true; // Mark as nudged to prevent retry on next poll
        }
      }
    }

    if (!looksComplete) continue;

    // Completion signal fired. Require that we have observed the session at
    // least once via status OR that at least one assistant message exists.
    // This blocks the "!status on first poll before session registered" false
    // positive that plagued v0.10.1 rollback.
    if (!sessionEverAppeared && messages.length === 0) {
      dbg?.(`[pollSubSession] IGNORE completion (session never appeared, no messages) session=${sessionId} poll=${pollCount}`);
      continue;
    }

    if (!lastAssistant) {
      return {
        kind: "empty",
        reason: "no assistant message",
        polls: pollCount,
        elapsedMs: now() - startTime,
      };
    }

    const text = (lastAssistant.parts ?? [])
      .filter(p => p.type === "text" && typeof p.text === "string" && p.text.length > 0)
      .map(p => p.text!)
      .join("\n");

    if (text.length > 0) {
      if (
        preambleOnlyTextThreshold !== undefined &&
        preambleOnlyTextThreshold > 0 &&
        text.trim().length < preambleOnlyTextThreshold &&
        !hasPendingToolCall
      ) {
        dbg?.(
          `[pollSubSession] preamble-only detected session=${sessionId} ` +
          `textLen=${text.trim().length} threshold=${preambleOnlyTextThreshold} — ` +
          `reclassifying text outcome as empty`,
        );
        return {
          kind: "empty",
          reason: "preamble_only",
          polls: pollCount,
          elapsedMs: now() - startTime,
        };
      }
      return { kind: "text", text, polls: pollCount, elapsedMs: now() - startTime };
    }

    return {
      kind: "empty",
      reason: "assistant message has no text parts",
      polls: pollCount,
      elapsedMs: now() - startTime,
    };
  }

  err(`[pollSubSession] TIMEOUT session=${sessionId} polls=${pollCount} transientFailures=${transientFailures}`);
  await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
  return {
    kind: "timeout",
    polls: pollCount,
    elapsedMs: now() - startTime,
    transientFailures,
  };
}

/**
 * Convert a {@link PollOutcome} into a display string plus a boolean success
 * flag. Used by callers that need a single string for downstream serialization
 * (e.g., embedding in a JSON response) but must also know whether the
 * sub-agent actually produced work.
 */
export function pollOutcomeToLegacy(
  outcome: PollOutcome,
): { text: string; success: boolean } {
  switch (outcome.kind) {
    case "text":
      return { text: outcome.text, success: true };
    case "empty":
      return {
        text: `(session complete, no text output — ${outcome.reason})`,
        success: false,
      };
    case "timeout":
      return {
        text:
          `(timeout: sub-agent did not complete within the allotted time; ` +
          `polls=${outcome.polls} transientFailures=${outcome.transientFailures})`,
        success: false,
      };
    case "aborted":
      return { text: `(aborted: ${outcome.reason})`, success: false };
    case "permission_stall":
      return {
        text: outcome.permissionType
          ? `(permission_stall: sub-agent blocked on ${outcome.permissionType} permission (id=${outcome.permissionID}) — auto-rejected and aborted)`
          : `(permission_stall: sub-agent tool call stalled for ${outcome.stalledMs}ms — likely waiting for external_directory permission approval that cannot be answered in subagent context)`,
        success: false,
      };
    case "session_gone":
      return {
        text: outcome.reason === "message_stall"
          ? `(session_gone[message_stall]: sub-session busy for ${outcome.elapsedMs}ms without producing any assistant message ` +
            `(polls=${outcome.polls}) — LLM API hang suspected. Caller should redispatch a new session.)`
          : `(session_gone: sub-session disappeared from status map after appearing, no new messages, ` +
            `and no recent tool activity for at least the configured grace period ` +
            `(polls=${outcome.polls}, elapsed=${outcome.elapsedMs}ms). ` +
            `Caller should redispatch a new session instead of retrying this one.)`,
        success: false,
      };
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled outcome kind: ${(_exhaustive as any).kind}`);
    }
  }
}
