// test/issue-reporter-guard.test.mjs — makdoong2-issue-reporter 사용자-전용 트리거 회귀.
//
// 검증 대상:
//   1. issueReporterSkillLoadViolation — 전용 에이전트 외의 skill() 자율 로드 차단
//   2. 패키징 정합 — skill/agent/command 3종 파일의 이름·라우팅 일치
//      (command 이름 == skill 이름이어야 opencode 의 skill-derived command 를
//       cfg.command 가 덮어써 전용 에이전트로 라우팅된다)
//   3. SEALED_SUBAGENTS 등록 (CLAUDE.md hardrule: 신규 서브에이전트는 반드시 등록)
//   4. install()/uninstall() 왕복 — 신규 산출물 배포·제거
//
// Run via: node --test test/issue-reporter-guard.test.mjs  (dist 빌드 필요)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  issueReporterSkillLoadViolation,
  extractSkillNameFromArgs,
  ISSUE_REPORTER_SKILL_NAME,
  ISSUE_REPORTER_AGENT,
} from "../dist/issue-reporter-guard.js";
import { install, uninstall } from "../scripts/install-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

describe("issueReporterSkillLoadViolation — 사용자-전용 트리거 강제", () => {
  test("team-leader 의 자율 로드는 차단하고 /makdoong2-issue-reporter 안내를 포함한다", () => {
    const msg = issueReporterSkillLoadViolation("makdoong2-team-leader", { name: ISSUE_REPORTER_SKILL_NAME });
    assert.ok(msg, "violation message expected");
    assert.match(msg, /\/makdoong2-issue-reporter/);
    assert.match(msg, /makdoong2-team-leader/);
  });

  test("sealed 서브에이전트(planner/publisher)의 로드도 차단한다", () => {
    for (const agent of ["makdoong2-planner", "makdoong2-publisher"]) {
      assert.ok(issueReporterSkillLoadViolation(agent, { name: ISSUE_REPORTER_SKILL_NAME }), `${agent} must be blocked`);
    }
  });

  test("전용 에이전트 자신의 로드는 허용한다", () => {
    assert.equal(issueReporterSkillLoadViolation(ISSUE_REPORTER_AGENT, { name: ISSUE_REPORTER_SKILL_NAME }), null);
  });

  test("agent 미상(undefined)은 primary passthrough 로 허용한다", () => {
    assert.equal(issueReporterSkillLoadViolation(undefined, { name: ISSUE_REPORTER_SKILL_NAME }), null);
  });

  test("다른 스킬 로드에는 개입하지 않는다", () => {
    assert.equal(issueReporterSkillLoadViolation("makdoong2-team-leader", { name: "jira-research" }), null);
    assert.equal(issueReporterSkillLoadViolation("makdoong2-planner", {}), null);
    assert.equal(issueReporterSkillLoadViolation("makdoong2-planner", undefined), null);
  });

  test("extractSkillNameFromArgs — { name } 및 { arguments: { name } } 형태 수용", () => {
    assert.equal(extractSkillNameFromArgs({ name: "x" }), "x");
    assert.equal(extractSkillNameFromArgs({ arguments: { name: "y" } }), "y");
    assert.equal(extractSkillNameFromArgs("not-an-object"), undefined);
    assert.equal(extractSkillNameFromArgs(null), undefined);
  });
});

describe("패키징 정합 — skill / agent / command 3종 세트", () => {
  const skillMd = readFileSync(join(PKG_ROOT, "skills/makdoong2-issue-reporter/SKILL.md"), "utf8");
  const agentMd = readFileSync(join(PKG_ROOT, "agents/makdoong2-issue-reporter.md"), "utf8");
  const commandMd = readFileSync(join(PKG_ROOT, "command/makdoong2-issue-reporter.md"), "utf8");

  test("SKILL.md frontmatter name 이 guard 상수와 일치한다", () => {
    assert.match(skillMd, new RegExp(`^name: ${ISSUE_REPORTER_SKILL_NAME}$`, "m"));
  });

  test("SKILL.md description 이 사용자-직접-호출 전용을 명시하고 자동 트리거 문구가 없다", () => {
    assert.match(skillMd, /유일한 트리거는 사용자의 직접 호출/);
    assert.ok(!/관측했을 때 반드시 이 스킬을 사용한다/.test(skillMd), "자동 트리거 문구가 제거되어야 한다");
  });

  test("command 파일명 == skill 이름 (skill-derived command 를 덮어쓰는 전제)", () => {
    // opencode 는 cfg.command 를 먼저 채우고 같은 이름의 skill 은 건너뛴다.
    // 파일명이 skill 이름과 다르면 권한 없는 skill-derived command 가 살아남는다.
    assert.ok(existsSync(join(PKG_ROOT, `command/${ISSUE_REPORTER_SKILL_NAME}.md`)));
  });

  test("command 는 전용 에이전트로 라우팅하고 inline 실행을 강제한다", () => {
    assert.match(commandMd, new RegExp(`^agent: ${ISSUE_REPORTER_AGENT}$`, "m"));
    assert.match(commandMd, /^subtask: false$/m);
  });

  test("agent frontmatter — mode all + bash/write 전권", () => {
    assert.match(agentMd, new RegExp(`^name: ${ISSUE_REPORTER_AGENT}$`, "m"));
    assert.match(agentMd, /^mode: all$/m);
    assert.match(agentMd, /"\*": "allow"/);
    assert.match(agentMd, /"\*\*\/\*": "allow"/);
  });

  test("agent 는 SEALED_SUBAGENTS 에 등록되어 있다 (CLAUDE.md hardrule)", () => {
    const pluginSrc = readFileSync(join(PKG_ROOT, "src/opencode-plugin.ts"), "utf8");
    const sealedBlock = pluginSrc.match(/const SEALED_SUBAGENTS = new Set\(\[[\s\S]*?\]\);/);
    assert.ok(sealedBlock, "SEALED_SUBAGENTS 선언을 찾지 못했다");
    assert.match(sealedBlock[0], /ISSUE_REPORTER_AGENT/);
  });
});

describe("install/uninstall 왕복 — 신규 산출물", () => {
  test("install 이 skill + command 를 배포하고 uninstall 이 제거한다", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mkd2-issue-reporter-"));
    const silent = { log: () => {}, warn: () => {}, error: () => {} };
    try {
      install({ configDir, pkgRoot: PKG_ROOT, force: false, patchOpencode: "skip", logger: silent });
      assert.ok(existsSync(join(configDir, "skills/makdoong2-issue-reporter/SKILL.md")), "skill deployed");
      assert.ok(existsSync(join(configDir, "command/makdoong2-issue-reporter.md")), "command deployed");
      assert.ok(existsSync(join(configDir, "agents/makdoong2-issue-reporter.md")), "agent deployed");

      uninstall({ configDir, pkgRoot: PKG_ROOT, logger: silent });
      assert.ok(!existsSync(join(configDir, "skills/makdoong2-issue-reporter")), "skill removed");
      assert.ok(!existsSync(join(configDir, "command/makdoong2-issue-reporter.md")), "command removed");
      assert.ok(!existsSync(join(configDir, "agents/makdoong2-issue-reporter.md")), "agent removed");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
