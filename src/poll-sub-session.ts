// poll-sub-session.ts — pure, testable polling primitive for sub-sessions.
//
// Extracted from opencode-plugin.ts so that end-conditions (idle, finish,
// timeout, transient failures, empty parts) can be unit-tested with a mock
// client. The plugin passes its real `client` at call sites; tests inject a
// scripted mock via the same shape.
//
// Design invariants (see CLAUDE.md and Oracle diagnosis for rationale):
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

export type MessagePartLike = {
  type: string;
  text?: string;
  /** opencode SDK 의 ToolPart 는 state.status 로 진행 상태를 알린다. */
  state?: { status?: string };
  /** ToolPart 의 호출 ID — `tool.execute.before/after` 훅의 callID 와 같은 값. */
  callID?: string;
};

/**
 * 폴 시점 스냅샷에서 읽은 툴 호출 상태. `isToolExecuting` 에 넘겨 훅 레지스트리와
 * 대조하게 한다 — throw 로 끝난 툴은 after 훅이 돌지 않아 레지스트리에 남는데,
 * 스냅샷의 completed/error part 가 그 호출이 끝났음을 확정해 준다.
 */
export type ToolSnapshot = {
  /** completed / error 로 끝난 호출 ID (스냅샷 전체 메시지 기준). */
  settledCallIDs: ReadonlySet<string>;
  /** pending / running 인 호출 ID (마지막 assistant 메시지 기준). */
  inFlightCallIDs: ReadonlySet<string>;
};
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
    /**
     * 피드백을 실은 거부. opencode 는 `reject` + `message` 를 `RejectedError` 가 아니라
     * `CorrectedError` 로 바꾼다 — 툴 호출은 그 문구를 오류로 돌려받고, **세션 루프는
     * 멈추지 않는다** (`processor.ts` 의 `ctx.blocked` 는 `RejectedError` 에만 걸린다).
     * 그래서 서브에이전트가 경로를 좁혀 같은 자리에서 이어갈 수 있다. 없으면(구버전
     * 클라이언트) 종전대로 reject + abort 로 떨어진다.
     */
    correct?: (req: { path: { requestID: string }; body: { message: string } }) => Promise<unknown>;
  };
}

export type PermissionStallReason =
  | "outside_allowed_roots"
  | "non_external_permission"
  | "tool_call_stall";

export type PollOutcome =
  | { kind: "text"; text: string; polls: number; elapsedMs: number }
  | { kind: "empty"; reason: string; polls: number; elapsedMs: number }
  | { kind: "timeout"; polls: number; elapsedMs: number; transientFailures: number }
  | { kind: "aborted"; reason: string; polls: number; elapsedMs: number }
  // permissionReason 은 **처방이 정반대인 두 실패를 구분**한다:
  //   outside_allowed_roots  — 허용 경로 밖 접근. 대안 경로를 알려주면 회복 가능
  //   non_external_permission — external_directory 가 아닌 권한(edit/bash 등)이 도달.
  //                             경로 문제가 아니라 에이전트 설정 문제다
  //   tool_call_stall        — 권한 요청 없이 툴 호출만 멈춰 있는 경우
  // permissionCorrections 는 abort 전에 같은 세션 안에서 피드백 거부(in-place
  // correction)를 몇 번 보냈는지다. 0 이 아니면 서브에이전트가 안내를 받고도
  // 스코프 밖 경로를 반복 요청한 것이다 — 재디스패치 안내에 그 사실을 싣는다.
  | { kind: "permission_stall"; polls: number; elapsedMs: number; stalledMs: number; permissionID?: string; permissionType?: string; permissionPatterns?: string[]; permissionReason?: PermissionStallReason; permissionScope?: string; permissionCorrections?: number }
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
  // 세션 하나에서 스코프 밖 요청을 abort 없이 피드백 거부로 돌려보내는 횟수 상한.
  // 초과하면 종전 경로(reject + abort → permission_stall) 로 떨어진다. 0 이면
  // in-place correction 을 끈다. Default: 3.
  maxPermissionCorrections?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    debug?: (msg: string) => void;
    // 회복 가능한 이상 상황 (in-place correction 등). 없으면 error 로 떨어진다.
    warn?: (msg: string) => void;
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
  // 지금 이 순간 툴이 실행 중인가 — 실시간 신호.
  //
  // `hasPendingToolCall` 은 폴 시점에 읽은 **메시지 스냅샷**이라, 서버가 tool part
  // 를 메시지에 반영하기 전에는 false 로 보인다. 실측된 오판 2건 모두
  // `tool.execute.before` 발화 후 110ms / 108ms 안의 폴이었고, 그 폴에서
  // `finishComplete=true` + `textLen=0` 으로 완료 판정이 내려져 **툴을 실행 중이던
  // 세션이 abort** 됐다 (GitHub issue #7).
  //
  // 플러그인은 이미 그 순간의 진실을 알고 있다 — `tool.execute.before` 에서 세션별
  // 활성 툴 카운터를 올리고 `tool.execute.after` 에서 내린다. 카운터가 >0 이면 툴이
  // 실제로 실행 중이라는 뜻이다. 그 신호를 주입해 스냅샷 지연을 메운다.
  //
  // `isRecentlyActive` 와 반드시 구분한다: 그쪽은 "최근 5분 안에 툴 활동이 있었나"
  // 라는 넓은 창(gone 오탐 방지용)이고, 이쪽은 "지금 실행 중인가" 라는 정확한
  // 순간값이다. 넓은 창을 완료 판정에 쓰면 정상 종료가 매번 5분씩 지연된다.
  // 미주입(undefined)이면 종전 동작과 동일하다.
  //
  // 인자로 이번 폴의 툴 스냅샷을 받는다 (무시해도 된다). 훅 사본의 레지스트리는
  // 툴이 throw 하면 after 훅이 돌지 않아 항목이 남는데, 스냅샷의 completed/error
  // part 로 그 항목을 정리할 수 있다 — 정리하지 않으면 실행 중으로 굳어 완료
  // 판정이 절대 타임아웃까지 유보된다.
  isToolExecuting?: (snapshot: ToolSnapshot) => boolean;
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

// opencode SDK 의 실제 part 타입은 **"tool"** 이다 (@opencode-ai/sdk 의 ToolPart:
// `type: "tool"`, `state: ToolState`). 종전 집합에는 "tool" 이 아예 없어서
// `hasPendingToolCall` 이 **프로덕션에서 항상 false** 였다 — 그 결과 이 값이
// 지키려던 것("docker/gradle 처럼 수 분 걸리는 툴 실행을 stall 로 오판하지 않는다")
// 이 통째로 무력화돼, 긴 빌드를 도는 정상 세션이 MESSAGE_STALL 로 abort 되고
// 재디스패치됐다. 배포 대상이 JVM(sbt) 저장소라 정면으로 걸리는 경로다.
// 구형/변형 shape 대비로 옛 이름도 남긴다.
const TOOL_CALL_PART_TYPES = new Set(["tool", "tool_call", "tool-call", "tool_use"]);

/** 아직 끝나지 않은 툴 상태 (ToolStatePending / ToolStateRunning). */
const IN_FLIGHT_TOOL_STATUSES = new Set(["pending", "running"]);
/** 확실히 끝난 툴 상태 (ToolStateCompleted / ToolStateError). */
const SETTLED_TOOL_STATUSES = new Set(["completed", "error"]);

/**
 * 스냅샷에서 툴 호출 ID 를 상태별로 모은다. settled 는 전체 메시지를 훑는다 —
 * 레지스트리에 남은 항목은 이전 turn 의 호출일 수도 있다. inFlight 는 마지막
 * assistant 메시지만 본다 (`hasPendingToolCall` 과 같은 기준).
 */
function collectToolSnapshot(messages: MessageLike[], lastAssistant: MessageLike | undefined): ToolSnapshot {
  const settledCallIDs = new Set<string>();
  const inFlightCallIDs = new Set<string>();
  for (const m of messages) {
    if (m.info?.role !== "assistant") continue;
    for (const part of m.parts ?? []) {
      if (!TOOL_CALL_PART_TYPES.has(part.type)) continue;
      if (typeof part.callID !== "string" || part.callID.length === 0) continue;
      const status = part.state?.status;
      if (typeof status === "string" && SETTLED_TOOL_STATUSES.has(status)) settledCallIDs.add(part.callID);
    }
  }
  for (const part of lastAssistant?.parts ?? []) {
    if (!isInFlightToolPart(part)) continue;
    if (typeof part.callID === "string" && part.callID.length > 0) inFlightCallIDs.add(part.callID);
  }
  return { settledCallIDs, inFlightCallIDs };
}

/**
 * "지금 실행 중인 툴 호출이 있는가".
 *
 * 타입만 보면 안 된다 — 마지막 assistant 메시지에는 이미 끝난 툴 파트가 여러 개
 * 들어 있으므로, `type === "tool"` 만 추가하면 이번에는 값이 **항상 true** 가 되어
 * stall 감지 자체가 꺼진다. 그래서 `state.status` 로 진행 중인 것만 센다.
 *
 * status 가 없는 알 수 없는 shape 은 **실행 중으로 본다**: 오탐(무거운 툴을 더
 * 기다림)은 절대 타임아웃이 받쳐주지만, 미탐(살아있는 세션을 죽임)은 진행 중이던
 * 작업을 통째로 버린다.
 */
function isInFlightToolPart(part: MessagePartLike): boolean {
  if (!TOOL_CALL_PART_TYPES.has(part.type)) return false;
  const status = part.state?.status;
  if (typeof status !== "string") return true;
  return IN_FLIGHT_TOOL_STATUSES.has(status);
}

// path.posix.dirname is used directly so the module works in both Node and test
// environments without importing 'path'. The separator is always '/' because
// opencode worktree paths are POSIX.
function posixDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/**
 * 자동 승인 범위의 루트 = worktree 의 **직계 부모 한 단계**.
 *
 * 형제(메인 저장소·다른 worktree)까지는 열고 그 위는 닫는다. 조부모를 열면
 * `/root/IdeaProjects/*` 하나가 모든 프로젝트 그룹을, 극단적으로 `/` 가 파일시스템
 * 전체를 자동 승인 대상으로 만든다 — 이 함수의 반환값은 사람의 확인 없이 `allow`
 * 로 응답되므로 그 확장은 승인 게이트 자체를 무력화한다 (GitHub #12 의 제안 1을
 * 채택하지 않은 이유). 조부모 요청은 **차단이 정답**이고, 회복은 범위를 넓히는 것이
 * 아니라 서브에이전트에게 허용 범위를 알려주고 재시도시키는 쪽(dispatch_stage 의
 * permission-block 재디스패치)이 맡는다.
 */
export function worktreeAllowedScope(worktree: string): string {
  return posixDirname(worktree);
}

/**
 * 스코프 밖 요청을 abort 없이 돌려보낼 때 툴 오류로 실리는 문구.
 *
 * 서브에이전트가 보는 것은 "The user rejected permission … with the following
 * feedback: <이 문구>" 다. 재디스패치 노트(`permissionBlockNote`)와 같은 내용을
 * 담되, **지금 이 세션에서 바로 고칠 수 있다**는 전제로 쓴다 — 대화 이력이 그대로
 * 남아 있으므로 새 세션에 실었던 "직전 세션이 죽었다" 류 설명은 필요 없다.
 * `remaining` 은 이번 교정 이후 남은 횟수다. 0 이면 다음 위반에서 세션이 종료된다.
 */
export function buildPermissionCorrectionMessage(input: {
  patterns: string[];
  worktree?: string;
  scope?: string;
  remaining: number;
}): string {
  const blocked = input.patterns.length ? JSON.stringify(input.patterns) : "(패턴 미상)";
  const scope = input.scope
    ? `${input.scope}/ 이하(worktree 와 그 형제 디렉토리)`
    : "worktree 와 그 형제 디렉토리";
  const wt = input.worktree ? `worktree(${input.worktree})` : "worktree";
  const budget = input.remaining > 0
    ? `남은 자동 교정 ${input.remaining}회 — 그 뒤에는 세션이 종료되고 지금까지의 작업이 버려진다.`
    : `자동 교정 한도에 도달했다 — 한 번 더 스코프 밖을 요청하면 세션이 종료되고 지금까지의 작업이 버려진다.`;
  return [
    `워크스페이스 밖 경로 요청이라 자동 거부됐다 (요청 패턴 ${blocked}). 이 세션에는 승인 채널이 없다 — 사용자에게 승인을 요청하지 말 것.`,
    `자동 승인 범위는 ${scope}뿐이고 그 위(조부모 이상)는 열리지 않는다.`,
    `조치: glob / grep / read / list / bash 의 경로 인자를 ${wt} 안으로 좁혀 다시 시도하라. 경로 인자를 아예 주지 않고 cwd 기준 상대 패턴을 쓰는 것이 가장 안전하다.`,
    `저장소 안에서 못 찾은 참조를 상위 디렉토리로 넓혀 찾지 말 것. 저장소 밖 자료가 꼭 필요하면 조사하지 말고, 필요한 이유를 최종 출력에 적어 보고하라.`,
    `임시 파일은 /tmp 가 아니라 worktree 안의 .makdoong2-team/<이슈키>/tmp/ 에 만든다.`,
    budget,
  ].join(" ");
}

/**
 * 모든 dispatch_stage 프롬프트에 상시 주입되는 경로 범위 안내 (선제 방어).
 *
 * 재디스패치 노트와 in-place 교정은 둘 다 **차단이 난 뒤**에 작동한다. 관측된
 * 위반은 우연이 아니라 의도된 것이었다 — 저장소 안 검색이 비자 모델이 상위
 * 디렉토리를 검색 루트로 **명시적으로** 넘겼다 (`glob {path:"/root/IdeaProjects"}`,
 * GitHub #12 재발 보고). 그 판단이 내려지기 전에 규칙을 보여주는 것이 가장 싸다.
 * 문구는 교정 메시지·재디스패치 노트와 같은 어휘를 쓴다 — 세 층이 다른 말을
 * 하면 모델은 어느 것이 규칙인지 모른다.
 */
export function buildPathScopePromptBlock(worktree: string, maxCorrections: number): string[] {
  const scope = worktreeAllowedScope(worktree);
  const budget = maxCorrections > 0
    ? `위반하면 툴 호출이 "The user rejected permission … with the following feedback: …" 오류로 실패하고 경로를 좁히라는 안내가 실린다 (세션당 ${maxCorrections}회). 그 이상 반복하면 세션이 종료되고 지금까지의 작업이 버려진다.`
    : `위반하면 세션이 즉시 종료되고 지금까지의 작업이 버려진다.`;
  return [
    `\n=== 경로 범위 (hardrule) ===`,
    `이 세션은 헤드리스라 권한 요청에 답할 사람이 없다. 자동 승인 범위는 ${scope}/ 이하(worktree 와 그 형제 디렉토리)뿐이고, 그 위(조부모 이상)는 열리지 않는다.`,
    `glob / grep / read / list / bash 의 경로 인자는 항상 worktree(${worktree}) 안으로 둔다. 경로 인자를 아예 주지 않고 cwd 기준 상대 패턴을 쓰는 것이 가장 안전하다.`,
    `저장소 안에서 못 찾은 참조(배포 설정·다른 프로젝트의 파일 등)를 상위 디렉토리로 넓혀 찾지 말 것. 저장소 밖 자료가 꼭 필요하면 조사하지 말고, 필요한 이유를 최종 출력에 적어 보고한다.`,
    `임시 파일은 /tmp 가 아니라 worktree 안의 .makdoong2-team/<이슈키>/tmp/ 에 만든다.`,
    budget,
  ];
}

// Returns true when every permission pattern resides within the allowed scope,
// defined as the parent directory of the worktree (siblings are the main repo
// and other worktrees — all legitimate access targets for engineers).
// Trailing glob suffixes (/* , /*/ , /**/ , /**) are stripped before prefix check.
export function isWithinWorktreeScope(patterns: string[], worktree: string): boolean {
  if (!worktree || patterns.length === 0) return false;
  const scope = worktreeAllowedScope(worktree);
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
  const warn = options.logger?.warn ?? err;

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
  const isToolExecuting = options.isToolExecuting;
  const permissionCheckIntervalPolls = options.permissionCheckIntervalPolls ?? 5;
  const maxPermissionCorrections = options.maxPermissionCorrections ?? 3;

  let pollCount = 0;
  let permissionCorrections = 0;
  let transientFailures = 0;
  let sessionEverAppeared = false;
  let hasProducedAssistantMessage = false;
  let lastProgressAt = startTime;
  let lastSeenMessageCount = -1;
  let lastAssistantSig = "";
  let nudged = false;
  let firstGoneObservedAt: number | null = null;
  // finish 단독 완료 신호를 처음 관측한 폴의 content 시그니처. 같은 시그니처를
  // 연속 두 폴에서 볼 때만 완료로 확정한다 (아래 finishOnlyCompletion 참조).
  let finishConfirmSig: string | null = null;
  let toolStallExemptLogged = false;

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
    const hasPendingToolCall = !!lastAssistant?.parts?.some(isInFlightToolPart);
    // 메시지 스냅샷(hasPendingToolCall)과 실시간 훅 신호(isToolExecuting)의 합집합.
    // 둘 중 하나라도 "툴이 떠 있다" 고 하면 완료로 판정하지 않는다 — 스냅샷은
    // 서버 반영이 늦고(issue #7), 훅 신호는 훅이 안 붙은 환경에서 아예 없다.
    // OR 로 묶어야 각자의 사각지대를 서로 덮는다.
    const toolExecuting = isToolExecuting
      ? isToolExecuting(collectToolSnapshot(messages, lastAssistant)) === true
      : false;
    const toolInFlight = hasPendingToolCall || toolExecuting;

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
      !toolInFlight &&
      !messagesChanged &&
      !status &&
      (sessionEverAppeared || (sessionAliveByMessages && hasProducedAssistantMessage));
    if (goneAdmitted) {
      if (firstGoneObservedAt === null) {
        firstGoneObservedAt = now();
        dbg?.(
          `[pollSubSession] GONE_ADMIT session=${sessionId} poll=${pollCount} ` +
          `sig="${currentAsstSig}" pending_tool=${hasPendingToolCall} tool_exec=${toolExecuting} ` +
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
          `active_signal=${activeSignal} pending_tool=${hasPendingToolCall} tool_exec=${toolExecuting} ` +
          `messages_changed=${messagesChanged} status=${status?.type ?? "absent"} ` +
          `— gone admission cleared before grace elapsed`,
        );
      }
      firstGoneObservedAt = null;
    }

    if (client.permission && pollCount % permissionCheckIntervalPolls === 0) {
      const permResult = await client.permission.list().catch(() => null);
      const pending = (permResult?.data ?? []).filter(p => p.sessionID === sessionId);
      const isWithinScope = (p: PermissionRequestLike): boolean =>
        p.permission === "external_directory" && (
          (!!options.allowedWorktree && isWithinWorktreeScope(p.patterns, options.allowedWorktree)) ||
          isMatchedByConfiguredRules(p.patterns, options.configuredAllowPatterns ?? [])
        );
      // 허용을 먼저 전부 답하고 거부는 그 뒤에 한다. opencode 의 `reject` 는 같은
      // 세션의 **다른 대기 요청까지 연쇄 거부**하므로(`Permission.reply`), 순서를
      // 섞으면 병렬 배치의 정당한 형제 디렉토리 요청이 스코프 밖 요청 하나에
      // 딸려 죽는다.
      const allowed = pending.filter(isWithinScope);
      const denied = pending.filter(p => !isWithinScope(p));
      for (const p of allowed) {
        dbg?.(
          `[pollSubSession] PERMISSION_ALLOW session=${sessionId} polls=${pollCount}` +
          ` permissionID=${p.id} type=${p.permission} patterns=${JSON.stringify(p.patterns)}` +
          ` scope=dirname(${options.allowedWorktree})`
        );
        await client.permission
          .reply({ path: { requestID: p.id }, body: { reply: "once" } })
          .catch(() => undefined);
      }
      for (const p of denied) {
        // 두 실패를 뭉뚱그리지 않는다. "허용 경로 밖" 은 대안 경로를 알려주면
        // 회복 가능하고, "external_directory 가 아닌 권한" 은 경로와 무관한
        // 에이전트 설정 문제라 조치가 정반대다. 종전에는 한 문장이었다.
        const reason: PermissionStallReason =
          p.permission === "external_directory"
            ? "outside_allowed_roots"
            : "non_external_permission";
        const permissionScope = options.allowedWorktree
          ? worktreeAllowedScope(options.allowedWorktree)
          : undefined;

        // ── in-place correction: 세션을 죽이지 않고 경로를 좁히게 한다 ─────────
        //
        // 관측된 차단은 전부 모델이 **명시적으로** 조부모를 검색 루트로 넘긴
        // 것이었다 (`glob {path:"/root/IdeaProjects"}` — 저장소 안 검색이 비어
        // 상위로 넓힌 것, GitHub #12 재발 보고). 이건 세션을 abort 할 일이 아니라
        // 툴 오류 하나로 고쳐질 일이다. `reject` 에 `message` 를 실으면 opencode 가
        // `CorrectedError` 로 바꿔 툴 호출만 실패시키고 루프는 계속 돈다 — 모델은
        // 그 문구를 읽고 같은 자리에서 경로를 좁힌다. 대화 이력·진행 중이던 병렬
        // 툴·지금까지의 작업이 전부 보존된다. 재디스패치는 이 예산이 소진된 뒤의
        // 후순위 경로다.
        //
        // 예산은 세션당 `maxPermissionCorrections` 회. 안내를 받고도 반복하면
        // 프롬프트로 고쳐지지 않는 것이므로 종전대로 abort → 재디스패치 →
        // hang_history 상한으로 넘긴다.
        const canCorrect =
          reason === "outside_allowed_roots" &&
          typeof client.permission.correct === "function" &&
          permissionCorrections < maxPermissionCorrections;
        if (canCorrect) {
          const remaining = maxPermissionCorrections - permissionCorrections - 1;
          const message = buildPermissionCorrectionMessage({
            patterns: p.patterns,
            worktree: options.allowedWorktree,
            scope: permissionScope,
            remaining,
          });
          const corrected = await client.permission
            .correct!({ path: { requestID: p.id }, body: { message } })
            .then(() => true)
            .catch((e: unknown) => {
              err(
                `[pollSubSession] PERMISSION_CORRECT_FAILED session=${sessionId} polls=${pollCount}` +
                ` permissionID=${p.id} error=${e} — falling back to reject + abort`
              );
              return false;
            });
          if (corrected) {
            permissionCorrections++;
            warn(
              `[pollSubSession] PERMISSION_CORRECT session=${sessionId} polls=${pollCount}` +
              ` permissionID=${p.id} type=${p.permission} patterns=${JSON.stringify(p.patterns)}` +
              ` scope=${permissionScope ?? "unknown"} corrections=${permissionCorrections}/${maxPermissionCorrections}` +
              ` — rejected with feedback, session continues`
            );
            // 연쇄 거부로 나머지 대기 요청은 이미 opencode 가 정리했다. 이번 폴에서
            // 더 답하면 NotFound 만 난다.
            break;
          }
        }

        err(
          `[pollSubSession] PERMISSION_STALL session=${sessionId} polls=${pollCount}` +
          ` permissionID=${p.id} type=${p.permission} patterns=${JSON.stringify(p.patterns)}` +
          ` reason=${reason} corrections=${permissionCorrections}/${maxPermissionCorrections} — auto-rejecting`
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
          permissionPatterns: p.patterns,
          permissionReason: reason,
          // 무엇이 막혔는지(patterns)만으로는 처방이 안 나온다 — **어디까지가
          // 허용인지**를 같이 실어야 서브에이전트가 경로를 좁혀 재시도할 수 있다.
          permissionScope,
          permissionCorrections,
        };
      }
    }

    // Tool-call stall — "툴 호출이 떠 있는데 아무 진전이 없다".
    //
    // 이 휴리스틱이 잡으려는 것은 **서브에이전트 컨텍스트에서 답할 수 없는 권한
    // 요청에 막힌** 툴 호출이다. 실행 자체가 오래 걸리는 툴(sbt·docker·gradle
    // 빌드)은 대상이 아니다 — 그런데 둘은 `stalledMs` 만 보면 구분되지 않는다.
    // tool part 의 state 변화는 시그니처(`id:partsLen:textLen`)를 바꾸지 않으므로
    // 5분짜리 빌드도 "진전 없음" 으로 보이고, 기본 임계 60초에서 abort 된다.
    // `hasPendingToolCall` 이 프로덕션에서 항상 false 였던 동안에는 이 경로가 한
    // 번도 발화하지 않아 드러나지 않았고, 그 값을 고치는 순간 무장됐다.
    //
    // `isToolExecuting()` 이 그 둘을 가른다. before 훅이 발화하고 after 훅이 아직
    // 안 돈 상태 = 툴이 실제로 **실행 중**이다. 이때는 죽이지 않는다. 진짜 권한
    // 대기는 매 폴 도는 `permission.list()` 경로가 요청 ID·패턴까지 짚어 정확히
    // 잡아내고, 그마저 실패해도 절대 타임아웃이 받쳐준다. 이 모듈의 위험 선호와
    // 같은 방향이다 — 미탐(살아있는 세션을 죽임)이 오탐(타임아웃까지 기다림)보다
    // 비싸다.
    if (hasPendingToolCall && toolExecuting && stalledMs >= toolCallStallThresholdMs && !toolStallExemptLogged) {
      toolStallExemptLogged = true;
      dbg?.(
        `[pollSubSession] TOOL_STALL_EXEMPT session=${sessionId} poll=${pollCount} ` +
        `stalled_ms=${stalledMs} threshold_ms=${toolCallStallThresholdMs} ` +
        `— 툴이 실행 중이므로 permission_stall 로 판정하지 않는다`,
      );
    }
    if (hasPendingToolCall && !toolExecuting && stalledMs >= toolCallStallThresholdMs) {
      // abort 전에 대기 중인 permission 요청을 1회 조회해 어떤 카테고리·경로가
      // 대기 중인지 abort 메시지에 남긴다 (issue #8 제안 2). 종전에는 폴러
      // 로그만으로 대기 대상을 특정할 수 없어 원인 규명에 코드 독해가 필요했다.
      // best-effort — client.permission 이 없거나(구버전 SDK) 조회가 실패해도
      // 종전과 동일한 무정보 outcome 으로 진행한다.
      let stalledPerm: PermissionRequestLike | undefined;
      if (client.permission) {
        const permResult = await client.permission.list().catch(() => null);
        stalledPerm = (permResult?.data ?? []).find(p => p.sessionID === sessionId);
      }
      err(
        `[pollSubSession] PERMISSION_STALL session=${sessionId} polls=${pollCount} stalledMs=${stalledMs}` +
        (stalledPerm
          ? ` pending permissionID=${stalledPerm.id} type=${stalledPerm.permission} patterns=${JSON.stringify(stalledPerm.patterns)}`
          : client.permission
            ? ` no pending permission observed for this session (tool part in flight, no tool.execute signal)`
            : ` pending permission unknown (permission source unavailable)`),
      );
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      return {
        kind: "permission_stall",
        polls: pollCount,
        elapsedMs: now() - startTime,
        stalledMs,
        permissionID: stalledPerm?.id,
        permissionType: stalledPerm?.permission,
        permissionPatterns: stalledPerm?.patterns,
        permissionReason: "tool_call_stall",
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
      !toolInFlight &&
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

    const finishComplete = hasFinish && !toolInFlight && properOrdering;

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
      !toolInFlight &&
      stalledFromProgress >= contentStableCompletionMs;

    // finish 단독 완료는 한 폴 더 확인하고 결론낸다.
    //
    // `finish` 는 "이번 assistant 메시지의 생성이 끝났다" 는 뜻이지 "세션이 끝났다"
    // 가 아니다. 모델이 tool call 로 턴을 마치면 그 순간 finish 가 붙고 곧바로 툴이
    // 실행된다. 그 사이(관측 110ms)에 폴이 끼면 tool part 는 아직 안 보이고 finish
    // 만 보여 **완료로 오판**한다 (issue #7). statusIdle(서버가 직접 idle 이라고
    // 말함)이나 contentStable(5분 무변화)이 함께 서 있으면 그런 오판이 아니므로
    // 즉시 결론내고, finish 뿐일 때만 한 폴(기본 2s) 뒤 재확인한다. 그 시점이면
    // tool part 가 메시지에 반영돼 있거나 isToolExecuting 이 참이라 판정이 취소된다.
    //
    // 재확인의 기준은 **content 시그니처 동일**이다. 시그니처가 바뀌었다는 것은
    // 이번 폴에서 내용이 움직였다는 뜻이고, 움직이는 중에는 결론내지 않는다.
    // (관측된 오판 2건 모두 `contentStable=false` — 내용이 아직 안정되지 않은
    // 상태에서 완료 판정이 내려졌다.)
    //
    // 비용은 finish 단독 경로에서 폴 1회다. worktree-CWD 세션(status map 이 CWD
    // 필터링되어 statusIdle 이 영영 안 뜬다)이 이 경로를 상시로 타지만, substage
    // 하나가 수 분인 것에 비하면 2초는 무시할 수 있다.
    const finishOnlyCompletion = finishComplete && !statusIdle && !contentStable;
    let deferredForConfirm = false;
    if (finishOnlyCompletion) {
      if (finishConfirmSig !== currentAsstSig) {
        finishConfirmSig = currentAsstSig;
        deferredForConfirm = true;
      }
    } else {
      finishConfirmSig = null;
    }
    const looksComplete = !deferredForConfirm && (statusIdle || finishComplete || contentStable);

    dbg?.(
      `[pollSubSession] POLL session=${sessionId} poll=${pollCount} status=${status?.type ?? "absent"} ` +
      `messages=${messages.length} finishComplete=${finishComplete} statusIdle=${statusIdle} ` +
      `contentStable=${contentStable} sessionEverAppeared=${sessionEverAppeared} ` +
      `pendingTool=${hasPendingToolCall} toolExec=${toolExecuting} deferredForConfirm=${deferredForConfirm}`,
    );
    if (deferredForConfirm) {
      dbg?.(
        `[pollSubSession] FINISH_CONFIRM_PENDING session=${sessionId} poll=${pollCount} ` +
        `sig="${currentAsstSig}" — finish 단독 완료 신호. 한 폴 뒤 재확인한다`,
      );
    }

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

    // 공백만 있는 text part 는 "짧은 서두" 가 아니라 "아직 텍스트가 없음" 이다.
    // 종전에는 `text.length > 0` 만 보고 preamble 분기에 들어갔고, trim 길이 0 은
    // 임계 미만이라 그대로 preamble_only 로 확정됐다 — 로그의 `textLen=0` 이 바로
    // 이 경로다 (issue #7). 스트리밍 초기 상태를 "서두만 쓰고 끝냈다" 로 읽는
    // 것이라 오판의 방향이 정반대다. 정상 반환된 서브에이전트 출력들도 모두
    // `\n\n` 으로 시작한다는 관측이 이 경로가 상시 노출돼 있었음을 말한다.
    //
    // 텍스트 없음으로 떨어뜨리면 dispatch_stage 는 "작업을 다시 하라" 는 action
    // 재프롬프트 대신 요약 재프롬프트를 보내고, `.done=true` override 도 그대로
    // 걸린다 — 이미 끝난 작업을 되풀이시키지 않는 쪽이다.
    const trimmedLen = text.trim().length;

    if (trimmedLen > 0) {
      if (
        preambleOnlyTextThreshold !== undefined &&
        preambleOnlyTextThreshold > 0 &&
        trimmedLen < preambleOnlyTextThreshold &&
        !toolInFlight
      ) {
        dbg?.(
          `[pollSubSession] preamble-only detected session=${sessionId} ` +
          `textLen=${trimmedLen} threshold=${preambleOnlyTextThreshold} — ` +
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

    if (text.length > 0) {
      dbg?.(
        `[pollSubSession] whitespace-only text session=${sessionId} raw_len=${text.length} — ` +
        `텍스트 없음으로 처리 (preamble_only 아님)`,
      );
      return {
        kind: "empty",
        reason: "whitespace_only_text",
        polls: pollCount,
        elapsedMs: now() - startTime,
      };
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
 * `permission_stall` 보고 시 team-leader 가 그대로 따라야 하는 지시.
 *
 * dispatch_stage 응답의 `next_action` 으로 실린다. 하드룰 4("next_action 을 그대로
 * 따른다")가 적용되는 자리이며, 문구를 바꿀 때는 agents/makdoong2-team-leader.md 의
 * permission_stall 하드룰과 함께 고친다 (test/poll-permission-scope.test.ts 가 강제).
 */
export const PERMISSION_STALL_NEXT_ACTION =
  "이 실패는 사용자 승인으로 해소되지 않는다 — 권한 요청은 이미 자동 거부됐고 서브세션도 abort 된 뒤다. " +
  "헤드리스 서브세션에는 승인을 받을 채널 자체가 없으므로, 사용자에게 '권한을 승인한 뒤 재개해 달라' 고 " +
  "요청하는 것은 실행 불가능한 지시다. 절대 그렇게 보고하지 말 것. " +
  "output 원문과 permission_patterns / permission_scope 를 그대로 인용해 '차단되어 종료됨' 으로 보고하고, " +
  "permission_reason 별 처방을 따르라: outside_allowed_roots → 자동 재디스패치(허용 범위 안내 주입)가 이미 " +
  "소진된 상태다. 같은 인자로 재호출하지 말고 차단된 경로와 허용 범위를 보고한 뒤 사용자 지시를 기다린다. " +
  "non_external_permission → 해당 에이전트 frontmatter 의 permission 블록 문제다 (정식 키는 `edit`). " +
  "tool_call_stall → `npx makdoong2-team doctor` 로 설치 상태를 점검한다.";

/**
 * Convert a {@link PollOutcome} into a display string plus a boolean success
 * flag. Used by callers that need a single string for downstream serialization
 * (e.g., embedding in a JSON response) but must also know whether the
 * sub-agent actually produced work.
 */
export function pollOutcomeToLegacy(
  outcome: PollOutcome,
): { text: string; success: boolean; nextAction?: string } {
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
    case "permission_stall": {
      // 사유별로 **처방이 다르다.** 종전에는 셋을 한 문장으로 보고해서, 워크스페이스
      // 밖 접근(대안 경로를 알려주면 끝날 일)과 부분 설치(재설치가 필요한 일)와
      // 에이전트 오설정이 전부 같은 메시지로 나왔다.
      const detail = outcome.permissionType
        ? `${outcome.permissionType} permission (id=${outcome.permissionID}` +
          `${outcome.permissionPatterns ? `, patterns=${JSON.stringify(outcome.permissionPatterns)}` : ""})`
        : "an unidentified permission request";
      const remedy = (() => {
        switch (outcome.permissionReason) {
          case "outside_allowed_roots": {
            // 종전에는 처방이 "임시 파일은 worktree 안에 써라" 하나뿐이었다. 정작
            // 실제로 막힌 것은 read-only `glob` 이었고(GitHub #12), 그 안내는 상황과
            // 무관해 아무 조치도 유도하지 못했다. 무엇이 막혔는지(patterns)와
            // **어디까지가 허용인지**(scope)를 먼저 못 박고, 조회/쓰기 두 갈래로 나눈다.
            const blocked = outcome.permissionPatterns?.length
              ? JSON.stringify(outcome.permissionPatterns)
              : "(패턴 미상)";
            const scope = outcome.permissionScope
              ? `\`${outcome.permissionScope}/\` 이하 (worktree 와 그 형제 디렉토리)`
              : "worktree 와 그 형제 디렉토리";
            // in-place 교정이 있었다면 abort 는 "안내를 받고도 같은 범위를 다시
            // 요청했다" 는 뜻이다. 그 횟수를 보고에 싣지 않으면 리더는 첫 차단과
            // 구분할 수 없어 같은 안내를 한 번 더 주입하는 데 그친다.
            const corrections = outcome.permissionCorrections ?? 0;
            const correctionNote = corrections > 0
              ? `세션 안에서 ${corrections}회 경로 교정 안내(피드백 거부)를 받고도 같은 범위를 다시 요청해 abort 됐다. `
              : "";
            return `워크스페이스 밖 경로 접근이라 차단됐다 — 요청 ${blocked}, 자동 승인 범위 ${scope}. ${correctionNote}` +
              "그 위(조부모 이상)는 설계상 열지 않는다: 한 번 열면 형제 프로젝트 전체가 사람의 확인 없이 승인 대상이 된다. " +
              "조치는 둘 중 하나다. " +
              "(1) 조회(glob/grep/read/list)라면 경로 인자를 허용 범위 안으로 좁혀라 — 경로 인자 없이 cwd 기준 상대 패턴을 쓰는 것이 가장 안전하다. " +
              "저장소 밖을 훑어야만 하는 작업이면 수행하지 말고 그 사실을 최종 출력에 적어 보고하라. " +
              "(2) 임시 파일이 필요하면 `/tmp` 이 아니라 worktree 안의 " +
              "`.makdoong2-team/<이슈키>/tmp/` 에 만들어라 — 그 경로는 cwd 안이라 승인이 필요 없고, " +
              "git exclude 와 worktree 동기화 대상이다. `/tmp` 에 쓴 것은 동기화도 커밋도 되지 않아 조용히 사라진다.";
          }
          case "non_external_permission":
            return "external_directory 가 아닌 권한 요청이 서브에이전트에 도달했다 — 경로 문제가 아니라 " +
              "에이전트 permission 설정 문제다. 해당 에이전트의 frontmatter `permission:` 블록을 점검하라 " +
              "(정식 키는 `edit`; `write` 키는 존재하지 않아 조용히 무시된다).";
          default:
            return "툴 호출 part 가 떠 있는데 실행 신호(tool.execute.before)도 권한 요청도 관측되지 않았다. 점검: " +
              "(1) 세션의 디렉토리에서도 플러그인이 로드되는가 — 로그의 `[init] plugin instance directory=…` 가 " +
              "worktree 경로로도 찍혀야 한다 (opencode 는 디렉토리마다 플러그인을 따로 초기화한다) " +
              "(2) opencode.json 의 permission.external_directory 시드 (`npx makdoong2-team doctor`).";
        }
      })();
      return {
        text:
          `(permission_stall: sub-agent blocked on ${detail} — cannot be answered in subagent context; ` +
          `aborted after ${outcome.stalledMs}ms. reason=${outcome.permissionReason ?? "unknown"})\n` +
          `→ ${remedy}`,
        success: false,
        // 이 한 줄이 없어서 team-leader 가 "이미 abort 됨" 을 "승인 대기 중" 으로
        // 재해석해, 존재하지 않는 승인 행위를 사용자에게 요구하며 워크플로를
        // 세웠다 (GitHub #12). 헤드리스 서브세션에는 승인 채널이 없다 — 그래서
        // 훅이 대신 거부한 것이고, 사용자가 할 수 있는 일은 애초에 없다.
        nextAction: PERMISSION_STALL_NEXT_ACTION,
      };
    }
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
