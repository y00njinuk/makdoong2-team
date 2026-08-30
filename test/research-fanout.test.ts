/**
 * Regression tests for the parallel multi-source research fan-out contract
 * (src/research-fanout.ts, consumed by the dispatch_research tool).
 *
 * The tool itself needs a live opencode server, so what is pinned here is the
 * deterministic half: which sources exist, how queries are normalised, how a
 * model's messy output is parsed, and how partial failures survive the merge.
 * Those are exactly the places where a silent regression would look like
 * "the research just didn't find anything".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/research-fanout.js");
const {
  RESEARCH_SOURCES,
  MAX_RESEARCH_PARALLEL,
  DEFAULT_RESEARCH_PARALLEL,
  MAX_FINDINGS_PER_SOURCE,
  resolveResearchSource,
  resolveParallelism,
  normalizeQueries,
  buildResearchPrompt,
  parseResearchOutput,
  mergeResearchFindings,
  summarizeOutcomes,
} = mod;

const ctx = {
  issue: "PROJ-1",
  scriptsDir: "/abs/scripts",
  worktree: "/abs/wt",
};

describe("research source registry", () => {
  it("registers the four planner research skills", () => {
    assert.deepEqual(
      Object.keys(RESEARCH_SOURCES).sort(),
      ["bitbucket", "confluence", "github-oss", "jira"],
    );
  });

  it("maps each source to the skill name that must be loaded first", () => {
    assert.equal(RESEARCH_SOURCES.jira.skill, "jira-research");
    assert.equal(RESEARCH_SOURCES.confluence.skill, "confluence-research");
    assert.equal(RESEARCH_SOURCES.bitbucket.skill, "bitbucket-research");
    assert.equal(RESEARCH_SOURCES["github-oss"].skill, "github-oss-research");
  });

  it("uses the embedded MCP server names declared in each SKILL.md frontmatter", () => {
    assert.equal(RESEARCH_SOURCES.jira.mcp, "works");
    assert.equal(RESEARCH_SOURCES.confluence.mcp, "docs");
    assert.equal(RESEARCH_SOURCES.bitbucket.mcp, "repos");
  });

  it("marks github-oss as MCP-less — its SKILL.md declares no embedded MCP", () => {
    // Regression guard: an invented mcp_name here would make every github-oss
    // research session fail with `MCP server not found`.
    assert.equal(RESEARCH_SOURCES["github-oss"].mcp, null);
  });

  it("resolves source names case-insensitively and rejects unknown ones", () => {
    assert.equal(resolveResearchSource("JIRA")?.source, "jira");
    assert.equal(resolveResearchSource("  bitbucket ")?.source, "bitbucket");
    assert.equal(resolveResearchSource("slack"), null);
    assert.equal(resolveResearchSource(undefined), null);
    assert.equal(resolveResearchSource(42), null);
  });
});

describe("parallelism clamping", () => {
  it("defaults when unset and clamps into [1, MAX]", () => {
    assert.equal(resolveParallelism(undefined), DEFAULT_RESEARCH_PARALLEL);
    assert.equal(resolveParallelism("3"), DEFAULT_RESEARCH_PARALLEL);
    assert.equal(resolveParallelism(0), 1);
    assert.equal(resolveParallelism(-5), 1);
    assert.equal(resolveParallelism(999), MAX_RESEARCH_PARALLEL);
    assert.equal(resolveParallelism(2), 2);
  });
});

describe("query normalisation", () => {
  it("accepts the canonical three-source planning fan-out", () => {
    const r = normalizeQueries(
      [
        { source: "jira", focus: "에픽/링크 이슈" },
        { source: "confluence", focus: "설계 문서" },
        { source: "bitbucket", focus: "PR 이력" },
      ],
      3,
    );
    assert.equal(r.queries.length, 3);
    assert.equal(r.rejected.length, 0);
    assert.equal(r.deferred.length, 0);
  });

  it("rejects unknown sources and empty focus instead of silently skipping", () => {
    const r = normalizeQueries(
      [
        { source: "slack", focus: "무언가" },
        { source: "jira", focus: "   " },
        { source: "bitbucket", focus: "PR" },
      ],
      3,
    );
    assert.equal(r.queries.length, 1);
    assert.equal(r.rejected.length, 2);
    assert.match(r.rejected[0].reason, /알 수 없는 source/);
    assert.match(r.rejected[1].reason, /focus/);
  });

  it("drops duplicate source+focus pairs", () => {
    const r = normalizeQueries(
      [
        { source: "jira", focus: "같은 것" },
        { source: "jira", focus: "같은 것" },
      ],
      3,
    );
    assert.equal(r.queries.length, 1);
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /중복/);
  });

  it("keeps distinct focuses on the same source", () => {
    const r = normalizeQueries(
      [
        { source: "jira", focus: "에픽" },
        { source: "jira", focus: "링크 이슈" },
      ],
      3,
    );
    assert.equal(r.queries.length, 2);
    assert.equal(r.rejected.length, 0);
  });

  it("DEFERS the overflow past the parallel cap — never silently truncates", () => {
    // A silently dropped query reads as "that source found nothing".
    const r = normalizeQueries(
      [
        { source: "jira", focus: "a" },
        { source: "confluence", focus: "b" },
        { source: "bitbucket", focus: "c" },
        { source: "github-oss", focus: "d" },
      ],
      2,
    );
    assert.equal(r.queries.length, 2);
    assert.equal(r.deferred.length, 2);
    assert.deepEqual(r.deferred.map((d) => d.source), ["bitbucket", "github-oss"]);
    assert.match(r.deferred[0].reason, /병렬 상한/);
  });

  it("reports an empty/non-array queries argument as rejected", () => {
    for (const bad of [undefined, null, [], "jira", {}]) {
      const r = normalizeQueries(bad, 3);
      assert.equal(r.queries.length, 0, `input=${JSON.stringify(bad)}`);
      assert.equal(r.rejected.length, 1);
    }
  });
});

describe("research prompt", () => {
  it("orders skill load before the MCP call for MCP-backed sources", () => {
    const [q] = normalizeQueries([{ source: "jira", focus: "에픽 조사" }], 3).queries;
    const p = buildResearchPrompt(q, ctx);
    assert.ok(
      p.indexOf('skill(name="jira-research")') < p.indexOf('skill_mcp(mcp_name="works"'),
      "skill load instruction must precede the skill_mcp instruction (lazy-load order)",
    );
    assert.match(p, /MCP server "works" not found/);
  });

  it("does not tell an MCP-less source to call skill_mcp", () => {
    const [q] = normalizeQueries([{ source: "github-oss", focus: "라이브러리 이슈" }], 3).queries;
    const p = buildResearchPrompt(q, ctx);
    assert.ok(!p.includes("skill_mcp(mcp_name="), "github-oss has no embedded MCP to call");
    assert.match(p, /WebFetch/);
  });

  it("injects absolute paths and the issue key, plus optional shared context", () => {
    const [q] = normalizeQueries([{ source: "bitbucket", focus: "PR 이력" }], 3).queries;
    const p = buildResearchPrompt(q, { ...ctx, context: "공통 배경 문장" });
    assert.match(p, /Issue: PROJ-1/);
    assert.match(p, /Scripts directory \(ABSOLUTE\): \/abs\/scripts/);
    assert.match(p, /Working directory \(ABSOLUTE\): \/abs\/wt/);
    assert.match(p, /공통 배경 문장/);
    assert.match(p, /PR 이력/);
  });

  it("pins the fixed output schema so the parser and the prompt cannot drift apart", () => {
    const [q] = normalizeQueries([{ source: "confluence", focus: "ADR" }], 3).queries;
    const p = buildResearchPrompt(q, ctx);
    assert.match(p, /"findings"/);
    assert.match(p, /"gaps"/);
    assert.match(p, /```json/);
  });
});

describe("output parsing", () => {
  it("parses a fenced json block", () => {
    const raw = [
      "조사를 마쳤습니다.",
      "```json",
      '{"source":"jira","findings":[{"title":"T","detail":"D","url":"http://x"}],"gaps":[]}',
      "```",
    ].join("\n");
    const r = parseResearchOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.data.findings.length, 1);
    assert.equal(r.data.findings[0].url, "http://x");
  });

  it("prefers the LAST fenced block when a draft precedes the final answer", () => {
    const raw = [
      "```json",
      '{"findings":[{"title":"초안"}],"gaps":[]}',
      "```",
      "다시 정리하면:",
      "```json",
      '{"findings":[{"title":"최종"}],"gaps":[]}',
      "```",
    ].join("\n");
    const r = parseResearchOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.data.findings[0].title, "최종");
  });

  it("falls back to a balanced brace scan when the fence is missing", () => {
    const raw = '결과: {"findings":[{"title":"T","detail":"D"}],"gaps":["g"]} 끝.';
    const r = parseResearchOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.data.gaps[0], "g");
  });

  it("survives braces inside strings during the balance scan", () => {
    const raw = '{"findings":[{"title":"a{b}c","detail":"has \\" quote"}],"gaps":[]}';
    const r = parseResearchOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.data.findings[0].title, "a{b}c");
  });

  it("normalises empty url to null and drops findings without a title", () => {
    const raw = '{"findings":[{"title":"keep","url":"  "},{"detail":"no title"}],"gaps":[]}';
    const r = parseResearchOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.data.findings.length, 1);
    assert.equal(r.data.findings[0].url, null);
    assert.equal(r.data.findings[0].detail, "");
  });

  it("caps findings per source", () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_SOURCE + 10 }, (_, i) => ({ title: `t${i}` }));
    const r = parseResearchOutput(JSON.stringify({ findings: many, gaps: [] }));
    assert.equal(r.ok, true);
    assert.equal(r.data.findings.length, MAX_FINDINGS_PER_SOURCE);
  });

  it("FAILS rather than returning an empty success when nothing parses", () => {
    // An empty-but-ok result is indistinguishable from "the source had nothing",
    // which is the whole bug this guards against.
    for (const bad of ["", "   ", undefined, null, "설명만 있고 JSON 이 없다", "```json\n{not json}\n```"]) {
      const r = parseResearchOutput(bad);
      assert.equal(r.ok, false, `input=${JSON.stringify(bad)}`);
      assert.ok(r.reason.length > 0);
    }
  });

  it("rejects a JSON object that carries neither findings nor gaps", () => {
    const r = parseResearchOutput('{"summary":"조사했음"}');
    assert.equal(r.ok, false);
  });
});

describe("merge + summary", () => {
  const ok = (source, n) => ({
    source,
    label: source,
    focus: "f",
    status: "ok",
    findings: Array.from({ length: n }, (_, i) => ({ title: `${source}${i}`, detail: "", url: null })),
    gaps: [],
    error: null,
    session_id: `ses_${source}`,
    elapsed_ms: 1000,
  });
  const failed = (source) => ({
    source,
    label: source,
    focus: "f",
    status: "failed",
    findings: [],
    gaps: [],
    error: "인증 실패",
    session_id: null,
    elapsed_ms: 500,
  });

  it("counts ok/failed and totals findings", () => {
    const a = mergeResearchFindings("PROJ-1", "T", [ok("jira", 2), failed("confluence"), ok("bitbucket", 3)], [], []);
    assert.equal(a.counts.ok, 2);
    assert.equal(a.counts.failed, 1);
    assert.equal(a.counts.findings_total, 5);
    assert.equal(a.counts.requested, 3);
  });

  it("keeps a partial fan-out usable — failures do not erase the other sources", () => {
    const a = mergeResearchFindings("PROJ-1", "T", [failed("jira"), ok("bitbucket", 1)], [], []);
    assert.equal(a.counts.findings_total, 1);
    assert.equal(a.sources.find((s) => s.source === "jira").error, "인증 실패");
  });

  it("carries rejected/deferred into the artifact so shortfalls stay visible", () => {
    const rejected = [{ source: "slack", reason: "알 수 없는 source" }];
    const deferred = [{ source: "github-oss", reason: "병렬 상한 2 초과" }];
    const a = mergeResearchFindings("PROJ-1", "T", [ok("jira", 1)], rejected, deferred);
    assert.deepEqual(a.rejected, rejected);
    assert.deepEqual(a.deferred, deferred);
    // requested counts everything asked for, not just what ran
    assert.equal(a.counts.requested, 3);
  });

  it("summarises each source in one line, distinguishing ok from failed", () => {
    const lines = summarizeOutcomes([ok("jira", 2), failed("confluence")]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /findings 2건/);
    assert.match(lines[1], /실패 — 인증 실패/);
  });
});
