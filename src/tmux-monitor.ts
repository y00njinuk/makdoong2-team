// tmux-monitor.ts — sub-session pane monitor for makdoong2-team.
//
// Adapted from oh-my-opencode's `features/tmux-subagent` pattern:
//   - buildTmuxAttachCommand(serverUrl, sessionId) → `opencode attach <id>`
//   - tmux split-window -h -P -F '#{pane_id}' opens a side pane attached to
//     the sub-session, letting 부장님 watch each 막둥이 live.
//   - polling/eviction logic from omo's manager is dropped because
//     dispatch_stage runs at most one sub-session at a time.
//
// Activated only when (a) MAKDOONG2 is invoked from inside tmux AND
// (b) tmux.enabled=true in makdoong2-team.json. Otherwise every method is a no-op so the
// non-tmux happy path is untouched.

type ShellTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  cwd(dir: string): ReturnType<ShellTag>;
  quiet(): ReturnType<ShellTag>;
  nothrow(): ReturnType<ShellTag>;
  then<T>(onfulfilled: (value: ShellResult) => T): Promise<T>;
};

interface ShellResult {
  exitCode: number;
  stdout?: { toString(): string };
  stderr?: { toString(): string };
}

import { logger } from "./logger.ts";

export type TmuxLayout =
  | "main-vertical"
  | "main-horizontal"
  | "tiled"
  | "even-horizontal"
  | "even-vertical";

export type TmuxPlacement = "window" | "pane";

export const FOCUS_POLL_INTERVAL_MS = 2_000;

export interface TmuxMonitorConfig {
  enabled: boolean;
  placement: TmuxPlacement;
  layout: TmuxLayout;
  mainPaneSize: number;
  agentPaneMinWidth: number;
  splitDirection: "-h" | "-v";
  attachCommand: string;
  serverUrl?: string;
  keepPaneOnSuccess: boolean;
  autoCloseOnFailure: boolean;
  paneCloseDelaySeconds: number;
}

interface TrackedPane {
  sessionId: string;
  paneId: string;
  stage: string;
  agent: string;
  createdAt: Date;
  lastSuccess?: boolean;
  pending?: Promise<string | null>;
  attachCommand?: string;
  awaitingFocus?: boolean;
}

export function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function buildWindowName(stage: string, sessionId: string): string {
  const safeStage = stage.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `mdn2-${safeStage || "stage"}-${sessionId.slice(-8)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildPlaceholderCommand(stage: string, agent: string, sessionId: string): string {
  const banner = shellSingleQuote(`막둥이 ${agent} — ${stage} [${sessionId.slice(-8)}]`);
  const hint = shellSingleQuote("이 창을 선택하면 세션 화면으로 자동 전환됩니다.");
  return `printf '%s\\n%s\\n' ${banner} ${hint}; while :; do sleep 86400; done`;
}

// Pane ownership markers stored as tmux pane user options (`set-option -p`,
// tmux >= 3.0 — enforced by checkTmuxVersion at plugin init).
// Written by spawnPaneInner, read by cleanupOrphans / closePane fallback / reap pass.
export const MARKER_SESSION = "@mdn2_session";
export const MARKER_PID     = "@mdn2_pid";
export const MARKER_STAGE   = "@mdn2_stage";
export const MARKER_STARTED = "@mdn2_started_at";

// Parent opencode discriminator: the `oc` wrapper script always launches the
// parent as `opencode "$@" --port`, so any pane whose start_command contains
// `--port` MUST be excluded from cleanup regardless of markers.
export const PARENT_MARKER_PATTERN = /--port(\s|$)/;

export interface TmuxConfigBlock {
  enabled?: boolean;
  placement?: string;
  layout?: string;
  main_pane_size?: number;
  agent_pane_min_width?: number;
  split_direction?: string;
  attach_command?: string;
  server_url?: string | null;
  keep_pane_on_success?: boolean;
  auto_close_on_failure?: boolean;
  pane_close_delay_seconds?: number;
}

export function readTmuxConfig(block?: TmuxConfigBlock): TmuxMonitorConfig {
  const b = block ?? {};
  const layoutRaw = b.layout ?? "main-vertical";
  const layout: TmuxLayout =
    (["main-vertical", "main-horizontal", "tiled",
      "even-horizontal", "even-vertical"] as const).includes(layoutRaw as TmuxLayout)
      ? (layoutRaw as TmuxLayout)
      : "main-vertical";
  const splitRaw = b.split_direction ?? "-h";
  // Defaults to "window": "pane" resizes 부장님's pane on every spawn/kill.
  // ARCHITECTURE.md §17.6.
  const placement: TmuxPlacement = b.placement === "pane" ? "pane" : "window";
  return {
    enabled: b.enabled === true,
    placement,
    layout,
    mainPaneSize: typeof b.main_pane_size === "number" ? b.main_pane_size : 60,
    agentPaneMinWidth: typeof b.agent_pane_min_width === "number" ? b.agent_pane_min_width : 52,
    splitDirection: splitRaw === "-v" ? "-v" : "-h",
    attachCommand: b.attach_command ?? "opencode attach",
    serverUrl: b.server_url || undefined,
    keepPaneOnSuccess: b.keep_pane_on_success === true,
    autoCloseOnFailure: b.auto_close_on_failure === true,
    paneCloseDelaySeconds: typeof b.pane_close_delay_seconds === "number" ? b.pane_close_delay_seconds : 5,
  };
}

export interface OrphanScanResult {
  paneId: string;
  sessionId: string;
  stage?: string;
  startedAt?: number;
  ownerPid?: number;
  startCommand?: string;
}

export interface CleanupOrphansOptions {
  graceSeconds?: number;
  now?: () => number;
}

/** EPERM means the pid exists but belongs to another user — still alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Grace window applied to freshly spawned panes during the orphan-scan tick.
 * opencode's session.status() is scoped to the requesting directory, so a
 * sub-session created inside a worktree never appears in the parent's status
 * map. Without a spawn grace the very first tick after split-window reads
 * `status=undefined` and kills a perfectly healthy pane.
 */
export const ORPHAN_SPAWN_GRACE_MS = 120_000;

const EVICTION_DISABLED = 0;

export type OrphanGuardReason =
  | "foreign-live-owner"
  | "spawn-grace"
  | "tool-activity";

export interface OrphanGuardContext {
  nowMs: number;
  ownerPid: number;
  lastToolExecuteAtMs?: number;
  activeToolCount?: number;
  spawnGraceMs?: number;
  toolAliveWindowMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** @returns the guard that fired, or undefined when the pane may be cleaned up. */
export function orphanCleanupGuard(
  pane: Pick<OrphanScanResult, "ownerPid" | "startedAt">,
  ctx: OrphanGuardContext,
): OrphanGuardReason | undefined {
  const alive = ctx.isPidAlive ?? isPidAlive;
  if (pane.ownerPid !== undefined && pane.ownerPid !== ctx.ownerPid && alive(pane.ownerPid)) {
    return "foreign-live-owner";
  }

  const spawnGraceMs = ctx.spawnGraceMs ?? ORPHAN_SPAWN_GRACE_MS;
  if (spawnGraceMs > 0 && pane.startedAt !== undefined) {
    if (ctx.nowMs - pane.startedAt * 1000 < spawnGraceMs) return "spawn-grace";
  }

  if ((ctx.activeToolCount ?? 0) > 0) return "tool-activity";
  const toolAliveWindowMs = ctx.toolAliveWindowMs ?? 300_000;
  if (
    typeof ctx.lastToolExecuteAtMs === "number"
    && ctx.nowMs - ctx.lastToolExecuteAtMs < toolAliveWindowMs
  ) {
    return "tool-activity";
  }

  return undefined;
}

export interface CleanupOrphansReport {
  tracked_closed: number;
  orphans_closed: number;
  parents_skipped: number;
  fresh_skipped: number;
  total_closed: number;
}

export class TmuxMonitor {
  private readonly panes: Map<string, TrackedPane>;
  private readonly sourcePaneId: string | undefined;
  private readonly $: ShellTag;
  private readonly ownerPid: number;
  private tmuxVersionCache: { ok: boolean; version: string } | null = null;
  private versionBlocked = false;
  private focusTimer: ReturnType<typeof setInterval> | null = null;
  private focusPollInFlight = false;
  public readonly config: TmuxMonitorConfig;

  constructor(shell: ShellTag, config: TmuxMonitorConfig, ownerPid?: number) {
    this.$ = shell;
    this.config = config;
    this.panes = new Map();
    this.sourcePaneId = process.env.TMUX_PANE || undefined;
    this.ownerPid = ownerPid ?? process.pid;
  }

  get active(): boolean {
    return this.config.enabled && isInsideTmux() && !this.versionBlocked;
  }

  get trackedPaneCount(): number {
    return this.panes.size;
  }

  get ownerProcessId(): number {
    return this.ownerPid;
  }

  async checkTmuxVersion(): Promise<{ ok: boolean; version: string }> {
    if (this.tmuxVersionCache) return this.tmuxVersionCache;
    const r = await this.$`tmux -V`.quiet().nothrow();
    if (r.exitCode !== 0) {
      this.tmuxVersionCache = { ok: false, version: "unknown" };
      return this.tmuxVersionCache;
    }
    const raw = (r.stdout?.toString().trim() ?? "");
    const m = raw.match(/tmux(?:\s+(?:next-)?)\s*(\d+)\.(\d+)/);
    if (!m) {
      this.tmuxVersionCache = { ok: false, version: raw };
      return this.tmuxVersionCache;
    }
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major < 3) {
      this.versionBlocked = true;
      throw new Error(
        `tmux ${major}.${minor} is not supported. makdoong2-team@1.x requires tmux >= 3.0 ` +
        `for pane-scoped user options (\`set-option -p\`). Upgrade tmux or downgrade to ` +
        `makdoong2-team@0.x which supports tmux 2.7+.`
      );
    }
    this.tmuxVersionCache = { ok: true, version: `${major}.${minor}` };
    return this.tmuxVersionCache;
  }

  async spawnPane(
    sessionId: string,
    stage: string,
    agent: string,
    worktree: string,
  ): Promise<string | null> {
    if (!this.active) return null;

    const existing = this.panes.get(sessionId);
    if (existing) {
      logger.debug(
        `[tmux-monitor] spawnPane DUPLICATE-GUARD session=${sessionId} ` +
        `existing_paneId="${existing.paneId}" pending=${!!existing.pending} — returning cached`,
      );
      if (existing.pending) return existing.pending;
      return existing.paneId || null;
    }
    logger.debug(
      `[tmux-monitor] spawnPane ENTER session=${sessionId} stage=${stage} agent=${agent}`,
    );

    const placeholder: TrackedPane = {
      sessionId,
      paneId: "",
      stage,
      agent,
      createdAt: new Date(),
    };
    this.panes.set(sessionId, placeholder);

    const pending = (async () => {
      try {
        const paneId = await this.spawnPaneInner(sessionId, stage, agent, worktree);
        if (paneId) {
          placeholder.paneId = paneId;
          return paneId;
        }
        this.panes.delete(sessionId);
        return null;
      } catch (e) {
        this.panes.delete(sessionId);
        throw e;
      } finally {
        placeholder.pending = undefined;
      }
    })();
    placeholder.pending = pending;
    return pending;
  }

  private async spawnPaneInner(
    sessionId: string,
    stage: string,
    agent: string,
    worktree?: string,
  ): Promise<string | null> {
    const effectiveUrl = this.config.serverUrl ?? await this.discoverServerUrl();
    if (!effectiveUrl) {
      logger.warn(
        `[tmux-monitor] SERVER_URL_UNRESOLVED session=${sessionId} — ` +
        `pane attach will use fallback (no URL). ` +
        `Set tmux.server_url in makdoong2-team.json or ensure discoverServerUrl can find the process.`
      );
    }
    const dirFlag = worktree ? ` --dir '${worktree.replace(/'/g, "'\\''")}'` : "";
    const attachArgs = effectiveUrl
      ? `${this.config.attachCommand} ${effectiveUrl} --session ${sessionId}${dirFlag}`
      : `${this.config.attachCommand} ${sessionId}`;
    // The pane always starts as a placeholder: `opencode attach` is a full TUI
    // that fires 19 terminal palette queries on startup, and tmux can deliver a
    // fragmented reply to 부장님's prompt as literal text. ARCHITECTURE.md §17.7.
    const innerCmd = ["sh", "-c", buildPlaceholderCommand(stage, agent, sessionId)];

    const capacity = await this.computeCapacity();
    if (capacity > 0 && this.panes.size > capacity) {
      const evictable = [...this.panes.values()]
        .filter(p => p.sessionId !== sessionId && p.paneId && p.lastSuccess !== false)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const oldest = evictable[0];
      if (oldest) {
        await this.killPane(oldest.paneId);
        this.panes.delete(oldest.sessionId);
        this.stopFocusWatchIfIdle();
      }
    }

    // Target the source (부장님) pane when known; otherwise the active pane.
    const targetArgs = this.sourcePaneId
      ? ["-t", this.sourcePaneId]
      : [];

    // Use source pane's CWD (main repo) so `opencode attach` finds the
    // right server — the server is bound to the repo where opencode started,
    // not to the worktree.  Falls back to worktree if unreadable.
    const srcCwdResult = this.sourcePaneId
      ? await this.$`tmux display-message -t ${this.sourcePaneId} -p ${"#{pane_current_path}"}`.quiet().nothrow()
      : null;
    const serverCwd =
      srcCwdResult?.exitCode === 0 && srcCwdResult.stdout?.toString().trim()
        ? srcCwdResult.stdout.toString().trim()
        : undefined;
    const cwdArgs: string[] = serverCwd ? ["-c", serverCwd] : [];

    const useOwnWindow = this.config.placement === "window";
    const paneId = useOwnWindow
      ? await this.spawnInNewWindow(sessionId, stage, cwdArgs, innerCmd, serverCwd, attachArgs)
      : await this.spawnInSplitPane(sessionId, stage, targetArgs, cwdArgs, innerCmd, serverCwd, attachArgs);

    if (!paneId) return null;

    await this.$`tmux select-pane -t ${paneId} -T ${`${stage} [${sessionId.slice(-8)}]`}`
      .quiet().nothrow();

    await this.writePaneMarkers(paneId, sessionId, stage);

    if (!useOwnWindow) {
      await this.rebalanceLayout();
      if (this.sourcePaneId) {
        await this.$`tmux select-pane -t ${this.sourcePaneId}`.quiet().nothrow();
      }
    }

    const tracked = this.panes.get(sessionId);
    if (tracked) {
      tracked.attachCommand = attachArgs;
      tracked.awaitingFocus = true;
    }
    this.startFocusWatch();

    return paneId;
  }

  /**
   * Swap a placeholder pane over to the real `opencode attach` TUI.
   * Pane user options (@mdn2_*) survive respawn-pane, so ownership tracking is
   * unaffected — verified against tmux 3.6.
   */
  async activatePane(sessionId: string): Promise<boolean> {
    if (!this.active) return false;
    const tracked = this.panes.get(sessionId);
    if (!tracked?.awaitingFocus || !tracked.paneId || !tracked.attachCommand) return false;
    tracked.awaitingFocus = false;
    const r = await this.$`tmux respawn-pane -k -t ${tracked.paneId} ${["sh", "-c", tracked.attachCommand]}`
      .quiet().nothrow();
    if (r.exitCode !== 0) {
      tracked.awaitingFocus = true;
      logger.warn(
        `[tmux-monitor] activatePane FAILED session=${sessionId} pane=${tracked.paneId} ` +
        `exit=${r.exitCode} stderr=${r.stderr?.toString().trim() ?? ""} — will retry on next focus poll`,
      );
      return false;
    }
    logger.debug(`[tmux-monitor] activatePane session=${sessionId} pane=${tracked.paneId}`);
    this.stopFocusWatchIfIdle();
    return true;
  }

  /**
   * One focus sweep. A pane counts as focused only when it is the active pane
   * of the active window — `pane_active` alone is 1 for every window's own
   * active pane, so both flags are required.
   */
  async pollFocusOnce(): Promise<number> {
    if (!this.active) return 0;
    const waiting = [...this.panes.values()].filter(p => p.awaitingFocus && p.paneId);
    if (waiting.length === 0) {
      this.stopFocusWatchIfIdle();
      return 0;
    }
    const r = await this.$`tmux list-panes -aF ${"#{pane_id}\t#{pane_active}\t#{window_active}"}`
      .quiet().nothrow();
    if (r.exitCode !== 0) return 0;
    const focused = new Set<string>();
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      const [paneId, paneActive, windowActive] = line.split("\t");
      if (paneId && paneActive?.trim() === "1" && windowActive?.trim() === "1") focused.add(paneId);
    }
    let activated = 0;
    for (const p of waiting) {
      if (!focused.has(p.paneId)) continue;
      if (await this.activatePane(p.sessionId)) activated++;
    }
    return activated;
  }

  private startFocusWatch(): void {
    if (this.focusTimer) return;
    this.focusTimer = setInterval(() => {
      if (this.focusPollInFlight) return;
      this.focusPollInFlight = true;
      void this.pollFocusOnce()
        .catch(() => undefined)
        .finally(() => { this.focusPollInFlight = false; });
    }, FOCUS_POLL_INTERVAL_MS);
    this.focusTimer.unref?.();
  }

  private stopFocusWatchIfIdle(): void {
    if (!this.focusTimer) return;
    if ([...this.panes.values()].some(p => p.awaitingFocus)) return;
    clearInterval(this.focusTimer);
    this.focusTimer = null;
  }

  /**
   * placement=window — own tmux window; `-d` leaves the active window (and thus
   * 부장님's pane geometry) untouched. ARCHITECTURE.md §17.6.
   */
  private async spawnInNewWindow(
    sessionId: string,
    stage: string,
    cwdArgs: string[],
    innerCmd: string[],
    serverCwd: string | undefined,
    attachArgs: string,
  ): Promise<string | null> {
    const windowName = buildWindowName(stage, sessionId);
    // `new-window -t` rejects a pane id ("can't specify pane here") — it needs a
    // target-window, so resolve the source pane's <session_id>:<window_index>.
    // session_id ($N) is used instead of session_name because names may contain ':'.
    const windowTarget = await this.resolveSourceWindowTarget();
    if (!windowTarget) {
      // An untargeted `new-window` lands in whatever session/window the server
      // considers current — possibly another user's. Skip instead.
      logger.warn(
        `[tmux-monitor] new-window SKIPPED session=${sessionId} stage=${stage} — ` +
        `could not resolve source window target from pane=${this.sourcePaneId ?? "-"}`,
      );
      return null;
    }
    const placeArgs = ["-a", "-t", windowTarget];
    logger.debug(
      `[tmux-monitor] new-window session=${sessionId} stage=${stage} ` +
      `name=${windowName} target=${windowTarget ?? "-"} cwd=${serverCwd ?? "-"} ` +
      `attach="${attachArgs}"`,
    );
    const result = await this.$`tmux new-window ${placeArgs} -d -P -F ${"#{pane_id}"} -n ${windowName} ${cwdArgs} ${innerCmd}`
      .quiet().nothrow();
    if (result.exitCode !== 0) {
      logger.warn(
        `[tmux-monitor] new-window FAILED session=${sessionId} stage=${stage} ` +
        `exit=${result.exitCode} stderr=${result.stderr?.toString().trim() ?? ""}`,
      );
      return null;
    }
    return result.stdout?.toString().trim() || null;
  }

  private async resolveSourceWindowTarget(): Promise<string | null> {
    if (!this.sourcePaneId) return null;
    const r = await this.$`tmux display-message -t ${this.sourcePaneId} -p ${"#{session_id}:#{window_index}"}`
      .quiet().nothrow();
    if (r.exitCode !== 0) return null;
    return r.stdout?.toString().trim() || null;
  }

  /** placement=pane — legacy split of 부장님's window. Resizes the source pane. */
  private async spawnInSplitPane(
    sessionId: string,
    stage: string,
    targetArgs: string[],
    cwdArgs: string[],
    innerCmd: string[],
    serverCwd: string | undefined,
    attachArgs: string,
  ): Promise<string | null> {
    logger.debug(
      `[tmux-monitor] split-window session=${sessionId} stage=${stage} ` +
      `direction=${this.config.splitDirection} cwd=${serverCwd ?? "-"} ` +
      `attach="${attachArgs}"`,
    );
    const result = await this.$`tmux split-window ${targetArgs} ${this.config.splitDirection} -d -P -F ${"#{pane_id}"} ${cwdArgs} ${innerCmd}`
      .quiet().nothrow();
    if (result.exitCode !== 0) return null;
    return result.stdout?.toString().trim() || null;
  }

  private async rebalanceLayout(): Promise<void> {
    // main-vertical uses main-pane-width; main-horizontal uses main-pane-height.
    // Other layouts (tiled, even-*) distribute panes equally and ignore this option.
    if (this.config.layout === "main-vertical" || this.config.layout === "main-horizontal") {
      const isWidth = this.config.layout === "main-vertical";
      const dimFormat = isWidth ? "#{window_width}" : "#{window_height}";
      const dimResult = await this.$`tmux display-message -p ${dimFormat}`.quiet().nothrow();
      const dim = Number(dimResult.stdout?.toString().trim() ?? 0);
      if (Number.isFinite(dim) && dim > 0) {
        const mainDim = Math.floor((dim * this.config.mainPaneSize) / 100);
        const optName = isWidth ? "main-pane-width" : "main-pane-height";
        await this.$`tmux set-window-option ${optName} ${String(mainDim)}`.quiet().nothrow();
      }
    }
    await this.$`tmux select-layout ${this.config.layout}`.quiet().nothrow();
  }

  /**
   * Sub-session 완료 시 pane 처리.
   * - opts.success === true: paneCloseDelaySeconds 초 대기 후 kill (성공 로그 확인 시간 확보).
   * - opts.success === false: autoCloseOnFailure이 true면 kill, 아니면 유지 (실패 진단용).
   * - opts 미지정: 기존 호환 동작 — 즉시 kill.
   *
   * Fallback: if the in-memory Map lost the entry (plugin re-init between spawn
   * and close), a tmux marker scan finds the pane by @mdn2_session and kills it.
   */
  async closePane(sessionId: string, opts?: { success: boolean }): Promise<void> {
    if (!this.active) return;
    const tracked = this.panes.get(sessionId);

    if (!tracked) {
      const orphan = await this.findPaneBySession(sessionId);
      if (!orphan) return;
      if (opts && !opts.success && !this.config.autoCloseOnFailure) return;
      await this.killPane(orphan);
      return;
    }

    if (opts !== undefined) {
      tracked.lastSuccess = opts.success;
      if (opts.success) {
        if (this.config.paneCloseDelaySeconds > 0) {
          await new Promise<void>(r => setTimeout(r, this.config.paneCloseDelaySeconds * 1000));
        }
        await this.killPane(tracked.paneId);
        this.panes.delete(sessionId);
        this.stopFocusWatchIfIdle();
        return;
      }
      if (!this.config.autoCloseOnFailure) {
        // Pane is kept for diagnosis, so a lazy placeholder must stay
        // focus-activatable — otherwise 부장님 is left with an inert banner
        // instead of the failed 막둥이's transcript.
        return;
      }
      await this.killPane(tracked.paneId);
      this.panes.delete(sessionId);
      this.stopFocusWatchIfIdle();
      return;
    }

    await this.killPane(tracked.paneId);
    this.panes.delete(sessionId);
    this.stopFocusWatchIfIdle();
  }

  /** Kill every tracked pane — used when the plugin shuts down. */
  async cleanup(): Promise<void> {
    if (!this.active) return;
    for (const t of this.panes.values()) {
      await this.killPane(t.paneId);
    }
    this.panes.clear();
    this.stopFocusWatchIfIdle();
  }

  async reapDeadOwnerPanes(opts: { graceSeconds?: number; now?: () => number } = {}): Promise<number> {
    if (!this.active) return 0;
    const graceSeconds = opts.graceSeconds ?? 10;
    const nowMs = (opts.now ?? Date.now)();
    const scanned = await this.scanOrphans();
    let killed = 0;
    for (const p of scanned) {
      if (p.ownerPid === this.ownerPid) continue;
      if (p.ownerPid !== undefined && this.isPidAlive(p.ownerPid)) continue;
      if (graceSeconds > 0 && p.startedAt !== undefined) {
        const ageSeconds = (nowMs - p.startedAt * 1000) / 1000;
        if (ageSeconds < graceSeconds) continue;
      }
      await this.killPane(p.paneId);
      killed++;
    }
    return killed;
  }

  /**
   * Discover every pane on the tmux server that carries our @mdn2_session
   * marker. Parent opencode panes (--port) are NEVER returned regardless of
   * markers — safety guard against accidental self-kill if the parent ever
   * inherited a stale marker.
   */
  async scanOrphans(): Promise<OrphanScanResult[]> {
    if (!this.active) return [];
    const format = [
      "#{pane_id}",
      `#{${MARKER_SESSION}}`,
      `#{${MARKER_STAGE}}`,
      `#{${MARKER_PID}}`,
      `#{${MARKER_STARTED}}`,
      "#{pane_start_command}",
    ].join("\t");
    const r = await this.$`tmux list-panes -aF ${format}`.quiet().nothrow();
    if (r.exitCode !== 0) return [];
    const results: OrphanScanResult[] = [];
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      if (!line.trim()) continue;
      const cols = line.split("\t");
      const [paneId, sessionId, stage, pidStr, startedStr, startCmd] = cols;
      if (!paneId) continue;
      const cmd = startCmd ?? "";
      if (PARENT_MARKER_PATTERN.test(cmd)) continue;
      if (!sessionId || sessionId.trim().length === 0) continue;
      results.push({
        paneId,
        sessionId: sessionId.trim(),
        stage: stage?.trim() || undefined,
        ownerPid: pidStr && /^\d+$/.test(pidStr.trim()) ? Number(pidStr.trim()) : undefined,
        startedAt: startedStr && /^\d+$/.test(startedStr.trim()) ? Number(startedStr.trim()) : undefined,
        startCommand: cmd || undefined,
      });
    }
    return results;
  }

  /**
   * Cleanup entry point invoked by the cleanup_panes tool. Kills every
   * @mdn2_session-marked pane on the tmux server.
   *
   * Panes newer than opts.graceSeconds (default 0) are skipped to avoid
   * killing panes still in the spawn window.
   */
  async cleanupOrphans(opts: CleanupOrphansOptions = {}): Promise<CleanupOrphansReport> {
    const trackedCount = this.panes.size;
    let orphansKilled = 0;
    let parentsSkipped = 0;
    let freshSkipped = 0;

    if (!this.active) {
      return {
        tracked_closed: 0,
        orphans_closed: 0,
        parents_skipped: 0,
        fresh_skipped: 0,
        total_closed: 0,
      };
    }

    await this.cleanup();

    const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    const grace = Math.max(0, opts.graceSeconds ?? 0);
    const nowSec = now();

    const panes = await this.scanOrphans();
    for (const p of panes) {
      if (p.startedAt !== undefined && grace > 0 && nowSec - p.startedAt < grace) {
        freshSkipped++;
        continue;
      }
      await this.killPane(p.paneId);
      orphansKilled++;
    }

    return {
      tracked_closed: trackedCount,
      orphans_closed: orphansKilled,
      parents_skipped: parentsSkipped,
      fresh_skipped: freshSkipped,
      total_closed: trackedCount + orphansKilled,
    };
  }

  /**
   * Locate a pane by its @mdn2_session marker. Survives plugin re-init
   * (markers persist on the tmux server even when the in-memory Map is empty).
   * Parent opencode panes (--port) are filtered by scanOrphans.
   */
  private async findPaneBySession(sessionId: string): Promise<string | null> {
    const panes = await this.scanOrphans();
    for (const p of panes) {
      if (p.sessionId === sessionId) return p.paneId;
    }
    return null;
  }

  /**
   * Force-kill the marker-matched pane for the given session id. Unlike
   * closePane this bypasses in-memory tracking entirely and only cares
   * about the tmux state, so it survives plugin restarts.
   *
   * Never touches parent opencode panes — the scanOrphans PARENT filter
   * excludes any `--port` process.
   */
  async forceKillBySessionId(sessionId: string): Promise<boolean> {
    if (!this.active) return false;
    if (!sessionId || !sessionId.startsWith("ses_")) return false;
    const paneId = await this.findPaneBySession(sessionId);
    if (!paneId) return false;
    await this.killPane(paneId);
    this.panes.delete(sessionId);
    return true;
  }

  private async writePaneMarkers(paneId: string, sessionId: string, stage: string): Promise<void> {
    let v: { ok: boolean; version: string };
    try {
      v = await this.checkTmuxVersion();
    } catch (e) {
      logger.debug(
        `[tmux-monitor] writePaneMarkers SKIP session=${sessionId} pane=${paneId} ` +
        `— ${(e as Error).message}`,
      );
      return;
    }
    if (!v.ok) {
      logger.debug(
        `[tmux-monitor] writePaneMarkers SKIP session=${sessionId} pane=${paneId} ` +
        `tmux=${v.version} (requires >= 3.0 for set-option -p; in-memory tracking only)`,
      );
      return;
    }
    const started = String(Math.floor(Date.now() / 1000));
    const pid = String(this.ownerPid);
    await this.$`tmux set-option -p -t ${paneId} ${MARKER_SESSION} ${sessionId}`.quiet().nothrow();
    await this.$`tmux set-option -p -t ${paneId} ${MARKER_PID} ${pid}`.quiet().nothrow();
    await this.$`tmux set-option -p -t ${paneId} ${MARKER_STAGE} ${stage}`.quiet().nothrow();
    await this.$`tmux set-option -p -t ${paneId} ${MARKER_STARTED} ${started}`.quiet().nothrow();
  }

  private isPidAlive(pid: number): boolean {
    return isPidAlive(pid);
  }

  private async killPane(paneId: string): Promise<void> {
    if (!paneId) return;
    await this.$`tmux kill-pane -t ${paneId}`.quiet().nothrow();
  }

  private async discoverServerUrl(): Promise<string | undefined> {
    if (!this.sourcePaneId) return undefined;
    const pidResult = await this.$`tmux display-message -t ${this.sourcePaneId} -p ${"#{pane_pid}"}`.quiet().nothrow();
    if (pidResult.exitCode !== 0) return undefined;
    const panePid = pidResult.stdout?.toString().trim();
    if (!panePid || panePid === "0") return undefined;

    const pids = new Set<string>([panePid]);
    const childResult = await this.$`pgrep -P ${panePid}`.quiet().nothrow();
    if (childResult.exitCode === 0) {
      for (const p of childResult.stdout!.toString().trim().split("\n")) {
        if (p) pids.add(p);
      }
    }
    const level1 = [...pids].filter(p => p !== panePid);
    for (const parent of level1) {
      const grandResult = await this.$`pgrep -P ${parent}`.quiet().nothrow();
      if (grandResult.exitCode === 0) {
        for (const p of grandResult.stdout!.toString().trim().split("\n")) {
          if (p) pids.add(p);
        }
      }
    }

    const ssResult = await this.$`ss -tlnp`.quiet().nothrow();
    if (ssResult.exitCode !== 0) return undefined;
    for (const line of (ssResult.stdout?.toString() ?? "").split("\n")) {
      for (const pid of pids) {
        if (!line.includes(`pid=${pid},`) && !line.includes(`pid=${pid})`)) continue;
        const m = line.match(/(?:127\.0\.0\.1|\*|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)/);
        if (m && Number(m[1]) > 0) return `http://127.0.0.1:${m[1]}`;
      }
    }
    return undefined;
  }

  /** Maximum number of agent panes that fit beside the main pane. */
  private async computeCapacity(): Promise<number> {
    if (this.config.placement === "window") return EVICTION_DISABLED;
    const r = await this.$`tmux display-message -p ${"#{window_width}"}`
      .quiet().nothrow();
    if (r.exitCode !== 0) return EVICTION_DISABLED;
    const width = Number(r.stdout?.toString().trim() ?? 0);
    if (!Number.isFinite(width) || width <= 0) return EVICTION_DISABLED;
    const main = Math.floor((width * this.config.mainPaneSize) / 100);
    const remaining = Math.max(0, width - main);
    if (remaining < this.config.agentPaneMinWidth) return EVICTION_DISABLED;
    return Math.max(1, Math.floor(remaining / this.config.agentPaneMinWidth));
  }
}
