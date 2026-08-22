import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_SECRET_MAPPINGS,
  injectOneSecret,
  injectAllSecrets,
} from "../dist/mcp-secret-injector.js";

const REPOS_MAPPING = { mcpKey: "repos", varName: "BITBUCKET_API_TOKEN" };

function makeConfig(mcp) {
  return { mcp };
}

describe("MCP_SECRET_MAPPINGS", () => {
  test("covers the four SSoT-managed MCP servers", () => {
    const keys = MCP_SECRET_MAPPINGS.map((m) => m.mcpKey);
    assert.deepEqual(keys.sort(), ["bamboo", "docs", "repos", "works"]);
  });

  test("varName matches makdoong2-team.json .secrets.<var> convention", () => {
    const byKey = Object.fromEntries(
      MCP_SECRET_MAPPINGS.map((m) => [m.mcpKey, m.varName]),
    );
    assert.equal(byKey.repos, "BITBUCKET_API_TOKEN");
    assert.equal(byKey.works, "JIRA_API_TOKEN");
    assert.equal(byKey.docs, "CONFLUENCE_API_TOKEN");
    assert.equal(byKey.bamboo, "BAMBOO_TOKEN");
  });
});

describe("injectOneSecret", () => {
  test("skipped-no-secret when secret is missing", () => {
    const cfg = makeConfig({ repos: { environment: { OTHER: "x" } } });
    const r = injectOneSecret(cfg, {}, REPOS_MAPPING);
    assert.equal(r.status, "skipped-no-secret");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, undefined);
    assert.equal(cfg.mcp.repos.environment.OTHER, "x");
  });

  test("skipped-no-secret when secret is empty string", () => {
    const cfg = makeConfig({ repos: { environment: {} } });
    const r = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "" }, REPOS_MAPPING);
    assert.equal(r.status, "skipped-no-secret");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, undefined);
  });

  test("skipped-no-mcp when opencodeConfig has no mcp block", () => {
    const cfg = {};
    const r = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "t" }, REPOS_MAPPING);
    assert.equal(r.status, "skipped-no-mcp");
  });

  test("skipped-no-mcp when the specific MCP entry is missing", () => {
    const cfg = makeConfig({ works: { environment: {} } });
    const r = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "t" }, REPOS_MAPPING);
    assert.equal(r.status, "skipped-no-mcp");
    assert.equal(cfg.mcp.repos, undefined);
  });

  test("injected when environment is fresh", () => {
    const cfg = makeConfig({ repos: {} });
    const r = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "TOKEN_A" }, REPOS_MAPPING);
    assert.equal(r.status, "injected");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "TOKEN_A");
    assert.equal(r.tokenPrefix, "TOKEN_A");
  });

  test("injected when existing value already matches", () => {
    const cfg = makeConfig({ repos: { environment: { BITBUCKET_API_TOKEN: "SAME" } } });
    const r = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "SAME" }, REPOS_MAPPING);
    assert.equal(r.status, "injected");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "SAME");
  });

  test("overridden when existing value differs (SSoT wins)", () => {
    const cfg = makeConfig({
      repos: { environment: { BITBUCKET_API_TOKEN: "OLD_STALE" } },
    });
    const r = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "NEW_FRESH" }, REPOS_MAPPING);
    assert.equal(r.status, "overridden");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "NEW_FRESH");
  });

  test("preserves unrelated environment vars in the same MCP block", () => {
    const cfg = makeConfig({
      repos: {
        environment: {
          BITBUCKET_API_TOKEN: "OLD",
          BITBUCKET_API_BASE_PATH: "https://example.com/rest",
        },
      },
    });
    injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "NEW" }, REPOS_MAPPING);
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "NEW");
    assert.equal(
      cfg.mcp.repos.environment.BITBUCKET_API_BASE_PATH,
      "https://example.com/rest",
    );
  });

  test("preserves sibling MCP entries untouched", () => {
    const cfg = makeConfig({
      repos: { environment: {} },
      "chrome-devtools-mcp": {
        command: ["cmd"],
        environment: { SOMETHING: "keep-me" },
      },
    });
    injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "T" }, REPOS_MAPPING);
    assert.equal(cfg.mcp["chrome-devtools-mcp"].environment.SOMETHING, "keep-me");
  });

  test("creates environment object when absent", () => {
    const cfg = makeConfig({ repos: {} });
    injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "T" }, REPOS_MAPPING);
    assert.equal(typeof cfg.mcp.repos.environment, "object");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "T");
  });

  test("returns tokenPrefix for successful writes only", () => {
    const cfg = makeConfig({ repos: {} });
    const injected = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "abcdefghij" }, REPOS_MAPPING);
    assert.equal(injected.tokenPrefix, "abcdefgh");

    const skipped = injectOneSecret(
      makeConfig({}),
      { BITBUCKET_API_TOKEN: "x" },
      REPOS_MAPPING,
    );
    assert.equal(skipped.tokenPrefix, undefined);
  });

  test("is idempotent — calling twice yields same result", () => {
    const cfg = makeConfig({ repos: { environment: {} } });
    const r1 = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "TOK" }, REPOS_MAPPING);
    const r2 = injectOneSecret(cfg, { BITBUCKET_API_TOKEN: "TOK" }, REPOS_MAPPING);
    assert.equal(r1.status, "injected");
    assert.equal(r2.status, "injected");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "TOK");
  });
});

describe("injectAllSecrets", () => {
  test("applies every mapping in one pass", () => {
    const cfg = makeConfig({
      repos: { environment: {} },
      works: { environment: {} },
      docs: { environment: {} },
      bamboo: { environment: {} },
    });
    const secrets = {
      BITBUCKET_API_TOKEN: "B",
      JIRA_API_TOKEN: "J",
      CONFLUENCE_API_TOKEN: "C",
      BAMBOO_TOKEN: "M",
    };
    const results = injectAllSecrets(cfg, secrets);
    assert.equal(results.length, 4);
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "B");
    assert.equal(cfg.mcp.works.environment.JIRA_API_TOKEN, "J");
    assert.equal(cfg.mcp.docs.environment.CONFLUENCE_API_TOKEN, "C");
    assert.equal(cfg.mcp.bamboo.environment.BAMBOO_TOKEN, "M");
    for (const r of results) {
      assert.equal(r.status, "injected");
    }
  });

  test("mixed result set — override, skip-no-secret, skip-no-mcp all in one run", () => {
    const cfg = makeConfig({
      repos: { environment: { BITBUCKET_API_TOKEN: "OLD" } },
      works: { environment: {} },
      docs: { environment: {} },
    });
    const secrets = {
      BITBUCKET_API_TOKEN: "NEW",
      CONFLUENCE_API_TOKEN: "C_TOK",
      BAMBOO_TOKEN: "M_TOK",
    };
    const results = injectAllSecrets(cfg, secrets);
    const byKey = Object.fromEntries(results.map((r) => [r.mcpKey, r.status]));
    assert.equal(byKey.repos, "overridden", "existing differing token → overridden");
    assert.equal(byKey.works, "skipped-no-secret", "JIRA_API_TOKEN not in secrets");
    assert.equal(byKey.docs, "injected", "docs both has mcp entry and secret");
    assert.equal(byKey.bamboo, "skipped-no-mcp", "bamboo secret provided but no mcp entry");
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, "NEW");
    assert.equal(cfg.mcp.docs.environment.CONFLUENCE_API_TOKEN, "C_TOK");
    assert.equal(cfg.mcp.works.environment.JIRA_API_TOKEN, undefined);
  });

  test("secret-check precedes mcp-check — no-secret wins when both missing", () => {
    const cfg = makeConfig({});
    const results = injectAllSecrets(cfg, {});
    for (const r of results) {
      assert.equal(r.status, "skipped-no-secret", `${r.mcpKey}: secret check runs first`);
    }
  });

  test("does nothing when opencodeConfig has no mcp block, even with secrets", () => {
    const cfg = {};
    const results = injectAllSecrets(cfg, {
      BITBUCKET_API_TOKEN: "T",
      JIRA_API_TOKEN: "T",
      CONFLUENCE_API_TOKEN: "T",
      BAMBOO_TOKEN: "T",
    });
    assert.equal(results.length, 4);
    for (const r of results) {
      assert.equal(r.status, "skipped-no-mcp");
    }
    assert.equal(cfg.mcp, undefined);
  });

  test("does nothing when no secrets provided", () => {
    const cfg = makeConfig({
      repos: { environment: {} },
      works: { environment: {} },
    });
    const results = injectAllSecrets(cfg, {});
    for (const r of results) {
      assert.equal(r.status, "skipped-no-secret");
    }
    assert.equal(cfg.mcp.repos.environment.BITBUCKET_API_TOKEN, undefined);
    assert.equal(cfg.mcp.works.environment.JIRA_API_TOKEN, undefined);
  });

  test("returns results in mapping declaration order", () => {
    const cfg = makeConfig({});
    const results = injectAllSecrets(cfg, {});
    assert.deepEqual(
      results.map((r) => r.mcpKey),
      MCP_SECRET_MAPPINGS.map((m) => m.mcpKey),
    );
  });
});
