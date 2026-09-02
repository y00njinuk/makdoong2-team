// 프로세스 전역 서브세션 레지스트리 — 플러그인 사본 사이의 공유 신호.
//
// opencode 1.18 은 **디렉토리(Instance)마다 플러그인을 따로 초기화한다**.
// `dispatch_stage` 는 서브세션을 `directory=<worktree>` 로 만들므로 그 세션의
// `tool.execute.before/after` · `event` 훅은 worktree Instance 의 플러그인 사본에서
// 발화하고, 그 세션을 감시하는 `pollSubSession` 은 main Instance 의 사본에서 돈다.
// 사본마다 자기 Map 을 들고 있으면 폴러는 언제나 빈 Map 을 본다 —
// `isToolExecuting()` 이 영영 false 라 60초를 넘는 모든 툴(sbt test 등)이
// `permission_stall`(reason=tool_call_stall) 로 abort 됐다 (GitHub issue #10).
//
// 그래서 사본을 가로지르는 신호는 전부 여기, `globalThis` 에 둔다. 같은 프로세스
// 안의 모든 사본이 — 모듈 경로가 달라 module cache 가 갈리더라도 — 한 객체를 본다.
// 여기 두는 것은 "훅 사본이 쓰고 폴러 사본이 읽는" 세션 단위 신호뿐이다.
// `pendingDispatch` 같은 디스패치 소유 상태는 공유하지 않는다 — 공유하면 worktree
// 사본의 `session.created` 핸들러가 pane 을 한 번 더 띄운다.
//
// 이 파일은 src/opencode-plugin.ts 에서 import 만 한다 (re-export 금지 —
// 로더가 모든 named export 를 plugin factory 로 호출한다).

export type PendingPermission = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  askedAt: number;
};

export interface SubSessionRegistry {
  readonly version: 1;
  /** sessionID → (callID → startedAt). before 에서 넣고 after / 툴 part 종결에서 뺀다. */
  readonly activeToolCalls: Map<string, Map<string, number>>;
  /** sessionID → 마지막 tool.execute.* 발화 시각. */
  readonly lastToolExecuteAt: Map<string, number>;
  /** sessionID → (requestID → 요청). permission.asked 로 넣고 replied 로 뺀다. */
  readonly pendingPermissions: Map<string, Map<string, PendingPermission>>;
  /** sessionID → 이슈키. dispatch 사본이 쓰고 훅 사본(guard-bash.sh 인자)이 읽는다. */
  readonly sessionIssue: Map<string, string>;
  /** sessionID → worktree 절대경로. auto-git-add 가 읽는다. */
  readonly sessionWorktree: Map<string, string>;
  /** session.deleted 대기자. abort 후 재디스패치 전 race window 를 닫는다. */
  readonly sessionDeletedWaiters: Map<string, Array<() => void>>;
  /** callID 가 없는 before 훅에 붙일 대체 키 일련번호. */
  anonSeq: number;
}

const SHARED_KEY = Symbol.for("makdoong2-team.sub-session-registry.v1");

export function createSubSessionRegistry(): SubSessionRegistry {
  return {
    version: 1,
    activeToolCalls: new Map(),
    lastToolExecuteAt: new Map(),
    pendingPermissions: new Map(),
    sessionIssue: new Map(),
    sessionWorktree: new Map(),
    sessionDeletedWaiters: new Map(),
    anonSeq: 0,
  };
}

/**
 * 프로세스 전역 레지스트리. 첫 호출이 만들고 이후 호출은 같은 객체를 돌려준다.
 * 키에 버전을 박아 두어, 형태가 다른 미래 버전이 같은 프로세스에 섞여도 서로의
 * 객체를 깨뜨리지 않는다.
 */
export function sharedSubSessionRegistry(): SubSessionRegistry {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[SHARED_KEY] as SubSessionRegistry | undefined;
  if (existing && existing.version === 1) return existing;
  const created = createSubSessionRegistry();
  g[SHARED_KEY] = created;
  return created;
}

/** 테스트 전용 — 전역 객체를 비운다. */
export function resetSharedSubSessionRegistryForTests(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[SHARED_KEY];
}

// ── 툴 실행 신호 ─────────────────────────────────────────────────────────────

const ANON_PREFIX = "anon#";

/** `tool.execute.before` — 이 세션에서 callID 툴이 실행을 시작했다. 사용한 키를 돌려준다. */
export function toolStarted(
  reg: SubSessionRegistry,
  sessionID: string,
  callID: string | undefined,
  now: number = Date.now(),
): string {
  const key = typeof callID === "string" && callID.length > 0 ? callID : `${ANON_PREFIX}${++reg.anonSeq}`;
  let calls = reg.activeToolCalls.get(sessionID);
  if (!calls) {
    calls = new Map();
    reg.activeToolCalls.set(sessionID, calls);
  }
  calls.set(key, now);
  reg.lastToolExecuteAt.set(sessionID, now);
  return key;
}

/**
 * `tool.execute.after` 또는 툴 part 의 completed/error 관측 — 실행이 끝났다.
 * 멱등이다: 같은 callID 를 두 번 끝내도, 모르는 callID 를 끝내도 아무 일도 없다.
 * callID 가 없으면 가장 최근에 시작한 항목을 뺀다 (종전 카운터 의미 유지).
 */
export function toolFinished(
  reg: SubSessionRegistry,
  sessionID: string,
  callID: string | undefined,
  now: number = Date.now(),
): boolean {
  reg.lastToolExecuteAt.set(sessionID, now);
  const calls = reg.activeToolCalls.get(sessionID);
  if (!calls || calls.size === 0) return false;
  let key: string | undefined;
  if (typeof callID === "string" && callID.length > 0) {
    if (!calls.has(callID)) return false;
    key = callID;
  } else {
    let latest = -Infinity;
    for (const [k, startedAt] of calls) {
      if (startedAt >= latest) {
        latest = startedAt;
        key = k;
      }
    }
  }
  if (key === undefined) return false;
  calls.delete(key);
  if (calls.size === 0) reg.activeToolCalls.delete(sessionID);
  return true;
}

/**
 * 메시지 스냅샷과 대조해 이미 끝난 호출을 정리한다.
 *
 * 툴이 throw 하면(권한 거부 · 파일 없음 · MCP 오류) opencode 는 `tool.execute.after`
 * 를 부르지 않는다 — 항목이 영영 남아 `isToolExecuting()` 이 참으로 굳고, 그러면
 * 완료 판정이 유보돼 substage 가 절대 타임아웃까지 기다린다. 스냅샷의 tool part
 * 가 completed/error 면 그 호출은 확실히 끝난 것이므로 여기서 뺀다. 스냅샷에
 * **아직 없는** 호출은 건드리지 않는다 (issue #7 의 110ms 창 — 훅은 발화했는데
 * 서버가 part 를 아직 반영하지 않은 상태). 정리한 개수를 돌려준다.
 */
export function settleToolCalls(
  reg: SubSessionRegistry,
  sessionID: string,
  settledCallIDs: Iterable<string>,
): number {
  const calls = reg.activeToolCalls.get(sessionID);
  if (!calls || calls.size === 0) return 0;
  let n = 0;
  for (const id of settledCallIDs) {
    if (calls.delete(id)) n++;
  }
  if (calls.size === 0) reg.activeToolCalls.delete(sessionID);
  return n;
}

/** 지금 이 순간 이 세션에서 실행 중인 툴이 있는가 (순간값). */
export function isToolExecuting(reg: SubSessionRegistry, sessionID: string): boolean {
  return (reg.activeToolCalls.get(sessionID)?.size ?? 0) > 0;
}

export function activeToolCount(reg: SubSessionRegistry, sessionID: string): number {
  return reg.activeToolCalls.get(sessionID)?.size ?? 0;
}

/** 세션이 idle 로 전이했다 — 실행 중인 툴은 정의상 없다. */
export function clearToolCalls(reg: SubSessionRegistry, sessionID: string): void {
  reg.activeToolCalls.delete(sessionID);
}

// ── 권한 요청 관측 ───────────────────────────────────────────────────────────

/**
 * 플러그인 `event` 훅이 받는 권한 요청 이벤트를 공통 형태로 바꾼다.
 *
 * 1.18 v1 브리지는 `permission.asked` 를 `PermissionRequest` 그대로 싣는다
 * (`id / sessionID / permission / patterns`). 더 오래된 SDK 형태 `permission.updated`
 * 는 `type` · `pattern`(문자열 또는 배열) 을 쓴다. 둘 다 받아 둔다 — 어느 쪽이 오든
 * 폴러가 보는 것은 같은 shape 이어야 한다. 요청으로 볼 수 없는 페이로드는 null.
 */
export function normalizePermissionEvent(
  type: string,
  properties: unknown,
  now: number = Date.now(),
): PendingPermission | null {
  if (type !== "permission.asked" && type !== "permission.updated") return null;
  if (!properties || typeof properties !== "object") return null;
  const p = properties as Record<string, unknown>;
  const id = typeof p.id === "string" ? p.id : undefined;
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : undefined;
  if (!id || !sessionID) return null;
  const permission =
    typeof p.permission === "string" ? p.permission
    : typeof p.type === "string" ? p.type
    : "unknown";
  const rawPatterns = p.patterns ?? p.pattern;
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns.filter((x): x is string => typeof x === "string")
    : typeof rawPatterns === "string" ? [rawPatterns]
    : [];
  return { id, sessionID, permission, patterns, askedAt: now };
}

export function permissionAsked(reg: SubSessionRegistry, req: PendingPermission): void {
  let bySession = reg.pendingPermissions.get(req.sessionID);
  if (!bySession) {
    bySession = new Map();
    reg.pendingPermissions.set(req.sessionID, bySession);
  }
  bySession.set(req.id, req);
}

export function permissionReplied(reg: SubSessionRegistry, sessionID: string, requestID: string): void {
  const bySession = reg.pendingPermissions.get(sessionID);
  if (!bySession) return;
  bySession.delete(requestID);
  if (bySession.size === 0) reg.pendingPermissions.delete(sessionID);
}

/** 이 세션에 답을 기다리는 권한 요청 — 오래된 순. */
export function pendingPermissionsFor(reg: SubSessionRegistry, sessionID: string): PendingPermission[] {
  const bySession = reg.pendingPermissions.get(sessionID);
  if (!bySession) return [];
  return [...bySession.values()].sort((a, b) => a.askedAt - b.askedAt);
}

// ── 수명 ─────────────────────────────────────────────────────────────────────

/** 세션 하나의 흔적을 전부 지운다 (cleanupSubSession · session.deleted). */
export function forgetSession(reg: SubSessionRegistry, sessionID: string): void {
  reg.activeToolCalls.delete(sessionID);
  reg.lastToolExecuteAt.delete(sessionID);
  reg.pendingPermissions.delete(sessionID);
  reg.sessionIssue.delete(sessionID);
  reg.sessionWorktree.delete(sessionID);
}

/** session.deleted — 대기자를 전부 깨운다. 깨운 수를 돌려준다. */
export function notifySessionDeleted(reg: SubSessionRegistry, sessionID: string): number {
  const waiters = reg.sessionDeletedWaiters.get(sessionID);
  if (!waiters || waiters.length === 0) return 0;
  const copy = [...waiters];
  for (const w of copy) {
    try { w(); } catch { /* waiter 오류는 이벤트 처리를 막지 않는다 */ }
  }
  return copy.length;
}
