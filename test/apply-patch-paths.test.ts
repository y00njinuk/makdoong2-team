import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractApplyPatchPaths,
  isApplyPatchTool,
  parsePatchTargets,
} from "../src/apply-patch-paths.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const patch = (...body: string[]) =>
  ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

describe("parsePatchTargets — opencode 패치 형식", () => {
  test("Add File 경로를 뽑는다", () => {
    const r = parsePatchTargets(patch(
      "*** Add File: .makdoong2-team/PROJ-1/requirements-draft.md",
      "+# 요구사항",
    ));
    assert.deepEqual(r, { ok: true, paths: [".makdoong2-team/PROJ-1/requirements-draft.md"] });
  });

  test("Update / Delete 경로를 뽑는다", () => {
    const r = parsePatchTargets(patch(
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/b.ts",
    ));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.paths, ["src/a.ts", "src/b.ts"]);
  });

  test("Move to 는 원본과 목적지 둘 다 대상이다", () => {
    const r = parsePatchTargets(patch(
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      "+x",
    ));
    assert.deepEqual(r.ok && r.paths, ["src/a.ts", "src/b.ts"]);
  });

  test("여러 파일을 모두 뽑는다 — 하나라도 허용 밖이면 차단해야 하므로 전수가 필요하다", () => {
    const r = parsePatchTargets(patch(
      "*** Add File: .makdoong2-team/PROJ-1/x.md",
      "+a",
      "*** Add File: /etc/passwd",
      "+b",
    ));
    assert.deepEqual(r.ok && r.paths, [".makdoong2-team/PROJ-1/x.md", "/etc/passwd"]);
  });

  test("heredoc 으로 감싼 본문도 벗겨서 파싱한다", () => {
    const inner = patch("*** Add File: a.md", "+x");
    const r = parsePatchTargets(`<<'PATCH'\n${inner}\nPATCH`);
    assert.deepEqual(r.ok && r.paths, ["a.md"]);
  });

  test("Begin/End 마커가 없으면 실패로 보고한다 (차단이 기본값)", () => {
    const r = parsePatchTargets("*** Add File: a.md\n+x");
    assert.deepEqual(r, { ok: false, reason: "missing_begin_end_markers" });
  });

  test("대상이 하나도 없으면 실패로 보고한다", () => {
    assert.equal(parsePatchTargets(patch("@@", "+x")).ok, false);
    assert.equal(parsePatchTargets("").ok, false);
  });

  test("경로가 빈 헤더는 실패로 보고한다", () => {
    assert.equal(parsePatchTargets(patch("*** Add File:   ", "+x")).ok, false);
  });
});

describe("extractApplyPatchPaths — 인자 모양", () => {
  test("opencode 내장 툴의 patchText", () => {
    const r = extractApplyPatchPaths({ patchText: patch("*** Add File: a.md", "+x") });
    assert.deepEqual(r.ok && r.paths, ["a.md"]);
  });

  test("OpenAI provider tool 의 operation 모양", () => {
    const r = extractApplyPatchPaths({
      callId: "c1",
      operation: { type: "create_file", path: ".makdoong2-team/PROJ-1/x.md", diff: "+a" },
    });
    assert.deepEqual(r.ok && r.paths, [".makdoong2-team/PROJ-1/x.md"]);
  });

  test("operation 의 move_path 도 대상에 포함한다", () => {
    const r = extractApplyPatchPaths({
      operation: { type: "update_file", path: "a.ts", move_path: "b.ts" },
    });
    assert.deepEqual(r.ok && r.paths, ["a.ts", "b.ts"]);
  });

  test("경로를 확정할 수 없는 인자는 실패로 보고한다", () => {
    assert.equal(extractApplyPatchPaths(undefined).ok, false);
    assert.equal(extractApplyPatchPaths({}).ok, false);
    assert.equal(extractApplyPatchPaths({ operation: {} }).ok, false);
  });

  test("툴 이름 판별은 대소문자를 가리지 않는다", () => {
    assert.equal(isApplyPatchTool("apply_patch"), true);
    assert.equal(isApplyPatchTool("Patch"), true);
    assert.equal(isApplyPatchTool("write"), false);
  });
});

// ── 회귀 고정 (GitHub #8 재발) ───────────────────────────────────────────────
// opencode 1.18 의 ToolRegistry.tools 는 modelID 에 "gpt-" 가 들어가면
// write·edit 를 등록에서 빼고 apply_patch 만 노출한다. 그 세션에서 "write 로
// 만들라" 는 지침은 수행 불가능한 지시이고, 훅이 apply_patch 를 대상 불명으로
// 일괄 차단하면 산출물을 만들 수단이 하나도 남지 않아 워크플로가 정지한다.
describe("스펙 정합 — 산출물 생성 수단이 write 로 고정되어 있지 않다", () => {
  for (const p of ["stages/01-planning.md", "stages/02-requirements.md", "agents/makdoong2-planner.md"]) {
    test(`${p} 가 apply_patch 대체 경로를 명시한다`, () => {
      const s = read(p);
      assert.ok(
        s.includes("apply_patch"),
        `${p} 에 apply_patch 안내가 없다 — write 가 없는 모델 세션에서 산출물 생성이 불가능해진다`,
      );
      assert.ok(
        !s.includes("유일한 파일 쓰기 수단은 `write`"),
        `${p} 가 여전히 write 를 유일한 수단으로 규정한다`,
      );
    });
  }

  test("플러그인이 산출물 가드와 auto-git-add 양쪽에서 apply_patch 경로를 해석한다", () => {
    const s = read("src/opencode-plugin.ts");
    const uses = s.split("extractWriteTargets(").length - 1;
    assert.ok(
      uses >= 3,
      `extractWriteTargets 호출처가 ${uses}곳뿐이다 — 산출물 가드 · state.json 가드 · auto-git-add 세 곳을 모두 거쳐야 한다`,
    );
    assert.ok(
      !/const filePath = extractFilePathFromToolArgs\(input\.args\);/.test(s),
      "auto-git-add 가 filePath 단독 추출로 되돌아갔다 — apply_patch 편집이 stage 되지 않는다",
    );
  });

  test("state.json 은 쓰기 툴로 건드릴 수 없다", () => {
    const s = read("src/opencode-plugin.ts");
    assert.ok(
      s.includes("state hardrule] state.json 은"),
      "state.json 쓰기 툴 가드가 없다 — 산출물 허용 패턴(*.json)이 state.json 을 포함한다",
    );
  });
});
