import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactAndTruncate, REDACTED } from "../dist/redact-secrets.js";

describe("redactSecrets — shell assignment forms", () => {
  test("bare shell assignment with secret substring in key", () => {
    const input = `JIRA_API_TOKEN=MDAwMDAwMDAwMDAwFakeTokenFakeTokenFakeToken0 npx foo`;
    const out = redactSecrets(input);
    assert.match(out, /JIRA_API_TOKEN=\*{3}REDACTED\*{3}/);
    assert.doesNotMatch(out, /MDAwMDAw/);
    assert.match(out, /npx foo/, "surrounding command preserved");
  });

  test("double-quoted export retains quotes", () => {
    const input = `export JIRA_API_TOKEN="MDAwMDAwMDAwMDAw"`;
    const out = redactSecrets(input);
    assert.equal(out, `export JIRA_API_TOKEN="${REDACTED}"`);
  });

  test("single-quoted export retains quotes", () => {
    const input = `export JIRA_API_TOKEN='MDAwMDAwMDAwMDAw'`;
    const out = redactSecrets(input);
    assert.equal(out, `export JIRA_API_TOKEN='${REDACTED}'`);
  });

  test("multi-line multiple exports (planner regression case)", () => {
    const input = [
      `export JIRA_HOST="jira.example.com"`,
      `export JIRA_API_TOKEN="MDAwMDAwMDAwMDAwFakeTokenFakeTokenFakeToken0"`,
      `npx -y "@atlassian-dc-mcp/jira" get-issue --issue-key PROJ-40406`,
    ].join("\n");
    const out = redactSecrets(input);
    assert.doesNotMatch(out, /MDAwMDAw/, "token payload must be fully masked");
    assert.match(out, /JIRA_API_TOKEN="\*{3}REDACTED\*{3}"/);
    assert.match(out, /JIRA_HOST="jira\.example\.com"/, "non-secret env var preserved (JIRA_HOST does not contain a secret substring)");
    assert.match(out, /npx -y/, "trailing command preserved");
  });

  test("all 4 makdoong2-team credentials (JIRA/BITBUCKET/CONFLUENCE/BAMBOO) are masked", () => {
    const credentials = [
      { key: "JIRA_API_TOKEN", value: "JIRA_secretPayload_ABCDEF123456" },
      { key: "BITBUCKET_API_TOKEN", value: "BITBUCKET_secretPayload_ABCDEF123456" },
      { key: "CONFLUENCE_API_TOKEN", value: "CONFLUENCE_secretPayload_ABCDEF123456" },
      { key: "BAMBOO_TOKEN", value: "BAMBOO_secretPayload_ABCDEF123456" },
    ];
    for (const { key, value } of credentials) {
      for (const input of [
        `${key}=${value}`,
        `export ${key}="${value}"`,
        `export ${key}='${value}'`,
        `${key}=${value} curl -sSf https://api.example.com`,
      ]) {
        const out = redactSecrets(input);
        assert.doesNotMatch(out, new RegExp(value), `${key} form '${input}' must be fully masked`);
        assert.match(out, new RegExp(`${key}=.*REDACTED`), `${key} redacted marker present`);
      }
    }
  });

  test("secret substring anywhere in identifier is masked (JIRA_API_TOKEN, MY_SECRET_KEY)", () => {
    const inputs = [
      `MY_SECRET_KEY=abcdef`,
      `SOME_LONG_APIKEY=xyz`,
      `USER_PASSWORD=hunter2`,
    ];
    for (const inp of inputs) {
      const out = redactSecrets(inp);
      assert.match(out, new RegExp(`^${inp.split("=")[0]}=\\*{3}REDACTED\\*{3}$`));
    }
  });

  test("non-secret identifiers are preserved (case-insensitive substring lookup)", () => {
    const input = `JIRA_HOST=jira.example.com  BUILD_NUMBER=42  DEBUG=true`;
    const out = redactSecrets(input);
    assert.equal(out, input, "no key contains a secret substring, string unchanged");
  });

  test("does not eat command boundaries — assignment followed by pipe", () => {
    const input = `TOKEN=abc | grep foo`;
    const out = redactSecrets(input);
    assert.match(out, /TOKEN=\*{3}REDACTED\*{3} \| grep foo/);
  });
});

describe("redactSecrets — CLI flag forms", () => {
  test("--token=VALUE", () => {
    assert.match(redactSecrets("curl --token=abc123def456"), /--token=\*{3}REDACTED\*{3}/);
  });
  test("--api-key VALUE (space-separated)", () => {
    assert.match(redactSecrets("curl --api-key abc123def456 https://api"), /--api-key \*{3}REDACTED\*{3} https:\/\/api/);
  });
  test("--password=\"quoted\"", () => {
    assert.equal(redactSecrets(`--password="hunter2"`), `--password="${REDACTED}"`);
  });
});

describe("redactSecrets — HTTP auth scheme literals", () => {
  test("Authorization: Bearer TOKEN", () => {
    const input = `curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"`;
    const out = redactSecrets(input);
    assert.match(out, /Authorization: Bearer \*{3}REDACTED\*{3}/);
    assert.doesNotMatch(out, /eyJhbGci/);
  });
  test("bare Bearer TOKEN in body", () => {
    assert.match(redactSecrets(`Bearer abcdef123456`), /Bearer \*{3}REDACTED\*{3}/);
  });
  test("Basic base64", () => {
    assert.match(redactSecrets(`Basic ZmFrZXVzZXI6ZmFrZXBhc3M=`), /Basic \*{3}REDACTED\*{3}/);
  });
  test("conservative: over-masking of prose Bearer/Basic mentions is acceptable (false-positive > false-negative)", () => {
    const input = `Bearer strategy_here is preferred`;
    const out = redactSecrets(input);
    assert.match(out, /Bearer \*{3}REDACTED\*{3}/,
      "the sanitizer is conservative — masking a prose word after 'Bearer' is preferable to leaking a real token");
  });
});

describe("redactSecrets — well-known token prefixes", () => {
  const cases = [
    ["xoxb-1234567890-abcdefghijkl", "Slack bot token"],
    ["ghp_abcdefghijklmnopqrstuvwxyz012345", "GitHub PAT"],
    ["AKIAIOSFODNN7EXAMPLE", "AWS access key"],
    ["npm_abcdefghijklmnopqrstuvwxyz012345", "npm registry token"],
    ["AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe", "Google API key"],
  ];
  for (const [tok, label] of cases) {
    test(`masks ${label}`, () => {
      const out = redactSecrets(`some prefix ${tok} some suffix`);
      assert.doesNotMatch(out, new RegExp(tok.slice(0, 12)), `${label} prefix should not remain`);
      assert.match(out, /some prefix \*{3}REDACTED\*{3} some suffix/);
    });
  }
});

describe("redactSecrets — idempotence & safety", () => {
  test("empty / non-string inputs pass through unchanged", () => {
    assert.equal(redactSecrets(""), "");
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(undefined), undefined);
  });
  test("idempotent — running twice yields same output", () => {
    const input = `export TOKEN="abc123" && curl -H "Authorization: Bearer xyz789abc123"`;
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    assert.equal(twice, once);
  });
});

describe("redactAndTruncate", () => {
  test("redacts BEFORE slicing so tokens in first N chars are masked", () => {
    const token = "MDAwMDAwMDAwMDAwFakeTokenFakeTokenFakeToken0";
    const input = `export JIRA_API_TOKEN="${token}"; ${"x".repeat(500)}`;
    const out = redactAndTruncate(input, 60);
    assert.doesNotMatch(out, new RegExp(token), "token must be masked before truncation window");
    assert.match(out, /truncated/);
  });
  test("short redacted output not truncated", () => {
    const out = redactAndTruncate("harmless command", 200);
    assert.equal(out, "harmless command");
    assert.doesNotMatch(out, /truncated/);
  });
});
