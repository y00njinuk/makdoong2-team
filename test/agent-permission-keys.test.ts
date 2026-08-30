// test/agent-permission-keys.test.ts — 에이전트 frontmatter 의 permission 규칙이
// 런타임에서 **실제로 평가되는 형태**인지 고정한다.
//
// ── 배경 ──
// analyzer / publisher / researcher / issue-reporter 는 `permission.write` 블록으로
// 쓰기 범위를 제한하고 있었다. 그런데 그 블록은 **한 번도 평가되지 않았다.**
// opencode 1.18 바이너리에서 확인한 사실 두 가지:
//
//   1. permission 설정 스키마의 키 집합에 `write` 가 없다. 정식 키는 `edit` 이다.
//      (read / edit / glob / grep / list / bash / task / external_directory /
//       todowrite / question / webfetch / websearch / lsp / doom_loop / skill)
//      스키마가 StructWithRest 라 모르는 키도 **에러 없이 통과**한다 — 그래서
//      오타처럼 드러나지 않고 조용히 무시됐다.
//   2. write / edit / apply_patch 툴은 전부 `ask({permission: "edit", …})` 로 묻는다.
//
//   => `write:` 로 적은 규칙은 매칭 대상이 없어 기본값 `{action:"ask"}` 로 떨어지고,
//      그 ask 는 플러그인의 permission 자동 승인(worktree scope 안이면 approve)이
//      받아버린다. 즉 **쓰기 제한이 전혀 걸려 있지 않았다.**
//
// 그리고 규칙 평가는 `findLast` 다:
//     evaluate(perm, resource, ...rulesets) =
//       rulesets.flat().findLast(r => match(perm, r.permission) && match(resource, r.pattern))
//         ?? { action: "ask" }
// 규칙 목록은 설정 객체의 **키 순서 그대로** 만들어지므로(fromConfig), 마지막 매치가
// 이긴다 → **넓은 규칙을 위, 좁은 규칙을 아래**에 둬야 한다. `"**/*": "deny"` 를
// 맨 아래에 두면 위의 allow 를 전부 덮어쓴다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const AGENTS_DIR = join(REPO, "agents");

/** opencode 1.18 permission 설정 스키마가 인정하는 키. */
const KNOWN_PERMISSION_KEYS = new Set([
  "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory",
  "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill",
  "*",
]);

/** frontmatter 의 `permission:` 블록에서 (키 → [패턴, ...]) 을 뽑는다. */
function permissionBlocks(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "permission:");
  if (start < 0) return {};
  const out = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") break;
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const key = /^ {2}([a-z_*]+):\s*$/.exec(line);
    if (key) { current = key[1]; out[current] = []; continue; }
    const rule = /^ {4}"([^"]*)"\s*:\s*"(allow|deny|ask)"\s*$/.exec(line);
    if (rule && current) { out[current].push([rule[1], rule[2]]); continue; }
    if (/^ {2}\S/.test(line)) current = null; // 다른 2-space 항목 → 블록 종료
  }
  return out;
}

const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));

describe("agent frontmatter — permission 키가 실제로 평가되는 것인가", () => {
  test("`write:` 키를 쓰지 않는다 (스키마에 없어 조용히 무시된다)", () => {
    const offenders = [];
    for (const f of agentFiles) {
      const blocks = permissionBlocks(readFileSync(join(AGENTS_DIR, f), "utf8"));
      if ("write" in blocks) offenders.push(f);
    }
    assert.deepEqual(
      offenders, [],
      "`permission.write` 는 opencode 가 평가하지 않는다 — 정식 키는 `edit` 이다.\n" +
      "  write/edit/apply_patch 툴이 전부 permission:\"edit\" 으로 묻는다.",
    );
  });

  test("알 수 없는 permission 키가 없다", () => {
    const offenders = [];
    for (const f of agentFiles) {
      for (const key of Object.keys(permissionBlocks(readFileSync(join(AGENTS_DIR, f), "utf8")))) {
        if (!KNOWN_PERMISSION_KEYS.has(key)) offenders.push(`${f}: ${key}`);
      }
    }
    assert.deepEqual(offenders, [], "스키마가 StructWithRest 라 오타가 에러 없이 통과한다");
  });
});

describe("agent frontmatter — findLast 순서 (넓은 규칙이 위)", () => {
  test("전면 deny(`**/*` / `*`)가 더 좁은 allow 보다 아래에 오지 않는다", () => {
    const offenders = [];
    for (const f of agentFiles) {
      const blocks = permissionBlocks(readFileSync(join(AGENTS_DIR, f), "utf8"));
      for (const [key, rules] of Object.entries(blocks)) {
        const catchAllIdx = rules.findIndex(([pat]) => pat === "**/*" || pat === "*");
        if (catchAllIdx < 0) continue;
        const narrowerAfter = rules.slice(catchAllIdx + 1).length;
        const narrowerBefore = rules.slice(0, catchAllIdx).length;
        // 전면 규칙 **뒤에** 좁은 규칙이 오는 것이 올바르다 (findLast).
        // 전면 규칙이 마지막인데 그 앞에 좁은 규칙이 있으면 그것들은 전부 죽는다.
        if (narrowerAfter === 0 && narrowerBefore > 0) {
          offenders.push(
            `${f} → permission.${key}: "${rules[catchAllIdx][0]}" 가 마지막이라 ` +
            `앞의 규칙 ${narrowerBefore}개가 전부 무효다`,
          );
        }
      }
    }
    assert.deepEqual(offenders, [], "findLast 이므로 넓은 규칙을 위, 좁은 규칙을 아래에 둘 것");
  });

  test("analyzer / publisher 는 자기 산출물에 실제로 쓸 수 있다", () => {
    // 규칙 목록을 findLast 로 직접 평가해 최종 action 을 확인한다.
    const evaluate = (rules, resource) => {
      const globToRe = (g) =>
        new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "(?:.*/)?")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") + "$");
      const hit = [...rules].reverse().find(([pat]) => globToRe(pat).test(resource));
      return hit ? hit[1] : "ask";
    };
    const cases = [
      ["makdoong2-analyzer.md", ".makdoong2-team/PROJ-1/workspace-analysis.json"],
      ["makdoong2-publisher.md", ".makdoong2-team/PROJ-1/change-report.md"],
    ];
    for (const [file, artifact] of cases) {
      const rules = permissionBlocks(readFileSync(join(AGENTS_DIR, file), "utf8")).edit ?? [];
      assert.equal(evaluate(rules, artifact), "allow",
        `${file}: 유일하게 허용된 산출물조차 쓸 수 없다 — ${artifact}`);
      assert.equal(evaluate(rules, "src/Main.scala"), "deny",
        `${file}: 산출물 밖 쓰기가 열려 있다`);
    }
  });
});

describe("publisher — 필수 산출물 2종을 모두 쓸 수 있다 (릴리즈 검토에서 잡힌 blocker)", () => {
  // publisher 의 산출물은 change-report.md (07-commit) 하나가 아니다 —
  // review-comment-plan.json (09-review §8-2) 은 stage8-post-review-verify 가
  // 존재를 하드 요구하는 필수 산출물이다. change-report 만 허용하면
  // 3_delivery.review 가 구조적으로 통과 불가능해진다. frontmatter(1차)와
  // 플러그인 ARTIFACT_RESTRICTED_AGENTS(2차) 두 층을 모두 고정한다.
  const PUB_ARTIFACTS = [
    ".makdoong2-team/PROJ-1/change-report.md",
    ".makdoong2-team/PROJ-1/review-comment-plan.json",
  ];
  const globToRe = (g) =>
    new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");

  test("frontmatter edit 규칙이 두 산출물을 허용한다", () => {
    const rules = permissionBlocks(
      readFileSync(join(AGENTS_DIR, "makdoong2-publisher.md"), "utf8"),
    ).edit ?? [];
    const evaluate = (res) =>
      ([...rules].reverse().find(([pat]) => globToRe(pat).test(res)) ?? [null, "ask"])[1];
    for (const a of PUB_ARTIFACTS) {
      assert.equal(evaluate(a), "allow", `frontmatter 가 ${a} 를 막는다`);
    }
    assert.equal(evaluate("src/Main.scala"), "deny");
  });

  test("플러그인 2차 방어 패턴이 두 산출물을 허용한다", () => {
    const src = readFileSync(join(REPO, "src", "opencode-plugin.ts"), "utf8");
    // 정규식 리터럴 안에 [^/] 처럼 이스케이프 없는 / 가 들어 있으므로 비탐욕
    // 매칭으로는 잘린다 — 줄을 찾은 뒤 첫 `/` 와 마지막 `/` 사이를 취한다.
    const line = src.split("\n").find(
      (l) => l.includes('["makdoong2-publisher",') && l.trimEnd().endsWith("$/],"),
    );
    assert.ok(line, "ARTIFACT_RESTRICTED_AGENTS 의 publisher 항목을 찾지 못했다");
    const body = line.slice(line.indexOf(", /") + 3, line.lastIndexOf("/"));
    const re = new RegExp(body);
    for (const a of PUB_ARTIFACTS) {
      assert.ok(re.test(a), `플러그인 패턴이 ${a} 를 막는다: /${body}/`);
    }
    assert.ok(!re.test(".makdoong2-team/PROJ-1/state.json"), "state.json 은 계속 차단");
  });
});

describe("frontmatter 가 엄격 YAML 파서로 파싱된다", () => {
  // publisher 의 description 이 인용 없는 `: ` 를 담고 있어 엄격 파서가
  // "Nested mappings are not allowed in compact mappings" 로 실패했다.
  // 파서가 실패하면 permission 규칙 전체가 유실될 수 있는 위치라, 파서 유무와
  // 무관하게 위험 패턴 자체를 금지한다: description 값은 인용됐거나 `: ` 무포함.
  test("description 값에 인용 없는 ': ' 가 없다", () => {
    const offenders = [];
    for (const f of agentFiles) {
      const text = readFileSync(join(AGENTS_DIR, f), "utf8");
      const m = /^description:\s*(.*)$/m.exec(text.slice(0, text.indexOf("\n---", 4)));
      if (!m) continue;
      const v = m[1];
      const quoted = /^["']/.test(v);
      if (!quoted && /:\s/.test(v)) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      "인용 없는 ': ' 는 엄격 YAML 파서를 실패시킨다 — 값을 따옴표로 감쌀 것");
  });
});
