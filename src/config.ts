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
}

export const DEFAULT_STALL_ESCALATE_THRESHOLD = 5;

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

/** Resolve the five runtime path roots (JSON paths.* override → default).
 *
 * `skills` default is the opencode config dir (`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills`)
 * because scripts/install-lib.mjs deploys skill directories there, not into the
 * package root. All other paths default to package-root subdirs.
 */
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
