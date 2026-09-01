/**
 * 파이프라인 형태 회귀 — researcher fan-out 제거 + scope substage 흡수.
 *
 * 두 변경 모두 "여러 파일이 같은 사실을 알고 있어야" 성립한다. 한 곳만 되돌아가면
 * substage 가 done=true + VERIFIED 로 끝난 뒤 다음 게이트가 하드 차단하는 정지가
 * 재현되므로(CLAUDE.md "필수 마커 정의는 세 곳이 일치") 여기서 전수 고정한다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_SPEC_FILES, AGENTS, agentForStage } from "../src/agent-stage-config.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("researcher fan-out 제거", () => {
  const REMOVED = [
    "agents/makdoong2-researcher.md",
    "src/research-fanout.ts",
    "gates/stage3-scope-verify.sh",
    "stages/03-scope.md",
  ];
  for (const p of REMOVED) {
    it(`${p} 가 존재하지 않는다`, () => {
      assert.equal(existsSync(join(ROOT, p)), false, `${p} 가 되살아났다`);
    });
  }

  it("AGENTS · 모델 정책 어디에도 researcher 가 없다", () => {
    assert.equal(AGENTS["makdoong2-researcher"], undefined);
    for (const p of ["src/model-fallback-policy.ts", "scripts/model-policy.mts", "makdoong2-team.json"]) {
      assert.ok(!read(p).includes("makdoong2-researcher"), `${p} 에 researcher 항목이 남아 있다`);
    }
  });

  it("dispatch_research 툴이 툴 목록 어디에도 없다", () => {
    // 플러그인에서 지워도 설치본 opencode.json 의 tools 목록에 남으면 opencode 가
    // 존재하지 않는 툴을 등재한다 (example-config-portability 가 고아 키로 잡는다).
    for (const p of ["src/opencode-plugin.ts", "scripts/install-lib.mts", "bin/cli.ts", "opencode.json.example"]) {
      assert.ok(!read(p).includes("dispatch_research"), `${p} 에 dispatch_research 가 남아 있다`);
    }
  });

  it("planner 가 조사를 자기 세션에서 수행하도록 지시받는다", () => {
    const planner = read("agents/makdoong2-planner.md");
    assert.ok(!planner.includes("dispatch_research"), "planner frontmatter/본문에 dispatch_research 가 남아 있다");
    assert.match(planner, /skill_mcp/, "인라인 조사 수단(skill_mcp) 안내가 없다");
    for (const spec of ["stages/01-planning.md", "stages/02-requirements.md"]) {
      const t = read(spec);
      assert.ok(!t.includes("dispatch_research"), `${spec} 가 여전히 fan-out 을 지시한다`);
      assert.match(t, /skill\(name=/, `${spec} 에 skill 로드 절차가 없다`);
    }
  });
});

describe("scope substage 흡수", () => {
  it("STAGE_ORDER · STAGE_SPEC_FILES 에 scope 가 없다", () => {
    assert.equal((STAGE_SPEC_FILES as Record<string, string>)["1_planning.scope"], undefined);
    assert.equal(Object.keys(STAGE_SPEC_FILES).length, 8, "substage 는 9개에서 8개로 줄어야 한다");
    assert.equal(agentForStage("1_planning.requirements").id, "makdoong2-planner");
  });

  it("verify.sh 가 scope 를 라우팅하지 않는다", () => {
    assert.ok(!read("gates/verify.sh").includes("1_planning.scope"));
  });

  // 게이트만 지우고 검사를 옮기지 않으면 승인·모호성·spec drift 검증이 파이프라인에서
  // 통째로 사라진다 — 삭제와 이관은 한 쌍이다.
  it("scope 게이트가 하던 검사가 analysis 게이트로 이관됐다", () => {
    const gate = read("gates/stage-analysis-verify.sh");
    for (const check of [
      'substages."requirements".done',
      'auto_approve."1_planning.requirements"',
      "approved_by_user",
      "interview_completed",
      "ambiguity_score",
      "spec_hash",
      "draft_path",
    ]) {
      assert.ok(gate.includes(check), `analysis 게이트에 '${check}' 검사가 없다`);
    }
  });

  it("dev 게이트가 requirements 를 본다", () => {
    const gate = read("gates/stage4-dev-verify.sh");
    assert.ok(!gate.includes('substages."scope"'), "dev 게이트가 사라진 scope 마커를 본다");
    assert.match(gate, /substages\."requirements"\.done/);
  });

  it("state.sh init 스키마에 scope 가 없고 migrate 가 AND 로 접는다", () => {
    const sh = read("scripts/state.sh");
    const init = sh.slice(sh.indexOf('"1_planning": {'), sh.indexOf('"2_implementation": {'));
    assert.ok(!init.includes('"scope"'), "init 스키마가 여전히 scope substage 를 만든다");
    // OR 로 접으면 아직 끝나지 않은 scope 가 통과로 둔갑한다.
    assert.match(sh, /substages\.scope\.done \/\/ false\)\)/, "migrate 의 scope 흡수 로직이 없다");
    const fold = sh.slice(sh.indexOf("scope substage 흡수"), sh.indexOf("auto_approve 는 flat"));
    assert.ok(fold.includes("and"), "done 을 AND 로 접지 않는다");
    assert.ok(!fold.includes(" or "), "done 을 OR 로 접으면 미완료 scope 가 통과로 둔갑한다");
  });

  it("범위 확정 4항목을 stage spec 과 verifier 가 함께 요구한다", () => {
    const MARKERS = ["paths_explicit", "test_scope_defined", "atomic_units", "scope_out_listed"];
    const combined = read("stages/01-planning.md");
    const verifier = read("agents/makdoong2-verifier.md");
    for (const m of MARKERS) {
      assert.ok(combined.includes(m), `01-planning.md 의 self_check 에 ${m} 이 없다`);
      assert.ok(verifier.includes(m), `verifier 기준에 ${m} 이 없다 — 게이트만 아는 조건이 된다`);
    }
    assert.ok(!verifier.includes("## §3. Substage: scope"));
  });
});
