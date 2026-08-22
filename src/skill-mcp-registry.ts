// skill-mcp-registry.ts — mcp_name → skill_name 매핑 스캐너.
//
// 배경
// ----
// 이 프로젝트의 skill 은 SKILL.md frontmatter 에 MCP 서버를 embedded 로 선언한다
// (lazy-load 아키텍처). skill 이 실제로 `skill(name="...")` 로 로드되기 전에는
// 해당 MCP 서버가 세션에 스폰되지 않는다.
//
// 사용자(막둥이 에이전트)가 순서 강제 문구를 놓치고 `skill_mcp(mcp_name="works", ...)`
// 를 먼저 호출하면 opencode 가 "MCP server not found" 로 튕기지만, 그 에러
// 메시지는 어떤 skill 을 로드해야 하는지 명시하지 않는다.
//
// 이 모듈은 install 된 skills 디렉토리를 스캔해 frontmatter 의 `mcp:` 블록에서
// 서버 이름을 추출하고, `mcp_name → skill_name` 룩업 테이블을 만든다.
// tool.execute.before / .after 훅이 이 테이블로 사용자에게 정확한 skill 이름을
// 지시하는 에러를 낼 수 있게 한다.
//
// 파서는 최소 구현으로 유지한다 — SKILL.md frontmatter 는
// name / description / mcp / temperature / tools 등 얕은 구조만 사용하며,
// YAML full spec 을 의존성으로 도입할 필요가 없다.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillMcpEntry {
  /** skill 디렉토리 이름 (SKILL.md 의 name 필드와 동일해야 함). */
  skillName: string;
  /** frontmatter mcp: 블록에서 선언된 MCP 서버 이름들. */
  mcpNames: readonly string[];
  /** 원본 SKILL.md 절대 경로 (디버깅용). */
  path: string;
}

export interface SkillMcpRegistry {
  /** mcp_name → 이 MCP를 embedded 로 선언한 skill 이름 (첫 번째 매칭). */
  readonly byMcp: ReadonlyMap<string, string>;
  /** skill_name → SkillMcpEntry. */
  readonly bySkill: ReadonlyMap<string, SkillMcpEntry>;
  /** 스캔한 skills 루트 경로 (디버깅용). */
  readonly root: string;
}

/**
 * SKILL.md 하나에서 frontmatter 를 추출한다. `---` 로 감싼 YAML 프론트매터가
 * 없으면 null 을 반환한다.
 *
 * 파서는 다음 두 필드만 최소 파싱한다:
 *  - `name: <string>`
 *  - `mcp:` 하위의 최상위 키(들) — 각 키가 MCP 서버 이름
 *
 * 예시:
 * ```
 * ---
 * name: jira-research
 * mcp:
 *   works:
 *     command: bash
 *     args: ["./run-works.sh"]
 * ---
 * ```
 * → { name: "jira-research", mcpNames: ["works"] }
 */
export function parseSkillFrontmatter(src: string): { name?: string; mcpNames: string[] } | null {
  // frontmatter 는 파일 시작의 `---` 로 감싸진 첫 블록.
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const front = m[1];
  const lines = front.split(/\r?\n/);

  let name: string | undefined;
  const mcpNames: string[] = [];
  let inMcp = false;
  let mcpIndent = -1;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    // 최상위 name: <value>
    const topLevel = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    // 들여쓰기 계산 (leading spaces 개수).
    const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;

    if (inMcp) {
      // mcp: 블록 종료 조건 — indent 가 mcp 헤더보다 크지 않으면 블록 밖.
      if (indent <= mcpIndent) {
        inMcp = false;
      } else {
        // mcp: 블록 안. mcpIndent + 2 (표준 YAML 2-space 들여쓰기) 정확히
        // 매칭되는 라인만 서버 이름 후보. 더 깊은 들여쓰기는 서버의 하위 옵션.
        if (indent === mcpIndent + 2) {
          const kv = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/);
          if (kv) mcpNames.push(kv[1]);
        }
        continue;
      }
    }

    if (!inMcp && indent === 0 && topLevel) {
      const key = topLevel[1];
      const value = topLevel[2].trim();
      if (key === "name" && value) {
        name = value.replace(/^["']|["']$/g, "");
      } else if (key === "mcp" && value === "") {
        inMcp = true;
        mcpIndent = indent;
      }
    }
  }

  return { name, mcpNames };
}

/**
 * `skillsRoot` 하위의 SKILL.md 를 모두 스캔해 registry 를 만든다.
 *
 * 디렉토리가 없거나 접근 불가면 빈 registry 를 반환한다 (fail-open).
 * 훅 로직은 registry 가 비어 있으면 정보성 힌트를 생략하고 opencode 기본
 * 에러를 그대로 전달한다.
 */
export function scanSkillMcpRegistry(skillsRoot: string): SkillMcpRegistry {
  const byMcp = new Map<string, string>();
  const bySkill = new Map<string, SkillMcpEntry>();

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return { byMcp, bySkill, root: skillsRoot };
  }

  for (const dirName of entries) {
    const skillPath = join(skillsRoot, dirName);
    let s;
    try {
      s = statSync(skillPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;

    const mdPath = join(skillPath, "SKILL.md");
    let src: string;
    try {
      src = readFileSync(mdPath, "utf8");
    } catch {
      continue; // SKILL.md 없는 디렉토리는 스킵.
    }

    const parsed = parseSkillFrontmatter(src);
    if (!parsed) continue;

    // frontmatter 의 name 필드가 있으면 그것을, 없으면 디렉토리명을 사용.
    // opencode 는 skill(name=...) 호출 시 SKILL.md name 필드를 정본으로 삼는다.
    const skillName = parsed.name || dirName;

    const entry: SkillMcpEntry = {
      skillName,
      mcpNames: parsed.mcpNames,
      path: mdPath,
    };
    bySkill.set(skillName, entry);

    for (const mcp of parsed.mcpNames) {
      // 첫 번째 매칭 skill 만 등록. 동일 mcp_name 을 여러 skill 이 선언하면
      // 뒤에 오는 것은 무시하고 경고성 로그는 훅 쪽에서 처리.
      if (!byMcp.has(mcp)) byMcp.set(mcp, skillName);
    }
  }

  return { byMcp, bySkill, root: skillsRoot };
}

/**
 * skill_mcp 호출 인자에서 mcp_name 을 안전하게 추출한다.
 * 호출 형식은 { mcp_name: string, ... } 이며, 미제공이면 undefined.
 */
export function extractMcpName(args: unknown): string | undefined {
  if (args && typeof args === "object" && "mcp_name" in args) {
    const v = (args as { mcp_name?: unknown }).mcp_name;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * opencode 가 반환하는 "MCP server ... not found" 에러 문자열을 감지한다.
 * 정확한 문구는 opencode 버전에 따라 달라질 수 있으므로 관용적으로 매칭한다.
 */
export function looksLikeMcpNotFound(output: string): boolean {
  if (!output) return false;
  // "MCP server \"works\" not found" / "MCP server 'works' not found" /
  // "MCP server works not found" 모두 커버.
  return /MCP\s+server\s+["']?[A-Za-z0-9_.-]+["']?\s+not\s+found/i.test(output);
}

// "Failed to connect to MCP server \"works\"." / "MCP error -32000: Connection closed" 패턴.
// opencode 가 embedded MCP 프로세스 종료(exit non-zero) 시 반환하는 문구.
export function looksLikeMcpConnectionFailed(output: string): boolean {
  if (!output) return false;
  return (
    /Failed\s+to\s+connect\s+to\s+MCP\s+server/i.test(output) ||
    /MCP\s+error\s+-32000[^:]*:\s*Connection\s+closed/i.test(output)
  );
}
