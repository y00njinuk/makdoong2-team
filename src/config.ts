// config.ts — single source of configuration for makdoong2-team.
//
// Replaces every MAKDOONG2 environment variable with ONE JSON file:
//   ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/makdoong2-team.json
//
// The shell-side mirror reader is scripts/config.sh (jq). Both resolve the
// same path and the same defaults, so gates (shell) and the plugin (TS) agree.
//
// HOME / XDG_CONFIG_HOME are read ONLY to *locate* the config dir (the same
// convention opencode itself follows) — they are not tunable settings.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FallbackOverrideEntry =
  | string
  | { id: string; tier?: "low" | "medium" | "high" | "max" };

export interface AgentOverride {
  model?: string;
  variant?: "low" | "medium" | "high" | "xhigh" | "max";
  fallback_models?: FallbackOverrideEntry | FallbackOverrideEntry[];
}

export interface ModelPolicyConfig {
  allowed_primaries?: string[];
}

export interface TmuxConfigJson {
  enabled?: boolean;
  placement?: string;
  layout?: string;
  main_pane_size?: number;
  agent_pane_min_width?: number;
  split_direction?: string;
  attach_command?: string;
  server_url?: string | null;
}

export interface PathsConfig {
  hooks?: string;
  gates?: string;
  scripts?: string;
  stages?: string;
  skills?: string;
}

export interface TimeoutConfig {
  substage_minutes?: number;
  per_agent?: Record<string, number>;
  stall_escalate_threshold?: number;
  // 서브세션 하나에서 워크스페이스 밖 경로 요청을 abort 없이 피드백 거부로
  // 되돌려 주는 횟수. 0 이면 종전대로 첫 요청에서 abort 한다.
  permission_corrections_per_session?: number;
}

export const DEFAULT_STALL_ESCALATE_THRESHOLD = 5;
export const DEFAULT_PERMISSION_CORRECTIONS_PER_SESSION = 3;


export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

// LogMode: user-facing schema name kept as "stdin"/"file".
//   stdin → console.* (stderr/stdout). Backward-compatible default.
//   file  → append to `path`, rotating once `max_bytes` is exceeded.
//
// Append-only is load-bearing: several opencode processes (main TUI, each
// tmux sub-agent pane, `npm test`) share one `path`. A truncate-on-first-write
// per process would let every new process wipe the history the others are
// still producing, which is exactly what made file logs unusable for
// post-mortem diagnosis. Growth is bounded by rotation instead.
export type LogMode = "stdin" | "file";

export interface LoggingConfig {
  level?: LogLevel;
  mode?: LogMode;
  path?: string | null;
  event_max_chars?: number;
  max_bytes?: number;
}

export interface Makdoong2Config {
  agents?: Record<string, AgentOverride>;
  model_policy?: ModelPolicyConfig;
  coverage?: { threshold?: number };
  timeout?: TimeoutConfig;
  tmux?: TmuxConfigJson;
  worktree?: { extra_exclude?: string };
  paths?: PathsConfig;
  secrets?: Record<string, string>;
  logging?: LoggingConfig;
}

export const LOG_LEVELS: readonly LogLevel[] = [
  "silent",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export const LOG_MODES: readonly LogMode[] = ["stdin", "file"] as const;

export interface ResolvedLoggingConfig {
  level: LogLevel;
  mode: LogMode;
  path: string | null;
  eventMaxChars: number;
  maxBytes: number;
}

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;

export function readLoggingConfig(block?: LoggingConfig): ResolvedLoggingConfig {
  const rawLevel = block?.level;
  const level: LogLevel =
    typeof rawLevel === "string" && (LOG_LEVELS as readonly string[]).includes(rawLevel)
      ? (rawLevel as LogLevel)
      : "error";

  const rawMode = block?.mode;
  const mode: LogMode =
    typeof rawMode === "string" && (LOG_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as LogMode)
      : "stdin";

  const rawEventMax = block?.event_max_chars;
  const eventMaxChars: number =
    typeof rawEventMax === "number" && Number.isFinite(rawEventMax) && rawEventMax > 0
      ? Math.floor(rawEventMax)
      : 300;

  const rawMaxBytes = block?.max_bytes;
  const maxBytes: number =
    typeof rawMaxBytes === "number" && Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
      ? Math.floor(rawMaxBytes)
      : DEFAULT_LOG_MAX_BYTES;

  if (mode === "stdin") {
    return { level, mode, path: null, eventMaxChars, maxBytes };
  }

  const rawPath = block?.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error(
      `[makdoong2-team config] logging.mode="file" requires logging.path to be a non-empty string. ` +
      `Edit \${XDG_CONFIG_HOME:-\$HOME/.config}/opencode/makdoong2-team.json and set .logging.path, ` +
      `or change .logging.mode to "stdin".`
    );
  }
  return { level, mode, path: rawPath, eventMaxChars, maxBytes };
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "opencode");
}

// Locate the npm-installed makdoong2-team package root by walking up from this
// file (src/config.ts → package root). Works for both npm global installs
// (…/lib/node_modules/makdoong2-team/) and local dev checkouts.
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

let _cache: Makdoong2Config | null | undefined;

/** Load + cache makdoong2-team.json. Returns {} when absent or invalid (defaults apply). */
export function loadConfig(): Makdoong2Config {
  if (_cache !== undefined) return _cache ?? {};
  try {
    const path = join(configDir(), "makdoong2-team.json");
    _cache = JSON.parse(readFileSync(path, "utf8")) as Makdoong2Config;
  } catch {
    _cache = null; // absent / unreadable / invalid JSON → defaults
  }
  return _cache ?? {};
}

/**
 * opencode 는 자기 설정을 JSONC 로 파싱한다 (주석·후행 쉼표 허용). 문자열 리터럴
 * 바깥의 그 둘만 걷어내고 JSON.parse 한다.
 *
 * `scripts/install-lib.mts` 의 `parseJsonc` 와 **동작이 같아야 한다** — 한쪽은
 * opencode.json 을 쓰고 한쪽은 읽으므로, 갈리면 install 이 성공했다고 보고한
 * 설정을 런타임이 못 읽는 상태가 된다. `test/opencode-json-read.test.ts` 가
 * 두 구현의 동치를 강제한다. (install-lib 은 `bin/cli` 의 dist-무의존 성질 때문에
 * dist 를 import 할 수 없어 공용 모듈로 합치지 못한다.)
 */
export function parseJsoncLoose(text: string): unknown {
  let out = "";
  let inString = false, escaped = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  let stripped = "";
  inString = false; escaped = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) {
      stripped += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; stripped += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    stripped += c;
  }
  return JSON.parse(stripped);
}

/**
 * opencode.json 의 `permission.external_directory` 중 action==="allow" 인 패턴 목록.
 *
 * **이 설정은 opencode.json 에 있다 — makdoong2-team.json 이 아니다.**
 * 종전 구현은 `loadConfig().permission?.external_directory` 를 읽었는데
 * loadConfig() 는 makdoong2-team.json 을 읽고 그 스키마에는 `permission` 키가
 * 아예 없다(additionalProperties:false). 그래서 이 목록은 **항상 빈 배열**이었고,
 * 사용자가 opencode.json 에 명시적으로 allow 한 외부 디렉터리도 인식되지 않아
 * 서브세션의 permission 요청이 auto-reject 됐다.
 * (install-lib 의 computeExternalDirPaths 가 그 값을 쓰는 쪽이다.)
 */
export function loadOpencodeExternalDirAllows(diag?: (reason: string) => void): string[] {
  // 빈 배열로 끝나는 이유를 호출자가 알 수 있게 한다. 이 모듈은 logger 를 import
  // 하지 못하므로(logger→config) 콜백으로 돌려준다. 같은 pid 의 두 플러그인 사본이
  // 서로 다른 개수를 읽은 사례(issue #10: 7개→5개)에서 파일 부재였는지 파싱
  // 실패였는지 키 부재였는지가 로그에 남지 않았다.
  const file = join(configDir(), "opencode.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    diag?.(`read failed: ${file}: ${(err as Error).message}`);
    return []; // 부재 → 설정된 allow 없음
  }
  let oc: { permission?: { external_directory?: unknown } } | null;
  try {
    oc = parseJsoncLoose(raw) as typeof oc;
  } catch (err) {
    diag?.(`parse failed: ${file} (${raw.length} bytes): ${(err as Error).message}`);
    return []; // 파싱 실패 → 설정된 allow 없음
  }
  const ext = oc?.permission?.external_directory;
  if (!ext || typeof ext !== "object") {
    diag?.(`permission.external_directory absent: ${file}`);
    return [];
  }
  return Object.entries(ext as Record<string, unknown>)
    .filter(([, action]) => action === "allow")
    .map(([pattern]) => pattern);
}

/** Resolve the five runtime path roots (JSON paths.* override → default).
 *
 * `skills` default is the opencode config dir (`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills`)
 * because scripts/install-lib.mjs deploys skill directories there, not into the
 * package root. All other paths default to package-root subdirs.
 */
/**
 * 플러그인이 **자기 자신을 실행하기 위해** 반드시 접근해야 하는 디렉토리들.
 *
 * 모든 substage 가 `bash <SCRIPTS_DIR>/state.sh` 를 호출하고, 게이트·stage spec·
 * 리서치 스킬도 전부 opencode 설정 디렉토리(또는 패키지 루트) 아래에 있다.
 * 이들은 **워크스페이스 밖**이므로 opencode 가 `external_directory` 승인을 묻는다
 * (1.18 `ShellTool.ask` 는 bash 명령이 참조하는 디렉토리에도 발화한다).
 *
 * 종전에는 그 승인 근거가 설치 시 opencode.json 에 심어둔 시드 하나뿐이었다.
 * 시드가 남지 않은 부분 설치에서는 서브에이전트가 **자기 상태 파일조차 읽지 못한 채**
 * PERMISSION_STALL 로 죽었다 (GitHub #8). 파일 배포만 성공한 설치는 겉보기에 정상이라
 * 원인 규명도 어려웠다.
 *
 * 그래서 플러그인이 자기 경로를 **설정과 무관하게** 스스로 허용한다. opencode.json
 * 시드는 1차 방어로 그대로 두고(사용자가 직접 승인할 때의 UX), 이것이 2차 방어다 —
 * 다른 하드룰들과 같은 이중 방어 구조다.
 *
 * 허용 범위를 넓히는 변경이 아니다: 여기 담기는 경로는 플러그인이 이미 자기 손으로
 * 실행하고 있는 것들뿐이고, 워크스페이스·`/tmp`·홈 디렉토리는 포함되지 않는다.
 */
export function pluginOwnAllowPatterns(paths: Required<PathsConfig> = resolvePaths()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [paths.hooks, paths.gates, paths.scripts, paths.stages, paths.skills]) {
    if (typeof dir !== "string" || dir.trim() === "") continue;
    const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm === "" || norm === "/" || seen.has(norm)) continue;
    seen.add(norm);
    out.push(`${norm}/**`);
  }
  return out;
}

export function resolvePaths(): Required<PathsConfig> {
  const p = loadConfig().paths ?? {};
  const root = packageRoot();
  return {
    hooks:   p.hooks   ?? join(root, "src", "hooks"),
    gates:   p.gates   ?? join(root, "gates"),
    scripts: p.scripts ?? join(root, "scripts"),
    stages:  p.stages  ?? join(root, "stages"),
    skills:  p.skills  ?? join(configDir(), "skills"),
  };
}
