import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../dist/logger.js";
import { readLoggingConfig } from "../dist/config.js";

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mkd2-logger-"));
  logger._resetForTests();
});

afterEach(() => {
  logger._resetForTests();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("readLoggingConfig", () => {
  test("default: level='error', mode='stdin', path=null when block is undefined", () => {
    const r = readLoggingConfig();
    assert.equal(r.level, "error");
    assert.equal(r.mode, "stdin");
    assert.equal(r.path, null);
  });

  test("stdin mode ignores path even if set", () => {
    const r = readLoggingConfig({ level: "debug", mode: "stdin", path: "/tmp/ignored.log" });
    assert.equal(r.mode, "stdin");
    assert.equal(r.path, null);
  });

  test("file mode with valid path", () => {
    const r = readLoggingConfig({ level: "info", mode: "file", path: "/tmp/mkd2.log" });
    assert.equal(r.mode, "file");
    assert.equal(r.path, "/tmp/mkd2.log");
  });

  test("file mode with missing path throws", () => {
    assert.throws(() => readLoggingConfig({ mode: "file" }), /logging\.path/);
  });

  test("file mode with empty-string path throws", () => {
    assert.throws(() => readLoggingConfig({ mode: "file", path: "" }), /logging\.path/);
  });

  test("file mode with whitespace-only path throws", () => {
    assert.throws(() => readLoggingConfig({ mode: "file", path: "   " }), /logging\.path/);
  });

  test("file mode with null path throws", () => {
    assert.throws(() => readLoggingConfig({ mode: "file", path: null }), /logging\.path/);
  });

  test("invalid mode falls back to stdin (permissive parse)", () => {
    const r = readLoggingConfig({ mode: "syslog" });
    assert.equal(r.mode, "stdin");
  });

  test("invalid level falls back to 'error'", () => {
    const r = readLoggingConfig({ level: "verbose" });
    assert.equal(r.level, "error");
  });
});

describe("logger mode='stdin' (console)", () => {
  test("respects level threshold: level='error' suppresses warn/info/debug/trace", () => {
    logger._setConfigForTests({ level: "error", mode: "stdin", path: null });
    const calls = [];
    const origError = console.error, origWarn = console.warn, origLog = console.log;
    console.error = (...a) => calls.push(["error", ...a]);
    console.warn  = (...a) => calls.push(["warn",  ...a]);
    console.log   = (...a) => calls.push(["log",   ...a]);
    try {
      logger.error("e");
      logger.warn("w");
      logger.info("i");
      logger.debug("d");
      logger.trace("t");
    } finally {
      console.error = origError;
      console.warn  = origWarn;
      console.log   = origLog;
    }
    assert.deepEqual(calls, [["error", "e"]]);
  });

  test("level='debug' emits error/warn/info/debug but not trace", () => {
    logger._setConfigForTests({ level: "debug", mode: "stdin", path: null });
    const calls = [];
    const origError = console.error, origWarn = console.warn, origLog = console.log;
    console.error = (...a) => calls.push(["error", ...a]);
    console.warn  = (...a) => calls.push(["warn",  ...a]);
    console.log   = (...a) => calls.push(["log",   ...a]);
    try {
      logger.error("e");
      logger.warn("w");
      logger.info("i");
      logger.debug("d");
      logger.trace("t");
    } finally {
      console.error = origError;
      console.warn  = origWarn;
      console.log   = origLog;
    }
    assert.equal(calls.length, 4, "trace suppressed at level=debug");
    assert.equal(calls[0][0], "error");
    assert.equal(calls[1][0], "warn");
    assert.equal(calls[2][0], "log");
    assert.equal(calls[3][0], "log");
  });
});

describe("logger mode='file'", () => {
  test("never truncates: pre-existing content survives the first write", () => {
    const logPath = join(tmp, "plugin.log");
    writeFileSync(logPath, "CONTENT FROM ANOTHER PROCESS\n");
    assert.ok(existsSync(logPath));

    logger._setConfigForTests({ level: "trace", mode: "file", path: logPath });

    logger.error("first line");
    const afterFirst = readFileSync(logPath, "utf8");
    assert.ok(
      afterFirst.includes("CONTENT FROM ANOTHER PROCESS"),
      "another process's log lines must not be wiped by our first write",
    );
    assert.ok(afterFirst.includes("[error]"));
    assert.ok(afterFirst.includes("first line"));

    logger.warn("second line");
    logger.info("third line");
    const afterMore = readFileSync(logPath, "utf8");
    assert.ok(afterMore.includes("first line"), "first line preserved (append, not overwrite)");
    assert.ok(afterMore.includes("second line"));
    assert.ok(afterMore.includes("third line"));
    assert.ok(afterMore.includes("[warn]"));
    assert.ok(afterMore.includes("[info]"));
  });

  test("creates parent directory if missing", () => {
    const logPath = join(tmp, "nested", "sub", "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("hello");
    assert.ok(existsSync(logPath));
    assert.ok(readFileSync(logPath, "utf8").includes("hello"));
  });

  test("respects level threshold in file mode", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "warn", mode: "file", path: logPath });
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    const content = readFileSync(logPath, "utf8");
    assert.ok(content.includes("[error]"));
    assert.ok(content.includes("[warn]"));
    assert.ok(!content.includes("[info]"), "info suppressed at level=warn");
    assert.ok(!content.includes("[debug]"), "debug suppressed at level=warn");
  });

  test("does not write below-threshold levels (no empty file for silent)", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "silent", mode: "file", path: logPath });
    logger.error("should be suppressed");
    logger.warn("also suppressed");
    assert.ok(!existsSync(logPath), "no file created when level=silent suppresses everything");
  });

  test("every call appends — no per-call truncation", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    for (let i = 0; i < 10; i++) logger.error(`line ${i}`);
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 10, "all 10 lines present (no per-call truncation)");
  });

  test("a fresh logger lifetime keeps the previous lifetime's lines", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("run 1 line 1");
    logger.error("run 1 line 2");
    logger._resetForTests();
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("run 2 line 1");
    const content = readFileSync(logPath, "utf8");
    assert.ok(content.includes("run 1 line 1"), "restart must not erase earlier history");
    assert.ok(content.includes("run 1 line 2"));
    assert.ok(content.includes("run 2 line 1"));
  });

  test("tags each line with the emitting pid so shared logs stay separable", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("who wrote this");
    assert.ok(
      readFileSync(logPath, "utf8").includes(`[pid=${process.pid}]`),
      "log line must carry the writing process id",
    );
  });

  test("rotates to <path>.1 once max_bytes is exceeded", () => {
    const logPath = join(tmp, "plugin.log");
    const maxBytes = 500;
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath, maxBytes });
    for (let i = 0; i < 7; i++) logger.error(`padding line ${i} ${"x".repeat(40)}`);

    assert.ok(existsSync(`${logPath}.1`), "rotated file must exist");
    assert.ok(statSync(logPath).size < maxBytes, "live file restarted after rotation");
    assert.ok(
      readFileSync(`${logPath}.1`, "utf8").includes("padding line 0"),
      "earliest lines land in the rotated file, not deleted",
    );
  });

  test("does not rotate while under max_bytes", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath, maxBytes: 1024 * 1024 });
    logger.error("small");
    logger.error("also small");
    assert.ok(!existsSync(`${logPath}.1`), "no rotation below threshold");
  });

  test("missing maxBytes in a config object disables rotation instead of rotating every write", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("line one");
    logger.error("line two");
    assert.ok(!existsSync(`${logPath}.1`));
    const content = readFileSync(logPath, "utf8");
    assert.ok(content.includes("line one") && content.includes("line two"));
  });

  test("creating the file chmods it to 0o600 (defense-in-depth against credential leak)", () => {
    const logPath = join(tmp, "plugin.log");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("first line");
    const mode = statSync(logPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  });

  test("chmod failure is non-fatal (log emission still succeeds)", () => {
    const logPath = join(tmp, "plugin.log");
    writeFileSync(logPath, "");
    logger._setConfigForTests({ level: "error", mode: "file", path: logPath });
    logger.error("should still write despite any chmod issue");
    assert.ok(readFileSync(logPath, "utf8").includes("should still write"));
  });
});
