/**
 * Regression: dev substage resume prompt must reference requirements-draft.md first
 * and fall back to Jira. `buildPromptText` in opencode-plugin.ts is a closure,
 * so we assert on source-level contract: the specific literal strings that
 * uniquely encode this behavior.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = resolve(HERE, "..", "src", "opencode-plugin.ts");
const PLUGIN_DIST = resolve(HERE, "..", "dist", "opencode-plugin.js");

describe("opencode-plugin.ts — buildPromptText dev-resume injection", () => {
  const src = readFileSync(PLUGIN_SRC, "utf8");

  test("has attempt > 1 dev-specific branch that mentions requirements-draft.md via draft_path", () => {
    assert.match(src,
      /if\s*\(\s*args\.target_stage\s*===\s*"2_implementation\.dev"\s*\)/,
      "buildPromptText must special-case 2_implementation.dev on resume");
    assert.match(src, /requirements-draft\.md|requirements"\.draft_path/,
      "must mention requirements-draft.md or draft_path lookup");
  });

  test("mentions draft_path lookup via state.sh with hierarchical jq path", () => {
    assert.match(src,
      /\.stages\."1_planning"\.substages\."requirements"\.draft_path/,
      "must query the hierarchical draft_path field");
  });

  test("mentions Jira fallback via jira-research skill and works MCP getIssue", () => {
    assert.match(src, /jira-research/,
      "must reference jira-research skill for MCP loading");
    assert.match(src, /works.*getIssue|getIssue.*works/s,
      "must reference works MCP getIssue tool");
  });

  test("explicitly ordered: FIRST draft, FALLBACK jira", () => {
    const firstIdx = src.search(/FIRST\s*—.*requirements-draft/i);
    const fallbackIdx = src.search(/FALLBACK.*Jira|FALLBACK.*works/i);
    assert.ok(firstIdx > 0, "must contain 'FIRST' marker for draft");
    assert.ok(fallbackIdx > firstIdx, "FALLBACK must come after FIRST in source");
  });

  test("built dist file contains the same dev-resume injection", () => {
    let dist;
    try { dist = readFileSync(PLUGIN_DIST, "utf8"); }
    catch { return; }
    assert.match(dist, /2_implementation\.dev/);
    assert.match(dist, /draft_path|requirements-draft/);
  });

  test("prompt injects state.sh root() resolution (not raw absolute path)", () => {
    assert.match(src, /buildDraftPathReadSnippet/,
      "must use buildDraftPathReadSnippet helper (relative→absolute resolution)");
    assert.match(src, /state\.sh root/,
      "must reference state.sh root() for cwd-independent path resolution");
  });

  test("helper snippet includes legacy absolute-path migration", () => {
    const helperMatch = src.match(/function buildDraftPathReadSnippet\([\s\S]*?\n\}/);
    assert.ok(helperMatch, "buildDraftPathReadSnippet helper function not found");
    const body = helperMatch[0];
    assert.match(body, /\.makdoong2-team\//,
      "migration must reference .makdoong2-team/ marker");
    assert.match(body, /state\.sh set/,
      "migration must write back the normalized relative path via state.sh set");
  });
});
