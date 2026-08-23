// research-fanout.ts — pure helpers for the parallel multi-source research fan-out.
//
// Why a separate module: the opencode plugin loader calls EVERY named export of
// the entry file as a plugin factory (see ARCHITECTURE.md §2). New helpers must
// live outside opencode-plugin.ts and be imported. `test/plugin-exports-shape.test.mjs`
// pins the entry file's export set.
//
// Everything here is deterministic and side-effect free so the fan-out contract
// (source registry, query normalisation, output parsing, merge) is unit-testable
// without spawning sessions.

/** Research sources backed by a lazy-loaded MCP skill. */
export type ResearchSource = "jira" | "confluence" | "bitbucket" | "github-oss";

export interface ResearchSourceSpec {
  source: ResearchSource;
  /** `skill(name=…)` — MUST be loaded before the MCP call (lazy-load, ARCHITECTURE.md §4.4). */
  skill: string;
  /**
   * `skill_mcp(mcp_name=…)` for sources whose SKILL.md declares an embedded MCP.
   * `null` for skills that carry no MCP of their own (github-oss-research works
   * through WebFetch / site-wide chrome-devtools-mcp) — the prompt branches on this.
   */
  mcp: string | null;
  /** Korean label used in prompts and the merged artifact. */
  label: string;
  /** What this source is good for — injected into the research prompt. */
  scope: string;
}

export const RESEARCH_SOURCES: Record<ResearchSource, ResearchSourceSpec> = {
  jira: {
    source: "jira",
    skill: "jira-research",
    mcp: "works",
    label: "Jira",
    scope: "에픽·상위 이슈·링크 이슈·서브태스크·코멘트에서 구체화된 요구사항과 결정 사항",
  },
  confluence: {
    source: "confluence",
    skill: "confluence-research",
    mcp: "docs",
    label: "Confluence",
    scope: "설계 문서·ADR·API 스펙·운영 가이드에서 지켜야 할 제약과 합의된 규약",
  },
  bitbucket: {
    source: "bitbucket",
    skill: "bitbucket-research",
    mcp: "repos",
    label: "Bitbucket",
    scope: "수정 대상 파일·클래스의 현재 구현, 관련 PR 이력, 기존 테스트 패턴",
  },
  "github-oss": {
    source: "github-oss",
    skill: "github-oss-research",
    // SKILL.md 에 embedded MCP 선언이 없다 — WebFetch / site-wide chrome-devtools-mcp 사용.
    mcp: null,
    label: "GitHub OSS",
    scope: "외부 오픈소스 라이브러리의 사용 예시·알려진 이슈·업스트림 변경",
  },
};

/** Hard ceiling on simultaneously spawned research sessions, regardless of config. */
export const MAX_RESEARCH_PARALLEL = 6;
/** Default when `research.max_parallel` is unset. */
export const DEFAULT_RESEARCH_PARALLEL = 3;
/** Default per-source wall-clock budget when `research.timeout_minutes` is unset. */
export const DEFAULT_RESEARCH_TIMEOUT_MINUTES = 10;
/** Focus text longer than this is truncated before it reaches the prompt. */
export const MAX_FOCUS_CHARS = 600;
/** Per-source cap on findings kept in the merged artifact. */
export const MAX_FINDINGS_PER_SOURCE = 20;

export interface ResearchQueryInput {
  source?: unknown;
  focus?: unknown;
}

export interface NormalizedQuery {
  spec: ResearchSourceSpec;
  focus: string;
}

export interface RejectedQuery {
  source: string;
  reason: string;
}

export interface NormalizeResult {
  queries: NormalizedQuery[];
  rejected: RejectedQuery[];
  /** Queries dropped because they exceeded the parallel cap (reported, never silent). */
  deferred: RejectedQuery[];
}

export function resolveResearchSource(name: unknown): ResearchSourceSpec | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  return (RESEARCH_SOURCES as Record<string, ResearchSourceSpec>)[key] ?? null;
}

/** Clamp the configured parallelism into [1, MAX_RESEARCH_PARALLEL]. */
export function resolveParallelism(configured: unknown): number {
  const n = typeof configured === "number" && Number.isFinite(configured)
    ? Math.round(configured)
    : DEFAULT_RESEARCH_PARALLEL;
  return Math.min(MAX_RESEARCH_PARALLEL, Math.max(1, n));
}

/**
 * Validate + de-duplicate the caller's queries.
 *
 * Rules:
 *  - unknown source → rejected (the caller mistyped; failing loudly beats a silent no-op)
 *  - empty focus → rejected
 *  - same (source, focus) twice → the duplicate is rejected
 *  - more than `limit` survivors → the tail is DEFERRED, never silently dropped
 */
export function normalizeQueries(raw: unknown, limit: number): NormalizeResult {
  const queries: NormalizedQuery[] = [];
  const rejected: RejectedQuery[] = [];
  const deferred: RejectedQuery[] = [];

  if (!Array.isArray(raw) || raw.length === 0) {
    return { queries, rejected: [{ source: "(none)", reason: "queries 배열이 비어 있다" }], deferred };
  }

  const seen = new Set<string>();
  for (const item of raw as ResearchQueryInput[]) {
    const rawSource = typeof item?.source === "string" ? item.source : String(item?.source ?? "");
    const spec = resolveResearchSource(item?.source);
    if (!spec) {
      rejected.push({
        source: rawSource || "(unset)",
        reason: `알 수 없는 source. 허용: ${Object.keys(RESEARCH_SOURCES).join(", ")}`,
      });
      continue;
    }
    const focus = typeof item?.focus === "string" ? item.focus.trim() : "";
    if (!focus) {
      rejected.push({ source: spec.source, reason: "focus 가 비어 있다" });
      continue;
    }
    const key = `${spec.source}::${focus.toLowerCase()}`;
    if (seen.has(key)) {
      rejected.push({ source: spec.source, reason: "동일 source+focus 중복" });
      continue;
    }
    seen.add(key);
    queries.push({ spec, focus: focus.slice(0, MAX_FOCUS_CHARS) });
  }

  if (queries.length > limit) {
    for (const q of queries.slice(limit)) {
      deferred.push({ source: q.spec.source, reason: `병렬 상한 ${limit} 초과 — 이번 라운드에서 제외` });
    }
    queries.length = limit;
  }

  return { queries, rejected, deferred };
}

export interface ResearchPromptContext {
  issue: string;
  scriptsDir: string;
  worktree: string;
  /** Optional extra context from the caller (e.g. the Jira summary). */
  context?: string;
}

/**
 * Prompt for one research sub-session.
 *
 * The session is deliberately narrow: one source, one focus, fixed output schema.
 * That is what makes the fan-out worth its cost — each session's context holds
 * only its own source's material instead of all three (DESIGN.md §3.7).
 */
export function buildResearchPrompt(q: NormalizedQuery, ctx: ResearchPromptContext): string {
  const lines = [
    `Issue: ${ctx.issue}`,
    `Working directory (ABSOLUTE): ${ctx.worktree}`,
    `Scripts directory (ABSOLUTE): ${ctx.scriptsDir}`,
    `Research source: ${q.spec.label} (${q.spec.source})`,
    "",
    `당신은 **${q.spec.label} 한 곳만** 조사하는 리서치 막둥이다. 다른 소스는 조사하지 않는다.`,
    "",
    "## 조사 지시",
    "",
    `1. **가장 먼저** \`skill(name="${q.spec.skill}")\` 로 스킬을 세션에 로드한다.`,
    ...(q.spec.mcp
      ? [
          `   로드 전에 \`skill_mcp\` 를 부르면 \`MCP server "${q.spec.mcp}" not found\` 로 실패한다.`,
          `2. \`skill_mcp(mcp_name="${q.spec.mcp}", ...)\` 로 아래 focus 를 조사한다.`,
        ]
      : [
          "   이 스킬은 전용 MCP 가 없다. SKILL.md 의 절차대로 WebFetch / chrome-devtools-mcp 를 사용한다.",
          "2. 위 수단으로 아래 focus 를 조사한다.",
        ]),
    `3. 조사 범위: ${q.spec.scope}`,
    "",
    "## Focus",
    "",
    q.focus,
    "",
    "## 출력 형식 (엄수)",
    "",
    "마지막 assistant turn 에 아래 스키마의 JSON 을 ```json 펜스로 감싸 **하나만** 출력한다.",
    "펜스 밖 설명 문장은 자유지만, JSON 블록은 정확히 하나여야 한다.",
    "",
    "```json",
    "{",
    `  "source": "${q.spec.source}",`,
    '  "findings": [',
    '    {"title": "<한 줄 제목>", "detail": "<300자 이내 요약>", "url": "<출처 URL 또는 null>"}',
    "  ],",
    '  "gaps": ["<이 소스에서 확인하지 못한 항목>"]',
    "}",
    "```",
    "",
    "## 규약",
    "",
    "- **읽기 전용.** 파일 생성·수정, state.json 조작, git 명령을 일절 수행하지 않는다.",
    "- 조사 결과가 없으면 `findings: []` 로 두고 `gaps` 에 이유를 적는다. 추측으로 채우지 않는다.",
    "- 근거가 있는 항목에만 `url` 을 넣는다. 지어내지 않는다.",
    `- findings 는 최대 ${MAX_FINDINGS_PER_SOURCE}개. 중요도 순으로 자른다.`,
  ];
  if (ctx.context) {
    lines.push("", "## 추가 컨텍스트", "", ctx.context);
  }
  return lines.join("\n");
}

export interface ResearchFinding {
  title: string;
  detail: string;
  url: string | null;
}

export interface ParsedResearch {
  findings: ResearchFinding[];
  gaps: string[];
}

export type ParseResult =
  | { ok: true; data: ParsedResearch }
  | { ok: false; reason: string };

/**
 * Pull the research JSON out of an LLM turn.
 *
 * Order matters: prefer the LAST fenced ```json block (models often show a draft
 * before the final answer), then fall back to a balanced brace scan. A parse
 * failure is reported, never coerced into an empty-but-successful result — a
 * silently empty source reads as "nothing to find" when it means "nothing parsed".
 */
export function parseResearchOutput(raw: unknown): ParseResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "빈 응답" };
  }

  const candidates: string[] = [];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(raw)) !== null) candidates.push(m[1]);
  candidates.reverse(); // last fenced block first

  const braced = extractBalancedObject(raw);
  if (braced) candidates.push(braced);

  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (!("findings" in obj) && !("gaps" in obj)) continue;
    return { ok: true, data: coerceParsed(obj) };
  }

  return { ok: false, reason: "JSON 블록을 찾지 못했다 (findings/gaps 키 부재)" };
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function coerceParsed(obj: Record<string, unknown>): ParsedResearch {
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: ResearchFinding[] = [];
  for (const f of rawFindings.slice(0, MAX_FINDINGS_PER_SOURCE)) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title) continue;
    findings.push({
      title,
      detail: typeof r.detail === "string" ? r.detail.trim() : "",
      url: typeof r.url === "string" && r.url.trim() !== "" ? r.url.trim() : null,
    });
  }
  const gaps = (Array.isArray(obj.gaps) ? obj.gaps : [])
    .filter((g): g is string => typeof g === "string" && g.trim() !== "")
    .map((g) => g.trim());
  return { findings, gaps };
}

export interface SourceOutcome {
  source: ResearchSource;
  label: string;
  focus: string;
  status: "ok" | "failed";
  findings: ResearchFinding[];
  gaps: string[];
  error: string | null;
  session_id: string | null;
  elapsed_ms: number;
}

export interface ResearchFindingsArtifact {
  issue: string;
  generated_at: string;
  sources: SourceOutcome[];
  rejected: RejectedQuery[];
  deferred: RejectedQuery[];
  counts: { requested: number; ok: number; failed: number; findings_total: number };
}

/**
 * Merge per-source outcomes into the artifact a gate can check deterministically.
 *
 * `rejected` / `deferred` are carried into the artifact on purpose: a fan-out that
 * quietly covered 2 of 3 sources looks identical to one that covered all 3 unless
 * the shortfall is written down.
 */
export function mergeResearchFindings(
  issue: string,
  generatedAt: string,
  outcomes: SourceOutcome[],
  rejected: RejectedQuery[],
  deferred: RejectedQuery[],
): ResearchFindingsArtifact {
  const ok = outcomes.filter((o) => o.status === "ok").length;
  return {
    issue,
    generated_at: generatedAt,
    sources: outcomes,
    rejected,
    deferred,
    counts: {
      requested: outcomes.length + rejected.length + deferred.length,
      ok,
      failed: outcomes.length - ok,
      findings_total: outcomes.reduce((n, o) => n + o.findings.length, 0),
    },
  };
}

/** Human-readable one-liner per source for the tool's text return. */
export function summarizeOutcomes(outcomes: SourceOutcome[]): string[] {
  return outcomes.map((o) =>
    o.status === "ok"
      ? `${o.label}: findings ${o.findings.length}건, gaps ${o.gaps.length}건 (${Math.round(o.elapsed_ms / 1000)}s)`
      : `${o.label}: 실패 — ${o.error ?? "unknown"} (${Math.round(o.elapsed_ms / 1000)}s)`,
  );
}
