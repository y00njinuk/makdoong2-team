// opencode-plugin.ts — makdoong2-team opencode plugin (omo-free).
//
// Replaces oh-my-openagent's responsibilities for the workflow pipeline:
//   1. Hook bridging — reuse existing guard-bash.sh / sync-state.sh / verify.sh
//      via opencode's tool.execute.before / .after events.
//   2. Stage gate + agent dispatch — `verify_stage` checks entry gates; `dispatch_stage`
//      spawns the per-stage sub-agent (막둥이) via client.session.create/prompt SDK API.
//   3. Model fallback advisor — expose a `get_fallback_model` tool so agents can
//      self-switch on rate limits / 5xx without omo's wrapper.
//   4. Per-agent permission enforcement — agent frontmatter `permission:` is the primary
//      layer; guard-bash.sh (secondary) handles push gates and destructive commands.
//      Note: @opencode-ai/plugin hook input does NOT include the calling agent ID
//      (input shape: { tool, sessionID, callID }), so sub-agent identity checks at
//      hook level are not possible. Rely on frontmatter permissions.
//
// Install path (default): ~/.config/opencode/plugins/makdoong2-team/
// Place this file at ~/.config/opencode/plugins/makdoong2-team/src/opencode-plugin.ts
// (or load the npm package via opencode.json "plugin": ["./plugins/makdoong2-team/src/opencode-plugin.ts"]).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve, sep as pathSep } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { appendSessionIndex, findWorktreeRoot, lookupSessionFromIndex } from "./session-index.js";
import { computeVerdictHash } from "./verdict-hash.js";
import { nextModel, applyConfigOverrides, POLICIES } from "./model-fallback-policy.ts";
import { agentForStage, STAGE_SPEC_FILES, type Stage } from "./agent-stage-config.ts";
import { shouldEscalateStall } from "./stall-escalation.ts";
import {
  RESEARCH_SOURCES,
  DEFAULT_RESEARCH_TIMEOUT_MINUTES,
  buildResearchPrompt,
  mergeResearchFindings,
  normalizeQueries,
  parseResearchOutput,
  resolveParallelism,
  summarizeOutcomes,
  type SourceOutcome,
} from "./research-fanout.ts";
import { TmuxMonitor, readTmuxConfig, orphanCleanupGuard } from "./tmux-monitor.ts";
import {
  resolvePaths,
  loadConfig,
  readLoggingConfig,
  DEFAULT_STALL_ESCALATE_THRESHOLD,
} from "./config.ts";
import {
  scanSkillMcpRegistry,
  extractMcpName,
  looksLikeMcpNotFound,
  looksLikeMcpConnectionFailed,
  type SkillMcpRegistry,
} from "./skill-mcp-registry.ts";
import { injectAllSecrets } from "./mcp-secret-injector.ts";
import { pollSubSession as pollSubSessionCore, pollOutcomeToLegacy, type PollOutcome } from "./poll-sub-session.ts";
import { logger } from "./logger.ts";
import { redactAndTruncate } from "./redact-secrets.ts";

// All runtime paths come from makdoong2-team.json (paths.* overrides) or are
// derived from the opencode config dir. No MAKDOONG2 environment variables.
const {
  hooks: HOOKS_DIR,
  gates: GATES_DIR,
  scripts: SCRIPTS_DIR,
  stages: STAGES_DIR,
  skills: SKILLS_DIR,
} = resolvePaths();

// Console output is centralized through the `logger` module. Level is
// controlled by makdoong2-team.json .logging.level (default "error"; set to
// "debug" or "trace" for full audit trail).

// ── OMO tmux 관리 여부 감지 ─────────────────────────────────────────────────
// 배경: oh-my-openagent(OMO) 가 opencode.json plugin 배열에 존재하면
// (문자열이든 튜플이든) OMO 가 직접 pane 을 관리하도록 위임하고
// makdoong2-team 은 pane spawn 을 완전히 skip 한다.
//
// 이력:
// v1 (detectOmoActive): "OMO 이름이 있으면 skip" — 그러나 문자열 등록 시
//   OMO tmux 가 dormant 여서 아무도 pane 을 만들지 않는 vacuum 이 됐다.
// v2 (isOmoTmuxManaged, 튜플+enabled=true 감지): "enabled=true 명시 시만 skip"
//   — 그러나 Opt 3 liveness false-positive 가 같은 세션에 pane 을 2개 spawn
//   하는 부작용을 낳았고, 근본 해결을 위해 단순화로 회귀한다.
// v3 (현재): OMO 존재 자체를 감지 → skip. OMO 가 없는 환경에서만 우리가 spawn.
//   - OMO 설치: OMO 가 sub-session pane 을 책임짐 (중복 제거)
//   - OMO 미설치: makdoong2-team 이 spawn (vacuum 없음)
export function isOmoTmuxManaged(pluginEntries?: Array<string | [string, unknown]>): boolean {
  try {
    let entries: Array<string | [string, unknown]> | undefined = pluginEntries;
    if (!entries) {
      const xdg = process.env.XDG_CONFIG_HOME;
      const configDir = xdg && xdg.trim()
        ? `${xdg}/opencode`
        : join(homedir(), ".config", "opencode");
      const configPath = `${configDir}/opencode.json`;
      if (!existsSync(configPath)) return false;
      const raw = readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw) as { plugin?: Array<string | [string, unknown]> };
      entries = cfg.plugin;
    }
    if (!Array.isArray(entries)) return false;
    return entries.some((p) => {
      const name = typeof p === "string"
        ? p
        : Array.isArray(p) && typeof p[0] === "string" ? p[0] : null;
      return typeof name === "string" && name.includes("oh-my-openagent");
    });
  } catch {
    return false;
  }
}

const OMO_TMUX_MANAGED = isOmoTmuxManaged();
if (OMO_TMUX_MANAGED) {
  logger.debug(
    "[makdoong2-team] oh-my-openagent detected — " +
    "skipping our own tmux pane spawn to avoid duplicates. OMO will manage sub-agent panes; " +
    "makdoong2-team continues to own dispatch/gate/state logic.",
  );
}

// Pure predicate — dispatch_stage 의 empty-output override 결정 로직.
// 로컬 LLM(qwen 계열 등)이 tool_call 로 작업을 마치고 최종 text 요약을
// 생성하지 않으면 pollSubSession 은 kind:"empty" 로 판정하지만 실제 작업은
// 완료된 경우가 많다. sub-agent 가 state.json 의 `.done=true` 마커를
// 기록했다면 완료 신호로 간주하고 성공으로 override 한다. state.sh runtime
// guard 가 state.json 직접 편집을 차단하고 sealed subagent 규약이 자기
// stage 만 done 처리를 허용하므로 false positive 위험이 낮다.
export function shouldOverrideEmptyOutcome(
  outcomeKind: string,
  currentSuccess: boolean,
  doneMarkerValue: string | null,
): boolean {
  return !currentSuccess && outcomeKind === "empty" && doneMarkerValue === "true";
}

// dispatch_stage 의 session_gone-override 결정 로직.
// pollSubSession 이 kind:"session_gone" 을 반환했을 때, sub-agent 가 이미
// state.json 의 `.done=true` 마커를 기록했다면 실제 작업은 완료되고
// 세션 tail 만 사라진 것으로 간주해 성공으로 override 한다. state.sh runtime
// guard 와 sealed subagent 규약이 done 마커 위조를 차단하므로 false positive
// 위험은 empty override 와 동일한 수준이다. shouldOverrideEmptyOutcome 과
// 별도 함수로 유지해 kind 별 재정의를 독립적으로 확장 가능하게 한다.
export function shouldOverrideSessionGoneOutcome(
  outcomeKind: string,
  currentSuccess: boolean,
  doneMarkerValue: string | null,
): boolean {
  return !currentSuccess && outcomeKind === "session_gone" && doneMarkerValue === "true";
}


const STAGE_ORDER: Stage[] = [
  "1_planning.jira",
  "1_planning.requirements",
  "1_planning.scope",
  "2_implementation.analysis",
  "2_implementation.dev",
  "2_implementation.test",
  "3_delivery.commit",
  "3_delivery.pr",
  "3_delivery.review",
];

function nextStage(current: Stage | null): Stage | null {
  if (current === null) return STAGE_ORDER[0];
  const idx = STAGE_ORDER.indexOf(current);
  return idx < 0 || idx + 1 >= STAGE_ORDER.length ? null : STAGE_ORDER[idx + 1];
}

function stageJqPath(stage: Stage): string {
  const dot = stage.indexOf(".");
  if (dot < 0) return `.stages."${stage}"`;
  const phase = stage.slice(0, dot);
  const substage = stage.slice(dot + 1);
  return `.stages."${phase}".substages."${substage}"`;
}

// dev substage 프롬프트용 draft_path Read 스니펫.
// 3-step (legacy 절대경로→상대 마이그레이션 / root() 해석 / 존재 검증) 로직은
// opencode 1.4.17 Read tool 의 worktree 밖 절대경로 hang 을 원천 차단하기 위함이다.
// 이 로직을 단순 raw read 로 회귀시키면 hang 버그가 재발한다.
// 배경: .sisyphus/plans/2026-07-27-worktree-path-refactor.md
function buildDraftPathReadSnippet(issue: string, indent = ""): string {
  const jq = `.stages."1_planning".substages."requirements".draft_path`;
  const lines = [
    `DRAFT_REL=$(bash ${SCRIPTS_DIR}/state.sh get ${issue} '${jq}' | tr -d '"')`,
    `# Legacy 절대경로 감지 시 상대경로로 자동 마이그레이션 (idempotent)`,
    `if [ -n "$DRAFT_REL" ] && [ "$DRAFT_REL" != "null" ] && [[ "$DRAFT_REL" == /* ]] && [[ "$DRAFT_REL" == */.makdoong2-team/* ]]; then`,
    `  DRAFT_REL=".makdoong2-team/\${DRAFT_REL##*/.makdoong2-team/}"`,
    `  bash ${SCRIPTS_DIR}/state.sh set ${issue} '${jq}' "\\"$DRAFT_REL\\""`,
    `fi`,
    `# 상대경로를 root() 기준으로 절대경로 해석`,
    `if [ -n "$DRAFT_REL" ] && [ "$DRAFT_REL" != "null" ]; then`,
    `  if [[ "$DRAFT_REL" == /* ]]; then DRAFT_PATH="$DRAFT_REL"; else DRAFT_PATH="$(bash ${SCRIPTS_DIR}/state.sh root)/$DRAFT_REL"; fi`,
    `  [ -f "$DRAFT_PATH" ] && [ -s "$DRAFT_PATH" ] && Read "$DRAFT_PATH"`,
    `fi`,
  ];
  return lines.map((l) => indent + l).join("\n");
}

// ── Worktree 자동 생성 (deterministic, Planning → Dev 진입 전)
interface CreateWorktreeResult {
  ok: boolean;
  path?: string;
  reused?: boolean;
  error?: string;
  hint?: string;
}

interface CreateWorktreeLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

async function createWorktree(
  $: any,
  issue: string,
  cwd: string,
  wtLogger?: CreateWorktreeLogger,
): Promise<CreateWorktreeResult> {
  const branchName = `feature/${issue}`;
  wtLogger?.info?.(`[createWorktree] ENTER issue=${issue} cwd=${cwd} branch=${branchName}`);

  const mainRepoResult = await $`git worktree list --porcelain`
    .cwd(cwd).quiet().nothrow();

  if (mainRepoResult.exitCode !== 0) {
    wtLogger?.error?.(`[createWorktree] FAIL issue=${issue} reason="git worktree list exit=${mainRepoResult.exitCode}"`);
    return {
      ok: false,
      error: "git worktree list 실패",
      hint: "git repository가 아니거나 worktree 기능을 사용할 수 없습니다.",
    };
  }
  
  const worktreeListOutput = mainRepoResult.stdout?.toString() || "";
  const lines = worktreeListOutput.split("\n");
  
  let mainRepo = "";
  let existingWorktreePath = "";
  
  // Parse worktree list --porcelain
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("worktree ")) {
      const path = line.replace(/^worktree\s+/, "");
      if (!mainRepo) {
        mainRepo = path; // 첫 항목이 메인 repo
      }
      
      // 브랜치 체크 (다음 줄)
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine === `branch refs/heads/${branchName}`) {
          existingWorktreePath = path;
        }
      }
    }
  }
  
  if (!mainRepo) {
    wtLogger?.error?.(`[createWorktree] FAIL issue=${issue} reason="main repo not parsed from worktree list"`);
    return {
      ok: false,
      error: "메인 repo 식별 실패",
      hint: "git worktree list 출력을 파싱할 수 없습니다.",
    };
  }

  const path = require("node:path");
  const parentDir = path.dirname(mainRepo);
  const repoName = path.basename(mainRepo);
  const targetWorktree = path.join(parentDir, `${repoName}-${issue}`);

  if (existingWorktreePath) {
    if (existingWorktreePath === targetWorktree) {
      if (!existsSync(targetWorktree)) {
        // git metadata 는 남아있지만 실제 디렉토리가 삭제된 phantom 상태.
        // prune 으로 stale entry 를 제거한 뒤 아래 addCommand 로 재생성한다.
        wtLogger?.info?.(
          `[createWorktree] PHANTOM_REUSED — dir gone, pruning and recreating ` +
          `issue=${issue} path=${targetWorktree}`,
        );
        await $`git worktree prune`.cwd(cwd).quiet().nothrow();
      } else {
        wtLogger?.info?.(`[createWorktree] REUSED issue=${issue} path=${targetWorktree} branch=${branchName}`);
        return {
          ok: true,
          path: targetWorktree,
          reused: true,
        };
      }
    } else {
      wtLogger?.error?.(
        `[createWorktree] FAIL issue=${issue} reason="branch ${branchName} already checked out elsewhere" ` +
        `existing=${existingWorktreePath} target=${targetWorktree}`,
      );
      return {
        ok: false,
        error: `브랜치 '${branchName}'가 이미 다른 worktree에서 사용 중`,
        hint: `기존 경로: ${existingWorktreePath}\n수동 정리: git worktree remove "${existingWorktreePath}" 또는 해당 경로 재사용`,
      };
    }
  }

  const branchExistsResult = await $`git show-ref --verify --quiet refs/heads/${branchName}`
    .cwd(cwd).quiet().nothrow();

  const branchExists = branchExistsResult.exitCode === 0;

  const addCommand = branchExists
    ? $`git worktree add ${targetWorktree} ${branchName}`.cwd(cwd).quiet().nothrow()
    : $`git worktree add ${targetWorktree} -b ${branchName}`.cwd(cwd).quiet().nothrow();

  const addResult = await addCommand;

  if (addResult.exitCode !== 0) {
    wtLogger?.error?.(
      `[createWorktree] FAIL issue=${issue} target=${targetWorktree} branch=${branchName} ` +
      `branch_existed=${branchExists} exit=${addResult.exitCode} stderr=${redactAndTruncate(addResult.stderr?.toString() ?? "", 200)}`,
    );
    return {
      ok: false,
      error: "git worktree add 실패",
      hint: addResult.stderr?.toString() || "알 수 없는 오류",
    };
  }

  wtLogger?.info?.(
    `[createWorktree] CREATED issue=${issue} path=${targetWorktree} branch=${branchName} ` +
    `branch_existed=${branchExists}`,
  );
  return {
    ok: true,
    path: targetWorktree,
    reused: false,
  };
}

export function looksLikeFileWrite(cmd: string): boolean {
  if (/\.makdoong2-team\/[^/\s]+\/state\.json/.test(cmd) && !/state\.sh\s+(get|set|init)/.test(cmd)) return true;
  if (/^\s*(git\s+(commit|push|add|rm|status|log|diff|show|branch|checkout|fetch|worktree|config|remote))/i.test(cmd)) return false;
  if (/state\.sh\s+(set|init|get|issue|root|update)/.test(cmd)) return false;
  if (/(^|[|&;])\s*(tee|dd)\b/.test(cmd)) return true;
  if (/\bsed\b[^|;&]*\s-i(?:\b|['"])/.test(cmd)) return true;
  if (/\bawk\b[^|;&]*?(?<![0-9])>\s*(?![&/])\S/.test(cmd)) return true;
  if (/(^|[|;&\s])(cat|printf|echo)\b[^|;&]*?(<<\S+.*?)?(?<![0-9])>\s*(?![&/])\S/.test(cmd)) return true;
  if (/(^|[|&;\s])>\s*(?!&|\/dev\/(?:null|stderr|stdout|tty)\b)\S/.test(cmd)) return true;
  if (/(^|[|&;\s])>>\s*(?!\/dev\/(?:null|stderr|stdout|tty)\b)\S/.test(cmd)) return true;
  if (/\bpython3?\s+-c\s+["'][^"']*open\s*\([^)]*["']\s*,\s*["'][wa]/.test(cmd)) return true;
  if (/\bnode\s+-e\s+["'].*?(?:writeFileSync|writeFile\b|appendFileSync|createWriteStream)/.test(cmd)) return true;
  if (/(^|[|&;])\s*(cp|mv)\s/.test(cmd)) return true;
  return false;
}

export function looksLikeSealedStateWrite(cmd: string): boolean {
  return /\.makdoong2-team\/[^/\s]+\/state\.json/.test(cmd)
    && !/state\.sh\s+(get|set|init|issue|root|update)/.test(cmd);
}

export const Makdoong2TeamPlugin: Plugin = async ({ $, client, directory, worktree }) => {
  const cwd = worktree || directory || ".";
  const config = loadConfig();
  applyConfigOverrides(config.agents, config.model_policy);

  // Sub-session monitor — splits a tmux pane next to 부장님 for each spawned
  // 막둥이 when invoked inside tmux with tmux.enabled=true in makdoong2-team.json.
  // No-op otherwise, so non-tmux runs are unaffected.
  const tmuxCfg = readTmuxConfig(config.tmux);
  if (!tmuxCfg.serverUrl) {
    const clientUrl: string | undefined =
      (client as any)?.baseURL
      ?? (client as any)?._options?.baseURL
      ?? (client as any)?._client?.baseURL
      ?? undefined;
    if (clientUrl) {
      try {
        tmuxCfg.serverUrl = new URL(clientUrl).origin;
      } catch {
        tmuxCfg.serverUrl = clientUrl;
      }
    }
  }
  const tmuxMonitor = new TmuxMonitor($ as never, tmuxCfg);

  if (tmuxMonitor.active) {
    (async () => {
      try {
        await tmuxMonitor.checkTmuxVersion();
      } catch (e) {
        logger.error(`[tmux-monitor] ${(e as Error).message}`);
        throw e;
      }
      const reaped = await tmuxMonitor.reapDeadOwnerPanes();
      if (reaped > 0) {
        logger.debug(
          `[tmux-monitor] reaped ${reaped} orphan pane(s) from previous plugin instance(s)`
        );
      }
    })().catch((e: unknown) => {
      logger.error(`[tmux-monitor] init failed: ${(e as Error).message}`);
    });
  }

  const subSessionIds = new Set<string>();
  // session.abort() 후 지연 삭제 대기 큐. key=sid, value=abortedAt(ms).
  // session.delete 즉시 호출 시 opencode 내부 event handler(opencode-auto-session-export 등)가
  // 아직 세션에 접근 중일 수 있어 NotFoundError가 team-leader runLoop까지 전파된다.
  // orphanScanTimer(60초 주기)가 DELETE_GRACE_MS 경과 후 안전하게 삭제한다.
  const pendingDelete = new Map<string, number>();
  // makdoong2-team sub-session title 패턴 (dispatch_stage/dispatch_verifier 공통).
  // 형식: `${stage} (@makdoong2-${agent})` 또는 `verifier:${stage} (@makdoong2-verifier)`
  const SUB_SESSION_TITLE_PATTERN = /\(@makdoong2-/;

  // 지속적 감시 주기. 5분(이전값)은 hang 감지가 너무 늦었고, poll-sub-session
  // deadline(기본 30분)과 겹쳐 정리가 필요한 시점에도 다음 tick 까지 대기해야 했다.
  // 60초로 단축해 timeout 직후 zombie session/pane 을 즉시 회수한다. 짧은
  // interval 이지만 session.status() 는 in-memory 조회이므로 부하가 낮다.
  const ORPHAN_SCAN_INTERVAL_MS = 60_000;
  const orphanScanTimer = setInterval(async () => {
    try {
      const staleThresholdMs = substageTimeoutMs + 10 * 60_000;
      const statusResult = await (client as any).session.status().catch(() => null);
      const statuses = (statusResult?.data ?? {}) as Record<string, { type: string }>;
      const nowMs = Date.now();

      // 정리 대상 sid → { reason, sessionGone } 매핑.
      // sessionGone=true 는 opencode 세션이 이미 사라진 경우로, session.abort/delete
      // 호출 시 부모 세션(team-leader) 에 NotFoundError 이벤트가 fire 되어 hang 을
      // 유발하므로 tmux pane 만 kill 하고 session ops 는 skip 해야 한다.
      const toCleanup = new Map<string, { reason: string; sessionGone: boolean }>();

      for (const [sid, pd] of pendingDispatch) {
        if (statuses[sid]?.type !== "busy") continue;
        const elapsedMs = nowMs - pd.startedAt;
        if (elapsedMs > staleThresholdMs) {
          toCleanup.set(sid, {
            reason: `stale busy ${Math.round(elapsedMs / 60_000)}min stage=${pd.stage}`,
            sessionGone: false,
          });
        }
      }

      for (const sid of subSessionIds) {
        if (pendingDispatch.has(sid)) continue;
        if (statuses[sid]?.type === "busy") {
          toCleanup.set(sid, {
            reason: "orphan busy (no pending dispatch entry)",
            sessionGone: false,
          });
        }
      }

      const tmuxOrphans = await tmuxMonitor.scanOrphans().catch(() => []);
      for (const p of tmuxOrphans) {
        const sid = p.sessionId;
        if (toCleanup.has(sid)) continue;
        if (pendingDispatch.has(sid)) continue;

        // status=undefined 는 세션 소멸이 아니라 정상 상태일 수 있다. session.status()
        // 는 요청 디렉토리 스코프로 필터링되므로 worktree 에서 생성된 서브세션은
        // 부모의 status map 에 영구히 나타나지 않는다.
        const guard = orphanCleanupGuard(p, {
          nowMs,
          ownerPid: tmuxMonitor.ownerProcessId,
          lastToolExecuteAtMs: sessionLastToolExecuteAt.get(sid),
          activeToolCount: sessionActiveToolCount.get(sid),
          toolAliveWindowMs: TOOL_EXECUTE_ALIVE_WINDOW_MS,
        });
        if (guard) {
          logger.debug(`[orphan-scan] skip sid=${sid} pane=${p.paneId} guard=${guard}`);
          continue;
        }

        const s = statuses[sid]?.type;
        if (s === "idle") {
          toCleanup.set(sid, {
            reason: "tmux pane orphan (opencode session status=idle)",
            sessionGone: false,
          });
        } else if (s === undefined) {
          toCleanup.set(sid, {
            reason: "tmux pane orphan (opencode session status=gone)",
            sessionGone: true,
          });
        }
      }

      for (const [sid, { reason, sessionGone }] of toCleanup) {
        if (sessionGone) {
          logger.debug(`[orphan-scan] pane-kill-only (session gone) sid=${sid} reason=${reason}`);
          await tmuxMonitor.forceKillBySessionId(sid).catch(() => undefined);
          sessionIssue.delete(sid);
          pendingDispatch.delete(sid);
          subSessionIds.delete(sid);
          sessionLastToolExecuteAt.delete(sid);
          sessionActiveToolCount.delete(sid);
        } else {
          logger.debug(`[orphan-scan] cleaning sid=${sid} reason=${reason}`);
          await cleanupSubSession(sid, { success: false, reason });
        }
      }
      if (toCleanup.size > 0) {
        logger.debug(`[orphan-scan] cleaned ${toCleanup.size} orphan/stale session(s)`);
      }

      const DELETE_GRACE_MS = 60_000;
      for (const [sid, abortedAt] of pendingDelete) {
        if (nowMs - abortedAt < DELETE_GRACE_MS) continue;
        await (client as any).session
          .delete({ path: { id: sid } })
          .catch(() => undefined);
        pendingDelete.delete(sid);
        logger.debug(`[orphan-scan] pendingDelete flushed sid=${sid}`);
      }
    } catch (e) {
      logger.warn(`[orphan-scan] scan error: ${e}`);
    }
  }, ORPHAN_SCAN_INTERVAL_MS);
  orphanScanTimer.unref?.();

  // ── Phantom busy scanner (10분 주기) ─────────────────────────────────────
  // session.status()는 타임스탬프가 없어 "언제부터 busy인지" 알 수 없으므로
  // session.list()의 Session.time.updated로 실질적 활동 여부를 판단한다.
  // 임계값은 orphanScanTimer의 staleThresholdMs와 동일하게 유지한다 (느린 모델 고려).
  const PHANTOM_BUSY_SCAN_INTERVAL_MS = 10 * 60_000;
  const phantomBusyTimer = setInterval(async () => {
    try {
      const nowMs = Date.now();
      const staleThresholdMs = substageTimeoutMs + 10 * 60_000;

      const statusResult = await (client as any).session.status().catch(() => null);
      const statuses = (statusResult?.data ?? {}) as Record<string, { type: string }>;

      const listResult = await (client as any).session.list().catch(() => null);
      const sessions = (listResult?.data ?? []) as Array<{
        id: string; title?: string; time?: { updated?: number };
      }>;

      for (const s of sessions) {
        if (!SUB_SESSION_TITLE_PATTERN.test(s.title ?? "")) continue;
        if (pendingDispatch.has(s.id)) continue;
        if (pendingDelete.has(s.id)) continue;
        if (statuses[s.id]?.type !== "busy") continue;

        const staleSinceMs = nowMs - (s.time?.updated ?? 0);
        if (staleSinceMs <= staleThresholdMs) continue;

        logger.warn(
          `[phantom-busy] sid=${s.id} title="${s.title}" ` +
          `stale=${Math.round(staleSinceMs / 60_000)}min → cleanup`,
        );
        await cleanupSubSession(s.id, {
          success: false,
          reason: `phantom busy: time.updated ${Math.round(staleSinceMs / 60_000)}min ago`,
        });
      }
    } catch (e) {
      logger.warn(`[phantom-busy] scan error: ${e}`);
    }
  }, PHANTOM_BUSY_SCAN_INTERVAL_MS);
  phantomBusyTimer.unref?.();

  const runScript = async (dir: string, script: string, ...args: string[]) => {
    const r = await $`bash ${dir}/${script} ${args}`.cwd(cwd).quiet().nothrow();
    return {
      ok: r.exitCode === 0,
      code: r.exitCode,
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
    };
  };

  const runScriptCwd = async (runCwd: string, dir: string, script: string, ...args: string[]) => {
    if (!existsSync(runCwd)) {
      return { ok: false, code: -1, stdout: "", stderr: `worktree_path_missing: ${runCwd}` };
    }
    try {
      const r = await $`bash ${dir}/${script} ${args}`.cwd(runCwd).quiet().nothrow();
      return {
        ok: r.exitCode === 0,
        code: r.exitCode,
        stdout: r.stdout?.toString() ?? "",
        stderr: r.stderr?.toString() ?? "",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, code: -1, stdout: "", stderr: msg };
    }
  };

  // ── Helper: semantic gates beyond verify.sh (LLM-judgement markers). ──
  const checkExtensionGates = async (
    issue: string,
    target: Stage,
    baseCwd = cwd
  ): Promise<{ ok: true } | { ok: false; reason: string; marker_path?: string }> => {
    if (target === "1_planning.requirements") {
      const jiraValidationPath = `${stageJqPath("1_planning.jira")}.validation_passed`;
      const r = await $`bash ${SCRIPTS_DIR}/state.sh get ${issue} ${jiraValidationPath}`
        .cwd(baseCwd).quiet().nothrow();
      const passed = r.exitCode === 0 && r.stdout?.toString().trim() === "true";
      if (!passed) {
        const policy = await readPolicy(issue, baseCwd);
        const autoApprove = policy?.auto_approve?.[target] ?? null;
        if (autoApprove === true) {
          return { ok: true };
        }
        return {
          ok: false,
          reason:
            "MAKDOONG2-GATE BLOCKED [1_planning.requirements]: Jira 검증 미통과 — " +
            "planner(jira substage)가 template_validation 6개 항목(content_template_match / " +
            "content_quality_adequate / priority_set / assignee_set / reporter_set / " +
            "fix_version_handled)을 모두 통과시키거나, 실패 항목에 대해 사용자 인터뷰 " +
            `후 ${jiraValidationPath}=true 마커를 기록해야 함. ` +
            "참조: references/jira-issue-templates.md",
          marker_path: jiraValidationPath,
        };
      }
    }
    return { ok: true };
  };

  // ── Helper: read the issue-level work-categorization policy (.policy). ──
  // Set by stage 2 (makdoong2-requirements). null/absent for legacy issues.
  // category="major" → publisher generates change-report.md as an artifact (no approval gate).
  const readPolicy = async (
    issue: string,
    baseCwd = cwd
  ): Promise<{ category?: "minor" | "major"; auto_approve?: Record<string, boolean> } | null> => {
    const r = await $`bash ${SCRIPTS_DIR}/state.sh get ${issue} ${".policy"}`
      .cwd(baseCwd).quiet().nothrow();
    if (r.exitCode !== 0) return null; // null/absent → state.sh get (jq -e) exits non-zero
    try {
      const v = JSON.parse(r.stdout?.toString().trim() || "null");
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  };

  const substageTimeoutMs = Math.max(
    60_000,
    Math.round((config.timeout?.substage_minutes ?? 30) * 60_000),
  );

  const agentTimeoutMs: Record<string, number> = Object.fromEntries(
    Object.entries(config.timeout?.per_agent ?? {}).map(([agent, minutes]) => [
      agent,
      Math.max(60_000, Math.round(minutes * 60_000)),
    ]),
  );

  const getEffectiveTimeoutMs = (agentId: string): number =>
    agentTimeoutMs[agentId] ?? substageTimeoutMs;

  // MAX_ATTEMPTS bounds retries *within* one dispatch_stage call. It cannot
  // bound the orchestrator re-calling dispatch_stage after a failure, which
  // resets the budget and produces an unbounded stall→redispatch loop. This
  // threshold caps the accumulated hang_history across calls — the stall-path
  // counterpart of same_reason_streak on the REJECTED-verdict path.
  const stallEscalateThreshold = Math.max(
    1,
    Math.round(config.timeout?.stall_escalate_threshold ?? DEFAULT_STALL_ESCALATE_THRESHOLD),
  );

  const externalDirConfig = (config as any).permission?.external_directory ?? {};
  const configuredAllowPatterns: string[] = typeof externalDirConfig === "string"
    ? []
    : Object.entries(externalDirConfig as Record<string, string>)
        .filter(([, action]) => action === "allow")
        .map(([pattern]) => pattern);

  const sessionLastToolExecuteAt = new Map<string, number>();
  const sessionActiveToolCount = new Map<string, number>();
  const TOOL_EXECUTE_ALIVE_WINDOW_MS = 300_000;

  // MESSAGE_STALL 후 client.session.abort() 는 즉시 반환하지만 opencode 서버는 잠시 후
  // session.deleted 이벤트를 fire 한다. 그 사이(관측 최대 112s) sub-agent 가 tool call 을
  // 계속 발사할 수 있어 좀비 실행이 발생한다. abort 직후 session.deleted 를 대기하는
  // 헬퍼로 이 race window 를 닫는다. event 핸들러가 session.deleted 를 수신하면 이 map 의
  // pending waiter 를 resolve 한다.
  const sessionDeletedWaiters = new Map<string, Array<() => void>>();
  const waitForSessionDeleted = (sessionId: string, maxWaitMs: number): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const settle = (deleted: boolean) => {
        if (done) return;
        done = true;
        const arr = sessionDeletedWaiters.get(sessionId);
        if (arr) {
          const idx = arr.indexOf(onDeleted);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) sessionDeletedWaiters.delete(sessionId);
        }
        resolve(deleted);
      };
      const onDeleted = () => settle(true);
      const arr = sessionDeletedWaiters.get(sessionId) ?? [];
      arr.push(onDeleted);
      sessionDeletedWaiters.set(sessionId, arr);
      setTimeout(() => settle(false), maxWaitMs).unref?.();
    });
  };
  const MESSAGE_STALL_BACKOFF_MS: readonly number[] = [300_000, 600_000, 1_200_000];
  const VERIFIER_STALL_THRESHOLD_MS = MESSAGE_STALL_BACKOFF_MS[MESSAGE_STALL_BACKOFF_MS.length - 1];
  const SESSION_DELETED_WAIT_MS = 30_000;
  const eventMaxChars = readLoggingConfig(config.logging).eventMaxChars;

  const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
  const sessionWorktree = new Map<string, string>();

  const extractFilePathFromToolArgs = (args: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    const fp = (args as { filePath?: unknown }).filePath;
    return typeof fp === "string" && fp.length > 0 ? fp : undefined;
  };

  const trackAndStageEngineerWrite = async (
    sessionID: string,
    filePath: string,
  ): Promise<{ ok: boolean; relPath?: string; error?: string }> => {
    let wt = sessionWorktree.get(sessionID) ?? pendingDispatch.get(sessionID)?.worktree;
    let issue = sessionIssue.get(sessionID);
    if (!wt || !issue) {
      const worktreeRoot = findWorktreeRoot(filePath);
      if (worktreeRoot) {
        const indexed = lookupSessionFromIndex(worktreeRoot, sessionID);
        if (indexed) {
          wt = wt ?? indexed.worktree;
          issue = issue ?? indexed.issue;
          if (wt) sessionWorktree.set(sessionID, wt);
          if (issue) sessionIssue.set(sessionID, issue);
          logger.debug(
            `[auto-git-add] recovered from index session=${sessionID} ` +
            `wt=${wt} issue=${issue}`,
          );
        }
      }
    }
    if (!wt || !issue) {
      logger.debug(
        `[auto-git-add] skip session=${sessionID} reason=no_wt_or_issue wt=${wt ?? "N/A"} issue=${issue ?? "N/A"}`,
      );
      return { ok: true };
    }

    const resolvedWt = pathResolve(wt);
    const resolvedFile = pathResolve(wt, filePath);
    if (resolvedFile === resolvedWt) {
      logger.debug(`[auto-git-add] skip session=${sessionID} reason=file_equals_wt file=${filePath}`);
      return { ok: true };
    }
    if (!resolvedFile.startsWith(resolvedWt + pathSep)) {
      logger.debug(
        `[auto-git-add] skip session=${sessionID} reason=outside_wt ` +
        `file=${filePath} resolved=${resolvedFile} wt=${resolvedWt}`,
      );
      return { ok: true };
    }
    const relPath = resolvedFile.slice(resolvedWt.length + 1);
    if (!relPath || relPath.startsWith(".git" + pathSep) || relPath.startsWith(".makdoong2-team" + pathSep)) {
      logger.debug(`[auto-git-add] skip session=${sessionID} reason=excluded_path relPath=${relPath}`);
      return { ok: true };
    }

    const addR = await $`git -C ${resolvedWt} add -- ${relPath}`.quiet().nothrow();
    if (addR.exitCode === 0) {
      logger.debug(`[auto-git-add] session=${sessionID} file=${relPath} exit=0`);
    } else {
      const stderrRaw = addR.stderr?.toString() ?? "";
      logger.warn(
        `[auto-git-add] session=${sessionID} file=${relPath} exit=${addR.exitCode} ` +
        `stderr=${redactAndTruncate(stderrRaw, 200)}`,
      );
      try {
        const dir = `${resolvedWt}/.makdoong2-team/${issue}`;
        mkdirSync(dir, { recursive: true });
        appendFileSync(`${dir}/dev-written-files.txt`, `${relPath}\n`);
      } catch { /* ignore */ }
      return { ok: false, relPath, error: stderrRaw.trim() || `git add exit=${addR.exitCode}` };
    }

    try {
      const dir = `${resolvedWt}/.makdoong2-team/${issue}`;
      mkdirSync(dir, { recursive: true });
      appendFileSync(`${dir}/dev-written-files.txt`, `${relPath}\n`);
    } catch (err) {
      logger.debug(
        `[auto-git-add] track-append failed session=${sessionID} file=${relPath} ` +
        `error=${(err as Error).message}`,
      );
    }
    return { ok: true, relPath };
  };

  const pollSubSession = (
    sessionId: string,
    timeoutMs = substageTimeoutMs,
    allowedWorktree?: string,
    onNudge?: (sessionId: string, elapsedMs: number) => Promise<void>,
    messageStallThresholdMs?: number,
  ): Promise<PollOutcome> =>
    pollSubSessionCore(client as any, sessionId, {
      timeoutMs,
      allowedWorktree,
      configuredAllowPatterns,
      logger: {
        debug: (msg: string) => logger.debug(msg),
        error: (msg: string) => logger.error(msg),
      },
      permissionCheckIntervalPolls: 1,
      nudgeAtFraction: onNudge ? 0.8 : undefined,
      onNudge,
      messageStallThresholdMs,
      contentStableCompletionMs: 300_000,
      preambleOnlyTextThreshold: 200,
      isRecentlyActive: () => {
        if ((sessionActiveToolCount.get(sessionId) ?? 0) > 0) return true;
        const last = sessionLastToolExecuteAt.get(sessionId);
        return typeof last === "number" && Date.now() - last < TOOL_EXECUTE_ALIVE_WINDOW_MS;
      },
    });

  // ── sessionID → agent 매핑. chat.params hook에서 채우고, tool.execute.before
  //    hook에서 조회한다. 이 매핑을 통해 hook input에 없는 agent 식별을 우회한다.
  //    Primary agent(team-leader)만 직접 파일 쓰기를 차단하기 위한 최소 필요 조건.
  const sessionAgent = new Map<string, string>();

  // ── sessionID → Jira Issue Key 매핑 ─────────────────────────────────────────
  // 모든 워크플로우는 Jira Issue Key를 중심으로 설계된다. dispatch_stage /
  // dispatch_verifier / auto_advance_stage 는 항상 args.issue 를 명시적으로
  // 받으므로, 이를 sessionID에 바인딩해두면 guard-bash.sh / sync-state.sh 가
  // git branch 이름이나 worktree 경로를 추론하지 않고 신뢰할 수 있는 ISSUE를
  // 직접 전달받을 수 있다. 이 설계로 multi-worktree / 비-makdoong2-team 워크트리
  // 오탐 문제가 근본적으로 해결된다.
  const sessionIssue = new Map<string, string>();

  // ── skill_mcp lazy-load 방어 (mcp_name → skill_name 매핑).
  //    SKILL.md frontmatter 를 스캔해 각 MCP 서버가 어떤 skill 에 embedded 인지
  //    캐시한다. `skill(name="...")` 로 skill 이 로드되기 전에는 opencode 가
  //    "MCP server ... not found" 로 튕기지만 어떤 skill 을 로드해야 하는지는
  //    알려주지 않는다. 이 매핑으로 tool.execute.before / .after 훅이 정확한
  //    skill 이름을 사용자에게 지시하는 에러를 낼 수 있다.
  //    스캔은 플러그인 초기화 시 한 번만 수행하며 skills 디렉토리가 없으면
  //    fail-open (빈 registry) 으로 폴백한다.
  const skillMcpRegistry: SkillMcpRegistry = scanSkillMcpRegistry(SKILLS_DIR);
  logger.debug(
    `[makdoong2-team hook] skill_mcp registry scanned: root=${skillMcpRegistry.root} ` +
    `skills=${skillMcpRegistry.bySkill.size} mcp_servers=${skillMcpRegistry.byMcp.size}`,
  );

  // 사용자가 아직 알려지지 않은 outer MCP 서버(chrome-devtools-mcp 등)나
  // opencode.json 의 site-wide MCP 를 skill_mcp 로 부를 수도 있다. 이런 이름은
  // registry 에는 없지만 opencode 가 성공적으로 처리할 수 있다. 확실히 우리가
  // 관리하는 MCP 인 경우에만 사전 힌트를 낸다 — 사전 throw 는 하지 않는다.
  // (registry 는 정보성이지 whitelist 가 아니다).
  const knownMcpNames = skillMcpRegistry.byMcp;

  const parentSessionByCallID = new Map<string, string>();
  const parentSessionByToolStack: string[] = [];
  const dispatchParentSessionID = (callID: string | undefined): string | null => {
    if (callID && parentSessionByCallID.has(callID)) {
      return parentSessionByCallID.get(callID)!;
    }
    return parentSessionByToolStack.length > 0
      ? parentSessionByToolStack[parentSessionByToolStack.length - 1]
      : null;
  };

  interface PendingDispatch {
    stage: string;
    agent: string;
    worktree: string;
    startedAt: number;
  }
  const pendingDispatch = new Map<string, PendingDispatch>();
  const spawnPaneForSession = async (sessionId: string): Promise<void> => {
    if (OMO_TMUX_MANAGED) return;
    const pd = pendingDispatch.get(sessionId);
    if (!pd) return;
    try {
      await tmuxMonitor.spawnPane(sessionId, pd.stage, pd.agent, pd.worktree);
    } catch (e) {
      logger.error(`[event] spawnPane failed for session=${sessionId}: ${e}`);
    }
  };

  // Permission 방어 (SDK 1.18): session.create body 는 parentID/title 만 허용하고
  // Session 응답 타입에도 permission 필드가 없어, create 시점 permission 상속이
  // 불가능하다 (0.x 의 resolveInheritedPermission 방식은 1.18 에서 no-op).
  // PROJ-40406 (headless sub-session 의 external_directory ask hang) 방어는
  // pollSubSession 의 permission auto-reply 가 전담한다:
  //   - external_directory + worktree scope 내 → 자동 allow (PERMISSION_ALLOW)
  //   - 그 외 → 자동 reject + abort (PERMISSION_STALL → redispatch)
  // question tool 은 prompt body 의 `tools: { question: false }` 로 차단 유지.

  // sub-session lifecycle 정리 단일 진입점: abort(진행 중 prompt 중단) → pane kill
  // (tracked path 우선, marker fallback) → force kill (plugin 재시작으로 in-memory
  // Map 손실 시 marker 기반 복구) → session.delete (opencode DB zombie 방지).
  // dispatch_stage/dispatch_verifier finally 블록, orphanScanTimer, 사용자가 부르는
  // inspect_sub_sessions/cleanup_panes 툴이 모두 이 함수를 공유한다.
  // 개별 단계는 idempotent 하므로 (이미 끝난 세션 abort 등은 no-op) 순서 보장을
  // 위해 순차 await 한다 - concurrent 정리는 tmux marker race 를 유발할 수 있다.
  const cleanupSubSession = async (
    sid: string,
    opts: { success: boolean; reason?: string; skipSessionOps?: boolean },
  ): Promise<void> => {
    try {
      // skipSessionOps=true 는 opencode 세션이 이미 gone 인 경우 사용한다.
      // gone 세션에 session.abort/delete 를 호출하면 opencode 가 부모(team-leader)
      // 이벤트 스트림에 NotFoundError 를 fire 하여 부장님 runLoop 가 hang 된다.
      // 이 경우에는 tmux pane 만 제거하고 in-memory 추적 맵만 정리한다.
      if (!opts.skipSessionOps) {
        await (client as any).session
          .abort({ path: { id: sid } })
          .catch(() => undefined);
      }
      await tmuxMonitor.closePane(sid, opts).catch(() => undefined);
      if (!opts.success) {
        await tmuxMonitor.forceKillBySessionId(sid).catch(() => undefined);
      }
      if (!opts.skipSessionOps) {
        pendingDelete.set(sid, Date.now());
      }
    } finally {
      sessionIssue.delete(sid);
      pendingDispatch.delete(sid);
      subSessionIds.delete(sid);
      sessionLastToolExecuteAt.delete(sid);
      sessionActiveToolCount.delete(sid);
    }
  };

  // team-leader가 직접 실행 시 물리적으로 차단할 툴 목록.
  // 하드룰 1: Read 외 파일 조작은 dispatch_stage로만 위임.
  const LEADER_FORBIDDEN_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

  // ══════════════════════════════════════════════════════════════════════════
  // Sealed Workflow Enforcement — Outer-World Tool Blocking
  // ══════════════════════════════════════════════════════════════════════════
  // makdoong2 서브에이전트가 outer-world(Sisyphus / Explore / Librarian /
  // Oracle / Metis / Momus 등 oh-my-openagent 계열)로 위임하는 툴을
  // 런타임에 물리적으로 차단한다. 프론트매터 whitelist(1차 방어) 위의
  // 2차 방어층 — 프론트매터가 오설정되어도 훅이 잡는다.
  //
  // Blocklist current as of oh-my-openagent@3.17.15 (2026-05).
  // oh-my-openagent 업그레이드 시 dist/tools/ 를 재검토하여 새 위임 툴이
  // 추가되었는지 확인한다.
  const OUTER_WORLD_TOOLS = new Set([
    "call_omo_agent",
    "delegate_task",
    "background_task",
    "task_create",
    "task_update",
    "task_get",
    "task_list",
  ]);

  // outer-world 위임이 금지된 makdoong2 서브에이전트 목록.
  // team-leader는 오케스트레이터 역할로 EXEMPT — 자체 하드룰 1/2 (파일
  // 쓰기 금지)로 이미 제약됨. 다른 서브에이전트는 sealed workflow 원칙에
  // 따라 skill_mcp + dispatch_stage 만으로 작업을 완결해야 한다.
  const SEALED_SUBAGENTS = new Set([
    "makdoong2-planner",
    "makdoong2-analyzer",
    "makdoong2-engineer",
    "makdoong2-publisher",
    "makdoong2-verifier",
    // Research fan-out worker. Sealed like every other sub-agent: its frontmatter
    // already omits Task (L1), but sealed workflow is defence in depth — a worker
    // missing here would be caught by nothing at runtime (L2).
    "makdoong2-researcher",
  ]);

  // 미래의 oh-my-openagent 위임 툴을 조기 발견하기 위한 이름 패턴.
  // 알려진 툴이 아니면서 위임/스폰을 시사하는 이름이 감지되면 경고한다.
  // Blocklist 갱신 여부를 판단하는 용도로만 사용 — 차단은 하지 않는다.
  const DELEGATION_LIKE_NAME = /^(delegate|spawn|background|task_(create|update|delete))/i;

  const KNOWN_SAFE_TOOLS = new Set([
    "dispatch_stage",
    "dispatch_verifier",
    "dispatch_research",
    "verify_stage",
    "auto_advance_stage",
    "get_fallback_model",
    "skill",
    "skill_mcp",
  ]);

  // Bash 우회 파일 쓰기 감지 정규식 (하드룰 2).
  // 허용: `git commit|push|add|rm`, `state.sh set`, `mkdir/touch/rm/ls/find/cat` (읽기)
  // 차단: `>`, `>>`, `tee`, `sed -i`, `awk ... > file`, `cat <<EOF > file`, `printf ... >`
  //
  // FD-redirect 방어: `2>/dev/null`, `1>&2`, `command 2>err.log` 같은
  // 파일 디스크립터 리다이렉트는 파일 쓰기가 아니거나(전자·중간자) 정책상 허용한다.
  // 모든 `>` 매칭에 `(?<![0-9])` negative lookbehind 를 걸어 FD 번호를 제외한다.
  // 또한 `> /dev/null` 처럼 명시적 /dev/null 리다이렉트도 파일 쓰기가 아니므로 허용한다.

  // ── Plugin init sweep ────────────────────────────────────────────────────
  (async () => {
    try {
      const ZOMBIE_IDLE_THRESHOLD_MS = 24 * 60 * 60_000;
      const listResult = await (client as any).session.list().catch(() => null);
      const initSessions = (listResult?.data ?? []) as Array<{
        id: string; title?: string; time?: { updated?: number };
      }>;
      const initStatusResult = await (client as any).session.status().catch(() => null);
      const initStatuses = (initStatusResult?.data ?? {}) as Record<string, { type: string }>;
      const initNowMs = Date.now();
      let swept = 0;
      for (const s of initSessions) {
        if (!SUB_SESSION_TITLE_PATTERN.test(s.title ?? "")) continue;
        if (pendingDispatch.has(s.id) || pendingDelete.has(s.id)) continue;
        if (initStatuses[s.id]?.type === "busy") continue;
        if (initNowMs - (s.time?.updated ?? 0) < ZOMBIE_IDLE_THRESHOLD_MS) continue;
        await (client as any).session.delete({ path: { id: s.id } }).catch(() => undefined);
        swept++;
      }
      if (swept > 0) logger.debug(`[init-sweep] zombie sub-session ${swept}개 정리 완료`);
    } catch (e) {
      logger.warn(`[init-sweep] 초기화 sweep 오류: ${e}`);
    }
  })();

  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (logger.isDebug() && event?.type?.startsWith("session.")) {
        try {
          logger.debug(`[event] type=${event.type} properties=${JSON.stringify(event.properties).slice(0, eventMaxChars)}`);
        } catch { /* ignore */ }
      }
      if (event?.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } } | { sessionID?: string } | undefined;
        const sid = (props as any)?.info?.id ?? (props as any)?.sessionID;
        if (sid) {
          const waiters = sessionDeletedWaiters.get(sid);
          if (waiters && waiters.length > 0) {
            for (const w of [...waiters]) {
              try { w(); } catch { /* ignore */ }
            }
          }
        }
        return;
      }
      if (event?.type !== "session.created") return;
      const props = event.properties as { info?: { id?: string } } | undefined;
      const sid = props?.info?.id;
      logger.debug(`[event] session.created sid=${sid} pendingDispatch.has=${sid ? pendingDispatch.has(sid) : "no-sid"}`);
      if (!sid) return;
      if (!pendingDispatch.has(sid)) return;
      await spawnPaneForSession(sid);
    },

    "chat.params": async (input) => {
      if (input.sessionID && input.agent) {
        sessionAgent.set(input.sessionID, input.agent);
      }
    },

    // ─────────────────────────────────────────────────────────────
    // PreToolUse — block destructive bash, gate `git push`,
    //              and physically forbid team-leader from direct file writes.
    // hook input shape (1.3.3): { tool, sessionID, callID }
    // Per-agent enforcement: sessionAgent Map을 통해 sessionID → agent 조회.
    // ─────────────────────────────────────────────────────────────
    "tool.execute.before": async (input, output) => {
      // Hard-block oh-my-openagent's call_omo_agent regardless of opencode.json
      // tools setting. makdoong2-team has its own dispatch_stage / get_fallback_model
      // pipeline; OmO's loop-style fallback would break stage gating and double-spawn
      // sub-agents. Throwing here cancels the tool call before it reaches OmO.
      const sessionID = (input as any).sessionID as string | undefined;
      // chat.params 와 tool.execute.before 사이의 race 가능성:
      // sub-session이 promptAsync 직후 첫 tool을 호출할 때 chat.params 가 아직
      // 미발화된 상태일 수 있다. pendingDispatch 는 promptAsync 이전에 채워지므로
      // 이를 fallback으로 사용하면 race window 를 완전히 닫는다.
      const agent = sessionID
        ? (sessionAgent.get(sessionID) ?? pendingDispatch.get(sessionID)?.agent)
        : undefined;
      const toolLower = (input.tool || "").toLowerCase();

      logger.debug(`[makdoong2-team hook] tool.execute.before fired: tool="${input.tool}" sessionID="${sessionID}" agent="${agent ?? "unknown"}" callID="${(input as any).callID}"`);

      if (sessionID) {
        sessionLastToolExecuteAt.set(sessionID, Date.now());
        sessionActiveToolCount.set(sessionID, (sessionActiveToolCount.get(sessionID) ?? 0) + 1);
      }

      if (sessionID && (toolLower === "dispatch_stage" || toolLower === "dispatch_verifier")) {
        const callID = (input as any).callID as string | undefined;
        if (callID) parentSessionByCallID.set(callID, sessionID);
        parentSessionByToolStack.push(sessionID);
        logger.debug(`[makdoong2-team hook] captured parentSessionID=${sessionID} for ${input.tool} callID=${callID}`);
      }

      if (input.tool === "call_omo_agent") {
        logger.error(`[makdoong2-team hook] BLOCKED: call_omo_agent invocation detected`);
        throw new Error(
          "[makdoong2-team] call_omo_agent is forbidden in this workflow. " +
          "Use dispatch_stage / dispatch_verifier / get_fallback_model instead. " +
          "If dispatch_stage is missing, the makdoong2-team plugin failed to load — " +
          "fix the plugin (likely: cd ~/.config/opencode/plugins/makdoong2-team && npm install --ignore-scripts)."
        );
      }

      if (OUTER_WORLD_TOOLS.has(toolLower)) {
        if (!agent) {
          logger.debug(
            `[makdoong2-team hook] outer-world tool "${input.tool}" called, agent unknown ` +
            `(sessionAgent not yet populated). Allowing — primary session passthrough. ` +
            `sessionID="${sessionID}" callID="${(input as any).callID}".`
          );
        } else if (SEALED_SUBAGENTS.has(agent)) {
          logger.error(
            `[makdoong2-team hook] BLOCKED: sealed sub-agent "${agent}" attempted outer-world tool "${input.tool}" (sessionID="${sessionID}")`
          );
          throw new Error(
            `[makdoong2-team sealed workflow violation]\n` +
            `Agent "${agent}" cannot call "${input.tool}".\n\n` +
            `Makdoong2 sub-agents are SEALED and must not delegate to outer-world agents ` +
            `(Sisyphus / Explore / Librarian / Oracle / Metis / Momus 등 oh-my-openagent 계열).\n\n` +
            `**허용된 대안:**\n` +
            `• 조사/리서치: \`skill_mcp\` 툴로 아래 스킬 사용\n` +
            `    - jira-research (Jira 이슈)\n` +
            `    - confluence-research (설계 문서, 위키)\n` +
            `    - bitbucket-research (소스 코드, PR, 커밋)\n` +
            `    - github-oss-research (공개 저장소, OSS 참조)\n` +
            `• 다른 substage 작업 필요 시: 결과·스펙을 team-leader에게 반환하면 team-leader가 dispatch_stage로 라우팅.\n` +
            `• 상태 공유: \`state.sh set\` 으로 state.json 마커에 기록. team-leader가 읽어서 다음 단계 결정.\n\n` +
            `**아키텍처 원칙:** 각 substage는 self-contained. Inter-substage 의존은 team-leader 오케스트레이션을 통해서만 흐르며, ` +
            `agent-to-agent 직접 호출은 금지된다. 참조: CLAUDE.md "워크플로우 상태 & 위임 규약".`
          );
        }
      } else if (agent && SEALED_SUBAGENTS.has(agent) && DELEGATION_LIKE_NAME.test(toolLower) && !KNOWN_SAFE_TOOLS.has(toolLower)) {
        logger.debug(
          `[makdoong2-team hook] sealed sub-agent "${agent}" called delegation-like tool "${input.tool}" not in blocklist. ` +
          `Consider adding to OUTER_WORLD_TOOLS if this is a new oh-my-openagent delegation tool.`
        );
      }

      // ── skill_mcp lazy-load 사전 힌트 ──
      // opencode 는 skill 이 로드되기 전에 skill_mcp 를 호출하면
      // "MCP server not found" 로 튕기지만 정작 어떤 skill 을 로드해야 하는지는
      // 알려주지 않는다. 우리가 관리하는 mcp_name 이면 콘솔에 정확한 skill 이름을
      // 미리 남긴다 — 성공 시엔 아무 영향 없고, 실패 시 사용자·디버거가 로그에서
      // 즉시 원인을 볼 수 있다. 사전 throw 는 하지 않는다 — outer MCP (site-wide)
      // 나 chrome-devtools-mcp 처럼 skill 밖의 MCP 도 정상 케이스다.
      if (toolLower === "skill_mcp") {
        const mcpName = extractMcpName((output as { args?: unknown }).args);
        if (mcpName && knownMcpNames.has(mcpName)) {
          const skillName = knownMcpNames.get(mcpName)!;
          logger.debug(
            `[makdoong2-team hook] skill_mcp lazy-load hint: mcp_name="${mcpName}" ` +
            `is embedded in skill "${skillName}". If the call fails with "not found", ` +
            `first invoke skill(name="${skillName}") in the current session, then retry.`,
          );
        }
      }

      // ── Leader hardrule 1: 직접 파일 편집·생성 금지 (write/edit/patch/multiedit) ──
      if (agent === "makdoong2-team-leader" && LEADER_FORBIDDEN_TOOLS.has(toolLower)) {
        logger.error(`[makdoong2-team hook] BLOCKED: team-leader가 ${input.tool} 툴 호출을 시도했다.`);
        throw new Error(
          `[makdoong2-team hardrule 1] team-leader는 '${input.tool}' 툴을 직접 호출할 수 없다. ` +
          "파일 조작은 반드시 dispatch_stage로 engineer/planner/publisher 막둥이에 위임하라. " +
          "auto_advance_stage의 next_action 필드가 지시하는 dispatch_stage 호출을 우선 실행하라."
        );
      }

      if (input.tool !== "bash") return;
      const cmd = (output.args as { command?: string })?.command ?? "";
      if (!cmd) return;

      // ── Universal state.json hardrule: agent 식별 결과와 무관하게 차단 ──
      // sessionAgent map race, primary/outer session, undefined agent 모두 포함.
      if (looksLikeSealedStateWrite(cmd)) {
        logger.error(`[makdoong2-team hook] BLOCKED: state.json 우회 조작 시도 (agent="${agent ?? "unknown"}"). cmd="${redactAndTruncate(cmd, 200)}"`);
        throw new Error(
          `[makdoong2-team state hardrule] state.json 은 오직 state.sh (get/set/init/append/update/migrate) 로만 조작할 수 있다.\n` +
          `직접 편집 (python -c open, node -e writeFileSync, sed -i, jq > , tee, cat > , echo > 등)은 workflow 정합성을 훼손하므로 금지된다.\n` +
          `caller agent="${agent ?? "unknown"}"`
        );
      }

      // ── Leader hardrule 2: Bash 우회 파일 쓰기 금지 (state.json 제외) ──
      if (agent === "makdoong2-team-leader" && looksLikeFileWrite(cmd)) {
        logger.error(`[makdoong2-team hook] BLOCKED: team-leader가 bash 파일 쓰기 우회를 시도했다. cmd="${redactAndTruncate(cmd, 200)}"`);
        throw new Error(
          "[makdoong2-team hardrule 2] team-leader는 bash를 통한 파일 쓰기(>, >>, tee, sed -i, cat > 등)도 금지된다. " +
          "허용: git commit/push/add/rm, state.sh set. " +
          "그 외 파일 생성·수정은 dispatch_stage로 engineer 막둥이에 위임하라."
        );
      }

      // ── Planner/Analyzer hardrule: READ-ONLY 원칙 - bash 파일 쓰기 일체 금지 ──
      if ((agent === "makdoong2-planner" || agent === "makdoong2-analyzer") && looksLikeFileWrite(cmd)) {
        logger.error(
          `[makdoong2-team hook] BLOCKED: ${agent}가 bash 파일 쓰기를 시도했다 (READ-ONLY 위반). cmd="${redactAndTruncate(cmd, 200)}"`
        );
        throw new Error(
          `[makdoong2-team READ-ONLY hardrule] ${agent}는 Read-only 에이전트로 파일 생성·수정이 일체 금지된다.\n\n` +
          `**허용**: state.sh set (state.json 마커 기록만)\n` +
          `**금지**: bash 리디렉션 (>, >>, tee, cat >, echo >, sed -i, awk > 등), Python/Node 인터프리터 파일 쓰기\n\n` +
          `**올바른 절차**:\n` +
          `• Planning 단계 (planner): "무엇을 만들지" 결정만. 실제 파일 생성은 implementation 단계로 위임.\n` +
          `• Analysis 단계 (analyzer): workspace-analysis.json 1개만 생성 가능 (Write 툴 사용).\n` +
          `• 초안 파일 필요 시: spec을 team-leader에게 반환 → dev 단계에서 engineer가 구현.\n\n` +
          `**참조**: agents/${agent}.md "금지" 섹션, CLAUDE.md "워크플로우 상태 & 위임 규약"`
        );
      }

      const hookIssue = sessionIssue.get(sessionID ?? "") ?? "";
      const r = await runScript(HOOKS_DIR, "guard-bash.sh", cmd, hookIssue);
      if (!r.ok) {
        throw new Error((r.stderr || "makdoong2-team gate blocked").trim());
      }
    },

    // ─────────────────────────────────────────────────────────────
    // PostToolUse — sync mechanical facts (commit done, etc.).
    // hook input shape (1.3.3): { tool, sessionID, callID, args }
    // output shape (1.3.3): { title, output: string, metadata }
    // ─────────────────────────────────────────────────────────────
    "tool.execute.after": async (input, output) => {
      const toolLowerAfter = (input.tool || "").toLowerCase();
      const afterSessionID = (input as any).sessionID as string | undefined;
      if (afterSessionID) {
        sessionLastToolExecuteAt.set(afterSessionID, Date.now());
        const cur = sessionActiveToolCount.get(afterSessionID) ?? 0;
        if (cur <= 1) sessionActiveToolCount.delete(afterSessionID);
        else sessionActiveToolCount.set(afterSessionID, cur - 1);
      }

      if (afterSessionID && WRITE_TOOLS.has(toolLowerAfter)) {
        const agentAfter = sessionAgent.get(afterSessionID)
          ?? pendingDispatch.get(afterSessionID)?.agent;
        const filePath = extractFilePathFromToolArgs(input.args);
        logger.debug(
          `[auto-git-add-hook] tool=${toolLowerAfter} session=${afterSessionID} ` +
          `agent=${agentAfter ?? "unknown"} filePath=${filePath ?? "N/A"} ` +
          `wt=${sessionWorktree.get(afterSessionID) ?? pendingDispatch.get(afterSessionID)?.worktree ?? "N/A"} ` +
          `issue=${sessionIssue.get(afterSessionID) ?? "N/A"}`,
        );
        if (agentAfter === "makdoong2-engineer" && filePath) {
          const result = await trackAndStageEngineerWrite(afterSessionID, filePath)
            .catch((err: unknown) => ({
              ok: false,
              relPath: filePath,
              error: `hook exception: ${(err as Error)?.message ?? String(err)}`,
            } as { ok: boolean; relPath?: string; error?: string }));
          if (!result.ok && result.relPath) {
            const warn = `\n\n[makdoong2-team] auto git add FAILED for "${result.relPath}": ${redactAndTruncate(result.error ?? "", 200)}\n` +
              `→ 조치: bash 로 'git add -- ${result.relPath}' 를 직접 실행해 stage 하시오. dev exit gate 가 unstaged 파일을 차단한다.`;
            const outAny = output as { output?: string };
            outAny.output = (outAny.output ?? "") + warn;
          }
        }
      }

      if (toolLowerAfter === "dispatch_stage" || toolLowerAfter === "dispatch_verifier") {
        const callID = (input as any).callID as string | undefined;
        if (callID) parentSessionByCallID.delete(callID);
        if (parentSessionByToolStack.length > 0) parentSessionByToolStack.pop();
      }
      if (input.tool === "skill_mcp") {
        const outAny = output as { output?: string };
        const raw = outAny.output ?? "";
        const mcpName = extractMcpName(input.args);
        const skillName = mcpName ? knownMcpNames.get(mcpName) : undefined;

        if (looksLikeMcpNotFound(raw)) {
          if (skillName) {
            outAny.output = [
              `[makdoong2-team] MCP server "${mcpName}" is embedded in skill "${skillName}" and must be loaded first.`,
              `Next step:`,
              `  1. Call skill(name="${skillName}") in the current session to spawn the MCP server.`,
              `  2. Then retry skill_mcp(mcp_name="${mcpName}", tool_name=..., arguments=...).`,
              `Reason: lazy-load MCP — declared in SKILL.md frontmatter, not spawned until the skill is loaded.`,
              ``,
              `Original opencode output:`,
              raw,
            ].join("\n");
            logger.debug(
              `[makdoong2-team hook] skill_mcp not-found rewritten: mcp_name="${mcpName}" → skill="${skillName}"`,
            );
          }
        } else if (looksLikeMcpConnectionFailed(raw)) {
          if (skillName) {
            outAny.output = [
              `[makdoong2-team] skill MCP server "${mcpName}" (skill: ${skillName}) connected but process exited immediately.`,
              `Possible causes:`,
              `  1. credentials: ~/.config/opencode/makdoong2-team.json 의 .secrets 토큰 미설정 또는 만료`,
              `  2. dependencies: jq 또는 npx 가 PATH 에 없음`,
              `  3. run: npx makdoong2-team doctor  — 설정 상태 진단`,
              ``,
              `Original error:`,
              raw,
            ].join("\n");
            logger.debug(
              `[makdoong2-team hook] skill_mcp connection-failed rewritten: mcp_name="${mcpName}" skill="${skillName}"`,
            );
          }
        }
      }

      if (input.tool !== "bash") return;
      const cmd = (input.args as { command?: string })?.command ?? "";
      if (!cmd) return;
      const out = (output as { output?: string }).output ?? "";
      const hookIssueAfter = sessionIssue.get((input as any).sessionID ?? "") ?? "";
      await runScript(HOOKS_DIR, "sync-state.sh", cmd, out, hookIssueAfter);
    },

    // ─────────────────────────────────────────────────────────────
    // Config hook — inject model settings into opencode agent registry AND
    // override MCP tokens from makdoong2-team.json (.secrets.*) into the
    // shared config object BEFORE MCP.state() spawns servers.
    //
    // Rationale for MCP env mutation: opencode 1.4.14 Config.get() returns
    // the live config object by reference (Config.Info is DeepMutable). The
    // MCP layer later reads cfg.mcp[key].environment on connectLocal(). By
    // mutating here, we make makdoong2-team.json the SSoT for direct MCP
    // tool calls (repos_*, works_*, docs_*, bamboo_*) — the same policy that
    // skills/_lib/load-secret.sh already enforces for skill_mcp calls.
    // See src/mcp-secret-injector.ts for the full rationale.
    // ─────────────────────────────────────────────────────────────
    config: async (opencodeConfig: any) => {
      if (!opencodeConfig.agent) {
        opencodeConfig.agent = {};
      }

      for (const [agentName, policy] of Object.entries(POLICIES)) {
        if (!policy?.primary?.id) continue;

        if (!opencodeConfig.agent[agentName]) {
          opencodeConfig.agent[agentName] = {
            name: agentName,
            description: `Makdoong2 workflow agent (${agentName})`,
            mode: agentName === "makdoong2-team-leader" ? "primary" : "subagent",
          };
        }

        opencodeConfig.agent[agentName].model = policy.primary.id;

        if (policy.primary.variant) {
          opencodeConfig.agent[agentName].variant = policy.primary.variant;
        }

        logger.debug(
          `[makdoong2-team config] Injected model for ${agentName}: ${policy.primary.id}` +
          (policy.primary.variant ? ` (variant: ${policy.primary.variant})` : "")
        );
      }

      const secrets = (config.secrets ?? {}) as Record<string, string>;
      const results = injectAllSecrets(opencodeConfig, secrets);
      for (const r of results) {
        if (r.status === "overridden") {
          logger.warn(
            `[makdoong2-team config] MCP secret OVERRIDDEN: mcp="${r.mcpKey}" var="${r.varName}" ` +
            `— opencode.json value differed from makdoong2-team.json (SSoT wins). ` +
            `Reconcile the two files to remove this warning.`
          );
        } else {
          const suffix = r.tokenPrefix ? ` (prefix=${r.tokenPrefix}…)` : "";
          logger.debug(
            `[makdoong2-team config] MCP secret ${r.status}: mcp="${r.mcpKey}" var="${r.varName}"${suffix}`
          );
        }
      }
    },

    // ─────────────────────────────────────────────────────────────
    // Custom tools — called by the orchestrator (부장님).
    // SDK 1.3.3 requires tool() factory with Zod args.
    // execute() must return Promise<string> (serialize objects as JSON).
    // ─────────────────────────────────────────────────────────────
    tool: {
      /**
       * verify_stage — gate-only check. Returns ok/reason without dispatching.
       */
      verify_stage: tool({
        description: "Verify entry gate for a stage; return ok/blocked without spawning any agent.",
        args: {
          issue: tool.schema.string().describe("Jira issue key, e.g. PROJ-12345"),
          target_stage: tool.schema.enum(STAGE_ORDER as [Stage, ...Stage[]]),
          worktree: tool.schema.string().optional().describe("Absolute worktree path; defaults to plugin cwd"),
        },
        async execute(args) {
          const gateCwd = args.worktree ?? cwd;
          const verify = await runScriptCwd(gateCwd, GATES_DIR, "verify.sh", args.issue, args.target_stage);
          if (!verify.ok) {
            return JSON.stringify({
              ok: false,
              gate: args.target_stage,
              reason: verify.stderr.trim(),
            });
          }
          const ext = await checkExtensionGates(args.issue, args.target_stage as Stage, gateCwd);
          if (!ext.ok) {
            return JSON.stringify({
              ok: false,
              gate: args.target_stage,
              reason: ext.reason,
              marker_path: (ext as { ok: false; reason: string; marker_path?: string }).marker_path,
            });
          }
          const spec = agentForStage(args.target_stage as Stage);
          const policy = POLICIES[spec.id];
          const workPolicy = await readPolicy(args.issue, gateCwd);
          return JSON.stringify({
            ok: true,
            gate: args.target_stage,
            agent: spec.id,
            primary_only: spec.primary_only,
            model: policy?.primary,
            category: workPolicy?.category ?? null,
            auto_approve: workPolicy?.auto_approve?.[args.target_stage] ?? null,
          });
        },
      }),

      /**
       * dispatch_stage — spawn the per-stage agent via opencode CLI.
       */
      dispatch_stage: tool({
        description: "Verify gate and spawn the per-stage sub-agent via opencode CLI. Returns execution result.",
        args: {
          issue:          tool.schema.string().describe("Jira issue key, e.g. PROJ-12345"),
          target_stage:   tool.schema.enum(STAGE_ORDER as [Stage, ...Stage[]]),
          worktree:       tool.schema.string().describe("Absolute path to the worktree"),
          context:        tool.schema.string().optional().describe("Extra context to append to the agent prompt"),
          model_override: tool.schema.string().optional().describe("Override model ID (e.g. for fallback)"),
        },
        async execute(args, context) {
          let success = false;
          const spec = agentForStage(args.target_stage as Stage);

          if (spec.primary_only) {
            return JSON.stringify({
              ok: false,
              gate: args.target_stage,
              reason: "PRIMARY_ONLY_STAGE",
              agent: spec.id,
              primary_only: true,
              hint: "This stage must be executed by the orchestrator (team-leader) directly; sub-agent spawn is not permitted.",
            });
          }

          // done=true stage 재-dispatch 방지 (sub-agent tool-call loop → timeout/empty output).
          // 3_delivery.* 는 hybrid stage (publisher = spec provider) 로 재-진입이 정상 흐름이라 제외.
          const isHybridDelivery = args.target_stage.startsWith("3_delivery.");
          if (!isHybridDelivery) {
            const doneR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageJqPath(args.target_stage as Stage) + ".done"}`
              .cwd(args.worktree).quiet().nothrow();
            if (doneR.exitCode === 0 && doneR.stdout?.toString().trim() === "true") {
              return JSON.stringify({
                ok: false,
                gate: args.target_stage,
                stage: args.target_stage,
                agent: spec.id,
                already_done: true,
                reason:
                  `Stage '${args.target_stage}' is already done=true. ` +
                  `Re-dispatching a completed stage causes sub-agent tool-call loops (timeout/empty output). ` +
                  `Call auto_advance_stage to obtain the correct next stage instead.`,
              });
            }
          }

          // Cross-call stall cap. hang_history accumulates across every
          // dispatch_stage invocation for this substage, so it is the only
          // signal that survives the per-call attempt budget reset. Refuse to
          // spawn yet another doomed session once it is saturated — swapping
          // models does not clear an upstream LLM hang, so the correct action
          // is to stop and escalate to a human.
          const hangCountR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${stageJqPath(args.target_stage as Stage)}.hang_history // [] | length`}`
            .cwd(args.worktree).quiet().nothrow();
          const hangCount = hangCountR.exitCode === 0
            ? Number.parseInt(hangCountR.stdout?.toString().trim() ?? "", 10)
            : Number.NaN;
          if (shouldEscalateStall(hangCount, stallEscalateThreshold)) {
            logger.error(
              `[dispatch_stage] STALL_ESCALATE issue=${args.issue} stage=${args.target_stage} ` +
              `hang_history=${hangCount}/${stallEscalateThreshold} — refusing to redispatch`,
            );
            return JSON.stringify({
              ok: false,
              escalate: true,
              stall_streak_exceeded: true,
              stage: args.target_stage,
              agent: spec.id,
              hang_history_len: hangCount,
              threshold: stallEscalateThreshold,
              reason:
                `Substage '${args.target_stage}' 이 누적 ${hangCount}회 hang (message_stall / status_absent) 했다. ` +
                `dispatch_stage 재호출은 attempt 예산만 리셋할 뿐 원인을 해소하지 못하므로 차단한다. ` +
                `모델 교체도 해법이 아니다 (동일 stall 이 fallback 모델에서도 재현됨). ` +
                `사용자에게 hang_history 를 보고하고 지시를 기다려라. ` +
                `원인 조사 후 재개하려면 state.sh set 으로 hang_history 를 [] 로 초기화해야 한다.`,
            });
          }

          const WORKTREE_ISOLATED_STAGES = new Set<string>([
            "2_implementation.dev", "2_implementation.test",
            "3_delivery.commit", "3_delivery.pr", "3_delivery.review",
          ]);
          let effectiveWorktree = args.worktree;
          if (WORKTREE_ISOLATED_STAGES.has(args.target_stage)) {
            const storedWtR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${".worktree"}`
              .cwd(args.worktree).quiet().nothrow();
            const storedWt = storedWtR.stdout?.toString().trim();
            if (storedWt && storedWt !== "null" && storedWt !== "" && storedWt !== args.worktree) {
              if (!existsSync(storedWt)) {
                return JSON.stringify({
                  ok: false,
                  error: "worktree_missing",
                  state_worktree: storedWt,
                  reason: `state.json worktree "${storedWt}" 가 파일 시스템에 존재하지 않습니다.`,
                  next_action: `auto_advance_stage(issue: "${args.issue}") 를 호출하면 worktree 를 자동 재생성합니다. dispatch_stage 를 먼저 호출하지 마세요.`,
                });
              }
              logger.warn(
                `[dispatch_stage] worktree 불일치 감지 — ` +
                `LLM 인자: "${args.worktree}", state.json: "${storedWt}". 자동 수정.`
              );
              effectiveWorktree = storedWt;
            }
          }

          const verify = await runScriptCwd(effectiveWorktree, GATES_DIR, "verify.sh", args.issue, args.target_stage);
          if (!verify.ok) {
            return JSON.stringify({
              ok: false,
              gate: args.target_stage,
              reason: verify.stderr.trim(),
              agent: spec.id,
              stage: args.target_stage,
            });
          }

          const gateAutoSkipped = verify.stdout.includes("MAKDOONG2-GATE SKIP");
          if (gateAutoSkipped) {
            return JSON.stringify({
              ok: true,
              skipped: true,
              stage: args.target_stage,
              message: verify.stdout.trim(),
            });
          }

          const ext = await checkExtensionGates(args.issue, args.target_stage as Stage, effectiveWorktree);
          if (!ext.ok) {
            return JSON.stringify({
              ok: false,
              gate: args.target_stage,
              reason: ext.reason,
              marker_path: (ext as { ok: false; reason: string; marker_path?: string }).marker_path,
              agent: spec.id,
              stage: args.target_stage,
            });
          }

          // Model selection: override wins, then policy primary.
          // activeXxx variables are mutated on fallback switch (session_gone
          // recovery after MAX_ATTEMPTS on primary). All references inside the
          // dispatch loop MUST use activeModelFull/activeProviderID/activeModelID
          // so a switch takes effect immediately on the next iteration.
          const policy = POLICIES[spec.id];
          let activeModelFull =
            args.model_override ?? policy?.primary?.id ?? "github-copilot/claude-sonnet-4.6";
          const parseModelId = (full: string): { providerID: string; modelID: string } => {
            const idx = full.indexOf("/");
            return {
              providerID: idx > 0 ? full.slice(0, idx) : "github-copilot",
              modelID: idx > 0 ? full.slice(idx + 1) : full,
            };
          };
          let { providerID: activeProviderID, modelID: activeModelID } = parseModelId(activeModelFull);

          const specPath = `${STAGES_DIR}/${STAGE_SPEC_FILES[args.target_stage as Stage]}`;
          if (!existsSync(specPath)) {
            return JSON.stringify({
              ok: false,
              error: "stage_spec_missing",
              stage: args.target_stage,
              spec_path: specPath,
              stages_dir: STAGES_DIR,
              reason:
                `Stage spec file not found at resolved path. STAGES_DIR was resolved to '${STAGES_DIR}'. ` +
                `Check: (1) makdoong2-team.json paths.stages override is correct, ` +
                `(2) npm package includes stages/ directory (see package.json files field), ` +
                `(3) reinstall via 'npx makdoong2-team install' if stages/ was removed.`,
            });
          }
          const lastVerdictReasonR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageJqPath(args.target_stage as Stage) + ".last_verdict_reason"}`
            .cwd(effectiveWorktree).quiet().nothrow();
          let lastVerdictReason: string | null = null;
          if (lastVerdictReasonR.exitCode === 0) {
            const raw = (lastVerdictReasonR.stdout?.toString() ?? "").trimEnd();
            if (raw && raw !== "null") lastVerdictReason = raw;
          }
          const lastVerdictStreakR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageJqPath(args.target_stage as Stage) + ".same_reason_streak"}`
            .cwd(effectiveWorktree).quiet().nothrow();
          const lastVerdictStreak = lastVerdictStreakR.exitCode === 0
            ? (parseInt(lastVerdictStreakR.stdout?.toString().trim() || "0", 10) || 0)
            : 0;

          const buildPromptText = (attemptNum: number, priorSessionIds: string[]): string => {
            const base = [
              `Working directory (ABSOLUTE): ${effectiveWorktree}`,
              `Scripts directory (ABSOLUTE): ${SCRIPTS_DIR}`,
              `Stages directory (ABSOLUTE): ${STAGES_DIR}`,
              `Issue: ${args.issue}`,
              `Stage spec: read ${specPath} and follow it strictly.`,
              `모든 state.sh / wt-sync-ignored.sh / config.sh 호출은 위 Scripts directory 경로를 사용하시오. \`$HOME/.config/opencode/scripts/\`나 \`scripts/\` 상대경로를 사용하지 마시오.`,
              `Stage 명세 파일은 위 Stages directory 경로에서 읽으시오. \`<SCRIPTS_DIR>/../stages/\` 상대경로를 사용하지 마시오.`,
            ];
            if (args.target_stage === "2_implementation.dev") {
              base.push(
                `\n=== dev substage 요구사항 소스 우선순위 ===`,
                `구현 착수 전 요구사항은 반드시 다음 순서로 참조한다:`,
                `  a) FIRST — requirements-draft.md 를 우선 확인 (아래 bash 스니펫 그대로 실행):`,
                buildDraftPathReadSnippet(args.issue, "       "),
                `     파일이 존재하고 비어있지 않으면 이 파일이 요구사항의 진실의 원천이다.`,
                `  b) FALLBACK — draft_path 미기록/파일 부재/빈 파일 인 경우 Jira 이슈 조회:`,
                `       skill(name="jira-research") 로 works MCP 로드 →`,
                `       skill_mcp(mcp_name="works", tool_name="getIssue", arguments={"issueKey":"${args.issue}"})`,
                `  c) 두 소스 모두 접근 불가하면 사용자에게 상황을 보고하고 즉시 종료.`,
                `주의: requirements-draft.md 없이 Jira 이슈만으로 구현 범위를 재결정하지 말 것 — draft 가 없다는 것은 planning 이 부적절하게 진행된 신호이므로 사용자에게 보고하고 종료하시오.`,
              );
            }
            if (attemptNum > 1) {
              base.push(
                `\n=== 재개(resume) 지시 — 이전 세션 중단됨 ===`,
                `이전 세션 ID: ${priorSessionIds.join(", ")} (attempt ${attemptNum - 1})`,
                `중단 원인: 이전 sub-session이 stall/gone 감지되어 새 세션으로 이어서 진행합니다.`,
                `context 승계 방식: opencode API는 세션 간 대화 이력을 옮기지 못하므로 state.json 을 진실의 원천으로 사용합니다.`,
                `첫 번째 필수 작업:`,
                `  1) bash ${SCRIPTS_DIR}/state.sh get ${args.issue} '.' 로 현재 상태 전량 조회`,
                `  2) 이미 done=true 로 기록된 substage / 마커는 재실행하지 말고 skip`,
                `  3) 미완료 substage 부터 stage spec 순서대로 이어서 진행`,
                `  4) 완료 시 관례대로 요약 출력 후 종료`,
                `주의: state.json 마커가 이미 target substage 완료를 나타내면 즉시 요약만 출력하고 종료하시오 (재작업 금지).`,
              );
            }
            if (lastVerdictReason) {
              base.push(
                `\n=== 이전 검증 실패 사유 (재작업 시 참고) ===`,
                `직전 attempt 가 makdoong2-verifier 에 의해 REJECTED 되었다. 같은 사유로 다시 실패하면 무한 루프로 판정된다 (동일 사유 ${lastVerdictStreak}회 연속 감지 중, 5회 도달 시 자동 중단).`,
                `아래 verifier 판정 원문을 읽고 지적된 규칙 위반·마커 누락·검증 실패 항목을 최우선으로 해결하시오. 동일한 접근을 반복하지 말고 finding 에 지적된 대안 (파일 재분할·마커 재기록·형식 수정 등) 을 시도하시오.`,
                `--- verifier 판정 원문 (앞 4000자) ---`,
                lastVerdictReason,
                `--- 원문 끝 ---`,
              );
            }
            if (args.context) base.push(args.context);
            return base.join("\n");
          };

          const parentSessionID = context?.sessionID ?? dispatchParentSessionID(undefined);
          if (!parentSessionID) {
            return JSON.stringify({
              ok: false,
              reason: "dispatch_stage 호출자의 sessionID를 얻지 못했다. ToolContext.sessionID 미제공 및 hook fallback 실패.",
              stage: args.target_stage,
            });
          }
          logger.debug(`[dispatch_stage] creating sub-session with parentID=${parentSessionID} target=${args.target_stage} agent=${spec.id}`);

          // session_gone auto-redispatch: pollSubSession이 kind:"session_gone" 을
          // 반환하는 두 경로 모두 여기서 재시도된다:
          //   - status-absent: orphan detection이 세션을 status map에서 제거한 경우
          //   - reason="message_stall": 세션은 살아있지만 LLM API 무응답 (upstream
          //     provider silent, quota 소진, 로컬 LLM 서버 hang 등)
          // opencode SDK가 세션 간 대화 이력 이관을 지원하지 않으므로 새 세션은
          // state.json 완료 마커를 진실의 원천으로 사용해 이어서 진행한다.
          // 지수 백오프: attempt별 messageStallThresholdMs 를 1분→2분→4분으로
          // 늘려 slow-first-token 모델에 여유를 준다.
          //
          // fallback_model auto-switch: primary 모델이 MAX_ATTEMPTS(3) 동안 모두
          // status_absent session_gone 으로 실패하면 model-fallback-policy 의
          // nextModel() 이 반환하는 fallback (설정에서 fallback_models 로 지정)
          // 로 자동 전환한다. 한 단계만 허용 (activeFallbackDepth=1) 하여
          // 무한 fallback 루프를 방지하고, fallback 은 MAX_FALLBACK_ATTEMPTS(2)
          // 만 재시도한다. 다음 케이스에서는 fallback switch 를 skip 한다:
          //   - user model_override 존재: 사용자가 명시 선택한 모델을 무시하지 않는다
          //   - message_stall: LLM API hang 은 모델 교체로 해소되지 않는 문제일
          //     가능성이 높으므로 primary 만 재시도하고 종료
          const MAX_ATTEMPTS = 3;
          const MAX_FALLBACK_ATTEMPTS = 2;
          let attempt = 0;
          let activeFallbackDepth = 0;
          const maxAttemptsForCurrentModel = () =>
            activeFallbackDepth === 0 ? MAX_ATTEMPTS : MAX_FALLBACK_ATTEMPTS;
          let finalResultJson: string | null = null;
          const attemptSessionIds: string[] = [];

          while (attempt < maxAttemptsForCurrentModel() && finalResultJson === null) {
            attempt++;
            const isRetry = attempt > 1;

            const createResult = await (client as any).session
              .create({
                body: {
                  parentID: parentSessionID,
                  title: `${args.target_stage} (@${spec.id})${isRetry ? ` [retry ${attempt}]` : ""}`,
                },
                query: { directory: effectiveWorktree },
              })
              .catch((e: unknown) => ({ error: e, data: null }));

            logger.debug(
              `[dispatch_stage] session.create: directory=${effectiveWorktree} ` +
              `parentID=${parentSessionID} title="${args.target_stage} (@${spec.id})"`,
            );

            if (createResult.error || !createResult.data) {
              finalResultJson = JSON.stringify({
                ok: false,
                reason: `session create failed (attempt=${attempt}): ${JSON.stringify(createResult.error)}`,
                stage: args.target_stage,
                attempts: attempt,
              });
              break;
            }
            const subSessionID = (createResult.data as { id: string }).id;
            attemptSessionIds.push(subSessionID);
            logger.debug(
              `[dispatch_stage] sub-session created: subSessionID=${subSessionID} ` +
              `parentID=${parentSessionID} attempt=${attempt}`,
            );
            if (isRetry) {
              logger.warn(
                `[dispatch_stage] REDISPATCH attempt=${attempt}/${MAX_ATTEMPTS} ` +
                `previous_session_gone → new_session_id=${subSessionID} stage=${args.target_stage}`,
              );
            }
            sessionIssue.set(subSessionID, args.issue);
            subSessionIds.add(subSessionID);
            pendingDispatch.set(subSessionID, {
              stage: args.target_stage,
              agent: spec.id,
              worktree: effectiveWorktree,
              startedAt: Date.now(),
            });
            sessionWorktree.set(subSessionID, effectiveWorktree);
            appendSessionIndex({
              sessionID: subSessionID,
              agent: spec.id,
              worktree: effectiveWorktree,
              issue: args.issue,
              stage: args.target_stage,
              createdAt: new Date().toISOString(),
            });

            let sessionGone = false;
            let success = false;

            try {
            // fire-and-observe: sync `prompt` drives model execution inline without
            // relying on an external wake signal (OMO or otherwise). We do NOT await
            // here so that spawnPaneForSession + pollSubSession run concurrently and
            // provide real-time tmux monitoring. pollSubSession remains the authoritative
            // completion signal; prompt drives the work, poll observes it.
            const attemptPromptText = buildPromptText(attempt, attemptSessionIds.slice(0, -1));
            const promptPromise = (client as any).session
              .prompt({
                path: { id: subSessionID },
                body: {
                  agent: spec.id,
                  tools: { question: false },
                  parts: [{ type: "text", text: attemptPromptText }],
                  model: { providerID: activeProviderID, modelID: activeModelID },
                } as Record<string, unknown>,
                query: { directory: effectiveWorktree },
              })
              .catch((e: unknown) => ({ error: e }));

            // Fast-fail: a successful model run holds the connection open for the full
            // run duration, so any response arriving within 2 s is an HTTP-level failure
            // (404 unknown session, 400 invalid agent, etc.).
            const earlyResult = await Promise.race([
              promptPromise,
              new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
            ]);
            if (earlyResult !== "pending" && (earlyResult as any)?.error) {
              finalResultJson = JSON.stringify({
                ok: false,
                reason: `prompt failed (attempt=${attempt}): ${JSON.stringify((earlyResult as any).error)}`,
                stage: args.target_stage,
                attempts: attempt,
              });
              continue;
            }

            await spawnPaneForSession(subSessionID);

            logger.debug(
              `[dispatch_stage] engineer session ready — ` +
              `session_id=${subSessionID} stage=${args.target_stage} attempt=${attempt}\n` +
              `  monitor: opencode attach http://127.0.0.1:44707 --session ${subSessionID}`,
            );

            const nudgeText = [
              "⚠ 작업 시한 80% 도달 — 현재 작업을 마무리하고 즉시 세션을 종료하시오.",
              "",
              "허용된 남은 작업:",
              "1. 진행 중인 단일 tool call 완료",
              `2. bash ${SCRIPTS_DIR}/state.sh 로 .done 마커 확인 후 완료 시 true 설정`,
              "3. 3줄 이상 한국어 요약 텍스트 출력:",
              "   - 처리한 substage 결과 (완료/차단/조기종료)",
              "   - 변경한 state.json 마커 목록",
              "   - 다음 단계 안내",
              "",
              "금지: 새 tool 호출 추가. 요약 텍스트 출력 직후 즉시 종료.",
            ].join("\n");

            const engineerNudge = async (sid: string, elapsedMs: number) => {
              logger.debug(`[dispatch_stage] NUDGE sid=${sid} elapsed=${Math.round(elapsedMs / 1000)}s`);
              await (client as any).session
                .promptAsync({
                  path: { id: sid },
                  body: {
                    parts: [{ type: "text", text: nudgeText }],
                    model: { providerID: activeProviderID, modelID: activeModelID },
                  } as Record<string, unknown>,
                  query: { directory: effectiveWorktree },
                })
                .catch(() => undefined);
            };

            const messageStallForAttempt =
              MESSAGE_STALL_BACKOFF_MS[Math.min(attempt - 1, MESSAGE_STALL_BACKOFF_MS.length - 1)];
            const outcome = await pollSubSession(
              subSessionID,
              getEffectiveTimeoutMs(spec.id),
              effectiveWorktree,
              engineerNudge,
              messageStallForAttempt,
            );
            let finalOutcome = outcome;
            let finalLegacy = pollOutcomeToLegacy(outcome);

            if (outcome.kind === "session_gone") {
              const isMessageStall = outcome.reason === "message_stall";
              // status-absent gone 은 session.abort/delete 시 opencode NotFoundError 를
              // 부모 세션에 fire 하므로 skipSessionOps=true. message_stall 은 세션이
              // 살아있어 정상적으로 abort 가능하므로 일반 cleanup 경로를 탄다.
              sessionGone = !isMessageStall ? true : false;
              promptPromise.catch(() => {});
              // pollSubSession 이 이미 abort() 를 fire 했지만 opencode 서버는
              // 잠시 후 session.deleted 이벤트를 fire 한다. 그 전에 redispatch 하면
              // 좀비 sub-agent 가 계속 tool call 을 발사해 새 세션과 worktree 상태가
              // 충돌할 수 있다. session.deleted 이벤트를 최대 30s 대기해 race window 를 닫는다.
              if (isMessageStall) {
                const deleted = await waitForSessionDeleted(subSessionID, SESSION_DELETED_WAIT_MS);
                logger.debug(
                  `[dispatch_stage] MESSAGE_STALL abort settled — session=${subSessionID} ` +
                  `deleted_event_received=${deleted} wait_ms=${SESSION_DELETED_WAIT_MS}`,
                );
              }
              const goneLabel = isMessageStall ? "MESSAGE_STALL" : "SESSION_GONE";
              const currentMaxAttempts = maxAttemptsForCurrentModel();
              const hangEntry = JSON.stringify({
                attempt,
                at: new Date().toISOString(),
                reason: isMessageStall ? "message_stall" : "status_absent",
                elapsed_ms: outcome.elapsedMs,
                polls: outcome.polls,
                session_id: subSessionID,
                model: activeModelFull,
                fallback_depth: activeFallbackDepth,
                final: attempt >= currentMaxAttempts,
              });
              const hangJqPath = stageJqPath(args.target_stage as Stage) + ".hang_history";
              const hangR = await $`bash ${SCRIPTS_DIR}/state.sh append ${args.issue} ${hangJqPath} ${hangEntry}`
                .cwd(args.worktree).quiet().nothrow();
              if (hangR.exitCode !== 0) {
                logger.debug(
                  `[hang_history] append failed issue=${args.issue} stage=${args.target_stage} ` +
                  `exit=${hangR.exitCode} stderr=${redactAndTruncate(hangR.stderr?.toString() ?? "", 120)}`,
                );
              } else {
                logger.debug(
                  `[hang_history] recorded issue=${args.issue} stage=${args.target_stage} ` +
                  `attempt=${attempt} reason=${isMessageStall ? "message_stall" : "status_absent"} ` +
                  `model=${activeModelFull} fallback_depth=${activeFallbackDepth} final=${attempt >= currentMaxAttempts}`,
                );
              }
              if (attempt < currentMaxAttempts) {
                logger.warn(
                  `[dispatch_stage] ${goneLabel} session=${subSessionID} stage=${args.target_stage} ` +
                  `attempt=${attempt}/${currentMaxAttempts} model=${activeModelFull} ` +
                  `fallback_depth=${activeFallbackDepth} threshold_ms=${messageStallForAttempt} ` +
                  `— will redispatch new session with state.json resume instructions`,
                );
                continue;
              }

              // Current model exhausted its attempt budget. Before terminating,
              // try (1) session_gone done-override, then (2) fallback_model switch.
              const donePath = `${stageJqPath(args.target_stage)}.done`;
              const doneResult = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${donePath}`
                .cwd(effectiveWorktree).quiet().nothrow();
              const doneValue = doneResult.exitCode === 0
                ? (doneResult.stdout?.toString().trim() ?? null)
                : null;
              if (shouldOverrideSessionGoneOutcome(outcome.kind, false, doneValue)) {
                logger.warn(
                  `[dispatch_stage] session_gone override: session=${subSessionID} ` +
                  `stage=${args.target_stage} model=${activeModelFull} .done=true — treating as success`,
                );
                finalResultJson = JSON.stringify({
                  ok: true,
                  stage: args.target_stage,
                  agent: spec.id,
                  model: activeModelFull,
                  session_id: subSessionID,
                  previous_session_ids: attemptSessionIds.slice(0, -1),
                  outcome_kind: "session_gone",
                  gone_reason: isMessageStall ? "message_stall" : "status_absent",
                  polls: finalOutcome.polls,
                  elapsed_ms: finalOutcome.elapsedMs,
                  attempts: attempt,
                  fallback_depth: activeFallbackDepth,
                  reason:
                    `sub-session disappeared but ${donePath}=true in state.json — ` +
                    `treated as success (session_gone override)`,
                });
                continue;
              }

              // Fallback switch: only from primary (depth=0), no user override,
              // and only on status_absent (message_stall stays on same model).
              if (
                activeFallbackDepth === 0 &&
                !isMessageStall &&
                !args.model_override
              ) {
                const next = nextModel({
                  agent: spec.id,
                  current: activeModelFull,
                  reason: "session_gone_after_max_attempts",
                });
                if (!next.exhausted && next.next) {
                  const previousModel = activeModelFull;
                  activeModelFull = next.next.id;
                  const parsed = parseModelId(activeModelFull);
                  activeProviderID = parsed.providerID;
                  activeModelID = parsed.modelID;
                  activeFallbackDepth = 1;
                  attempt = 0;
                  logger.warn(
                    `[dispatch_stage] FALLBACK_SWITCH agent=${spec.id} ` +
                    `from=${previousModel} to=${activeModelFull} ` +
                    `reason=session_gone_after_${MAX_ATTEMPTS}_attempts stage=${args.target_stage} ` +
                    `— retrying with fallback model (max ${MAX_FALLBACK_ATTEMPTS} attempts)`,
                  );
                  continue;
                }
                logger.debug(
                  `[dispatch_stage] fallback exhausted for agent=${spec.id} model=${activeModelFull} ` +
                  `— no next model available in policy chain`,
                );
              }

              finalResultJson = JSON.stringify({
                ok: false,
                stage: args.target_stage,
                agent: spec.id,
                model: activeModelFull,
                session_id: subSessionID,
                previous_session_ids: attemptSessionIds.slice(0, -1),
                outcome_kind: "session_gone",
                gone_reason: isMessageStall ? "message_stall" : "status_absent",
                polls: finalOutcome.polls,
                elapsed_ms: finalOutcome.elapsedMs,
                attempts: attempt,
                fallback_depth: activeFallbackDepth,
                reason: isMessageStall
                  ? `sub-session busy but produced no assistant message across ${MAX_ATTEMPTS} attempts ` +
                    `(exponential backoff ${MESSAGE_STALL_BACKOFF_MS.join("/")}ms). ` +
                    `LLM API hang suspected (upstream provider silent, quota exhausted, or local model server down). ` +
                    `Report to user and try get_fallback_model or wait for provider recovery.`
                  : activeFallbackDepth > 0
                    ? `sub-session repeatedly disappeared across primary (${MAX_ATTEMPTS}) + fallback (${MAX_FALLBACK_ATTEMPTS}) attempts. ` +
                      `Both models failed with status_absent gone. ` +
                      `Likely opencode server-side issue (session storage corruption, OOM, crash) or persistent provider outage. ` +
                      `Check opencode server logs. Do NOT retry immediately; report to user.`
                    : `sub-session repeatedly disappeared across ${MAX_ATTEMPTS} attempts. ` +
                      `Likely opencode server-side issue (session storage corruption, OOM, crash). ` +
                      `Check opencode server logs. Do NOT retry immediately; report to user.`,
              });
              continue;
            }

            if (outcome.kind === "empty") {
              const isPreambleOnly = outcome.reason === "preamble_only";
              logger.debug(
                `[dispatch_stage] empty output detected — sending one-time ${isPreambleOnly ? "action" : "summary"} re-prompt: ` +
                `session=${subSessionID} stage=${args.target_stage} reason=${outcome.reason}`,
              );
              const retryText = isPreambleOnly
                ? `직전 응답이 서두 텍스트만 있었고 실제 substage 작업이 수행되지 않았다. ` +
                  `설명 없이 지금 즉시 필요한 tool 을 호출하여 ${args.target_stage} substage 를 완결하라. ` +
                  `완료 조건은 stages/*.md 정의를 따르고, state.json 의 해당 substage 마커 (self_check, done 등) 를 반드시 세팅해야 한다. ` +
                  `Tool 호출부터 시작 — preamble 금지.`
                : "이전 작업 결과를 한국어로 최소 3줄 요약 후 종료하라:\n1. 처리한 substage 이름과 결과 (완료/차단/조기종료)\n2. 변경한 state.json 마커 목록\n3. 다음 단계 안내";
              const retryPromptPromise = (client as any).session
                .prompt({
                  path: { id: subSessionID },
                  body: {
                    agent: spec.id,
                    tools: { question: false },
                    parts: [{ type: "text", text: retryText }],
                    model: { providerID: activeProviderID, modelID: activeModelID },
                  } as Record<string, unknown>,
                  query: { directory: effectiveWorktree },
                })
                .catch((e: unknown) => ({ error: e }));

              const retryEarly = await Promise.race([
                retryPromptPromise,
                new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
              ]);
              if (!(retryEarly !== "pending" && (retryEarly as any)?.error)) {
                const retryOutcome = await pollSubSession(subSessionID, substageTimeoutMs, effectiveWorktree);
                retryPromptPromise.catch(() => {});
                if (retryOutcome.kind === "text") {
                  finalOutcome = retryOutcome;
                  finalLegacy = pollOutcomeToLegacy(retryOutcome);
                }
              } else {
                retryPromptPromise.catch(() => {});
              }
            }

            success = finalLegacy.success;
            let overriddenReason: string | undefined;

            if (!success && finalOutcome.kind === "empty") {
              const donePath = `${stageJqPath(args.target_stage)}.done`;
              const doneResult = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${donePath}`
                .cwd(effectiveWorktree).quiet().nothrow();
              const doneValue = doneResult.exitCode === 0
                ? (doneResult.stdout?.toString().trim() ?? null)
                : null;
              if (shouldOverrideEmptyOutcome(finalOutcome.kind, success, doneValue)) {
                logger.debug(
                  `[dispatch_stage] empty output override: session=${subSessionID} ` +
                  `stage=${args.target_stage} .done=true — treating as success`,
                );
                success = true;
                overriddenReason =
                  `sub-agent produced no final text but ${donePath}=true in state.json — ` +
                  `treated as success (local-model text-omission compensation)`;
              }
            }

            promptPromise.catch(() => {});

            if (success) {
              const resetPath = `${stageJqPath(args.target_stage as Stage)}.hang_history`;
              const resetR = await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${resetPath} ${"[]"}`
                .cwd(args.worktree).quiet().nothrow();
              logger.debug(
                `[hang_history] reset issue=${args.issue} stage=${args.target_stage} ` +
                `exit=${resetR.exitCode} — substage succeeded`,
              );
            }

            const retryDisallowed =
              finalOutcome.kind === "timeout" &&
              finalOutcome.transientFailures === 0;
            const retryDisallowedReason = retryDisallowed
              ? `sub-agent 이 ${Math.round(finalOutcome.elapsedMs / 60_000)}분 동안 응답 없음 (polls=${finalOutcome.polls}, transient_failures=0). ` +
                `네트워크·API 오류 없이 hang 이므로 model/prompt 이슈일 가능성이 높음. ` +
                `동일 dispatch_stage 를 재호출하지 말고 사용자에게 상황을 보고한 뒤 지시를 기다리거나 get_fallback_model 로 다른 모델을 요청하세요.`
              : undefined;

            finalResultJson = JSON.stringify({
              ok: success,
              stage: args.target_stage,
              agent: spec.id,
              model: activeModelFull,
              session_id: subSessionID,
              previous_session_ids: attemptSessionIds.slice(0, -1),
              attempts: attempt,
              fallback_depth: activeFallbackDepth,
              output: finalLegacy.text.slice(0, 8000),
              outcome_kind: finalOutcome.kind,
              polls: finalOutcome.polls,
              elapsed_ms: finalOutcome.elapsedMs,
              transient_failures:
                finalOutcome.kind === "timeout"
                  ? finalOutcome.transientFailures
                  : undefined,
              retry_disallowed: retryDisallowed || undefined,
              retry_disallowed_reason: retryDisallowedReason,
              reason: success
                ? overriddenReason
                : finalLegacy.text,
            });
          } finally {
            if (effectiveWorktree !== cwd) {
              logger.debug(
                `[wt-sync] REVERSE issue=${args.issue} worktree=${effectiveWorktree} ` +
                `caller=dispatch_stage stage=${args.target_stage} attempt=${attempt}`,
              );
              const syncResult = await $`bash ${SCRIPTS_DIR}/wt-sync-ignored.sh --reverse ${effectiveWorktree} ${args.issue}`
                .cwd(cwd).quiet().nothrow();
              if (syncResult.exitCode !== 0) {
                logger.warn(
                  `[wt-sync] REVERSE FAIL issue=${args.issue} exit=${syncResult.exitCode} ` +
                  `stderr=${redactAndTruncate(syncResult.stderr?.toString() ?? "", 200)}`,
                );
              }
            }
            await cleanupSubSession(subSessionID, {
              success,
              reason: `dispatch_stage finally stage=${args.target_stage} attempt=${attempt}`,
              skipSessionOps: sessionGone,
            });
          }
          }

          return finalResultJson ?? JSON.stringify({
            ok: false,
            stage: args.target_stage,
            reason: `dispatch_stage exited loop without result (attempts=${attempt})`,
            attempts: attempt,
          });
        },
      }),

      /**
       * dispatch_verifier — spawn makdoong2-verifier to second-check a stage that
       * just reported done. Read-only sub-agent reads state.json self_check markers,
       * the stage spec, and the dispatcher's output, and emits a structured verdict
       * of `<verifier-verdict>VERIFIED</verifier-verdict>` or `REJECTED`.
       */
      dispatch_verifier: tool({
        description:
          "Spawn the makdoong2-verifier sub-agent to second-check a stage's completion. " +
          "Returns { ok, verdict: 'VERIFIED' | 'REJECTED', raw, session_id }.",
        args: {
          issue:             tool.schema.string().describe("Jira issue key, e.g. PROJ-12345"),
          stage:             tool.schema.enum(STAGE_ORDER as [Stage, ...Stage[]]),
          worktree:          tool.schema.string().describe("Absolute worktree path"),
          sub_agent_output:  tool.schema.string().describe("Last assistant text from the just-dispatched stage agent (≤ 8000 chars)"),
          model_override:    tool.schema.string().optional(),
        },
        async execute(args, context) {
          let success = false;
          const verifierId = "makdoong2-verifier";
          const policy = POLICIES[verifierId];
          const modelFull =
            args.model_override ?? policy?.primary?.id ?? "github-copilot/claude-sonnet-4.6";
          const slashIdx = modelFull.indexOf("/");
          const providerID = slashIdx > 0 ? modelFull.slice(0, slashIdx) : "github-copilot";
          const modelID = slashIdx > 0 ? modelFull.slice(slashIdx + 1) : modelFull;

          const verifierSpecPath = `${STAGES_DIR}/${STAGE_SPEC_FILES[args.stage as Stage]}`;
          if (!existsSync(verifierSpecPath)) {
            return JSON.stringify({
              ok: false,
              error: "stage_spec_missing",
              stage: args.stage,
              spec_path: verifierSpecPath,
              stages_dir: STAGES_DIR,
              reason:
                `Stage spec file not found at resolved path. STAGES_DIR was resolved to '${STAGES_DIR}'. ` +
                `Check: (1) makdoong2-team.json paths.stages override is correct, ` +
                `(2) npm package includes stages/ directory (see package.json files field), ` +
                `(3) reinstall via 'npx makdoong2-team install' if stages/ was removed.`,
            });
          }
          if (args.worktree !== cwd) {
            logger.debug(
              `[wt-sync] FORWARD issue=${args.issue} worktree=${args.worktree} ` +
              `caller=dispatch_verifier stage=${args.stage}`,
            );
            const fwdSync = await $`bash ${SCRIPTS_DIR}/wt-sync-ignored.sh ${args.worktree} ${args.issue}`
              .cwd(cwd).quiet().nothrow();
            if (fwdSync.exitCode !== 0) {
              logger.warn(
                `[wt-sync] FORWARD FAIL issue=${args.issue} caller=dispatch_verifier exit=${fwdSync.exitCode} ` +
                `stderr=${redactAndTruncate(fwdSync.stderr?.toString() ?? "", 200)}`,
              );
            }
          }

          const promptText = [
            `Working directory (ABSOLUTE): ${args.worktree}`,
            `Scripts directory (ABSOLUTE): ${SCRIPTS_DIR}`,
            `Issue: ${args.issue}`,
            `Stage: ${args.stage}`,
            `Stage spec: read ${verifierSpecPath} and the agents/makdoong2-verifier.md system prompt for the verdict format.`,
            `모든 state.sh / wt-sync-ignored.sh / config.sh 호출은 위 Scripts directory 경로를 사용하시오. \`$HOME/.config/opencode/scripts/\`나 \`scripts/\` 상대경로를 사용하지 마시오.`,
            `Sub-agent output:`,
            "```",
            args.sub_agent_output.slice(0, 8000),
            "```",
          ].join("\n");

          const parentSessionID = context?.sessionID ?? dispatchParentSessionID(undefined);
          if (!parentSessionID) {
            return JSON.stringify({
              ok: false,
              reason: "dispatch_verifier 호출자의 sessionID를 얻지 못했다. ToolContext.sessionID 미제공 및 hook fallback 실패.",
              stage: args.stage,
            });
          }
          logger.debug(`[dispatch_verifier] creating sub-session with parentID=${parentSessionID} stage=${args.stage}`);

          const createResult = await (client as any).session
            .create({
              body: {
                parentID: parentSessionID,
                title: `verifier:${args.stage} (@${verifierId})`,
              },
              query: { directory: args.worktree },
            })
            .catch((e: unknown) => ({ error: e, data: null }));

          if (createResult.error || !createResult.data) {
            return JSON.stringify({
              ok: false,
              reason: `verifier session create failed: ${JSON.stringify(createResult.error)}`,
              stage: args.stage,
            });
          }
          const subSessionID = (createResult.data as { id: string }).id;
          logger.debug(
            `[dispatch_verifier] sub-session created: subSessionID=${subSessionID} ` +
            `parentID=${parentSessionID}`,
          );
          sessionIssue.set(subSessionID, args.issue);
          sessionWorktree.set(subSessionID, args.worktree);
          subSessionIds.add(subSessionID);
          pendingDispatch.set(subSessionID, {
            stage: `verify:${args.stage}`,
            agent: verifierId,
            worktree: args.worktree,
            startedAt: Date.now(),
          });
          appendSessionIndex({
            sessionID: subSessionID,
            agent: verifierId,
            worktree: args.worktree,
            issue: args.issue,
            stage: `verify:${args.stage}`,
            createdAt: new Date().toISOString(),
          });

          let raw = "";
          let verifierSessionGone = false;
          try {
            const promptPromise = (client as any).session
              .prompt({
                path: { id: subSessionID },
                body: {
                  agent: verifierId,
                  tools: { question: false },
                  parts: [{ type: "text", text: promptText }],
                  model: { providerID, modelID },
                } as Record<string, unknown>,
                query: { directory: args.worktree },
              })
              .catch((e: unknown) => ({ error: e }));

            const earlyResult = await Promise.race([
              promptPromise,
              new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
            ]);
            if (earlyResult !== "pending" && (earlyResult as any)?.error) {
              return JSON.stringify({
                ok: false,
                reason: `verifier prompt failed: ${JSON.stringify((earlyResult as any).error)}`,
                stage: args.stage,
              });
            }

            await spawnPaneForSession(subSessionID);

            const outcome = await pollSubSession(
              subSessionID,
              getEffectiveTimeoutMs("makdoong2-verifier"),
              args.worktree,
              undefined,
              VERIFIER_STALL_THRESHOLD_MS,
            );
            const legacy = pollOutcomeToLegacy(outcome);
            raw = legacy.text;
            success = legacy.success;
            if (outcome.kind === "session_gone") {
              verifierSessionGone = true;
              const stallReason = outcome.reason === "message_stall"
                ? " (message_stall detected)"
                : "";
              logger.warn(
                `[dispatch_verifier] SESSION_GONE session=${subSessionID} stage=${args.stage}` +
                `${stallReason} — defaulting to REJECTED verdict, no retry ` +
                `(verifier is idempotent, team-leader can redispatch)`,
              );
              const vHangEntry = JSON.stringify({
                attempt: 1,
                at: new Date().toISOString(),
                reason: outcome.reason === "message_stall" ? "message_stall" : "status_absent",
                elapsed_ms: outcome.elapsedMs,
                polls: outcome.polls,
                session_id: subSessionID,
                final: true,
                role: "verifier",
              });
              const vHangJqPath = stageJqPath(args.stage as Stage) + ".hang_history";
              const vHangR = await $`bash ${SCRIPTS_DIR}/state.sh append ${args.issue} ${vHangJqPath} ${vHangEntry}`
                .cwd(args.worktree).quiet().nothrow();
              if (vHangR.exitCode !== 0) {
                logger.debug(
                  `[hang_history] verifier append failed issue=${args.issue} stage=${args.stage} ` +
                  `exit=${vHangR.exitCode} stderr=${redactAndTruncate(vHangR.stderr?.toString() ?? "", 120)}`,
                );
              }
              if (outcome.reason === "message_stall") {
                const deleted = await waitForSessionDeleted(subSessionID, SESSION_DELETED_WAIT_MS);
                logger.debug(
                  `[dispatch_verifier] MESSAGE_STALL abort settled — session=${subSessionID} ` +
                  `deleted_event_received=${deleted} wait_ms=${SESSION_DELETED_WAIT_MS}`,
                );
              }
            }
            promptPromise.catch(() => {});
          } finally {
            if (args.worktree !== cwd) {
              logger.debug(
                `[wt-sync] REVERSE issue=${args.issue} worktree=${args.worktree} ` +
                `caller=dispatch_verifier stage=${args.stage}`,
              );
              const revSync = await $`bash ${SCRIPTS_DIR}/wt-sync-ignored.sh --reverse ${args.worktree} ${args.issue}`
                .cwd(cwd).quiet().nothrow();
              if (revSync.exitCode !== 0) {
                logger.warn(
                  `[wt-sync] REVERSE FAIL issue=${args.issue} caller=dispatch_verifier exit=${revSync.exitCode} ` +
                  `stderr=${redactAndTruncate(revSync.stderr?.toString() ?? "", 200)}`,
                );
              }
            }
            await cleanupSubSession(subSessionID, {
              success,
              reason: `dispatch_verifier finally stage=${args.stage}`,
              skipSessionOps: verifierSessionGone,
            });
          }

          const m = raw.match(/<verifier-verdict>\s*(VERIFIED|REJECTED)\s*<\/verifier-verdict>/i);
          const jsonFallback = !m ? raw.match(/"verdict"\s*:\s*"(VERIFIED|REJECTED)"/i) : null;
          const verdict = m
            ? (m[1].toUpperCase() as "VERIFIED" | "REJECTED")
            : jsonFallback
              ? (jsonFallback[1].toUpperCase() as "VERIFIED" | "REJECTED")
              : "REJECTED";

          const verdictSource = verifierSessionGone
            ? "session_gone_default"
            : m
              ? "verdict_tag"
              : jsonFallback
                ? "json_fallback"
                : success
                  ? "malformed_output_default"
                  : "session_failed_default";
          logger.debug(
            `[dispatch_verifier] VERDICT ${verdict} — issue=${args.issue} stage=${args.stage} ` +
            `session=${subSessionID} source=${verdictSource} success=${success}`,
          );

          const stageBase = stageJqPath(args.stage as Stage);
          let sameReasonStreak = 0;
          let sameReasonStreakExceeded = false;
          let rejectedCount = 0;
          const SAME_REASON_STREAK_LIMIT = 5;
          if (verdict === "REJECTED") {
            const reasonText = raw.trim().slice(0, 4000);
            const reasonHash = computeVerdictHash(raw, args.stage);
            const prevHashR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageBase + ".last_verdict_reason_hash"}`
              .cwd(args.worktree).quiet().nothrow();
            const prevHash = prevHashR.exitCode === 0
              ? (prevHashR.stdout?.toString().trim() ?? "").replace(/^"|"$/g, "")
              : "";
            const prevStreakR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageBase + ".same_reason_streak"}`
              .cwd(args.worktree).quiet().nothrow();
            const prevStreak = prevStreakR.exitCode === 0
              ? (parseInt(prevStreakR.stdout?.toString().trim() || "0", 10) || 0)
              : 0;
            const prevCountR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageBase + ".rejected_count"}`
              .cwd(args.worktree).quiet().nothrow();
            const prevCount = prevCountR.exitCode === 0
              ? (parseInt(prevCountR.stdout?.toString().trim() || "0", 10) || 0)
              : 0;

            sameReasonStreak = prevHash === reasonHash ? prevStreak + 1 : 1;
            rejectedCount = prevCount + 1;
            sameReasonStreakExceeded = sameReasonStreak >= SAME_REASON_STREAK_LIMIT;

            const nowIso = new Date().toISOString();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".last_verdict_reason"} ${JSON.stringify(reasonText)}`
              .cwd(args.worktree).quiet().nothrow();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".last_verdict_reason_hash"} ${JSON.stringify(reasonHash)}`
              .cwd(args.worktree).quiet().nothrow();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".last_verdict_at"} ${JSON.stringify(nowIso)}`
              .cwd(args.worktree).quiet().nothrow();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".same_reason_streak"} ${String(sameReasonStreak)}`
              .cwd(args.worktree).quiet().nothrow();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".rejected_count"} ${String(rejectedCount)}`
              .cwd(args.worktree).quiet().nothrow();

            logger.debug(
              `[dispatch_verifier] REJECTED reason recorded — issue=${args.issue} stage=${args.stage} ` +
              `hash=${reasonHash} streak=${sameReasonStreak}/${SAME_REASON_STREAK_LIMIT} ` +
              `rejected_count=${rejectedCount}` +
              (sameReasonStreakExceeded ? ` STREAK_EXCEEDED` : ``),
            );
          } else if (verdict === "VERIFIED") {
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".last_verdict_reason"} null`
              .cwd(args.worktree).quiet().nothrow();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".last_verdict_reason_hash"} null`
              .cwd(args.worktree).quiet().nothrow();
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".same_reason_streak"} 0`
              .cwd(args.worktree).quiet().nothrow();
          }

          await $`bash ${SCRIPTS_DIR}/log-event.sh ${args.issue} verifier_verdict stage=${args.stage} verdict=${verdict} session=${subSessionID}`
            .cwd(args.worktree).quiet().nothrow();

          return JSON.stringify({
            ok: success,
            verdict,
            stage: args.stage,
            agent: verifierId,
            model: modelFull,
            session_id: subSessionID,
            raw: raw.slice(0, 8000),
            same_reason_streak: sameReasonStreak,
            same_reason_streak_exceeded: sameReasonStreakExceeded,
            rejected_count: rejectedCount,
            parsed: m
              ? "verdict tag found"
              : jsonFallback
                ? `verdict tag missing — extracted from JSON body (${jsonFallback[1]})`
                : success
                  ? "verdict tag missing — defaulted to REJECTED (verifier output malformed)"
                  : `verifier session failed (${raw.slice(0, 120)})`,
          });
        },
      }),

      /**
       * get_fallback_model — fallback advisor.
       * Returns the next model in the chain, or exhausted=true.
       */
      /**
       * dispatch_research — parallel multi-source research fan-out.
       *
       * Why the plugin does the fan-out instead of the agent: sealed sub-agents
       * cannot delegate (ARCHITECTURE.md §4.2), and a prompt asking the model to
       * "call the sources in parallel" cannot be enforced — the model may call
       * them one at a time and nothing detects it. Doing it in code makes the
       * parallelism deterministic, and gives each source its own session so one
       * source's material never crowds out another's (DESIGN.md §3.7).
       *
       * Failure is isolated per source: one source failing yields a partial
       * artifact plus an explicit failure row, never an aborted fan-out.
       */
      dispatch_research: tool({
        description:
          "여러 리서치 소스(jira / confluence / bitbucket / github-oss)를 병렬 서브세션으로 동시 조사하고 " +
          "결과를 research-findings.json 으로 병합한다. 소스별 컨텍스트가 격리되며 한 소스의 실패가 " +
          "다른 소스를 막지 않는다. 1_planning.requirements 의 다출처 교차 조사에 사용.",
        args: {
          issue: tool.schema.string().describe("Jira issue key"),
          worktree: tool.schema.string().describe("작업 디렉토리 절대경로 (state.sh 실행 컨텍스트)"),
          queries: tool.schema
            .array(
              tool.schema.object({
                source: tool.schema
                  .string()
                  .describe("jira | confluence | bitbucket | github-oss"),
                focus: tool.schema
                  .string()
                  .describe("이 소스에서 확인할 것. 구체적일수록 좋다."),
              }),
            )
            .describe("소스별 조사 지시. 동시 실행되므로 서로 의존하면 안 된다."),
          context: tool.schema
            .string()
            .optional()
            .describe("모든 조사 세션에 공통 주입할 배경 (예: Jira 요약)"),
        },
        async execute(args, context) {
          const startedAll = Date.now();
          const parallelLimit = resolveParallelism(config.research?.max_parallel);
          const { queries, rejected, deferred } = normalizeQueries(args.queries, parallelLimit);

          if (queries.length === 0) {
            return JSON.stringify({
              ok: false,
              reason: "실행 가능한 query 가 없다.",
              rejected,
              deferred,
              allowed_sources: Object.keys(RESEARCH_SOURCES),
            });
          }

          const parentSessionID = context?.sessionID ?? dispatchParentSessionID(undefined);
          if (!parentSessionID) {
            return JSON.stringify({
              ok: false,
              reason: "dispatch_research 호출자의 sessionID를 얻지 못했다.",
            });
          }

          const researcherId = "makdoong2-researcher";

          // Recursion guard: a research session must never start its own fan-out.
          // The researcher's frontmatter omits this tool (L1), but a fan-out that
          // could nest would multiply sessions without bound, so it is refused at
          // runtime too — same defence-in-depth reasoning as SEALED_SUBAGENTS.
          if (sessionAgent.get(parentSessionID) === researcherId) {
            logger.error(
              `[dispatch_research] BLOCKED: researcher session ${parentSessionID} attempted a nested fan-out`,
            );
            return JSON.stringify({
              ok: false,
              reason:
                "리서치 세션은 dispatch_research 를 다시 호출할 수 없다 (중첩 fan-out 금지). " +
                "배정받은 소스만 조사하고 JSON 을 반환하라.",
            });
          }
          const policy = POLICIES[researcherId];
          if (!policy) {
            return JSON.stringify({
              ok: false,
              reason: `POLICIES 에 ${researcherId} 항목이 없다. 모델 정책 설정을 확인하라.`,
            });
          }
          const [providerID, ...modelRest] = policy.primary.id.split("/");
          const modelID = modelRest.join("/");
          const timeoutMs = Math.max(
            60_000,
            Math.round(
              (config.research?.timeout_minutes ?? DEFAULT_RESEARCH_TIMEOUT_MINUTES) * 60_000,
            ),
          );

          logger.debug(
            `[dispatch_research] fan-out start issue=${args.issue} sources=` +
            `${queries.map((q) => q.spec.source).join(",")} parallel_limit=${parallelLimit} ` +
            `timeout_ms=${timeoutMs} parentID=${parentSessionID}`,
          );

          const runOne = async (q: typeof queries[number]): Promise<SourceOutcome> => {
            const startedAt = Date.now();
            const base: Omit<SourceOutcome, "status" | "findings" | "gaps" | "error"> = {
              source: q.spec.source,
              label: q.spec.label,
              focus: q.focus,
              session_id: null,
              elapsed_ms: 0,
            };
            const fail = (error: string, sid: string | null): SourceOutcome => ({
              ...base,
              session_id: sid,
              elapsed_ms: Date.now() - startedAt,
              status: "failed",
              findings: [],
              gaps: [],
              error,
            });

            const createResult = await (client as any).session
              .create({
                body: {
                  parentID: parentSessionID,
                  title: `research:${q.spec.source} (${args.issue})`,
                },
                query: { directory: args.worktree },
              })
              .catch((e: unknown) => ({ error: e, data: null }));
            if (createResult.error || !createResult.data) {
              return fail(`session create 실패: ${JSON.stringify(createResult.error)}`, null);
            }
            const sid = (createResult.data as { id: string }).id;

            sessionIssue.set(sid, args.issue);
            subSessionIds.add(sid);
            sessionWorktree.set(sid, args.worktree);
            pendingDispatch.set(sid, {
              stage: `research:${q.spec.source}`,
              agent: researcherId,
              worktree: args.worktree,
              startedAt,
            });
            appendSessionIndex({
              sessionID: sid,
              agent: researcherId,
              worktree: args.worktree,
              issue: args.issue,
              stage: `research:${q.spec.source}`,
              createdAt: new Date().toISOString(),
            });

            let outcomeText = "";
            try {
              const promptText = buildResearchPrompt(q, {
                issue: args.issue,
                scriptsDir: SCRIPTS_DIR,
                worktree: args.worktree,
                context: args.context,
              });
              const promptPromise = (client as any).session
                .prompt({
                  path: { id: sid },
                  body: {
                    agent: researcherId,
                    tools: { question: false },
                    parts: [{ type: "text", text: promptText }],
                    model: { providerID, modelID },
                  } as Record<string, unknown>,
                  query: { directory: args.worktree },
                })
                .catch((e: unknown) => ({ error: e }));

              const early = await Promise.race([
                promptPromise,
                new Promise<"pending">((r) => setTimeout(() => r("pending"), 2_000)),
              ]);
              if (early !== "pending" && (early as any)?.error) {
                return fail(`prompt 실패: ${JSON.stringify((early as any).error)}`, sid);
              }

              await spawnPaneForSession(sid);

              const outcome = await pollSubSession(sid, timeoutMs, args.worktree);
              const legacy = pollOutcomeToLegacy(outcome);
              outcomeText = legacy.text;
              promptPromise.catch(() => {});

              if (outcome.kind === "session_gone") {
                await cleanupSubSession(sid, {
                  success: false,
                  reason: `research ${q.spec.source} session_gone`,
                  skipSessionOps: outcome.reason !== "message_stall",
                });
                return fail(`세션 종료 (${outcome.reason ?? "status_absent"})`, sid);
              }
              if (outcome.kind === "timeout") {
                await cleanupSubSession(sid, {
                  success: false,
                  reason: `research ${q.spec.source} timeout`,
                });
                return fail(`시간 초과 (${Math.round(timeoutMs / 60_000)}분)`, sid);
              }

              const parsed = parseResearchOutput(outcomeText);
              await cleanupSubSession(sid, { success: parsed.ok });
              if (!parsed.ok) {
                return fail(`출력 파싱 실패: ${parsed.reason}`, sid);
              }
              return {
                ...base,
                session_id: sid,
                elapsed_ms: Date.now() - startedAt,
                status: "ok",
                findings: parsed.data.findings,
                gaps: parsed.data.gaps,
                error: null,
              };
            } catch (e) {
              await cleanupSubSession(sid, {
                success: false,
                reason: `research ${q.spec.source} threw`,
              }).catch(() => undefined);
              return fail(`예외: ${e instanceof Error ? e.message : String(e)}`, sid);
            }
          };

          // Promise.all, not a loop: the whole point is that the sources run at
          // the same time. runOne never rejects (every path returns an outcome),
          // so one source cannot take the others down with it.
          const outcomes = await Promise.all(queries.map(runOne));

          const artifact = mergeResearchFindings(
            args.issue,
            new Date().toISOString(),
            outcomes,
            rejected,
            deferred,
          );

          // state.json 산출물 경로는 상대경로만 저장한다 (ARCHITECTURE.md §5.3).
          const relPath = `.makdoong2-team/${args.issue}/research-findings.json`;
          let artifactWritten = false;
          let artifactError: string | null = null;
          try {
            const absDir = join(args.worktree, ".makdoong2-team", args.issue);
            mkdirSync(absDir, { recursive: true });
            writeFileSync(join(absDir, "research-findings.json"), JSON.stringify(artifact, null, 2));
            artifactWritten = true;
          } catch (e) {
            artifactError = e instanceof Error ? e.message : String(e);
            logger.error(`[dispatch_research] artifact write 실패: ${artifactError}`);
          }

          if (artifactWritten) {
            // cwd 는 반드시 args.worktree — state.sh root() 가 cwd 의 git toplevel 을
            // 쓰므로 여기서 어긋나면 다른 state.json 에 기록된다 (ARCHITECTURE.md §10.2).
            const setR = await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${'.stages."1_planning".substages."requirements".research_path'} ${JSON.stringify(relPath)}`
              .cwd(args.worktree).quiet().nothrow();
            if (setR.exitCode !== 0) {
              logger.debug(
                `[dispatch_research] research_path 마커 기록 실패 exit=${setR.exitCode} ` +
                `stderr=${redactAndTruncate(setR.stderr?.toString() ?? "", 160)}`,
              );
            }
          }

          const okCount = artifact.counts.ok;
          logger.debug(
            `[dispatch_research] fan-out done issue=${args.issue} ok=${okCount}/${outcomes.length} ` +
            `findings=${artifact.counts.findings_total} elapsed_ms=${Date.now() - startedAll}`,
          );

          return JSON.stringify({
            // 부분 성공도 ok=true. 한 소스가 죽었다고 나머지 조사 결과를 버리면
            // fan-out 의 실패 격리가 의미를 잃는다. 호출자는 failed 배열을 본다.
            ok: okCount > 0,
            issue: args.issue,
            artifact_path: artifactWritten ? relPath : null,
            artifact_error: artifactError,
            elapsed_ms: Date.now() - startedAll,
            counts: artifact.counts,
            summary: summarizeOutcomes(outcomes),
            failed: outcomes.filter((o) => o.status === "failed").map((o) => ({
              source: o.source,
              error: o.error,
            })),
            rejected,
            deferred,
            next_action: okCount > 0
              ? `조사 결과를 읽고 요구사항 체크리스트에 반영하라: ${relPath}`
              : "모든 소스 조사가 실패했다. failed 사유를 사용자에게 보고하라.",
          });
        },
      }),

      get_fallback_model: tool({
        description: "Return the next model in this agent's fallback chain after a failure (rate_limit/5xx/context_exceeded).",
        args: {
          agent:   tool.schema.string(),
          current: tool.schema.string().describe("model id that just failed"),
          reason:  tool.schema.string().optional().describe("rate_limit | context_exceeded | 5xx | other"),
        },
        async execute(args) {
          return JSON.stringify(nextModel(args));
        },
      }),

      /**
       * inspect_sub_sessions — list and optionally clean up child sessions for an issue.
        */
      inspect_sub_sessions: tool({
        description:
          "이슈에 연결된 child 세션의 상태를 조회하고, orphan(부모 dispatch 완료 후 잔존 busy) 또는 " +
          "stale(지정 시간 초과 busy) 세션을 감지·정리한다. dispatch 사이 또는 워크플로우 이상 감지 시 호출.",
        args: {
          issue: tool.schema.string().describe("Jira issue key"),
          abort_orphans: tool.schema.boolean().optional()
            .describe("true: orphan 세션 abort. 기본 false (조회만)"),
          stale_minutes: tool.schema.number().optional()
            .describe("N분 초과 busy 세션을 stale로 판정. 미지정 시 stale 체크 안 함"),
        },
        async execute(args) {
          const statusResult = await (client as any).session.status().catch(() => null);
          const statuses = (statusResult?.data ?? {}) as Record<string, { type: string }>;
          const nowMs = Date.now();
          const staleThresholdMs = args.stale_minutes != null ? args.stale_minutes * 60_000 : null;

          const rows: {
            session_id: string; issue: string; stage: string; agent: string;
            status: string; elapsed_min: number; is_orphan: boolean; is_stale: boolean; aborted: boolean;
          }[] = [];

          const toCleanup: { sid: string; reason: string }[] = [];

          for (const sid of subSessionIds) {
            const issueKey = sessionIssue.get(sid);
            if (!issueKey || issueKey !== args.issue) continue;
            const pd = pendingDispatch.get(sid);
            const rawStatus = statuses[sid]?.type ?? "gone";
            const elapsedMs = pd ? nowMs - pd.startedAt : 0;
            const elapsedMin = Math.round(elapsedMs / 60_000);
            const isOrphan = rawStatus === "busy" && !pd;
            const isStale = rawStatus === "busy" && pd != null && staleThresholdMs != null && elapsedMs > staleThresholdMs;

            rows.push({
              session_id: sid,
              issue: issueKey,
              stage: pd?.stage ?? "unknown",
              agent: pd?.agent ?? "unknown",
              status: rawStatus,
              elapsed_min: elapsedMin,
              is_orphan: isOrphan,
              is_stale: isStale,
              aborted: (isOrphan || isStale) && args.abort_orphans === true,
            });

            if ((isOrphan || isStale) && args.abort_orphans) {
              toCleanup.push({
                sid,
                reason: isOrphan
                  ? "inspect_sub_sessions: orphan (no pending dispatch)"
                  : `inspect_sub_sessions: stale busy ${elapsedMin}min`,
              });
            }
          }

          for (const { sid, reason } of toCleanup) {
            await cleanupSubSession(sid, { success: false, reason });
          }

          return JSON.stringify({
            total: rows.length,
            orphans: rows.filter(r => r.is_orphan).length,
            stale: rows.filter(r => r.is_stale).length,
            aborted: rows.filter(r => r.aborted).length,
            sessions: rows,
          });
        },
      }),

      /**
       * auto_advance_stage — read state, compute next stage, return dispatch info.
        */
      auto_advance_stage: tool({
        description: "Read current state, determine next stage, run gate, and return dispatch instruction.",
        args: {
          issue:    tool.schema.string(),
          worktree: tool.schema.string().optional().describe("Absolute worktree path; defaults to plugin cwd"),
        },
        async execute(args, context) {
          const callerSession = context?.sessionID ?? dispatchParentSessionID(undefined);
          if (callerSession) sessionIssue.set(callerSession, args.issue);
          const effectiveCwd = args.worktree ?? cwd;
          let resolvedWt = effectiveCwd;

          // ── Defensive: state.json 존재/판독 가능성 사전 검증 ──
          // state.json 이 없거나 손상된 상태에서 stage.done 조회가 모두 실패하면
          // current=null 로 남아 target_stage="1_planning.jira" 로 되돌아가는
          // silent regression 이 발생한다. `.issue` 필드를 probe 하여 이 상황을
          // 명시적 에러로 분리한다.
          const probe = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${".issue"}`
            .cwd(effectiveCwd).quiet().nothrow();
          if (probe.exitCode !== 0) {
            const rootR = await $`bash ${SCRIPTS_DIR}/state.sh root`
              .cwd(effectiveCwd).quiet().nothrow();
            const expectedRoot = rootR.stdout?.toString().trim() || effectiveCwd;
            const expectedPath = `${expectedRoot}/.makdoong2-team/${args.issue}/state.json`;
            return JSON.stringify({
              ok: false,
              error: "state_unreadable",
              expected_path: expectedPath,
              effective_cwd: effectiveCwd,
              reason:
                `state.json 을 판독할 수 없습니다. worktree cwd 기준 예상 경로: ${expectedPath}. ` +
                `주요 원인: (1) wt-sync-ignored.sh 로 worktree 동기화 미수행, (2) 다른 cwd(main repo)에서 state.json 을 조작하여 worktree 사본과 불일치, (3) state.json 손상.`,
              next_action:
                `state.json 존재/유효성을 먼저 확인하세요. 필요 시 'bash ${SCRIPTS_DIR}/wt-sync-ignored.sh ${effectiveCwd} ${args.issue}' 로 재동기화하거나, ` +
                `'bash ${SCRIPTS_DIR}/state.sh init ${args.issue} ${effectiveCwd}' 로 초기화하세요. ` +
                `근본 원인이 해소되기 전에는 dispatch_stage 를 호출하지 마세요.`,
            });
          }

          let current: Stage | null = null;
          for (const s of STAGE_ORDER) {
            const testBase = stageJqPath(s);
            if (s === "2_implementation.analysis") {
              // analysis 는 게이트가 SKIP 판정 시 skipped=true 로만 마킹하고
              // done 도 함께 true 로 세팅한다. 따라서 done=true 만 확인해도 충분하지만,
              // 방어적으로 skipped=true 도 완료로 인정한다.
              const skR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${testBase}.skipped`}`
                .cwd(effectiveCwd).quiet().nothrow();
              const dnR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${testBase}.done`}`
                .cwd(effectiveCwd).quiet().nothrow();
              const sk = skR.stdout?.toString().trim();
              const dn = dnR.stdout?.toString().trim();
              if (sk === "true" || dn === "true") { current = s; continue; }
              else break;
            }
            if (s === "2_implementation.test") {
              const unitR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${testBase}.unit`}`
                .cwd(effectiveCwd).quiet().nothrow();
              const intR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${testBase}.integration`}`
                .cwd(effectiveCwd).quiet().nothrow();
              const covR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${testBase}.coverage`}`
                .cwd(effectiveCwd).quiet().nothrow();
              const unit = unitR.stdout?.toString().trim();
              const integration = intR.stdout?.toString().trim();
              const coverage = covR.stdout?.toString().trim();
              const testDone =
                (unit === "pass" || unit === "skip") &&
                (integration === "pass" || integration === "skip") &&
                (coverage === "pass" || coverage === "exempt");
              if (testDone) { current = s; continue; }
              else break;
            }
            const r = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${testBase}.done`}`
              .cwd(effectiveCwd).quiet().nothrow();
            if (r.exitCode === 0 && r.stdout?.toString().trim() === "true") current = s;
            else break;
          }
          const target = nextStage(current);
          if (target === null) {
            return JSON.stringify({
              ok: true,
              done: true,
              message: "all stages complete",
              next_action: "모든 stage가 완료되었습니다. 사용자에게 최종 요약을 보고하고 종료하세요.",
            });
          }

          // ── Pre-gate: 2_implementation.dev 진입 전 worktree 자동 생성 ──
          if (target === "2_implementation.dev") {
            const wtR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} '.worktree'`
              .cwd(effectiveCwd).quiet().nothrow();
            const existingWt = wtR.stdout?.toString().trim().replace(/^"|"$/g, "");
            
            const mainRepoR = await $`git worktree list --porcelain`
              .cwd(effectiveCwd).quiet().nothrow();
            let mainRepoPath = "";
            if (mainRepoR.exitCode === 0) {
              const lines = mainRepoR.stdout?.toString().split("\n") || [];
              for (const line of lines) {
                if (line.startsWith("worktree ")) {
                  mainRepoPath = line.replace(/^worktree\s+/, "").trim();
                  break;
                }
              }
            }
            
            const isWorktreeMissing = !existingWt || existingWt === "__MISSING__" || existingWt === "null";
            const isWorktreePathGone = Boolean(existingWt && !isWorktreeMissing && !existsSync(existingWt));
            const isWorktreePointingToMainRepo = existingWt === mainRepoPath || existingWt === effectiveCwd;
            const needsWorktree = isWorktreeMissing || isWorktreePathGone || isWorktreePointingToMainRepo;
            
            if (needsWorktree) {
              const wtResult = await createWorktree($, args.issue, effectiveCwd, {
                info: (msg: string) => logger.debug(msg),
                warn: (msg: string) => logger.warn(msg),
                error: (msg: string) => logger.error(msg),
              });

              if (!wtResult.ok) {
                const isConflict = wtResult.error?.includes("이미 다른 worktree에서 사용 중");
                const recoverySteps = isConflict
                  ? [
                      `\n**자동 복구 불가** — 브랜치가 이미 다른 경로에 체크아웃되어 있습니다.`,
                      `\n수동 조치:`,
                      `1. 기존 worktree 제거: git worktree remove "${wtResult.hint?.match(/기존 경로: (.+)/)?.[1] || '<기존경로>'}"`,
                      `2. 다시 auto_advance_stage 호출 → 올바른 경로에 자동 생성됩니다.`,
                      `\n**주의**: 기존 worktree에 커밋되지 않은 변경사항이 있으면 먼저 백업하세요.`,
                    ].join("\n")
                  : `\n${wtResult.hint || "상세: git worktree 기능이 지원되지 않거나 권한 문제일 수 있습니다."}\n사용자에게 보고하고 수동 조치를 안내하세요.`;
                
                return JSON.stringify({
                  ok: false,
                  gate: target,
                  reason: `Worktree 생성 실패: ${wtResult.error}`,
                  next_action: `Worktree 자동 생성 실패.${recoverySteps}`,
                });
              }
              
              const setResult = await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} '.worktree' '"${wtResult.path!}"'`
                .cwd(effectiveCwd).quiet().nothrow();
              
              if (setResult.exitCode !== 0) {
                return JSON.stringify({
                  ok: false,
                  gate: target,
                  reason: "Worktree 경로 state.json 기록 실패",
                  next_action: "state.json 업데이트 실패. 사용자에게 보고하세요.",
                });
              }
            }
          }

          // ── resolvedWt 교정: dev 이후 단계에서 state.json .worktree 로 전환 ──
          const DEV_OR_LATER_STAGES: Stage[] = [
            "2_implementation.dev", "2_implementation.test",
            "3_delivery.commit", "3_delivery.pr", "3_delivery.review",
          ];
          if (DEV_OR_LATER_STAGES.includes(target)) {
            const wtStateR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} '.worktree'`
              .cwd(effectiveCwd).quiet().nothrow();
            const rawWt = (wtStateR.stdout?.toString().trim() ?? "").replace(/^"|"$/g, "");
            if (rawWt && rawWt !== "null" && rawWt !== "__MISSING__") {
              resolvedWt = rawWt;
            }
          }

          // ── Pre-gate forward sync: worktree state.json을 항상 최신화 ──
          // createWorktree(신규/reused) + needsWorktree=false 재진입 경로 모두 커버.
          // state.sh set .worktree가 완료된 이후 실행되므로 올바른 .worktree 값이
          // worktree state.json에 전파된다 (Fix C+B: PROJ-40406).
          if (DEV_OR_LATER_STAGES.includes(target) && resolvedWt !== effectiveCwd) {
            if (!existsSync(resolvedWt)) {
              return JSON.stringify({
                ok: false,
                gate: target,
                error: "worktree_missing",
                reason: `resolvedWt "${resolvedWt}" 가 존재하지 않습니다.`,
                next_action: `auto_advance_stage(issue: "${args.issue}") 를 재호출하면 worktree 를 자동 재생성합니다.`,
              });
            }
            logger.debug(
              `[wt-sync] FORWARD issue=${args.issue} worktree=${resolvedWt} ` +
              `caller=auto_advance_stage target=${target}`,
            );
            const fwdSync = await $`bash ${SCRIPTS_DIR}/wt-sync-ignored.sh ${resolvedWt} ${args.issue}`
              .cwd(effectiveCwd).quiet().nothrow();
            if (fwdSync.exitCode !== 0) {
              logger.warn(
                `[wt-sync] FORWARD FAIL issue=${args.issue} caller=auto_advance_stage exit=${fwdSync.exitCode} ` +
                `stderr=${redactAndTruncate(fwdSync.stderr?.toString() ?? "", 200)}`,
              );
            }
          }

          const verify = await runScriptCwd(resolvedWt, GATES_DIR, "verify.sh", args.issue, target);

          if (!verify.ok) {
            const reason = verify.stderr.trim() || verify.stdout.trim();
            const isWorktreeSiblingError = reason.includes("형제 디렉토리가 아님");
            const isWorktreePathMissing = reason.includes("No such file or directory")
              || reason.includes("worktree_path_missing");
            const worktreeRecovery = isWorktreeSiblingError
              ? [
                  `\n\n**Worktree 위치 오류 복구**:`,
                  `1. 현재 잘못된 위치의 worktree 제거`,
                  `2. state.json의 .worktree 필드를 메인 repo 경로 또는 null로 재설정`,
                  `3. auto_advance_stage 재호출 → 올바른 위치(형제 디렉토리)에 자동 생성`,
                  `\n명령:`,
                  `  git worktree remove <잘못된경로>`,
                  `  bash ${SCRIPTS_DIR}/state.sh set ${args.issue} '.worktree' 'null'`,
                ].join("\n")
              : isWorktreePathMissing
              ? `\n\n**Worktree 경로 없음 — 자동 복구 가능**: auto_advance_stage(issue: "${args.issue}") 를 즉시 재호출하면 worktree 를 자동 재생성합니다. dispatch_stage 를 먼저 호출하지 마세요.`
              : "";
            
            return JSON.stringify({
              ok: false,
              gate: target,
              reason,
              next_action: isWorktreePathMissing
                ? `Worktree 경로가 파일 시스템에 없습니다. auto_advance_stage(issue: "${args.issue}") 를 재호출하면 자동 재생성됩니다.${worktreeRecovery}`
                : `게이트 차단: ${reason.slice(0, 200)}. 이 사유를 사용자에게 그대로 보고하고 dispatch_stage를 호출하지 마세요. 필요 시 이전 substage로 복귀하세요.${worktreeRecovery}`,
            });
          }

          const ext = await checkExtensionGates(args.issue, target, resolvedWt);
          if (!ext.ok) {
            const extReason = (ext as { ok: false; reason: string; marker_path?: string }).reason;
            const extMarker = (ext as { ok: false; reason: string; marker_path?: string }).marker_path;
            return JSON.stringify({
              ok: false,
              gate: target,
              reason: extReason,
              marker_path: extMarker,
              next_action: `게이트 차단: ${extReason.slice(0, 200)}. marker_path=${extMarker ?? 'unknown'}. 해당 마커를 검토·수정한 뒤 재시도하세요. dispatch_stage 호출 금지.`,
            });
          }
          const spec = agentForStage(target);
          const isPublisherHybrid = target.startsWith("3_delivery.");
          const dispatchInstruction = isPublisherHybrid
            ? `당신은 Publisher 하이브리드 stage에 진입했습니다. 지금 즉시 dispatch_stage(issue: "${args.issue}", target_stage: "${target}", worktree: "${resolvedWt}") 툴을 호출해 publisher가 spec을 반환하게 하고, 반환된 spec을 부장님이 직접 git 명령으로 실행하세요. 파일을 직접 편집하지 마세요.`
            : `당신은 직접 구현하지 마세요. 지금 즉시 dispatch_stage(issue: "${args.issue}", target_stage: "${target}", worktree: "${resolvedWt}") 툴을 호출하세요. Read/Bash 이외의 어떤 도구도 사용하지 말고, 파일을 직접 편집하지 마세요.`;
          
          const workPolicy = await readPolicy(args.issue, resolvedWt);
          const autoApprove = workPolicy?.auto_approve?.[target] ?? null;
          
          return JSON.stringify({
            ok: true,
            current_stage: current,
            target_stage: target,
            agent: spec.id,
            primary_only: spec.primary_only,
            model: POLICIES[spec.id]?.primary,
            category: workPolicy?.category ?? null,
            auto_approve: autoApprove,
            next_action: dispatchInstruction,
          });
        },
      }),

      cleanup_panes: tool({
        description:
          "Close tmux panes managed by makdoong2-team. Kills only panes carrying " +
          "the @mdn2_session ownership marker (safe). Parent opencode panes (--port) " +
          "are never killed. Panes younger than grace_seconds are skipped (default 0).",
        args: {
          grace_seconds: tool.schema.number().optional().describe(
            "Skip panes younger than this many seconds (race window guard). Default: 0."
          ),
        },
        async execute(args) {
          const report = await tmuxMonitor.cleanupOrphans({
            graceSeconds: typeof args.grace_seconds === "number" ? args.grace_seconds : 0,
          });
          return JSON.stringify({
            ok: true,
            ...report,
            message:
              `Closed ${report.total_closed} pane(s): ` +
              `tracked=${report.tracked_closed} marked_orphans=${report.orphans_closed} ` +
              `(fresh_skipped=${report.fresh_skipped})`,
          });
        },
      }),
    },
  };
};

export default Makdoong2TeamPlugin;
