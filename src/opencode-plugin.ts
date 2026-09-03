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

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename as pathBasename, dirname as pathDirname, join, resolve as pathResolve, sep as pathSep } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { appendSessionIndex, findWorktreeRoot, lookupSessionFromIndex } from "./session-index.js";
import {
  activeToolCount,
  clearToolCalls,
  forgetSession,
  isToolExecuting as registryIsToolExecuting,
  normalizePermissionEvent,
  notifySessionDeleted,
  pendingPermissionsFor,
  permissionAsked,
  permissionReplied,
  permissionsRejectedCascade,
  settleToolCalls,
  sharedSubSessionRegistry,
  toolFinished,
  toolStarted,
} from "./sub-session-registry.js";
import { computeVerdictHash } from "./verdict-hash.js";
import {
  classifyVerifierOutcome,
  nextVerifierErrorStreak,
  verifierErrorStreakExceeded,
  VERIFIER_ERROR_STREAK_LIMIT,
} from "./verifier-verdict.ts";
import { nextModel, applyConfigOverrides, POLICIES } from "./model-fallback-policy.ts";
import { agentForStage, STAGE_SPEC_FILES, type Stage } from "./agent-stage-config.ts";
import { shouldEscalateStall } from "./stall-escalation.ts";
import { classifyStageCompletion, INCOMPLETE_HANG_REASON } from "./stage-completion.ts";
import {
  buildStateWriteBlockMessage,
  classifyStateJsonAccess,
  looksLikeRedirection,
  splitUnquotedSegments,
  WRITE_INDICATORS_RAW,
  WRITE_INDICATORS_UNQUOTED,
  STATE_SH_CALL_RE,
  stripQuotedSpans,
} from "./state-access-guard.ts";
import { TmuxMonitor, readTmuxConfig, orphanCleanupGuard } from "./tmux-monitor.ts";
import {
  resolvePaths,
  loadConfig,
  loadOpencodeExternalDirAllows,
  pluginOwnAllowPatterns,
  readLoggingConfig,
  DEFAULT_STALL_ESCALATE_THRESHOLD,
  DEFAULT_PERMISSION_CORRECTIONS_PER_SESSION,
} from "./config.ts";
import {
  scanSkillMcpRegistry,
  extractMcpName,
  looksLikeMcpNotFound,
  looksLikeMcpConnectionFailed,
  type SkillMcpRegistry,
} from "./skill-mcp-registry.ts";
import { injectAllSecrets } from "./mcp-secret-injector.ts";
import {
  pollSubSession as pollSubSessionCore,
  pollOutcomeToLegacy,
  buildPathScopePromptBlock,
  type PollOutcome,
} from "./poll-sub-session.ts";
import { logger } from "./logger.ts";
import { redactAndTruncate } from "./redact-secrets.ts";
import { extractApplyPatchPaths, isApplyPatchTool } from "./apply-patch-paths.ts";
import {
  issueReporterSkillLoadViolation,
  issueReporterTaskSpawnViolation,
  ISSUE_REPORTER_AGENT,
  classifyGithubApiCall,
  payloadDisplayPaths,
  displayMismatch,
  sha256Hex,
} from "./issue-reporter-guard.ts";

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

/**
 * createWorktree 의 로깅 주입점.
 *
 * `info` 가 아니라 `debug` 다 — CLAUDE.md 는 플러그인 코드에서 `logger.info` 를
 * 쓰지 않고 debug / warn / error 세 레벨만 쓰도록 규정한다. 종전에는 이 인터페이스가
 * `info` 를 노출하고 호출부가 `info: (m) => logger.debug(m)` 으로 우회 매핑해서
 * 하드룰이 형식적으로만 지켜졌다.
 */
interface CreateWorktreeLogger {
  debug?: (msg: string) => void;
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
  wtLogger?.debug?.(`[createWorktree] ENTER issue=${issue} cwd=${cwd} branch=${branchName}`);

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

  // ESM 모듈에서 require() 를 쓰면 안 된다. package.json 이 "type":"module" 이고
  // tsc 산출물도 ESM 이라 `require` 는 정의되지 않는다 — 지금 터지지 않는 이유는
  // opencode 가 Bun 바이너리이고 Bun 이 ESM 안의 require() 를 허용하기 때문일
  // 뿐이다. Node 로 로드되는 순간 createWorktree 가 ReferenceError 로 즉사한다
  // (dev 단계 진입 = worktree 생성 경로).
  const parentDir = pathDirname(mainRepo);
  const repoName = pathBasename(mainRepo);
  const targetWorktree = join(parentDir, `${repoName}-${issue}`);

  if (existingWorktreePath) {
    if (existingWorktreePath === targetWorktree) {
      if (!existsSync(targetWorktree)) {
        // git metadata 는 남아있지만 실제 디렉토리가 삭제된 phantom 상태.
        // prune 으로 stale entry 를 제거한 뒤 아래 addCommand 로 재생성한다.
        wtLogger?.debug?.(
          `[createWorktree] PHANTOM_REUSED — dir gone, pruning and recreating ` +
          `issue=${issue} path=${targetWorktree}`,
        );
        await $`git worktree prune`.cwd(cwd).quiet().nothrow();
      } else {
        wtLogger?.debug?.(`[createWorktree] REUSED issue=${issue} path=${targetWorktree} branch=${branchName}`);
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

  wtLogger?.debug?.(
    `[createWorktree] CREATED issue=${issue} path=${targetWorktree} branch=${branchName} ` +
    `branch_existed=${branchExists}`,
  );
  return {
    ok: true,
    path: targetWorktree,
    reused: false,
  };
}

/**
 * 세그먼트가 "이 함수의 판정 대상이 아님" 으로 면제되는가.
 *
 * git 서브커맨드는 permission 계층(frontmatter deny)이 따로 관장하고, state.sh
 * 호출은 승인된 상태 쓰기 경로다. **세그먼트 단위로만** 면제한다 — 종전에는
 * 명령 전체를 면제해서 `git status && echo x > f` 처럼 접두만 git 이면 뒤에 붙은
 * 진짜 쓰기가 통째로 통과했다.
 */
function isExemptSegment(segment: string): boolean {
  if (STATE_SH_CALL_RE.test(segment)) return true;
  return /^\s*git\s+(?:commit|push|add|rm|status|log|diff|show|branch|checkout|fetch|worktree|config|remote)\b/i
    .test(segment);
}

export function looksLikeFileWrite(cmd: string): boolean {
  // state.json 은 전용 분류기가 판정한다. 읽기 전용 진단(ls/file/head/cat)을 여기서
  // 다시 "파일 쓰기" 로 잡으면 universal 훅을 고쳐도 leader 는 하드룰 2 로 막힌다.
  const stateAccess = classifyStateJsonAccess(cmd);
  if (stateAccess.kind === "write") return true;

  // ── 1) 명령 전체로 판정해야 하는 것 ──
  // 세그먼트로 쪼개면 인용 구간 안이나 리디렉션 문맥이 가려진다. 그리고 이 검사는
  // **면제보다 먼저** 와야 한다 — 종전에는 git/state.sh 접두 면제가 먼저 걸려서
  // `git diff > out.txt` · `git log > notes.md` · `git diff | tee out.txt` 가 전부
  // "쓰기 아님" 으로 통과했다 (READ-ONLY 하드룰과 leader 하드룰 2 동시 우회).
  if (/\b(?:ba|z|k|da)?sh\b\s+-\w*c\b/.test(cmd)) return true;
  if (/(^|[|&;\s(`{])eval\s/.test(cmd)) return true;
  if (looksLikeRedirection(cmd)) return true;
  if (/\bsed\b[^|;&]*\s(?:-i(?:\b|['"])|--in-place\b)/.test(cmd)) return true;
  if (/\b(?:perl|ruby)\b[^|;&]*\s-\w*i\b/.test(cmd)) return true;

  // 인터프리터 인라인 스크립트는 따옴표 *안* 을 봐야 하므로 원문으로 판정한다.
  //
  // state.json 가드(WRITE_INDICATORS_RAW)는 `-c`/`-e` 자체를 통째로 막지만 여기는
  // 그러지 않는다 — 이 함수는 **모든 파일**에 대한 판정이고, 읽기 전용 인라인
  // 스크립트는 planner/analyzer 의 정상 능력으로 이미 허용돼 있다
  // (test/state-write-guard.test.ts 가 고정). 대신 쓰기 API 목록을 넓힌다.
  if (/\bpython3?\s+-c\s+["'][\s\S]*?(?:open\s*\([^)]*["']\s*,\s*["'][wax]|\.write_text\s*\(|\.write_bytes\s*\(|shutil\.(?:copy|move|rmtree)|os\.(?:remove|unlink|rename|replace|truncate)|json\.dump\s*\()/.test(cmd)) return true;
  if (/\bnode\s+-e\s+["'][\s\S]*?(?:writeFileSync|writeFile\b|appendFileSync|appendFile\b|createWriteStream|renameSync|rmSync|unlinkSync|cpSync|copyFileSync|truncateSync|mkdirSync)/.test(cmd)) return true;

  // ── 2) 세그먼트별 판정 ──
  // 여기서만 면제가 적용된다. 인용 구간을 덮은 문자열로 보므로
  // `grep -e ' rm ' f` 같은 읽기는 걸리지 않는다.
  for (const segment of splitUnquotedSegments(cmd)) {
    if (isExemptSegment(segment)) continue;
    const bare = stripQuotedSpans(segment);
    for (const [re] of WRITE_INDICATORS_UNQUOTED) {
      if (re.test(bare)) return true;
    }
  }
  return false;
}

// 판정 본체는 src/state-access-guard.ts 에 있다 (플러그인 로더가 이 파일의 모든
// named export 를 factory 로 호출하므로 신규 helper 는 여기 두지 않는다).
export function looksLikeSealedStateWrite(cmd: string): boolean {
  return classifyStateJsonAccess(cmd).kind === "write";
}

export const Makdoong2TeamPlugin: Plugin = async ({ $, client, directory, worktree }) => {
  const cwd = worktree || directory || ".";
  const config = loadConfig();
  applyConfigOverrides(config.agents, config.model_policy);

  // opencode 는 디렉토리(Instance)마다 이 factory 를 따로 부른다 — 같은 pid 안에
  // 사본이 여럿이다. 어느 사본이 어떤 로그를 찍는지 구분하려고 진입 시점에 남긴다.
  // 로그에 worktree 경로의 `[init]` 이 없으면 서브세션 훅이 어디서도 발화하지
  // 않는 것이고, 그것이 issue #10 의 `tool_call_stall` 처방 1번이다.
  logger.debug(`[init] plugin instance directory=${directory} worktree=${worktree} pid=${process.pid}`);

  // 사본을 가로지르는 세션 신호(툴 실행 · 권한 요청 · 이슈키 · worktree · deleted
  // 대기자)는 프로세스 전역 레지스트리에 둔다. 사본마다 Map 을 들면 worktree 사본의
  // 훅이 올린 신호를 main 사본의 폴러가 영영 보지 못한다 (issue #10).
  const registry = sharedSubSessionRegistry();

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
          lastToolExecuteAtMs: registry.lastToolExecuteAt.get(sid),
          activeToolCount: activeToolCount(registry, sid),
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
          forgetSession(registry, sid);
          pendingDispatch.delete(sid);
          subSessionIds.delete(sid);
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

  // 워크스페이스 밖 경로 요청을 세션 안에서 되돌려 주는 예산 (issue #12 재발 보고).
  // abort → 재디스패치는 대화 이력을 잃는 비싼 경로라 이 예산이 소진된 뒤에만 탄다.
  const permissionCorrectionsPerSession = Math.max(
    0,
    Math.round(config.timeout?.permission_corrections_per_session ?? DEFAULT_PERMISSION_CORRECTIONS_PER_SESSION),
  );

  // 자동 승인 대상 외부 디렉터리 패턴 = 플러그인 자기 경로(항상) + 사용자 시드.
  //
  // 앞쪽이 2차 방어다: 설치가 opencode.json 패치를 남기지 못해도 서브에이전트가
  // state.sh / 게이트 / stage spec 에 접근할 수 있어야 한다 (GitHub #8 의 부분 설치가
  // PERMISSION_STALL 로 나타나던 경로). 뒤쪽은 사용자가 opencode.json 에 명시적으로
  // allow 한 것 — 종전에는 makdoong2-team.json 에서 읽어 **항상 빈 배열**이었다.
  const pluginOwnPatterns = pluginOwnAllowPatterns();
  const configuredAllowPatterns: string[] = [
    ...pluginOwnPatterns,
    ...loadOpencodeExternalDirAllows((reason) =>
      logger.warn(`[permission] opencode.json external_directory allows unavailable — ${reason} directory=${directory}`),
    ),
  ];
  // 사본마다 한 번씩 찍힌다 — 같은 pid 에 개수가 다른 두 줄이 있으면 사본이
  // 둘이라는 뜻이지 설정이 바뀐 것이 아니다 (issue #10 의 7개→5개). directory 를
  // 같이 남겨 어느 사본이 몇 개를 읽었는지 바로 대응시킨다.
  logger.debug(
    `[permission] plugin-own allows: ${pluginOwnPatterns.length}개 ` +
    `(${pluginOwnPatterns.join(", ")}) directory=${directory}`,
  );
  // 두 줄의 개수가 다른 것은 정상이다 — 아래가 위를 **포함**한다. 내역을
  // (plugin-own N + opencode.json M) 로 분해해 두지 않으면 "5개 / 7개" 두 줄이
  // 같은 목록의 불일치처럼 읽힌다 (GitHub #12 부수 관찰).
  logger.debug(
    `[permission] configured external_directory allows: ${configuredAllowPatterns.length}개` +
    ` (= plugin-own ${pluginOwnPatterns.length} + opencode.json ${configuredAllowPatterns.length - pluginOwnPatterns.length})` +
    (configuredAllowPatterns.length ? ` (${configuredAllowPatterns.slice(0, 3).join(", ")}…)` : "") +
    ` directory=${directory}`,
  );

  // 툴 실행 신호는 레지스트리(`registry.activeToolCalls` / `lastToolExecuteAt`)에
  // 있다 — before 훅에서 toolStarted, after 훅·툴 part 종결·idle 에서 toolFinished /
  // clearToolCalls. 종전의 사본-로컬 카운터는 issue #10 으로 제거됐다.
  const TOOL_EXECUTE_ALIVE_WINDOW_MS = 300_000;

  // MESSAGE_STALL 후 client.session.abort() 는 즉시 반환하지만 opencode 서버는 잠시 후
  // session.deleted 이벤트를 fire 한다. 그 사이(관측 최대 112s) sub-agent 가 tool call 을
  // 계속 발사할 수 있어 좀비 실행이 발생한다. abort 직후 session.deleted 를 대기하는
  // 헬퍼로 이 race window 를 닫는다. event 핸들러가 session.deleted 를 수신하면 이 map 의
  // pending waiter 를 resolve 한다.
  // 대기자 목록은 레지스트리에 있다 — session.deleted 이벤트는 세션의 디렉토리
  // 사본에만 도착하므로(worktree 서브세션이면 worktree 사본), 여기서 기다리는
  // main 사본과 이벤트를 받는 사본이 같은 목록을 봐야 한다.
  const sessionDeletedWaiters = registry.sessionDeletedWaiters;
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
  // dispatch 사본이 채우고 worktree 사본의 tool.execute.after 가 읽는다 — 레지스트리.
  // 디스크의 session-index.ndjson 은 사본이 다른 프로세스에 있을 때의 2차 경로로 남는다.
  const sessionWorktree = registry.sessionWorktree;

  const extractFilePathFromToolArgs = (args: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    const fp = (args as { filePath?: unknown }).filePath;
    return typeof fp === "string" && fp.length > 0 ? fp : undefined;
  };

  // 쓰기 툴이 건드리는 **모든** 대상 경로. write/edit 는 filePath 하나지만
  // apply_patch 는 패치 본문 안에 여러 개가 들어 있다 — opencode 가 gpt-5 계열
  // 세션에서 write/edit 대신 apply_patch 만 노출하므로(src/apply-patch-paths.ts
  // 주석 참조) filePath 만 보는 코드는 그 세션에서 전부 장님이 된다.
  //
  // 반환: paths=대상 목록, resolved=대상을 확정했는가.
  // resolved=false 는 "쓰기인데 대상을 모른다" 이고 정책상 차단이 기본값이다.
  const extractWriteTargets = (
    toolName: string,
    args: unknown,
  ): { paths: readonly string[]; resolved: boolean; reason?: string } => {
    if (isApplyPatchTool(toolName)) {
      const parsed = extractApplyPatchPaths(args);
      return parsed.ok
        ? { paths: parsed.paths, resolved: true }
        : { paths: [], resolved: false, reason: parsed.reason };
    }
    const fp = extractFilePathFromToolArgs(args);
    return fp ? { paths: [fp], resolved: true } : { paths: [], resolved: false, reason: "no_file_path" };
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

  // 폴러에 건네는 권한 요청 소스. v1 SDK 클라이언트에는 `permission` 네임스페이스가
  // 없고, `GET /permission` 은 클라이언트가 묶인 디렉토리 스코프라 worktree
  // 서브세션의 요청이 보이지 않는다 — 종전에는 이 소스가 항상 undefined 라
  // 자동 승인·거부 루프가 한 번도 돌지 않았고 stall 메시지는 언제나 "unknown" 이었다
  // (issue #10). 대신 그 세션의 사본이 `permission.asked` 이벤트로 레지스트리에
  // 넣은 것을 읽고, 응답은 세션-라우팅 엔드포인트
  // (`POST /session/{id}/permissions/{permissionID}`) 로 보낸다 — 세션 ID 로
  // 라우팅되므로 어느 사본에서 불러도 맞는 Instance 에 닿는다.
  const permissionSourceFor = (sessionId: string) => ({
    list: async () => ({
      data: pendingPermissionsFor(registry, sessionId).map((p) => ({
        id: p.id,
        sessionID: p.sessionID,
        permission: p.permission,
        patterns: p.patterns,
      })),
    }),
    reply: async (req: { path: { requestID: string }; body: { reply: string } }) => {
      const c = client as unknown as {
        postSessionIdPermissionsPermissionId?: (o: {
          path: { id: string; permissionID: string };
          body: { response: string };
        }) => Promise<unknown>;
      };
      if (typeof c.postSessionIdPermissionsPermissionId !== "function") {
        throw new Error("permission reply endpoint unavailable on this client");
      }
      const res = await c.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: req.path.requestID },
        body: { response: req.body.reply },
      });
      // permission.replied 이벤트는 세션의 사본에 도착하지만, 그 사본이 이벤트를
      // 놓치더라도 다음 폴이 같은 요청을 다시 처리하지 않도록 즉시 뺀다.
      permissionReplied(registry, sessionId, req.path.requestID);
      // reject 는 같은 세션의 나머지 대기 요청까지 연쇄 거부한다 — 이벤트가 오기
      // 전에 다음 폴이 그것들에 다시 답하지 않도록 즉시 비운다.
      if (req.body.reply === "reject") permissionsRejectedCascade(registry, sessionId);
      return res;
    },
    // 피드백 거부(in-place correction). 세션-라우팅 엔드포인트는 `{response}` 만
    // 받아 문구를 실을 수 없으므로 `POST /permission/{requestID}/reply` 를 쓴다.
    // 그 라우트는 **디렉토리 스코프**(`?directory=` 가 헤더보다 우선)라 worktree
    // 서브세션의 요청에 닿으려면 세션의 worktree 를 query 로 명시해야 한다 —
    // 클라이언트 기본 헤더는 main repo 를 가리키므로 생략하면 NotFound 다.
    // `reject` + `message` 는 opencode 가 `CorrectedError` 로 바꿔 툴 호출 하나만
    // 실패시키고 세션 루프는 계속 돌린다 (`RejectedError` 는 루프를 세운다).
    correct: async (req: { path: { requestID: string }; body: { message: string } }) => {
      const raw = (client as unknown as { _client?: { post?: (o: unknown) => Promise<{ error?: unknown; response?: { status?: number } }> } })._client;
      if (!raw || typeof raw.post !== "function") {
        throw new Error("raw permission reply endpoint unavailable on this client");
      }
      const directory = registry.sessionWorktree.get(sessionId);
      const res = await raw.post({
        url: "/permission/{requestID}/reply",
        path: { requestID: req.path.requestID },
        query: directory ? { directory } : undefined,
        body: { reply: "reject", message: req.body.message },
        headers: { "Content-Type": "application/json" },
      });
      if (res?.error !== undefined) {
        throw new Error(
          `permission correction rejected by server: status=${res.response?.status ?? "?"} ` +
          `error=${JSON.stringify(res.error).slice(0, 200)}`
        );
      }
      permissionReplied(registry, sessionId, req.path.requestID);
      permissionsRejectedCascade(registry, sessionId);
      return res;
    },
  });

  const pollSubSession = (
    sessionId: string,
    timeoutMs = substageTimeoutMs,
    allowedWorktree?: string,
    onNudge?: (sessionId: string, elapsedMs: number) => Promise<void>,
    messageStallThresholdMs?: number,
  ): Promise<PollOutcome> =>
    // 클래스 인스턴스를 spread 하면 프로토타입 메서드가 빠지므로 필요한 것만 집는다.
    pollSubSessionCore({ session: (client as any).session, permission: permissionSourceFor(sessionId) }, sessionId, {
      timeoutMs,
      allowedWorktree,
      configuredAllowPatterns,
      logger: {
        debug: (msg: string) => logger.debug(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
      },
      permissionCheckIntervalPolls: 1,
      maxPermissionCorrections: permissionCorrectionsPerSession,
      nudgeAtFraction: onNudge ? 0.8 : undefined,
      onNudge,
      messageStallThresholdMs,
      contentStableCompletionMs: 300_000,
      preambleOnlyTextThreshold: 200,
      isRecentlyActive: () => {
        if (registryIsToolExecuting(registry, sessionId)) return true;
        const last = registry.lastToolExecuteAt.get(sessionId);
        return typeof last === "number" && Date.now() - last < TOOL_EXECUTE_ALIVE_WINDOW_MS;
      },
      // "지금 이 순간 툴이 실행 중인가" — before 훅에서 넣고 after 훅에서 빼는
      // callID 집합 그대로다. isRecentlyActive 의 5분 창과 달리 순간값이라 완료
      // 판정에 쓸 수 있다. 폴러가 읽는 메시지 스냅샷보다 항상 앞선다 (issue #7:
      // tool.execute.before 발화 110ms 뒤의 폴이 tool part 를 아직 못 봤다).
      //
      // 읽기 전에 스냅샷과 대조한다: 툴이 throw 하면 after 훅이 오지 않아 항목이
      // 남는데, 스냅샷에서 이미 completed/error 인 callID 는 확실히 끝난 것이다.
      // 스냅샷에 아직 없는 callID 는 그대로 둔다 (110ms 창).
      isToolExecuting: (snapshot) => {
        const settled = settleToolCalls(registry, sessionId, snapshot.settledCallIDs);
        if (settled > 0) {
          logger.debug(`[pollSubSession] settled ${settled} stale tool call(s) from snapshot sid=${sessionId}`);
        }
        return registryIsToolExecuting(registry, sessionId);
      },
    });

  // ── sessionID → agent 매핑. chat.params hook에서 채우고, tool.execute.before
  //    hook에서 조회한다. 이 매핑을 통해 hook input에 없는 agent 식별을 우회한다.
  //    Primary agent(team-leader)만 직접 파일 쓰기를 차단하기 위한 최소 필요 조건.
  const sessionAgent = new Map<string, string>();

  // ── issue-reporter 원문 표시 증명 (payload 절대경로 → 표시 시점 sha256) ──────
  // GitHub 게시 승인의 "정보에 근거한 동의" 쪽 절반이다. permission 프롬프트에는
  // curl 명령만 보이고 본문은 파일 안에 있으므로, 사용자가 실제로 무엇을 보았는지는
  // 세션에 출력된 원문으로만 확인된다. 에이전트가 단일 `cat <payload>` 를 실행하면
  // tool.execute.after 가 그 시점의 해시를 여기 기록하고, 전송 시 현재 파일과
  // 대조한다. 표시 이후 내용이 바뀌면 차단된다.
  //
  // 프로세스 메모리에만 둔다 — 승인은 이 세션의 이 대화에 묶여야 하고, 디스크에
  // 남기면 예전 마커 방식과 같은 "파일로 존재하는 승인" 이 되어 위조 표면이 생긴다.
  const issueReporterShownPayloads = new Map<string, string>();

  // ── sessionID → Jira Issue Key 매핑 ─────────────────────────────────────────
  // 모든 워크플로우는 Jira Issue Key를 중심으로 설계된다. dispatch_stage /
  // dispatch_verifier / auto_advance_stage 는 항상 args.issue 를 명시적으로
  // 받으므로, 이를 sessionID에 바인딩해두면 guard-bash.sh / sync-state.sh 가
  // git branch 이름이나 worktree 경로를 추론하지 않고 신뢰할 수 있는 ISSUE를
  // 직접 전달받을 수 있다. 이 설계로 multi-worktree / 비-makdoong2-team 워크트리
  // 오탐 문제가 근본적으로 해결된다.
  // 레지스트리에 둔다 — dispatch 사본이 넣고, 서브세션의 훅 사본(guard-bash.sh /
  // sync-state.sh 인자)이 읽는다.
  const sessionIssue = registry.sessionIssue;

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
      forgetSession(registry, sid);
      pendingDispatch.delete(sid);
      subSessionIds.delete(sid);
    }
  };

  // team-leader가 직접 실행 시 물리적으로 차단할 툴 목록.
  // 하드룰 1: Read 외 파일 조작은 dispatch_stage로만 위임.
  const LEADER_FORBIDDEN_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

  // ── 산출물이 제한된 서브에이전트 ──
  //
  // 이 제한은 원래 에이전트 frontmatter 의 `permission.write` 블록으로만 표현돼
  // 있었는데 그 블록은 **런타임에서 한 번도 평가되지 않는다**. opencode 1.18 의
  // permission 스키마에는 `write` 키가 없고(정식 키는 `edit`), write/edit/patch
  // 툴은 전부 `permission: "edit"` 으로 묻는다 — 바이너리의 스키마 정의와 각 툴의
  // `ask({permission:"edit", …})` 호출로 확인했다. 즉 `write:` 로 적힌 규칙은
  // 조용히 무시되고 기본값 `ask` 로 떨어지며, 그 ask 는 플러그인의 permission
  // 자동 승인(worktree scope 안이면 approve)이 받아버린다.
  //
  // frontmatter 는 `edit:` 키로 고쳤지만(1차 방어), 그것만으로는 glob 매칭 의미에
  // 의존한다. 여기서 경로를 직접 대조하는 결정론적 2차 방어를 둔다 —
  // SEALED_SUBAGENTS 와 같은 이중 방어 구조다.
  const ARTIFACT_RESTRICTED_AGENTS: ReadonlyMap<string, RegExp | null> = new Map([
    // analyzer: workspace-analysis.json 하나만
    ["makdoong2-analyzer", /(^|\/)\.makdoong2-team\/[^/]+\/workspace-analysis\.json$/],
    // publisher: change-report.md (07-commit) + review-comment-plan.json (09-review §8-2).
    // 후자는 stage8-post-review-verify 가 존재를 하드 요구하는 필수 산출물이다 —
    // change-report 만 허용하면 3_delivery.review 가 구조적으로 통과 불가능해진다.
    ["makdoong2-publisher", /(^|\/)\.makdoong2-team\/[^/]+\/(change-report\.md|review-comment-plan\.json)$/],
    // planner: 요구사항 초안 · 리서치 산출물
    ["makdoong2-planner", /(^|\/)\.makdoong2-team\/[^/]+\/[^/]+\.(md|json)$/],
  ]);

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
    // User-only issue reporter. 워크플로우에 참여하지 않지만 outer-world 위임은
    // 동일하게 금지 — 수집·마스킹·등록 전 과정을 자기 세션에서 완결해야 하며,
    // 위임하면 마스킹·승인 게이트가 위임처에서 우회될 수 있다.
    ISSUE_REPORTER_AGENT,
  ]);

  // 미래의 oh-my-openagent 위임 툴을 조기 발견하기 위한 이름 패턴.
  // 알려진 툴이 아니면서 위임/스폰을 시사하는 이름이 감지되면 경고한다.
  // Blocklist 갱신 여부를 판단하는 용도로만 사용 — 차단은 하지 않는다.
  const DELEGATION_LIKE_NAME = /^(delegate|spawn|background|task_(create|update|delete))/i;

  const KNOWN_SAFE_TOOLS = new Set([
    "dispatch_stage",
    "dispatch_verifier",
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
    // 이벤트는 **세션의 디렉토리 사본**에만 도착한다 (opencode 의 이벤트 브리지가
    // `location.directory` 로 필터링한다). worktree 서브세션의 permission.asked ·
    // message.part.updated · session.deleted 는 worktree 사본이 받고, 그 세션을
    // 폴링하는 것은 main 사본이다. 그래서 여기서 관측한 것은 전부 레지스트리에
    // 쓴다 — 사본-로컬 변수에 쓰면 폴러는 영영 보지 못한다 (issue #10).
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (logger.isDebug() && (event?.type?.startsWith("session.") || event?.type?.startsWith("permission."))) {
        try {
          logger.debug(`[event] type=${event.type} directory=${directory} properties=${JSON.stringify(event.properties).slice(0, eventMaxChars)}`);
        } catch { /* ignore */ }
      }
      if (event?.type === "permission.asked" || event?.type === "permission.updated") {
        const req = normalizePermissionEvent(event.type, event.properties);
        if (req) {
          permissionAsked(registry, req);
          logger.debug(
            `[event] permission pending sid=${req.sessionID} requestID=${req.id} ` +
            `permission=${req.permission} patterns=${JSON.stringify(req.patterns)}`,
          );
        }
        return;
      }
      if (event?.type === "permission.replied") {
        const props = event.properties as { sessionID?: unknown; requestID?: unknown; permissionID?: unknown } | undefined;
        const sid = typeof props?.sessionID === "string" ? props.sessionID : undefined;
        const requestID =
          typeof props?.requestID === "string" ? props.requestID
          : typeof props?.permissionID === "string" ? props.permissionID
          : undefined;
        if (sid && requestID) permissionReplied(registry, sid, requestID);
        return;
      }
      if (event?.type === "message.part.updated") {
        // 툴 part 가 completed/error 로 바뀌면 그 호출은 끝났다. 툴이 throw 한
        // 경우 tool.execute.after 가 오지 않으므로 이것이 유일한 종결 신호다.
        const props = event.properties as { sessionID?: unknown; part?: Record<string, unknown> } | undefined;
        const part = props?.part;
        if (part && part.type === "tool") {
          const state = part.state as { status?: unknown } | undefined;
          const status = typeof state?.status === "string" ? state.status : undefined;
          if (status === "completed" || status === "error") {
            const sid =
              typeof part.sessionID === "string" ? part.sessionID
              : typeof props?.sessionID === "string" ? props.sessionID
              : undefined;
            const callID = typeof part.callID === "string" ? part.callID : undefined;
            if (sid) toolFinished(registry, sid, callID);
          }
        }
        return;
      }
      if (event?.type === "session.idle") {
        // idle 로 전이한 세션에 실행 중인 툴은 정의상 없다 — 남은 항목은 전부 누수다.
        const props = event.properties as { sessionID?: unknown } | undefined;
        if (typeof props?.sessionID === "string") clearToolCalls(registry, props.sessionID);
        return;
      }
      if (event?.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } } | { sessionID?: string } | undefined;
        const sid = (props as any)?.info?.id ?? (props as any)?.sessionID;
        if (sid) {
          notifySessionDeleted(registry, sid);
          // 세션이 사라졌으니 실행 신호·권한 요청도 의미가 없다. sessionIssue /
          // sessionWorktree 는 dispatch 사본의 cleanupSubSession 이 지운다.
          clearToolCalls(registry, sid);
          registry.pendingPermissions.delete(sid);
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
      if (!input.sessionID || !input.agent) return;
      // 정체성은 downgrade 하지 않는다 (2차 방어).
      // sessionAgent 는 sealed 서브에이전트 판정의 입력이므로, 한 번 sealed 로
      // 확정된 세션이 makdoong2 소속이 아닌 이름으로 덮어써지면 그 세션의
      // outer-world 차단·산출물 경로 제한이 조용히 풀린다. agent 를 빠뜨린
      // 프롬프트 하나로 그렇게 되어선 안 된다 — 실제로 NUDGE 가 그랬다 (issue #9).
      // 호출부(1차 방어)는 전부 agent 를 싣지만, 새 호출부가 또 빠뜨려도
      // 보안 속성은 유지되어야 한다.
      const known = sessionAgent.get(input.sessionID);
      if (known && SEALED_SUBAGENTS.has(known) && !SEALED_SUBAGENTS.has(input.agent)) {
        logger.warn(
          `[makdoong2-team hook] chat.params agent downgrade ignored: session=${input.sessionID} ` +
          `known="${known}" incoming="${input.agent}" — sealed 정체성을 유지한다. ` +
          `이 프롬프트 호출부가 agent 를 싣지 않았을 가능성이 높다.`,
        );
        return;
      }
      sessionAgent.set(input.sessionID, input.agent);
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

      // 활성 툴 집합은 **넣기와 빼기가 반드시 짝을 이뤄야 한다**.
      // tool.execute.after 는 툴이 실제로 실행된 뒤에만 돈다. 아래 가드들이 throw 하면
      // (차단된 bash · sealed 서브에이전트의 outer-world 툴 · leader 의 파일 쓰기 등)
      // after 훅이 돌지 않아 항목이 영구히 남고, 그러면 isRecentlyActive() 가
      // 항상 true 가 되어 그 세션의 gone 감지와 orphan 회수가 **영구 비활성**된다.
      // 차단은 정상 동작이라 반드시 일어나므로 확정적으로 누수됐다.
      // (툴 자체가 throw 하는 경우 — 권한 거부 · 파일 없음 — 는 여기서 잡을 수 없다.
      // 그쪽은 폴러가 스냅샷의 completed/error part 로 정리한다: settleToolCalls.)
      const activeToolKey = sessionID
        ? toolStarted(registry, sessionID, (input as any).callID as string | undefined)
        : undefined;
      try {

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

        // ── issue-reporter 스킬 사용자-전용 트리거 강제 ──
        // makdoong2-issue-reporter 스킬은 사용자의 /makdoong2-issue-reporter
        // 커맨드(전용 full-permission 에이전트로 라우팅)로만 실행된다. 다른
        // 에이전트의 skill() 자율 로드는 트리거 정책 위반 — 1차 방어는 SKILL.md
        // description, 이 블록이 2차(런타임) 방어다.
        if (toolLower === "skill") {
          const violation = issueReporterSkillLoadViolation(agent, (output as { args?: unknown }).args);
          if (violation) {
            logger.error(
              `[makdoong2-team hook] BLOCKED: agent "${agent}" attempted autonomous load of user-only skill makdoong2-issue-reporter (sessionID="${sessionID}")`
            );
            throw new Error(violation);
          }
        }

        // ── issue-reporter 는 task 로 spawn 할 수 없다 ──
        // frontmatter 의 mode/hidden 은 "목록에서 감추기" 일 뿐이고, opencode 의 task 툴은
        // subagent_type 의 mode 를 검사하지 않는다. 이름만 알면 부를 수 있으므로 여기서 막는다.
        if (toolLower === "task") {
          const taskViolation = issueReporterTaskSpawnViolation((output as { args?: unknown }).args);
          if (taskViolation) {
            logger.error(
              `[makdoong2-team hook] BLOCKED: agent "${agent ?? "unknown"}" attempted task spawn of ${ISSUE_REPORTER_AGENT} (sessionID="${sessionID}")`
            );
            throw new Error(taskViolation);
          }
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

        // ── Issue-reporter: payload 를 고쳐 쓰면 표시 증명이 무효가 된다 ──
        // 마커 파일 방식과 달리 표시 증명은 프로세스 메모리에 있어 위조할 수 없다.
        // 다만 사용자에게 보여준 뒤 파일만 바꿔치기하는 경로가 남으므로, write 계열
        // 툴이 표시된 payload 를 건드리면 그 증명을 즉시 폐기한다 (재표시 필요).
        if (agent === ISSUE_REPORTER_AGENT && (LEADER_FORBIDDEN_TOOLS.has(toolLower) || WRITE_TOOLS.has(toolLower))) {
          // filePath 인자뿐 아니라 인자 전체를 검사한다 — apply_patch 는 파일 경로가
          // 패치 본문 안에 들어 있어 filePath 추출로는 대상 파일을 알 수 없다.
          let argsSerialized = "";
          try { argsSerialized = JSON.stringify((output as { args?: unknown }).args ?? ""); } catch { /* ignore */ }
          for (const shownPath of [...issueReporterShownPayloads.keys()]) {
            if (argsSerialized.includes(shownPath)) {
              issueReporterShownPayloads.delete(shownPath);
              logger.debug(`[makdoong2-team hook] issue-reporter 표시 증명 폐기(${input.tool} 이 payload 를 수정): ${shownPath}`);
            }
          }
        }

        // ── Universal state.json hardrule (write 계열 툴) ──
        // bash 우회는 classifyStateJsonAccess 가 막지만 쓰기 **툴**은 종전에 무방비였다.
        // 산출물 허용 패턴(.makdoong2-team/<이슈키>/*.json)이 state.json 을 포함하므로
        // 여기서 명시적으로 도려낸다 — state.json 쓰기는 오직 state.sh 를 통해서만 한다.
        if (LEADER_FORBIDDEN_TOOLS.has(toolLower) || WRITE_TOOLS.has(toolLower)) {
          const stateTargets = extractWriteTargets(toolLower, (output as { args?: unknown }).args);
          const hit = stateTargets.paths
            .map((p) => p.replace(/\\/g, "/"))
            .find((p) => /(^|\/)\.makdoong2-team\/[^/]+\/state\.json$/.test(p));
          if (hit) {
            logger.error(
              `[makdoong2-team hook] BLOCKED: state.json 을 '${input.tool}' 툴로 쓰려 했다 ` +
              `(agent="${agent ?? "unknown"}", path="${hit}")`
            );
            throw new Error(
              `[makdoong2-team state hardrule] state.json 은 '${input.tool}' 툴로 쓸 수 없다 ("${hit}").\n` +
              `마커 기록은 반드시 'bash ${SCRIPTS_DIR}/state.sh set <이슈키> <키경로> <값>' 으로 하라. ` +
              `읽기는 'bash ${SCRIPTS_DIR}/state.sh get' / 'status' 를 쓴다.`
            );
          }
        }

        // ── 산출물 제한 서브에이전트의 write 계열 툴 차단 ──
        //
        // 판정 대상은 **툴이 건드리는 모든 경로**다. write/edit 는 filePath 하나,
        // apply_patch 는 패치 본문에서 파싱한 목록이다 — 후자를 "대상 불명" 으로
        // 뭉뚱그려 차단하면, opencode 가 write/edit 를 노출하지 않는 gpt-5 계열
        // 세션에서는 산출물을 만들 합법적 수단이 하나도 남지 않아 워크플로가
        // 구조적으로 정지한다 (GitHub #8 재발).
        //
        // 대상을 **확정하지 못한** 경우(패치 파싱 실패 등)에는 종전대로 차단한다.
        // 미탐에는 복구 수단이 없고 오탐에는 안내가 있다.
        if (agent && ARTIFACT_RESTRICTED_AGENTS.has(agent)
            && (LEADER_FORBIDDEN_TOOLS.has(toolLower) || WRITE_TOOLS.has(toolLower))) {
          const allowed = ARTIFACT_RESTRICTED_AGENTS.get(agent) ?? null;
          const targets = extractWriteTargets(toolLower, (output as { args?: unknown }).args);
          const normalized = targets.paths.map((p) => p.replace(/\\/g, "/"));
          const permitted = allowed !== null
            && targets.resolved
            && normalized.length > 0
            && normalized.every((p) => allowed.test(p));
          if (!permitted) {
            const shown = normalized.length > 0
              ? normalized.join(", ")
              : `unknown(${targets.reason ?? "no_target"})`;
            logger.error(
              `[makdoong2-team hook] BLOCKED: ${agent} 가 허용되지 않은 대상에 ` +
              `${input.tool} 을 시도했다 (targets=${shown})`
            );
            throw new Error(
              `[makdoong2-team artifact hardrule] "${agent}" 는 '${input.tool}' 로 ` +
              `${normalized.length > 0 ? `"${shown}" 에 ` : ""}쓸 수 없다.\n` +
              (allowed === null
                ? `이 에이전트는 파일을 쓰지 않는다 — 조사 결과는 최종 응답 텍스트로 반환하라.\n`
                : `허용된 산출물은 .makdoong2-team/<이슈키>/ 아래의 지정된 파일뿐이다 ` +
                  `(패턴: ${allowed.source}).\n` +
                  (targets.resolved
                    ? `대상 경로를 허용 패턴 안으로 바꿔 **지금 즉시 재시도**하라 — ` +
                      `산출물 쓰기 자체가 금지된 것이 아니다.\n`
                    : `이번 호출은 대상 경로를 확정하지 못해 차단됐다(${targets.reason ?? "unknown"}). ` +
                      `'write' 툴이 있으면 filePath 로 직접 쓰고, 없으면 apply_patch 본문을 ` +
                      `'*** Begin Patch' / '*** Add File: <허용 경로>' / '*** End Patch' 형식으로 ` +
                      `정확히 작성해 재시도하라 — 형식이 맞으면 허용 경로에 대해 통과한다.\n`) +
                  `bash 리디렉션 우회는 어느 경우에도 차단된다. 포기하지 말고 위 경로로 재시도하라.\n`) +
              `소스 코드 변경이 필요하면 그 사실을 산출물/응답에 적고 engineer 단계로 넘겨라.`
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
        // 차단 대상은 *쓰기* 뿐이다 — 읽기 전용 진단까지 막으면 state_unreadable
        // 복구 절차(next_action)를 수행할 수단이 사라진다 (issue #5).
        const stateAccess = classifyStateJsonAccess(cmd);
        if (stateAccess.kind === "write") {
          logger.error(
            `[makdoong2-team hook] BLOCKED: state.json 쓰기 우회 시도 (agent="${agent ?? "unknown"}", ` +
            `reason="${stateAccess.reason}"). cmd="${redactAndTruncate(cmd, 200)}"`,
          );
          throw new Error(buildStateWriteBlockMessage(stateAccess.reason, agent));
        }
        if (stateAccess.kind === "read-only") {
          logger.debug(
            `[makdoong2-team hook] state.json 읽기 전용 진단 허용 (agent="${agent ?? "unknown"}", ` +
            `readers=${stateAccess.readers.join(",")})`,
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

        // ── Issue-reporter 게시 게이트: GitHub 쓰기는 사용자가 본 원문만 ──
        // 승인의 의사표시는 opencode permission 프롬프트(세션 내 yes/no)가 받는다.
        // 여기서 강제하는 것은 나머지 절반 — 형식(검증 가능한 형태)과 표시 증명
        // (사용자가 본 원문 == 전송되는 원문). 계약 상세: src/issue-reporter-guard.ts 상단.
        if (agent === ISSUE_REPORTER_AGENT) {
          const approveHint =
            `승인 절차: ① payload 를 리터럴 절대경로 JSON 파일로 쓴다 → ② 'cat <payload>' 로 원문 전체를\n` +
            `세션에 표시한다 (체이닝 없이 단독 실행 — 이 출력이 사용자가 보는 원문이고 훅이 해시를 기록한다) →\n` +
            `③ 단일 curl -d @<payload> 로 전송하면 opencode 가 사용자에게 게시 여부를 묻는다 (yes/no).\n` +
            `표시 이후 payload 를 고치면 증명이 무효가 되므로 ②부터 다시 한다.`;

          const call = classifyGithubApiCall(cmd);
          if (call.kind === "forbidden-client") {
            logger.error(`[makdoong2-team hook] BLOCKED: issue-reporter가 비-curl 클라이언트로 GitHub API 접근. cmd="${redactAndTruncate(cmd, 200)}"`);
            throw new Error(`[makdoong2-team issue-reporter 게시 게이트] ${call.reason}\n${approveHint}`);
          }
          if (call.kind === "mutation") {
            if (call.problems.length > 0) {
              logger.error(`[makdoong2-team hook] BLOCKED: issue-reporter GitHub 쓰기 형식 위반: ${call.problems.join(" / ")}`);
              throw new Error(
                `[makdoong2-team issue-reporter 게시 게이트] GitHub 쓰기 호출 형식 위반:\n` +
                call.problems.map((p) => `  - ${p}`).join("\n") + `\n${approveHint}`
              );
            }
            for (const payloadPath of call.payloadPaths) {
              if (!existsSync(payloadPath)) {
                throw new Error(
                  `[makdoong2-team issue-reporter 게시 게이트] payload 파일이 없다: ${payloadPath}\n${approveHint}`
                );
              }
              const mismatch = displayMismatch(
                readFileSync(payloadPath),
                issueReporterShownPayloads.get(payloadPath),
              );
              if (mismatch !== null) {
                logger.error(`[makdoong2-team hook] BLOCKED: issue-reporter GitHub 쓰기 — ${mismatch} (${payloadPath})`);
                throw new Error(
                  `[makdoong2-team issue-reporter 게시 게이트] ${mismatch}.\n` +
                  `게시될 원문을 세션에 그대로 표시하라 (단독 실행):\n` +
                  `  cat ${payloadPath}\n${approveHint}`
                );
              }
              logger.debug(`[makdoong2-team hook] issue-reporter 표시 증명 확인: ${payloadPath} (hash 일치)`);
            }
          }
        }

        const hookIssue = sessionIssue.get(sessionID ?? "") ?? "";
        const r = await runScript(HOOKS_DIR, "guard-bash.sh", cmd, hookIssue);
        if (!r.ok) {
          throw new Error((r.stderr || "makdoong2-team gate blocked").trim());
        }
      } catch (err) {
        // 차단으로 끝난 호출은 실행되지 않았다 → 넣은 항목을 되돌린다.
        if (sessionID) toolFinished(registry, sessionID, activeToolKey);
        throw err;
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
        toolFinished(registry, afterSessionID, (input as any).callID as string | undefined);
      }

      // ── Issue-reporter 표시 증명 기록·소멸 ──
      // 기록: 단독 `cat <payload>` 가 실행되면 그 시점의 파일 해시를 남긴다. 이
      // 출력이 사용자가 세션에서 실제로 본 원문이고, 게시 게이트가 전송 직전에
      // 같은 해시인지 대조한다.
      // 소멸: GitHub 쓰기가 "실행"되고 나면 결과와 무관하게 증명을 폐기한다.
      // 성공이면 재게시에 새 승인이 필요하고, 실패(네트워크 등)여도 재시도 전에
      // 다시 보여주고 다시 묻는다 — 증명을 남겨두면 실패를 빌미로 승인 한 번에
      // 여러 번의 전송이 가능해지므로 엄격한 쪽을 택했다.
      if (toolLowerAfter === "bash") {
        const afterAgent = afterSessionID
          ? (sessionAgent.get(afterSessionID) ?? pendingDispatch.get(afterSessionID)?.agent)
          : undefined;
        if (afterAgent === ISSUE_REPORTER_AGENT) {
          const afterCmd = (input.args as { command?: string })?.command ?? "";
          for (const shownPath of payloadDisplayPaths(afterCmd)) {
            try {
              issueReporterShownPayloads.set(shownPath, sha256Hex(readFileSync(shownPath)));
              logger.debug(`[makdoong2-team hook] issue-reporter 표시 증명 기록: ${shownPath}`);
            } catch {
              // 읽을 수 없으면 표시가 성립하지 않은 것이다 — 기록하지 않는다.
            }
          }
          const afterCall = classifyGithubApiCall(afterCmd);
          if (afterCall.kind === "mutation") {
            for (const payloadPath of afterCall.payloadPaths) {
              if (issueReporterShownPayloads.delete(payloadPath)) {
                logger.debug(`[makdoong2-team hook] issue-reporter 표시 증명 소멸(1회용): ${payloadPath}`);
              }
            }
          }
        }
      }

      if (afterSessionID && WRITE_TOOLS.has(toolLowerAfter)) {
        const agentAfter = sessionAgent.get(afterSessionID)
          ?? pendingDispatch.get(afterSessionID)?.agent;
        // apply_patch 는 filePath 인자가 없다 — 패치 본문에서 대상을 뽑는다.
        // gpt-5 계열 세션에는 write/edit 가 아예 없어 engineer 의 모든 편집이
        // 이 경로로 오므로, filePath 만 보면 auto git add 가 통째로 무력화되고
        // dev exit gate 가 unstaged 파일로 하드 차단된다.
        const targets = extractWriteTargets(toolLowerAfter, input.args);
        logger.debug(
          `[auto-git-add-hook] tool=${toolLowerAfter} session=${afterSessionID} ` +
          `agent=${agentAfter ?? "unknown"} targets=${targets.paths.length > 0 ? targets.paths.join(",") : `N/A(${targets.reason ?? "none"})`} ` +
          `wt=${sessionWorktree.get(afterSessionID) ?? pendingDispatch.get(afterSessionID)?.worktree ?? "N/A"} ` +
          `issue=${sessionIssue.get(afterSessionID) ?? "N/A"}`,
        );
        if (agentAfter === "makdoong2-engineer") {
          for (const filePath of targets.paths) {
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

          const WORKTREE_ISOLATED_STAGES = new Set<string>([
            "2_implementation.dev", "2_implementation.test",
            "3_delivery.commit", "3_delivery.pr", "3_delivery.review",
          ]);
          // ── worktree 확정을 가장 먼저 한다 ──
          // 이 아래의 모든 state.json 접근(done 검사 · hang_history 읽기/쓰기 ·
          // verify.sh)이 **같은 state.json** 을 봐야 한다. state.sh 의 root() 는
          // cwd 의 git toplevel 을 쓰므로 cwd 가 갈리면 서로 다른 파일이 된다.
          //
          // 종전에는 done 검사와 hang_history 가 `args.worktree`(LLM 이 준 값)로,
          // 그 뒤의 나머지는 자동 교정된 `effectiveWorktree` 로 돌았다. 교정이
          // 발동하면 hang_history 만 main repo 쪽 state.json 에 쌓이는데,
          // finally 의 reverse sync 가 worktree 쪽 사본으로 그 파일을 덮어써
          // **방금 기록한 hang 이력이 매 시도마다 지워졌다** — 누적 상한
          // (stall_escalate_threshold) 이 영영 도달하지 못한다.
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

          // ── main repo → worktree 정방향 동기화 ──
          // dispatch_verifier 는 서브세션 생성 전에 이 동기화를 하는데 dispatch_stage
          // 에는 없었다. 그 비대칭이 REJECTED 재작업 규약을 구조적으로 깨뜨린다:
          // 규약은 team-leader 에게 `.done=false` 재설정을 시키는데, 리더의 cwd 는
          // main repo 이고 아래 done 검사는 worktree 사본을 본다. 리더가 규약대로
          // 했는데도 `already_done: true` 로 차단되고, 리더는 오류 문구만으로는
          // 원인을 알 수 없어 같은 실수를 반복했다 (issue #11).
          // 동기화 방향은 파이프라인 불변식과 같다 — main 이 durable 사본, worktree
          // 는 forward-seed / reverse-merge 되는 작업 사본이다 (finally 의 REVERSE).
          if (effectiveWorktree !== cwd) {
            logger.debug(
              `[wt-sync] FORWARD issue=${args.issue} worktree=${effectiveWorktree} ` +
              `caller=dispatch_stage stage=${args.target_stage}`,
            );
            const fwdSync = await $`bash ${SCRIPTS_DIR}/wt-sync-ignored.sh ${effectiveWorktree} ${args.issue}`
              .cwd(cwd).quiet().nothrow();
            if (fwdSync.exitCode !== 0) {
              logger.warn(
                `[wt-sync] FORWARD FAIL issue=${args.issue} caller=dispatch_stage exit=${fwdSync.exitCode} ` +
                `stderr=${redactAndTruncate(fwdSync.stderr?.toString() ?? "", 200)}`,
              );
            }
          }

          // done=true stage 재-dispatch 방지 (sub-agent tool-call loop → timeout/empty output).
          // 3_delivery.* 는 hybrid stage (publisher = spec provider) 로 재-진입이 정상 흐름이라 제외.
          const isHybridDelivery = args.target_stage.startsWith("3_delivery.");
          if (!isHybridDelivery) {
            const donePath = stageJqPath(args.target_stage as Stage) + ".done";
            const doneR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${donePath}`
              .cwd(effectiveWorktree).quiet().nothrow();
            if (doneR.exitCode === 0 && doneR.stdout?.toString().trim() === "true") {
              // 위 정방향 동기화가 성공했다면 두 사본은 같아야 한다. 그래도 다르면
              // 동기화가 실패한 것이고, 그 사실을 추측이 아니라 관측으로 알린다 —
              // 종전 문구는 "이미 done=true" 만 말해서, 사본 불일치라는 실제 원인을
              // 리더가 스스로 추론해야 했다 (state_unreadable 은 이미 안내한다).
              let mainRepoDone: string | null = null;
              if (effectiveWorktree !== cwd) {
                const mainDoneR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${donePath}`
                  .cwd(cwd).quiet().nothrow();
                if (mainDoneR.exitCode === 0) mainRepoDone = mainDoneR.stdout?.toString().trim() ?? null;
              }
              const copyMismatch = mainRepoDone !== null && mainRepoDone !== "true";
              return JSON.stringify({
                ok: false,
                gate: args.target_stage,
                stage: args.target_stage,
                agent: spec.id,
                already_done: true,
                state_copy_mismatch: copyMismatch,
                worktree_done: "true",
                main_repo_done: mainRepoDone,
                reason: copyMismatch
                  ? `Stage '${args.target_stage}' is done=true in the worktree state.json copy but ` +
                    `done=${mainRepoDone} in the main repo copy. state.sh 는 호출 cwd 의 git toplevel 을 ` +
                    `쓰므로 두 사본은 분리돼 있고, 이 검사는 worktree 사본을 본다. ` +
                    `main repo cwd 에서 '.done' 을 되돌렸다면 그 변경은 worktree 사본에 반영되지 않은 것이다 ` +
                    `(정방향 동기화를 이미 1회 자동 시도했고 실패했다).`
                  : `Stage '${args.target_stage}' is already done=true. ` +
                    `Re-dispatching a completed stage causes sub-agent tool-call loops (timeout/empty output). ` +
                    `Call auto_advance_stage to obtain the correct next stage instead. ` +
                    `참고: 방금 '.done=false' 로 되돌렸는데도 이 응답이 왔다면, 다른 cwd(main repo)에서 ` +
                    `state.json 을 조작해 worktree 사본과 불일치한 경우다 — state_unreadable 과 같은 메커니즘이다.`,
                next_action: copyMismatch
                  ? `동기화는 이미 자동 시도했고 실패했습니다 — 직접 재실행하지 마세요. ` +
                    `'bash ${SCRIPTS_DIR}/state.sh status ${args.issue}' 로 사본 상태를 확인하고, ` +
                    `해소되지 않으면 사용자에게 에스컬레이션하세요.`
                  : `auto_advance_stage(issue: "${args.issue}") 로 올바른 다음 단계를 받으세요. ` +
                    `REJECTED 재작업 중이라면 '.done' 재설정이 실제로 반영됐는지 ` +
                    `bash ${SCRIPTS_DIR}/state.sh get ${args.issue} <done jq-path> 로 먼저 확인하세요 ` +
                    `(jq-path: ${donePath}).`,
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
            .cwd(effectiveWorktree).quiet().nothrow();
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

          // 직전 attempt 가 워크스페이스 밖 경로 요청으로 자동 거부·abort 된 경우,
          // 새 세션 프롬프트에 "무엇이 막혔고 어디까지가 허용인지" 를 주입한다.
          // 이것이 없으면 재디스패치는 같은 경로를 다시 요청해 같은 지점에서 죽는다
          // — 서브세션은 이전 세션의 대화 이력을 이어받지 못하기 때문이다 (GitHub #12).
          let permissionBlockNote: string | null = null;

          const buildPromptText = (attemptNum: number, priorSessionIds: string[]): string => {
            const base = [
              `Working directory (ABSOLUTE): ${effectiveWorktree}`,
              `Scripts directory (ABSOLUTE): ${SCRIPTS_DIR}`,
              `Stages directory (ABSOLUTE): ${STAGES_DIR}`,
              `Issue: ${args.issue}`,
              `Stage spec: read ${specPath} and follow it strictly.`,
              `모든 state.sh / wt-sync-ignored.sh / config.sh 호출은 위 Scripts directory 경로를 사용하시오. \`$HOME/.config/opencode/scripts/\`나 \`scripts/\` 상대경로를 사용하지 마시오.`,
              `Stage 명세 파일은 위 Stages directory 경로에서 읽으시오. \`<SCRIPTS_DIR>/../stages/\` 상대경로를 사용하지 마시오.`,
              // 경로 범위는 차단이 난 뒤가 아니라 첫 프롬프트부터 알린다. 관측된
              // 위반은 모델이 저장소 밖을 검색 루트로 **명시적으로** 고른 것이라
              // (issue #12 재발 보고), 사후 안내만으로는 첫 시도를 막지 못한다.
              ...buildPathScopePromptBlock(effectiveWorktree, permissionCorrectionsPerSession),
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
                `\n=== 테스트 동반 원칙은 requirements 의 선언을 따른다 (issue #11) ===`,
                `테스트 추가 여부는 스스로 정하지 않는다. 아래를 실행해 1_planning.requirements 가 승인·동결한 선언을 먼저 읽는다:`,
                `  bash ${SCRIPTS_DIR}/state.sh get ${args.issue} '.stages."1_planning".substages."requirements".test_scope'`,
                `  - new_tests_required=true (마커 부재·null 도 true 로 간주 — fail-closed) → 변경에 대한 테스트를 함께 추가하고 self_check.new_tests_added=true 로 기록한다.`,
                `  - new_tests_required=false → 테스트 추가는 이번 이슈의 범위 밖이다. 추가하지 않는 것이 정답이며, self_check.new_tests_added=false 와 함께 dev.new_tests_waived=true 마커를 남긴다.`,
                `이 마커는 읽기 전용이다 — engineer 가 test_scope 를 쓰거나 고치지 않는다. 선언과 실제 작업이 맞지 않으면 임의로 면제·추가하지 말고 최종 출력에 적어 보고한다.`,
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
            if (permissionBlockNote) {
              base.push(
                `\n=== 경로 접근 차단 — 직전 세션이 이 사유로 즉시 중단됐다 (반복 금지) ===`,
                permissionBlockNote,
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

            // 종전 문구는 2번에서 state.sh 마커 기록을 요구하면서 마지막 줄에서
            // "새 tool 호출 추가 금지" 라고 못박아 서로 모순됐다. 실제로 planner 가
            // Jira 검증 6/6 을 끝내고도 "마커 기록 전 시한 도달" 이라며 마커를
            // 하나도 남기지 않고 종료해 27분이 통째로 버려졌다 (GitHub issue #9).
            // 마커 기록은 금지의 예외임을 문구 안에서 명시한다.
            const nudgeText = [
              "⚠ 작업 시한 80% 도달 — 지금부터는 마커 기록과 요약만 하고 즉시 세션을 종료하시오.",
              "",
              "순서대로 수행:",
              "1. 진행 중인 단일 tool call 만 마무리한다. 새 조사·탐색·구현은 시작하지 않는다.",
              `2. **이미 끝낸 작업의 state.json 마커를 지금 전부 기록한다.** bash ${SCRIPTS_DIR}/state.sh set 호출은`,
              "   아래 금지 규칙의 예외이며 필요한 횟수만큼 호출한다. 완료한 substage 는 .done=true 까지 기록한다.",
              "   마커 없이 종료하면 그 작업은 수행되지 않은 것으로 판정되어 substage 전체가 처음부터 재실행된다",
              "   — 지금까지의 결과가 통째로 버려진다. 기록할 시간이 없다는 판단은 하지 말 것.",
              "3. 3줄 이상 한국어 요약 텍스트 출력:",
              "   - 처리한 substage 결과 (완료/차단/조기종료)",
              "   - 변경한 state.json 마커 목록",
              "   - 다음 단계 안내",
              "",
              "금지: 새로운 조사·구현 tool 호출. 허용: state.sh 마커 기록. 요약 출력 직후 즉시 종료.",
            ].join("\n");

            const engineerNudge = async (sid: string, elapsedMs: number) => {
              logger.debug(`[dispatch_stage] NUDGE sid=${sid} elapsed=${Math.round(elapsedMs / 1000)}s`);
              await (client as any).session
                .promptAsync({
                  path: { id: sid },
                  body: {
                    // agent 를 빼면 opencode 가 기본 에이전트(`build`)로 이 turn 을
                    // 돌리고, `chat.params` 가 sessionAgent[sid] 를 그 값으로 덮어쓴다.
                    // 그 순간부터 이 세션은 sealed sub-agent 로 인식되지 않아
                    // outer-world 위임 차단과 산출물 경로 제한이 전부 풀린다.
                    // 실측 로그에서 NUDGE 직후 bash 호출이 agent="build" 로 기록됐다
                    // (GitHub issue #9 부수 관찰). 여기서만 누락돼 있었다.
                    agent: spec.id,
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
                .cwd(effectiveWorktree).quiet().nothrow();
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

            // ── permission_stall: 하드 실패가 아니라 회복 가능한 차단이다 ──────────
            //
            // 종전에는 여기서 곧장 최종 결과로 떨어졌다. `attempts` 가 1에서 늘지
            // 않았고, `next_action` 도 비어 있었다 — 그 공백을 team-leader 가
            // "사용자 승인 대기" 로 채워 넣어, 헤드리스 서브세션에는 존재하지도 않는
            // 승인 행위를 사용자에게 요구하며 워크플로가 멈췄다 (GitHub #12).
            //
            // `outside_allowed_roots` 만 재디스패치한다. 이 사유는 "경로를 좁히면
            // 끝날 일" 이라 새 세션에 허용 범위를 알려주면 진행할 수 있다. 나머지
            // 둘은 경로 문제가 아니다 — `non_external_permission` 은 에이전트
            // frontmatter 설정, `tool_call_stall` 은 설치 상태의 문제라 같은 조건의
            // 재시도가 결과를 바꾸지 못한다.
            if (outcome.kind === "permission_stall") {
              const blockedPatterns = outcome.permissionPatterns ?? [];
              const recoverable = outcome.permissionReason === "outside_allowed_roots";
              const currentMaxAttempts = maxAttemptsForCurrentModel();
              promptPromise.catch(() => {});

              if (recoverable && attempt < currentMaxAttempts) {
                const scopeLine = outcome.permissionScope
                  ? `자동 승인 범위: ${outcome.permissionScope}/ 이하 — worktree(${effectiveWorktree}) 와 그 형제 디렉토리까지다. 그 위(조부모 이상)는 열리지 않는다.`
                  : `자동 승인 범위: worktree(${effectiveWorktree}) 와 그 형제 디렉토리까지다. 그 위는 열리지 않는다.`;
                const corrections = outcome.permissionCorrections ?? 0;
                const correctionLine = corrections > 0
                  ? `그 세션은 abort 전에 이미 ${corrections}회 "경로를 좁혀라" 는 피드백 거부를 받았는데도 같은 범위를 다시 요청했다. 이번에는 첫 안내에서 멈춰야 한다.`
                  : null;
                permissionBlockNote = [
                  `직전 attempt(${attempt}) 는 워크스페이스 밖 경로에 대한 external_directory 권한 요청 때문에 자동 거부되고 세션이 abort 됐다.`,
                  `차단된 요청 패턴: ${JSON.stringify(blockedPatterns)}`,
                  scopeLine,
                  ...(correctionLine ? [correctionLine] : []),
                  `서브세션에는 이 승인을 받을 채널이 없다 — 같은 경로를 다시 요청하면 또 즉시 중단되고, 그때까지 한 작업은 전부 버려진다.`,
                  `조치:`,
                  `  - glob / grep / read / list 의 경로 인자를 위 허용 범위 안으로 좁혀라. 경로 인자를 아예 주지 않고 cwd 기준 상대 패턴을 쓰는 것이 가장 안전하다.`,
                  `  - 저장소 밖을 훑어야만 하는 작업이라면 수행하지 말고, 그 사실과 이유를 최종 출력에 적어 보고하라.`,
                  `  - 임시 파일은 /tmp 가 아니라 ${effectiveWorktree}/.makdoong2-team/${args.issue}/tmp/ 에 만든다.`,
                ].join("\n");
                logger.warn(
                  `[dispatch_stage] PERMISSION_BLOCK session=${subSessionID} stage=${args.target_stage} ` +
                  `attempt=${attempt}/${currentMaxAttempts} reason=${outcome.permissionReason} ` +
                  `patterns=${JSON.stringify(blockedPatterns)} scope=${outcome.permissionScope ?? "unknown"} ` +
                  `corrections=${corrections} — redispatching with allowed-scope guidance injected`,
                );
                continue;
              }

              // 예산 소진(또는 회복 불가 사유). hang_history 는 dispatch_stage 호출
              // 사이를 넘어 살아남는 유일한 카운터다 — 여기에 남기지 않으면 리더가
              // 같은 조건으로 무한히 재호출해도 cross-call 상한에 영영 닿지 않는다.
              const stallEntry = JSON.stringify({
                attempt,
                at: new Date().toISOString(),
                reason: `permission_stall:${outcome.permissionReason ?? "unknown"}`,
                patterns: blockedPatterns,
                scope: outcome.permissionScope ?? null,
                corrections: outcome.permissionCorrections ?? 0,
                elapsed_ms: outcome.elapsedMs,
                polls: outcome.polls,
                session_id: subSessionID,
                model: activeModelFull,
                fallback_depth: activeFallbackDepth,
                final: true,
              });
              const stallJqPath = stageJqPath(args.target_stage as Stage) + ".hang_history";
              const stallAppend = await $`bash ${SCRIPTS_DIR}/state.sh append ${args.issue} ${stallJqPath} ${stallEntry}`
                .cwd(effectiveWorktree).quiet().nothrow();
              logger.error(
                `[dispatch_stage] PERMISSION_STALL_FINAL session=${subSessionID} stage=${args.target_stage} ` +
                `attempts=${attempt} reason=${outcome.permissionReason} recoverable=${recoverable} ` +
                `patterns=${JSON.stringify(blockedPatterns)} scope=${outcome.permissionScope ?? "unknown"} ` +
                `hang_history append exit=${stallAppend.exitCode}`,
              );
              finalResultJson = JSON.stringify({
                ok: false,
                stage: args.target_stage,
                agent: spec.id,
                model: activeModelFull,
                session_id: subSessionID,
                previous_session_ids: attemptSessionIds.slice(0, -1),
                attempts: attempt,
                fallback_depth: activeFallbackDepth,
                output: finalLegacy.text.slice(0, 8000),
                outcome_kind: "permission_stall",
                permission_reason: outcome.permissionReason ?? "unknown",
                permission_patterns: blockedPatterns,
                permission_scope: outcome.permissionScope ?? null,
                // abort 전에 세션 안에서 돌려보낸 횟수. 0 이면 교정 경로가 없었다는
                // 뜻(0 예산 또는 회복 불가 사유)이고, >0 이면 안내를 받고도 반복한 것.
                permission_corrections: outcome.permissionCorrections ?? 0,
                permission_id: outcome.permissionID,
                permission_type: outcome.permissionType,
                // 승인 대기가 아니라 "이미 종료됨" 이다. 이 두 필드를 읽고 보고한다.
                awaiting_user_approval: false,
                session_aborted: true,
                stage_done: null,
                completion: "incomplete",
                polls: outcome.polls,
                elapsed_ms: outcome.elapsedMs,
                next_action: finalLegacy.nextAction,
                reason: finalLegacy.text,
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

            // 완료 판정은 sub-agent 의 문장이 아니라 substage 마커로 한다 (issue #9).
            // pollSubSession 의 kind="text" 는 "최종 turn 이 나왔다" 일 뿐이고,
            // 예산을 다 쓰고 "조기종료 — 마커 기록 없음" 이라고 말한 세션도 같은 kind 를
            // 낸다. 그 둘을 구분하는 유일한 값이 게이트·verifier 가 읽는 그 .done 이다.
            // cwd 는 effectiveWorktree — 이 substage 의 다른 state.json 접근과
            // 같은 파일을 봐야 한다 (args.worktree 를 쓰면 교정 발동 시 갈린다).
            const readMarker = async (field: string): Promise<string | null> => {
              const r = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${`${stageJqPath(args.target_stage as Stage)}.${field}`}`
                .cwd(effectiveWorktree).quiet().nothrow();
              return r.exitCode === 0 ? (r.stdout?.toString().trim() ?? null) : null;
            };
            const completion = classifyStageCompletion({
              outcomeKind: finalOutcome.kind,
              success,
              doneValue: success ? await readMarker("done") : null,
              interviewRequiredValue: success ? await readMarker("interview_required") : null,
            });

            if (completion.resetHangHistory) {
              // 리셋 조건은 "dispatch 정상 반환" 이 아니라 "substage 실제 완료(done=true)"
              // 다. 종전에는 세션이 텍스트만 뱉고 done=false 로 끝나도 리셋됐고,
              // 재-dispatch 를 반복하는 동안 이력이 매번 비워져
              // stall_escalate_threshold 가 사실상 도달 불가였다 (issue #8).
              const resetPath = `${stageJqPath(args.target_stage as Stage)}.hang_history`;
              const resetR = await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${resetPath} ${"[]"}`
                .cwd(effectiveWorktree).quiet().nothrow();
              logger.debug(
                `[hang_history] reset issue=${args.issue} stage=${args.target_stage} ` +
                `exit=${resetR.exitCode} — substage done=true`,
              );
            } else if (success) {
              logger.debug(
                `[hang_history] reset skipped issue=${args.issue} stage=${args.target_stage} ` +
                `completion=${completion.completion} — dispatch 는 정상 반환했지만 substage 미완료`,
              );
            }

            if (completion.recordHang) {
              // hang_history 는 dispatch_stage 호출 사이를 넘어 살아남는 유일한
              // 카운터다. 여기에 남기지 않으면 이 실패 모드는 cross-call 상한
              // (stall_escalate_threshold) 에 영영 도달하지 못하고, 매 호출이
              // 타임아웃 전체를 태우며 무한히 재실행된다 (issue #9).
              const incompleteEntry = JSON.stringify({
                attempt,
                at: new Date().toISOString(),
                reason: INCOMPLETE_HANG_REASON,
                elapsed_ms: finalOutcome.elapsedMs,
                polls: finalOutcome.polls,
                session_id: subSessionID,
                model: activeModelFull,
                fallback_depth: activeFallbackDepth,
                final: true,
              });
              const incompleteJqPath = stageJqPath(args.target_stage as Stage) + ".hang_history";
              const incompleteR = await $`bash ${SCRIPTS_DIR}/state.sh append ${args.issue} ${incompleteJqPath} ${incompleteEntry}`
                .cwd(effectiveWorktree).quiet().nothrow();
              logger.warn(
                `[dispatch_stage] STAGE_INCOMPLETE issue=${args.issue} stage=${args.target_stage} ` +
                `session=${subSessionID} outcome_kind=${finalOutcome.kind} elapsed_ms=${finalOutcome.elapsedMs} ` +
                `— 최종 텍스트는 나왔으나 .done=false. hang_history append exit=${incompleteR.exitCode}`,
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
              ok: completion.ok,
              stage: args.target_stage,
              agent: spec.id,
              model: activeModelFull,
              session_id: subSessionID,
              previous_session_ids: attemptSessionIds.slice(0, -1),
              attempts: attempt,
              fallback_depth: activeFallbackDepth,
              output: finalLegacy.text.slice(0, 8000),
              outcome_kind: finalOutcome.kind,
              // 완료 여부는 이 두 필드로 읽는다. output 문구를 해석하지 말 것 (issue #9).
              stage_done: completion.stageDone,
              completion: completion.completion,
              polls: finalOutcome.polls,
              elapsed_ms: finalOutcome.elapsedMs,
              transient_failures:
                finalOutcome.kind === "timeout"
                  ? finalOutcome.transientFailures
                  : undefined,
              retry_disallowed: retryDisallowed || undefined,
              retry_disallowed_reason: retryDisallowedReason,
              next_action: completion.nextAction,
              reason: completion.ok
                ? overriddenReason
                : (completion.incompleteReason ?? finalLegacy.text),
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
       *
       * 반환 verdict 는 셋이다. `ERROR` 는 "검증이 수행되지 않았다"(세션 인프라
       * 실패)로, 콘텐츠 반려인 `REJECTED` 와 조치가 정반대다 — 전자는 verifier 만
       * 재호출, 후자는 stage 재실행. 판정 근거는 `verdict_source`, 지시는
       * `next_action` 이 싣는다 (src/verifier-verdict.ts).
       */
      dispatch_verifier: tool({
        description:
          "Spawn the makdoong2-verifier sub-agent to second-check a stage's completion. " +
          "Returns { ok, verdict: 'VERIFIED' | 'REJECTED' | 'ERROR', verdict_source, retryable, " +
          "next_action, raw, session_id }. verdict='ERROR' means the verifier session failed " +
          "before producing a verdict — re-run dispatch_verifier only; do NOT re-run the stage.",
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
                `${stallReason} — verdict=ERROR (판정 없음), no retry ` +
                `(verifier is idempotent, team-leader can redispatch the verifier alone)`,
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

          const classification = classifyVerifierOutcome({
            raw,
            success,
            sessionGone: verifierSessionGone,
          });
          const verdict = classification.verdict;
          const verdictSource = classification.source;
          logger.debug(
            `[dispatch_verifier] VERDICT ${verdict} — issue=${args.issue} stage=${args.stage} ` +
            `session=${subSessionID} source=${verdictSource} success=${success} ` +
            `retryable=${classification.retryable} counts_as_rejection=${classification.countsAsRejection}`,
          );

          const stageBase = stageJqPath(args.stage as Stage);
          let sameReasonStreak = 0;
          let sameReasonStreakExceeded = false;
          let rejectedCount = 0;
          let verifierErrorStreak = 0;
          let verifierErrorStreakHit = false;
          const SAME_REASON_STREAK_LIMIT = 5;

          if (verdict === "ERROR") {
            // 검증이 **수행되지 않았다**. 반려 집계에 넣지 않는다.
            //
            // 여기서 REJECTED 로 집계하면 stage 산출물에 아무 문제가 없는데도
            // `rejected_count` 가 오르고 `last_verdict_reason` 에 "verifier session
            // failed" 가 박힌다. team-leader 는 그것을 반려로 읽고 stage 를 통째로
            // 재실행한다 — 실제로 마커가 전부 정상인 1_planning.jira 가 planner
            // 200초 재가동으로 이어졌고 재검증은 VERIFIED 였다 (issue #7).
            //
            // 대신 ERROR 전용 연속 카운터로 무한 재호출만 막는다.
            const prevErrR = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${stageBase + ".verifier_error_streak"}`
              .cwd(args.worktree).quiet().nothrow();
            const prevErr = prevErrR.exitCode === 0
              ? (parseInt(prevErrR.stdout?.toString().trim() || "0", 10) || 0)
              : 0;
            verifierErrorStreak = nextVerifierErrorStreak(prevErr, classification);
            verifierErrorStreakHit = verifierErrorStreakExceeded(verifierErrorStreak);
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".verifier_error_streak"} ${String(verifierErrorStreak)}`
              .cwd(args.worktree).quiet().nothrow();
            logger.warn(
              `[dispatch_verifier] VERIFIER_ERROR — issue=${args.issue} stage=${args.stage} ` +
              `source=${verdictSource} streak=${verifierErrorStreak}/${VERIFIER_ERROR_STREAK_LIMIT} ` +
              `— 판정 없음. verifier 재호출만이 올바른 조치다 (stage 재실행 금지)` +
              (verifierErrorStreakHit ? ` ERROR_STREAK_EXCEEDED` : ``),
            );
          } else if (classification.countsAsRejection) {
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

          // 판정을 얻었으면(VERIFIED / REJECTED 무관) ERROR 연속 카운터는 리셋한다.
          // 인프라가 회복됐다는 뜻이므로 직전 실패를 계속 들고 갈 이유가 없다.
          if (verdict !== "ERROR") {
            await $`bash ${SCRIPTS_DIR}/state.sh set ${args.issue} ${stageBase + ".verifier_error_streak"} 0`
              .cwd(args.worktree).quiet().nothrow();
          }

          await $`bash ${SCRIPTS_DIR}/log-event.sh ${args.issue} verifier_verdict stage=${args.stage} verdict=${verdict} session=${subSessionID}`
            .cwd(args.worktree).quiet().nothrow();

          return JSON.stringify({
            ok: success,
            verdict,
            // 종전에는 이 세 값이 없어서 호출자가 "왜 REJECTED 인지" 를 알 수 없었다.
            // verdictSource 는 이미 계산되어 로그에만 남고 있었다 (issue #7).
            verdict_source: verdictSource,
            // retryable=true 는 "같은 인자로 verifier 만 다시 부르면 된다" 는 뜻이다.
            // stage 재실행 신호가 아니다 — next_action 이 그 점을 못 박는다.
            retryable: classification.retryable,
            counts_as_rejection: classification.countsAsRejection,
            next_action: classification.nextAction,
            stage: args.stage,
            agent: verifierId,
            model: modelFull,
            session_id: subSessionID,
            raw: raw.slice(0, 8000),
            same_reason_streak: sameReasonStreak,
            same_reason_streak_exceeded: sameReasonStreakExceeded,
            rejected_count: rejectedCount,
            verifier_error_streak: verifierErrorStreak,
            verifier_error_streak_exceeded: verifierErrorStreakHit,
            parsed: classification.parsed,
          });
        },
      }),

      /**
       * get_fallback_model — fallback advisor.
       * Returns the next model in the chain, or exhausted=true.
       */
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
          let probe = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${".issue"}`
            .cwd(effectiveCwd).quiet().nothrow();

          // ── 자가 복구 1회: forward sync 는 플러그인 몫이다 ──
          // worktree cwd 에서 state.json 이 안 보이는 가장 흔한 원인은 forward sync
          // 미수행이다. 종전에는 그 복구를 next_action 으로 **team-leader 에게 시켰는데**,
          // 그 안내 문구에 worktree 절대경로가 박혀 있었다. opencode 는 bash 명령이
          // 참조하는 디렉토리마다 external_directory 승인을 묻으므로(ARCHITECTURE §4.2a),
          // 리더가 그 명령을 실행하는 순간 primary 세션이 사용자에게 승인을 물었다 —
          // 정작 다른 모든 동기화는 플러그인이 조용히 처리하는데 이 경로만 예외였다.
          // 여기서 직접 한 번 시도하면 승인 요청도, 왕복도 사라진다.
          if (probe.exitCode !== 0 && args.worktree && args.worktree !== cwd) {
            const heal = await $`bash ${SCRIPTS_DIR}/wt-sync-ignored.sh ${args.worktree} ${args.issue}`
              .cwd(effectiveCwd).quiet().nothrow();
            probe = await $`bash ${SCRIPTS_DIR}/state.sh get ${args.issue} ${".issue"}`
              .cwd(effectiveCwd).quiet().nothrow();
            logger.debug(
              `[wt-sync] SELF_HEAL issue=${args.issue} worktree=${args.worktree} ` +
              `sync_exit=${heal.exitCode} probe_after=${probe.exitCode}`,
            );
          }

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
              // 안내에 **절대경로를 싣지 않는다.** 리더가 그 경로를 명령에 넣어 실행하면
              // primary 세션이 external_directory 승인을 사용자에게 묻는다. 아래 명령은
              // 전부 cwd 기준으로 동작하므로 경로 인자가 필요 없다.
              next_action:
                `동기화는 이미 1회 자동 시도했고 실패했습니다 — 같은 동기화를 직접 실행하지 마세요. ` +
                `① 먼저 'bash ${SCRIPTS_DIR}/state.sh status ${args.issue}' 로 존재/유효성을 확인하세요 ` +
                `(승인된 읽기 명령입니다 — 훅이 차단하지 않습니다). ` +
                `② exists=false 면 'bash ${SCRIPTS_DIR}/state.sh init ${args.issue}' 로 초기화하세요 ` +
                `(경로 인자 없이 — cwd 의 git toplevel 을 자동으로 씁니다). ` +
                `③ readable=false (JSON 손상) 면 사용자에게 에스컬레이션하세요. ` +
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
                debug: (msg: string) => logger.debug(msg),
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
            // ⚠ 이 문구는 **폐기된 hybrid 모델**을 지시하면 안 된다. 종전에는
            // "publisher 가 spec 을 반환하게 하고 반환된 spec 을 부장님이 직접 git
            // 명령으로 실행하세요" 였는데, team-leader 는 frontmatter 에서
            // git commit/push/add/rm/worktree 가 **deny** 다. 그리고 leader 하드룰 4 는
            // "next_action 을 100% 따른다" 이므로, 지시를 따르면 permission 에 막히고
            // 안 따르면 하드룰 위반이 된다 — 어느 쪽으로도 진행이 안 되는 지시였다.
            // 현행 모델: publisher 가 worktree 안에서 git 을 직접 실행한다
            // (CLAUDE.md "파일 편집" 절 · DESIGN §2.2).
            ? `당신은 3_delivery 단계에 진입했습니다. 지금 즉시 dispatch_stage(issue: "${args.issue}", target_stage: "${target}", worktree: "${resolvedWt}") 툴을 호출하세요. git 명령은 publisher 가 worktree 안에서 직접 실행합니다 — 당신은 git 을 실행하지 마세요(permission deny). 반환값을 확인한 뒤 dispatch_verifier 로 검증하세요.`
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
