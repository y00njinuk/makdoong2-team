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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  issueReporterSkillLoadViolation,
  extractSkillNameFromArgs,
  ISSUE_REPORTER_SKILL_NAME,
  ISSUE_REPORTER_AGENT,
  APPROVAL_MARKER_SUFFIX,
  classifyGithubApiCall,
  isApproveScriptInvocation,
  referencesApprovalMarker,
  approvalMarkerPath,
  approvalMismatch,
  sha256Hex,
  parseApprovalMarker,
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

describe("classifyGithubApiCall — GitHub 게시 승인 게이트 분류", () => {
  const AUTH = `-H "Authorization: Bearer $GH_TOKEN"`;

  test("api.github.com 미참조 명령은 none", () => {
    assert.equal(classifyGithubApiCall("tail -n 500 /var/log/opencode/opencode.log").kind, "none");
    assert.equal(classifyGithubApiCall("curl -sS https://example.com -d @/tmp/x.json").kind, "none");
  });

  test("curl GET(중복 검색 -G --data-urlencode 포함)은 read", () => {
    assert.equal(classifyGithubApiCall(`curl -sS https://api.github.com/repos/y00njinuk/makdoong2-team/labels ${AUTH}`).kind, "read");
    assert.equal(
      classifyGithubApiCall(`curl -sS -G https://api.github.com/search/issues ${AUTH} --data-urlencode "q=repo:y00njinuk/makdoong2-team is:open hang"`).kind,
      "read",
    );
  });

  test("skill 7-2 의 정상 이슈 생성 curl 은 mutation·문제 없음", () => {
    const r = classifyGithubApiCall(
      `curl -sS -X POST https://api.github.com/repos/y00njinuk/makdoong2-team/issues ${AUTH} -H "Accept: application/vnd.github+json" -d @/tmp/makdoong2-issue/issue-payload.json`,
    );
    assert.equal(r.kind, "mutation");
    assert.deepEqual(r.payloadPaths, ["/tmp/makdoong2-issue/issue-payload.json"]);
    assert.deepEqual(r.problems, []);
  });

  test("-X 없이 -d 만 있어도 mutation (curl -d 는 POST 다)", () => {
    const r = classifyGithubApiCall(`curl -sS https://api.github.com/gists ${AUTH} -d @/tmp/g.json`);
    assert.equal(r.kind, "mutation");
    assert.deepEqual(r.problems, []);
  });

  test("인라인 JSON / stdin(-d @-) / 상대 경로 / 변수 경로는 problems", () => {
    const inline = classifyGithubApiCall(`curl -X POST https://api.github.com/repos/o/r/labels ${AUTH} -d '{"name":"x"}'`);
    assert.equal(inline.kind, "mutation");
    assert.ok(inline.problems.length > 0, "inline JSON must be flagged");

    const rel = classifyGithubApiCall(`curl -X POST https://api.github.com/gists ${AUTH} -d @gist-payload.json`);
    assert.ok(rel.problems.some((p) => p.includes("절대 경로")), "relative path must be flagged");

    const vars = classifyGithubApiCall(`curl -X POST https://api.github.com/gists ${AUTH} -d @$HOME/p.json`);
    assert.ok(vars.problems.some((p) => p.includes("변수")), "variable path must be flagged");
  });

  test("TOCTOU 방어 — 체이닝·리다이렉트가 섞인 쓰기는 problems", () => {
    const chained = classifyGithubApiCall(
      `echo '{"title":"evil"}' > /tmp/p.json && curl -X POST https://api.github.com/repos/o/r/issues -d @/tmp/p.json`,
    );
    assert.equal(chained.kind, "mutation");
    assert.ok(chained.problems.some((p) => p.includes("단일 curl")), "chained rewrite must be flagged");

    const piped = classifyGithubApiCall(`cat /tmp/p.json | curl -X POST https://api.github.com/gists -d @/tmp/p.json`);
    assert.ok(piped.problems.some((p) => p.includes("단일 curl")), "pipe must be flagged");
  });

  test("curl 이 아닌 클라이언트로 api.github.com 접근은 forbidden-client", () => {
    assert.equal(classifyGithubApiCall(`node -e "fetch('https://api.github.com/repos/o/r/issues',{method:'POST'})"`).kind, "forbidden-client");
    assert.equal(classifyGithubApiCall(`wget https://api.github.com/repos/o/r/issues`).kind, "forbidden-client");
  });

  test("gh CLI 는 URL 문자열이 없어도 forbidden-client (우회 차단)", () => {
    assert.equal(classifyGithubApiCall(`gh issue create -R y00njinuk/makdoong2-team -t "t" -b "b"`).kind, "forbidden-client");
    assert.equal(classifyGithubApiCall(`gh api -X POST repos/o/r/issues`).kind, "forbidden-client");
    assert.equal(classifyGithubApiCall(`gh gist create /tmp/log.txt`).kind, "forbidden-client");
    // 무관한 명령의 "gh" 부분 문자열은 오탐하지 않는다
    assert.equal(classifyGithubApiCall(`grep -n "gh issue" notes.md`).kind, "none");
  });

  test("승인 스크립트 호출·마커 참조 감지", () => {
    assert.equal(isApproveScriptInvocation("bash /x/scripts/issue-reporter-approve.sh /tmp/p.json"), true);
    assert.equal(isApproveScriptInvocation("curl -sS https://api.github.com/repos"), false);
    assert.equal(referencesApprovalMarker("touch /tmp/p.json.approved"), true);
    assert.equal(referencesApprovalMarker("cat /tmp/p.json"), false);
  });
});

describe("승인 마커 — 해시 바인딩", () => {
  test("approvalMarkerPath 는 payload 경로에 접미사를 붙인다", () => {
    assert.equal(approvalMarkerPath("/tmp/p.json"), `/tmp/p.json${APPROVAL_MARKER_SUFFIX}`);
  });

  test("일치하는 해시는 통과, 내용 변경은 불일치 사유 반환", () => {
    const payload = Buffer.from('{"title":"t","body":"b"}');
    const marker = `${sha256Hex(payload)}\n# approved-at: 2026-08-27T00:00:00Z\n`;
    assert.equal(approvalMismatch(payload, marker), null);

    const tampered = Buffer.from('{"title":"t","body":"EVIL"}');
    assert.match(approvalMismatch(tampered, marker), /변경/);
  });

  test("형식이 깨진 마커는 거부", () => {
    assert.match(approvalMismatch(Buffer.from("x"), "not-a-hash\n"), /형식/);
    assert.equal(parseApprovalMarker("deadbeef"), null);
  });
});

describe("issue-reporter-approve.sh — 기능 검증", () => {
  const APPROVE = join(PKG_ROOT, "scripts/issue-reporter-approve.sh");

  function runApprove(payloadPath, stdinText) {
    try {
      const out = execFileSync("bash", [APPROVE, payloadPath], {
        input: stdinText ?? "",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  test("y 승인 시 payload sha256 이 기록된 마커를 만들고, 원문을 전문 출력한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkd2-approve-"));
    try {
      const payload = join(dir, "issue-payload.json");
      const content = '{"title":"제목","labels":["bug"],"body":"본문 전체"}';
      writeFileSync(payload, content);

      const r = runApprove(payload, "y\n");
      assert.equal(r.code, 0, `approve failed: ${r.out}`);
      assert.ok(r.out.includes(content), "승인 화면에 payload 원문 전문이 나와야 한다");

      const marker = readFileSync(approvalMarkerPath(payload), "utf8");
      assert.equal(parseApprovalMarker(marker), sha256Hex(Buffer.from(content)));
      assert.equal(approvalMismatch(Buffer.from(content), marker), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("거부(n)·EOF 는 마커를 만들지 않고 실패 종료한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkd2-approve-"));
    try {
      const payload = join(dir, "p.json");
      writeFileSync(payload, "{}");

      assert.notEqual(runApprove(payload, "n\n").code, 0);
      assert.ok(!existsSync(approvalMarkerPath(payload)), "거부 후 마커가 없어야 한다");

      assert.notEqual(runApprove(payload, null).code, 0);
      assert.ok(!existsSync(approvalMarkerPath(payload)), "EOF 후 마커가 없어야 한다");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("게시 게이트 배선 — 훅·스크립트·문서 정합", () => {
  test("플러그인 훅이 게이트 함수들을 배선한다", () => {
    const src = readFileSync(join(PKG_ROOT, "src/opencode-plugin.ts"), "utf8");
    for (const sym of ["classifyGithubApiCall", "approvalMismatch", "isApproveScriptInvocation", "referencesApprovalMarker"]) {
      assert.ok(src.includes(sym), `opencode-plugin.ts 가 ${sym} 를 사용해야 한다`);
    }
  });

  test("승인 스크립트가 존재하고 원문 전문 출력 + stdin confirm 을 쓴다", () => {
    const script = readFileSync(join(PKG_ROOT, "scripts/issue-reporter-approve.sh"), "utf8");
    assert.match(script, /cat -- "\$\{PAYLOAD\}"/, "payload 원문 전문 출력");
    assert.match(script, /lib\/confirm\.sh/, "공용 stdin confirm 사용");
    // 주석의 설명 문구는 허용하고 실제 코드 라인만 검사한다
    const code = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.ok(!code.includes("/dev/tty"), "/dev/tty 금지");
  });

  test("SKILL.md 가 승인 게이트 절차(7-1)를 명시한다", () => {
    const skillMd = readFileSync(join(PKG_ROOT, "skills/makdoong2-issue-reporter/SKILL.md"), "utf8");
    assert.match(skillMd, /issue-reporter-approve\.sh/);
    assert.match(skillMd, /원문 전체를 채팅에 그대로 표시/);
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
