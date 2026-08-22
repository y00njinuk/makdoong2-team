import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadConfig,
  readLoggingConfig,
  DEFAULT_LOG_MAX_BYTES,
  LOG_LEVELS,
  type LogLevel,
  type LogMode,
  type ResolvedLoggingConfig,
} from "./config.ts";

let _cachedResolved: ResolvedLoggingConfig | undefined;

function currentConfig(): ResolvedLoggingConfig {
  if (_cachedResolved !== undefined) return _cachedResolved;
  _cachedResolved = readLoggingConfig(loadConfig().logging);
  return _cachedResolved;
}

function shouldEmit(target: LogLevel): boolean {
  const cur = LOG_LEVELS.indexOf(currentConfig().level);
  const tgt = LOG_LEVELS.indexOf(target);
  return tgt > 0 && tgt <= cur;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// File emit: append-only, with size-triggered rotation to `<path>.1`.
// Synchronous I/O — matches console.* blocking semantics and guarantees flush
// on process.exit without a graceful-shutdown handshake.
//
// Never truncate. One `path` is shared by every opencode process on the host
// (main TUI, each tmux sub-agent pane, `npm test`), so a per-process truncate
// makes each new process erase the history the others are still writing.
//
// Rotation races are benign by construction: renameSync is atomic, so if two
// processes both observe an oversized file, the loser simply re-renames a file
// that is already small and at worst overwrites `<path>.1`. Never partial.
//
// Permissions: when we create the file we chmod it to 0o600 (owner read/write
// only). Hook logs may contain redaction fallbacks or sub-agent command
// captures that must not be world-readable — the redactSecrets sanitizer is
// best-effort, so file mode is the last-line defense against credential leak
// via `/var/log/opencode/opencode.log`.
function rotateIfOversized(path: string, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  try {
    if (statSync(path).size < maxBytes) return;
    renameSync(path, `${path}.1`);
  } catch {
    // Missing file (nothing to rotate) or a concurrent rotation by another
    // process — either way the append below still lands in a valid file.
  }
}

function emitToFile(target: LogLevel, args: unknown[]): void {
  const cfg = currentConfig();
  const path = cfg.path;
  if (!path) {
    throw new Error("[makdoong2-team logger] file mode active but path is null (readLoggingConfig invariant violation)");
  }
  const line = `[${new Date().toISOString()}] [${target}] [pid=${process.pid}] ${formatArgs(args)}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfOversized(path, cfg.maxBytes);
    const isNewFile = !existsSync(path);
    appendFileSync(path, line);
    if (isNewFile) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // chmod failure is non-fatal (e.g. read-only mount, foreign owner) —
        // log emission itself succeeded and the file remains writable by us.
      }
    }
  } catch (err) {
    throw new Error(
      `[makdoong2-team logger] failed to write to log file "${path}": ${(err as Error).message}`
    );
  }
}

function emit(target: LogLevel, args: unknown[]): void {
  if (!shouldEmit(target)) return;
  const cfg = currentConfig();
  if (cfg.mode === "file") {
    emitToFile(target, args);
    return;
  }
  switch (target) {
    case "error": console.error(...args); return;
    case "warn":  console.warn(...args);  return;
    default:      console.log(...args);   return;
  }
}

export const logger = {
  error(...args: unknown[]): void { emit("error", args); },
  warn(...args: unknown[]): void  { emit("warn",  args); },
  info(...args: unknown[]): void  { emit("info",  args); },
  debug(...args: unknown[]): void { emit("debug", args); },
  trace(...args: unknown[]): void { emit("trace", args); },
  isDebug(): boolean { return shouldEmit("debug"); },
  isTrace(): boolean { return shouldEmit("trace"); },
  _resetForTests(): void {
    _cachedResolved = undefined;
  },
  _setLevelForTests(level: LogLevel): void {
    _cachedResolved = {
      level,
      mode: "stdin",
      path: null,
      eventMaxChars: 300,
      maxBytes: DEFAULT_LOG_MAX_BYTES,
    };
  },
  _setConfigForTests(cfg: ResolvedLoggingConfig): void {
    _cachedResolved = cfg;
  },
};

export type Logger = typeof logger;
