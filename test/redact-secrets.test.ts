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

// ── 3차: 미탐 8종 · 오탐 4종 ──
//
// 이 함수는 훅 로그와 issue-reporter 가 GitHub 에 올리는 본문의 마지막 방어선이다.
// 미탐은 자격증명 유출이고, 오탐은 사후 진단 가치의 손실이다 — 둘 다 실재했다.
describe("redactSecrets — 미탐 차단 (3차)", () => {
  test("Authorization 헤더는 대소문자를 가리지 않는다", () => {
    // GitHub·Jira 문서의 표준 표기가 소문자다. 종전 정규식은 대문자만 봤다.
    for (const s of [
      "authorization: bearer abcdef1234567890abcdef",
      "Authorization: Bearer abcdef1234567890abcdef",
      "AUTHORIZATION: TOKEN abcdef1234567890abcdef",
    ]) {
      assert.match(redactSecrets(s), /\*\*\*REDACTED\*\*\*/, s);
      assert.doesNotMatch(redactSecrets(s), /abcdef1234567890/, s);
    }
  });

  test("신형 GitHub fine-grained PAT 와 GitLab PAT", () => {
    const gh = "github_pat_11ABCDEFG0abcdefghijklmnop";
    const gl = "glpat-abcdefghijklmnop1234";
    assert.doesNotMatch(redactSecrets(`raw ${gh} here`), /github_pat_11/);
    assert.doesNotMatch(redactSecrets(`raw ${gl} here`), /glpat-abc/);
  });

  test("curl -u 와 URL 매립 자격증명", () => {
    assert.doesNotMatch(redactSecrets("curl -u myuser:sup3rs3cret https://x"), /sup3rs3cret/);
    const url = redactSecrets("git clone https://bob:hunter2pass@github.com/o/r.git");
    assert.doesNotMatch(url, /hunter2pass/);
    assert.match(url, /https:\/\/bob:/, "사용자명은 진단에 필요하므로 남긴다");
  });

  test("PEM 개인키 본문", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nline2\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(pem);
    assert.doesNotMatch(out, /MIIEabc/);
    assert.match(out, /-----BEGIN RSA PRIVATE KEY-----/, "헤더는 남겨 무엇이 지워졌는지 알린다");
  });
});

describe("redactSecrets — 오탐 해소 (3차)", () => {
  test("PATH / PATTERN / COMPATIBILITY 는 비밀이 아니다", () => {
    // "PAT" 를 부분 문자열로 매칭해서 진단에 꼭 필요한 PATH 가 통째로 지워졌다.
    assert.equal(redactSecrets("PATH=/usr/local/bin:/usr/bin"), "PATH=/usr/local/bin:/usr/bin");
    assert.equal(redactSecrets("PATTERN=^foo$"), "PATTERN=^foo$");
    assert.equal(redactSecrets("COMPATIBILITY_MODE=legacy"), "COMPATIBILITY_MODE=legacy");
  });

  // 주의: 산문의 "Bearer <단어>" 과잉 마스킹은 **의도된 보수적 선택**이며 위
  // "conservative: over-masking …" 케이스가 이미 고정하고 있다. 여기서 되돌리지
  // 말 것 — 오탐(진단 문구 손실)보다 미탐(토큰 유출)이 훨씬 비싸다는 판단이다.
  // PATH= 계열만이 되돌릴 가치가 있는 오탐이었다 (비밀이 아님이 확실하므로).

  test("진짜 PAT 키는 계속 마스킹된다", () => {
    for (const s of ["PAT=abc123", "GITHUB_PAT=abc123", "PAT_TOKEN=abc123", "JIRA_API_TOKEN=abc123"]) {
      assert.match(redactSecrets(s), /\*\*\*REDACTED\*\*\*/, s);
    }
  });
});

describe("redactSecrets — 선형 시간 (검토 회귀: ReDoS)", () => {
  test("Authorization 헤더 뒤 긴 공백 런에서 O(n²) 백트래킹이 없다", () => {
    // redactAndTruncate 는 truncate 전에 전체 입력에 redactSecrets 를 돌린다.
    // 긴 stderr/이벤트 문자열이 그대로 통과하므로 병리적 입력이 실행될 수 있다.
    // 종전 인접 \s* 이중화는 40k 입력에서 ~4s 였다.
    const s = "authorization: " + " ".repeat(20000) + "!";
    const t0 = process.hrtime.bigint();
    redactSecrets(s);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `${ms.toFixed(0)}ms — 2차 백트래킹 의심 (선형이면 <1ms)`);
  });

  test("신규 패턴(URL 자격증명·PEM·curl -u)도 선형이다", () => {
    for (const s of [
      "https://u:" + "x".repeat(20000) + "@h/r",
      "-----BEGIN X PRIVATE KEY-----\n" + "A".repeat(20000) + "\n-----END X PRIVATE KEY-----",
    ]) {
      const t0 = process.hrtime.bigint();
      redactSecrets(s);
      assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200);
    }
  });
});
