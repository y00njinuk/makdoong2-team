import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillFrontmatter,
  scanSkillMcpRegistry,
  extractMcpName,
  looksLikeMcpNotFound,
  looksLikeMcpConnectionFailed,
} from "../dist/skill-mcp-registry.js";

describe("parseSkillFrontmatter", () => {
  test("extracts name and single mcp server", () => {
    const src = [
      "---",
      "name: jira-research",
      "description: some desc",
      "mcp:",
      "  works:",
      "    command: bash",
      '    args: ["./run-works.sh"]',
      "---",
      "",
      "# Body",
    ].join("\n");

    const r = parseSkillFrontmatter(src);
    assert.equal(r?.name, "jira-research");
    assert.deepEqual(r?.mcpNames, ["works"]);
  });

  test("extracts server name when args uses bash -c absolute path format", () => {
    const src = [
      "---",
      "name: jira-research",
      "mcp:",
      "  works:",
      "    command: bash",
      `    args: ["-c", 'exec "\${XDG_CONFIG_HOME:-\$HOME/.config}/opencode/skills/jira-research/run-works.sh"']`,
      "---",
    ].join("\n");

    const r = parseSkillFrontmatter(src);
    assert.equal(r?.name, "jira-research");
    assert.deepEqual(r?.mcpNames, ["works"]);
  });

  test("extracts multiple mcp servers", () => {
    const src = [
      "---",
      "name: multi-skill",
      "mcp:",
      "  works:",
      "    command: bash",
      "  docs:",
      "    command: bash",
      "  repos:",
      "    command: bash",
      "---",
    ].join("\n");
    const r = parseSkillFrontmatter(src);
    assert.deepEqual(r?.mcpNames, ["works", "docs", "repos"]);
  });

  test("skill without mcp block yields empty mcpNames", () => {
    const src = [
      "---",
      "name: github-oss-research",
      "description: no mcp here",
      "---",
    ].join("\n");
    const r = parseSkillFrontmatter(src);
    assert.equal(r?.name, "github-oss-research");
    assert.deepEqual(r?.mcpNames, []);
  });

  test("returns null when frontmatter missing", () => {
    assert.equal(parseSkillFrontmatter("# just a body"), null);
  });

  test("does not treat deeper indented keys as server names", () => {
    const src = [
      "---",
      "name: t",
      "mcp:",
      "  works:",
      "    command: bash",
      "    args: []",
      "    env:",
      "      TOKEN: xyz",
      "---",
    ].join("\n");
    const r = parseSkillFrontmatter(src);
    assert.deepEqual(r?.mcpNames, ["works"]);
  });

  test("handles quoted name value", () => {
    const src = ['---', 'name: "jira-research"', '---'].join("\n");
    const r = parseSkillFrontmatter(src);
    assert.equal(r?.name, "jira-research");
  });
});

describe("scanSkillMcpRegistry", () => {
  test("scans a skills directory into byMcp/bySkill maps", () => {
    const root = mkdtempSync(join(tmpdir(), "mkd2-skills-"));
    try {
      mkdirSync(join(root, "jira-research"), { recursive: true });
      writeFileSync(
        join(root, "jira-research", "SKILL.md"),
        [
          "---",
          "name: jira-research",
          "mcp:",
          "  works:",
          "    command: bash",
          "---",
        ].join("\n"),
      );
      mkdirSync(join(root, "confluence-research"), { recursive: true });
      writeFileSync(
        join(root, "confluence-research", "SKILL.md"),
        [
          "---",
          "name: confluence-research",
          "mcp:",
          "  docs:",
          "    command: bash",
          "---",
        ].join("\n"),
      );
      mkdirSync(join(root, "github-oss-research"), { recursive: true });
      writeFileSync(
        join(root, "github-oss-research", "SKILL.md"),
        ["---", "name: github-oss-research", "---"].join("\n"),
      );

      const reg = scanSkillMcpRegistry(root);
      assert.equal(reg.byMcp.get("works"), "jira-research");
      assert.equal(reg.byMcp.get("docs"), "confluence-research");
      assert.equal(reg.byMcp.get("nope"), undefined);
      assert.equal(reg.bySkill.get("jira-research")?.mcpNames.length, 1);
      assert.equal(reg.bySkill.get("github-oss-research")?.mcpNames.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty registry when skills root missing", () => {
    const reg = scanSkillMcpRegistry("/nonexistent/path/mkd2-skills");
    assert.equal(reg.byMcp.size, 0);
    assert.equal(reg.bySkill.size, 0);
  });
});

describe("extractMcpName", () => {
  test("returns mcp_name from args object", () => {
    assert.equal(extractMcpName({ mcp_name: "works" }), "works");
  });
  test("trims whitespace", () => {
    assert.equal(extractMcpName({ mcp_name: "  works  " }), "works");
  });
  test("returns undefined for missing/empty/non-string", () => {
    assert.equal(extractMcpName({}), undefined);
    assert.equal(extractMcpName({ mcp_name: "" }), undefined);
    assert.equal(extractMcpName({ mcp_name: 42 }), undefined);
    assert.equal(extractMcpName(null), undefined);
    assert.equal(extractMcpName(undefined), undefined);
  });
});

describe("looksLikeMcpNotFound", () => {
  test("matches quoted server name variants", () => {
    assert.equal(looksLikeMcpNotFound('MCP server "works" not found.'), true);
    assert.equal(looksLikeMcpNotFound("MCP server 'docs' not found"), true);
    assert.equal(looksLikeMcpNotFound("MCP server bamboo not found."), true);
  });
  test("does not match unrelated errors", () => {
    assert.equal(looksLikeMcpNotFound("connection refused"), false);
    assert.equal(looksLikeMcpNotFound(""), false);
  });
});

describe("looksLikeMcpConnectionFailed", () => {
  test("matches Failed to connect message", () => {
    assert.equal(
      looksLikeMcpConnectionFailed('Failed to connect to MCP server "works".'),
      true,
    );
    assert.equal(
      looksLikeMcpConnectionFailed("Failed to connect to MCP server repos\nCommand: bash -c ...\nReason: MCP error -32000: Connection closed"),
      true,
    );
  });
  test("matches Connection closed error code", () => {
    assert.equal(
      looksLikeMcpConnectionFailed("MCP error -32000: Connection closed"),
      true,
    );
  });
  test("does not match not-found or unrelated errors", () => {
    assert.equal(looksLikeMcpConnectionFailed('MCP server "works" not found'), false);
    assert.equal(looksLikeMcpConnectionFailed("connection refused"), false);
    assert.equal(looksLikeMcpConnectionFailed(""), false);
  });
});
