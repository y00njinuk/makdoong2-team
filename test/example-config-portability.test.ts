// test/example-config-portability.test.ts — opencode.json.example 이식성 회귀 테스트
//
// opencode.json.example 및 fresh install이 생성하는 opencode.json이
// Windows 전용 MCP spawn 명령을 포함하지 않음을 검증한다.
//
// Run via: node --test test/example-config-portability.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const EXAMPLE_PATH = join(REPO_ROOT, "opencode.json.example");
const CLI = join(REPO_ROOT, "bin", "cli.ts");

// (a)와 (c)에서 공유하는 Windows 전용 spawn 마커 목록
const WINDOWS_MARKERS = [
  { pattern: /^cmd\.exe$/i,   label: "cmd.exe" },
  { pattern: /^powershell$/i, label: "powershell" },
  { pattern: /^pwsh$/i,       label: "pwsh" },
  { pattern: /\.bat$/i,       label: ".bat suffix" },
  { pattern: /\.cmd$/i,       label: ".cmd suffix" },
  { pattern: /\\/,            label: "backslash path separator (\\)" },
  { pattern: /^[A-Za-z]:/,   label: "drive-letter prefix (e.g. C:)" },
];

/** command 배열 안에서 Windows 마커에 걸리는 첫 번째 원소를 반환. 없으면 null. */
function findWindowsElement(commandArray) {
  for (const elem of commandArray) {
    for (const { pattern, label } of WINDOWS_MARKERS) {
      if (pattern.test(elem)) return { elem, label };
    }
  }
  return null;
}

/** mcp 섹션에서 Windows 전용 command를 가진 첫 번째 항목을 반환. 없으면 null. */
function findWindowsMcpEntry(mcpSection) {
  for (const [key, entry] of Object.entries(mcpSection)) {
    if (key.startsWith("_")) continue;     // _comment 등 메타 키 스킵
    if (!Array.isArray(entry?.command)) continue;
    const hit = findWindowsElement(entry.command);
    if (hit) return { key, ...hit };
  }
  return null;
}

// 내장 플러그인 툴 (mcp 대응 항목 없어도 됨)
const BUILTIN_PLUGIN_TOOLS = new Set([
  "verify_stage",
  "dispatch_stage",
  "dispatch_verifier",
  "auto_advance_stage",
  "get_fallback_model",
]);

describe("opencode.json.example 이식성", () => {
  test("(a) 예제 파일의 mcp command에 Windows 전용 마커가 없어야 한다", () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
    const hit = findWindowsMcpEntry(example.mcp ?? {});
    assert.equal(
      hit,
      null,
      `mcp["${hit?.key}"].command에 Windows 전용 요소 발견: "${hit?.elem}" (${hit?.label})`,
    );
  });

  test("(b) tools의 비-내장 키는 mcp 섹션에 대응 항목이 있어야 한다 (고아 tools 키 금지)", () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
    const mcp = example.mcp ?? {};
    const tools = example.tools ?? {};

    for (const toolKey of Object.keys(tools)) {
      const baseName = toolKey.replace(/\*$/, "");
      if (BUILTIN_PLUGIN_TOOLS.has(baseName)) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(mcp, baseName),
        `tools["${toolKey}"] 기반 이름 "${baseName}"에 대응하는 mcp 항목 없음 (고아 tools 키)`,
      );
    }
  });

  test("(c) 격리 install이 생성한 opencode.json에 Windows 전용 mcp 명령이 없어야 한다", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mkd2-portability-"));
    try {
      const r = spawnSync(
        process.execPath,
        [CLI, "install", "--config", tmpDir],
        { encoding: "utf8", timeout: 30_000 },
      );

      let produced;
      try {
        produced = JSON.parse(readFileSync(join(tmpDir, "opencode.json"), "utf8"));
      } catch {
        assert.fail(
          `install 후 opencode.json 없음.\nexit: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }

      const hit = findWindowsMcpEntry(produced.mcp ?? {});
      assert.equal(
        hit,
        null,
        `install 생성 opencode.json의 mcp["${hit?.key}"].command에 Windows 전용 요소: "${hit?.elem}" (${hit?.label})`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
