import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeVerdictHash } from "../dist/verdict-hash.js";

describe("computeVerdictHash — findings-based normalization", () => {
  test("same findings items in different order → same hash", () => {
    const a = JSON.stringify({
      verdict: "REJECTED",
      stage: "3_delivery.pr",
      findings: [
        { severity: "HIGH", item: "draft_url_missing", evidence: "attempt 1 details" },
        { severity: "high", item: "self_check_missing", evidence: "unique text A" },
        { severity: "medium", item: "body_validation_missing" },
      ],
    });
    const b = JSON.stringify({
      verdict: "rejected",
      stage: "3_delivery.pr",
      findings: [
        { severity: "medium", item: "body_validation_missing" },
        { severity: "HIGH", item: "self_check_missing", evidence: "unique text B — different!" },
        { severity: "high", item: "draft_url_missing", evidence: "attempt 2 details — different!" },
      ],
    });
    assert.equal(
      computeVerdictHash(a, "3_delivery.pr"),
      computeVerdictHash(b, "3_delivery.pr"),
      "identical item set (case/order-insensitive) must produce identical hash even when evidence text differs",
    );
  });

  test("different findings items → different hash", () => {
    const a = JSON.stringify({
      verdict: "REJECTED",
      stage: "3_delivery.pr",
      findings: [
        { severity: "high", item: "draft_url_missing" },
        { severity: "high", item: "self_check_missing" },
      ],
    });
    const b = JSON.stringify({
      verdict: "REJECTED",
      stage: "3_delivery.pr",
      findings: [
        { severity: "high", item: "draft_url_missing" },
        { severity: "high", item: "reviewer_marker_missing" },
      ],
    });
    assert.notEqual(
      computeVerdictHash(a, "3_delivery.pr"),
      computeVerdictHash(b, "3_delivery.pr"),
    );
  });

  test("different stage → different hash even for identical findings", () => {
    const raw = JSON.stringify({
      verdict: "REJECTED",
      findings: [{ severity: "high", item: "done_missing" }],
    });
    assert.notEqual(
      computeVerdictHash(raw, "3_delivery.pr"),
      computeVerdictHash(raw, "3_delivery.commit"),
    );
  });

  test("verifier output with fenced json block → parsed correctly", () => {
    const raw = "<verifier-verdict>REJECTED</verifier-verdict>\n" +
      "```json\n" +
      JSON.stringify({
        verdict: "REJECTED",
        stage: "3_delivery.pr",
        findings: [{ severity: "high", item: "draft_url_missing" }],
      }) +
      "\n```\nSome trailing narrative.";
    const raw2 = "<verifier-verdict>REJECTED</verifier-verdict>\n" +
      "```json\n" +
      JSON.stringify({
        verdict: "REJECTED",
        stage: "3_delivery.pr",
        findings: [{ severity: "high", item: "draft_url_missing" }],
      }) +
      "\n```\nCompletely different trailing narrative here.";
    assert.equal(
      computeVerdictHash(raw, "3_delivery.pr"),
      computeVerdictHash(raw2, "3_delivery.pr"),
      "trailing narrative outside the JSON block must not affect the hash",
    );
  });

  test("malformed json → falls back to slice(800) hash (still stable)", () => {
    const raw = "REJECTED: this is not JSON at all, just narrative text " +
      "explaining the failure in prose form. ".repeat(20);
    const h1 = computeVerdictHash(raw, "3_delivery.pr");
    const h2 = computeVerdictHash(raw, "3_delivery.pr");
    assert.equal(h1, h2, "fallback path must still be deterministic");
    assert.equal(h1.length, 16);
  });

  test("empty findings array → still hashable (all-null marker state)", () => {
    const raw = JSON.stringify({ verdict: "REJECTED", stage: "3_delivery.pr", findings: [] });
    const h = computeVerdictHash(raw, "3_delivery.pr");
    assert.equal(h.length, 16);
  });

  test("sub_agent_output snippet difference does NOT change hash (real PROJ-40406 scenario)", () => {
    const mkVerdict = (subAgentSnippet) => JSON.stringify({
      verdict: "REJECTED",
      stage: "3_delivery.pr",
      findings: [
        { severity: "high", item: "self_check_missing" },
        { severity: "high", item: "draft_url_missing" },
        { severity: "high", item: "body_validation_missing" },
        { severity: "high", item: "reviewer_marker_missing" },
        { severity: "high", item: "done_missing" },
        { severity: "high", item: "sub_agent.empty_output", evidence: subAgentSnippet },
      ],
    });
    const attempt1 = mkVerdict("qwen produced only preamble text after 2 tools");
    const attempt2 = mkVerdict("Claude produced 6 tool calls but ended with short preamble '좋습니다! 이제 PR 본문을...'");
    const attempt3 = mkVerdict("Claude produced 9 tool calls including works_jira_getIssue but same short preamble");
    const h1 = computeVerdictHash(attempt1, "3_delivery.pr");
    const h2 = computeVerdictHash(attempt2, "3_delivery.pr");
    const h3 = computeVerdictHash(attempt3, "3_delivery.pr");
    assert.equal(h1, h2);
    assert.equal(h2, h3);
  });

  test("progress across attempts (one item resolved) → hash changes → streak resets", () => {
    const attempt1 = JSON.stringify({
      verdict: "REJECTED",
      stage: "3_delivery.pr",
      findings: [
        { severity: "high", item: "self_check_missing" },
        { severity: "high", item: "draft_url_missing" },
        { severity: "high", item: "done_missing" },
      ],
    });
    const attempt2 = JSON.stringify({
      verdict: "REJECTED",
      stage: "3_delivery.pr",
      findings: [
        { severity: "high", item: "draft_url_missing" },
        { severity: "high", item: "done_missing" },
      ],
    });
    assert.notEqual(
      computeVerdictHash(attempt1, "3_delivery.pr"),
      computeVerdictHash(attempt2, "3_delivery.pr"),
      "resolving one item must produce a different hash so the streak counter resets and progress is recognized",
    );
  });
});
