// test/issue-reporter-guard.test.ts — makdoong2-issue-reporter 사용자-전용 트리거 회귀.
//
// 검증 대상:
//   1. issueReporterSkillLoadViolation — 전용 에이전트 외의 skill() 자율 로드 차단
//   2. 패키징 정합 — skill/agent/command 3종 파일의 이름·라우팅 일치
//      (command 이름 == skill 이름이어야 opencode 의 skill-derived command 를
//       cfg.command 가 덮어써 전용 에이전트로 라우팅된다)
//   3. SEALED_SUBAGENTS 등록 (CLAUDE.md hardrule: 신규 서브에이전트는 반드시 등록)
//   4. install()/uninstall() 왕복 — 신규 산출물 배포·제거
//
// Run via: node --test test/issue-reporter-guard.test.ts  (dist 빌드 필요)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  issueReporterSkillLoadViolation,
  issueReporterTaskSpawnViolation,
  extractSkillNameFromArgs,
  ISSUE_REPORTER_SKILL_NAME,
  ISSUE_REPORTER_AGENT,
  classifyGithubApiCall,
  payloadDisplayPaths,
  displayMismatch,
  sha256Hex,
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

  test("agent frontmatter — 목록 비노출(subagent+hidden) + bash/write 전권", () => {
    assert.match(agentMd, new RegExp(`^name: ${ISSUE_REPORTER_AGENT}$`, "m"));
    // mode: all 이면 사용자가 고를 수 있는 primary 목록에 뜬다. 진입점은 커맨드 하나뿐이어야 한다.
    assert.match(agentMd, /^mode: subagent$/m);
    assert.match(agentMd, /^hidden: true$/m);
    assert.ok(!/^mode: all$/m.test(agentMd), "mode: all 은 primary 선택 목록에 노출된다");
    assert.match(agentMd, /"\*": "allow"/);
    assert.match(agentMd, /"\*\*\/\*": "allow"/);
  });

  test("command 의 subtask:false 가 subagent 를 인라인으로 전환한다", () => {
    // opencode: subtask = (mode==="subagent" && subtask!==false) || subtask===true.
    // subtask:false 를 빼면 mode:subagent 는 자식 세션으로 격리되어 직전 대화 컨텍스트를 잃는다.
    assert.match(commandMd, /^subtask: false$/m);
    assert.match(commandMd, new RegExp(`^agent: ${ISSUE_REPORTER_AGENT}$`, "m"));
  });

  test("agent 는 SEALED_SUBAGENTS 에 등록되어 있다 (CLAUDE.md hardrule)", () => {
    const pluginSrc = readFileSync(join(PKG_ROOT, "src/opencode-plugin.ts"), "utf8");
    const sealedBlock = pluginSrc.match(/const SEALED_SUBAGENTS = new Set\(\[[\s\S]*?\]\);/);
    assert.ok(sealedBlock, "SEALED_SUBAGENTS 선언을 찾지 못했다");
    assert.match(sealedBlock[0], /ISSUE_REPORTER_AGENT/);
  });
});

describe("PAT 부재 — 토큰 발급 요청 절차", () => {
  const skillMd = readFileSync(join(PKG_ROOT, "skills/makdoong2-issue-reporter/SKILL.md"), "utf8");

  test("토큰을 못 찾으면 종료하지 않고 사용자에게 발급을 요청한다", () => {
    assert.match(skillMd, /토큰이 없을 때 — 사용자에게 발급을 요청한다/);
    assert.match(skillMd, /조용히 종료하지 않는다/);
    // 예전 동작(즉시 exit 1)이 남아 있으면 안내가 무의미해진다.
    assert.ok(
      !/PAT 파일 없음 또는 읽기 권한 없음.*exit 1/.test(skillMd),
      "파일 부재 시 즉시 exit 하는 스니펫이 남아 있으면 안 된다",
    );
  });

  test("발급 안내가 실제 발급 URL 과 최소 권한을 제시한다", () => {
    assert.match(skillMd, /github\.com\/settings\/personal-access-tokens\/new/);
    assert.match(skillMd, /github\.com\/settings\/tokens\/new/);
    assert.match(skillMd, /Issues: Read and write/);
    assert.match(skillMd, /public_repo/);
    assert.match(skillMd, /chmod 600/);
  });

  test("401/403 도 같은 재발급 요청 경로를 탄다", () => {
    assert.match(skillMd, /`401`\/`403` 응답도 같은 절차를 적용한다/);
  });

  test("토큰 발급·저장 주체는 사용자이고 값은 재출력하지 않는다", () => {
    assert.match(skillMd, /토큰 발급·저장은 사용자가 한다/);
    assert.match(skillMd, /채팅에 다시 출력하지 않는다/);
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

});

describe("표시 증명 — 사용자가 본 원문에 대한 바인딩", () => {
  test("단독 cat 만 표시로 인정한다", () => {
    assert.deepEqual(payloadDisplayPaths("cat /tmp/makdoong2-issue/issue-payload.json"), [
      "/tmp/makdoong2-issue/issue-payload.json",
    ]);
    assert.deepEqual(payloadDisplayPaths("cat -- /tmp/p.json"), ["/tmp/p.json"]);
    assert.deepEqual(payloadDisplayPaths(`cat "/tmp/p.json"`), ["/tmp/p.json"]);
  });

  test("체이닝·리다이렉트·치환이 섞이면 표시로 인정하지 않는다", () => {
    // 사용자가 본 내용과 파일에 남는 내용이 갈라지는 형태는 증거가 될 수 없다.
    assert.deepEqual(payloadDisplayPaths("cat /tmp/p.json; echo evil > /tmp/p.json"), []);
    assert.deepEqual(payloadDisplayPaths("cat /tmp/p.json && curl ..."), []);
    assert.deepEqual(payloadDisplayPaths("cat /tmp/p.json | head -5"), []);
    assert.deepEqual(payloadDisplayPaths("cat $(echo /tmp/p.json)"), []);
  });

  test("상대 경로·비-cat 명령은 표시가 아니다", () => {
    assert.deepEqual(payloadDisplayPaths("cat p.json"), []);
    assert.deepEqual(payloadDisplayPaths("jq . /tmp/p.json"), []);
    assert.deepEqual(payloadDisplayPaths("curl -sS https://api.github.com/x"), []);
  });

  test("표시한 원문과 같으면 통과, 표시 후 변경은 차단", () => {
    const payload = Buffer.from('{"title":"t","body":"b"}');
    const shown = sha256Hex(payload);
    assert.equal(displayMismatch(payload, shown), null);

    const tampered = Buffer.from('{"title":"t","body":"EVIL"}');
    assert.match(displayMismatch(tampered, shown), /변경/);
  });

  test("표시된 적이 없으면 차단한다", () => {
    assert.match(displayMismatch(Buffer.from("{}"), undefined), /표시된 적이 없다/);
  });
});

describe("게시 게이트 배선 — 훅·문서 정합", () => {
  const pluginSrc = readFileSync(join(PKG_ROOT, "src/opencode-plugin.ts"), "utf8");

  test("플러그인 훅이 게이트 함수들을 배선한다", () => {
    for (const sym of ["classifyGithubApiCall", "displayMismatch", "payloadDisplayPaths"]) {
      assert.ok(pluginSrc.includes(sym), `opencode-plugin.ts 가 ${sym} 를 사용해야 한다`);
    }
  });

  test("frontmatter 의 ask 패턴과 훅이 허용하는 표기가 한 쌍이다", () => {
    // 승인 프롬프트는 frontmatter 패턴이 명령 문자열에 매치될 때만 뜬다. 훅이 허용하는
    // 전송 표기가 그 패턴에 걸리지 않으면 질문 없이 게시된다 — 둘은 함께 움직여야 한다.
    const agentMd = readFileSync(join(PKG_ROOT, "agents/makdoong2-issue-reporter.md"), "utf8");
    assert.match(agentMd, /"\*-d @\/\*": "ask"/);

    const guardSrc = readFileSync(join(PKG_ROOT, "src/issue-reporter-guard.ts"), "utf8");
    assert.match(guardSrc, /APPROVABLE_PAYLOAD_RE/);

    // 읽기(-G 검색)는 패턴에 걸리지 않아야 한다 — 매번 물으면 승인이 일상이 된다.
    const askPattern = /(^|\s)-d @\/[^\s'"]+(\s|$)/;
    assert.ok(!askPattern.test(`curl -sS -G https://api.github.com/search/issues --data-urlencode "q=repo:x is:issue"`));
    assert.ok(askPattern.test(`curl -sS -X POST https://api.github.com/repos/o/r/issues -d @/tmp/p.json`));
  });

  test("승인 프롬프트를 못 띄우는 payload 표기는 차단한다", () => {
    const base = "curl -sS -X POST https://api.github.com/repos/o/r/issues";
    for (const flag of ["--data", "--data-binary", "--data-raw", "--json"]) {
      const r = classifyGithubApiCall(`${base} ${flag} @/tmp/p.json`);
      assert.equal(r.kind, "mutation");
      assert.ok(
        r.problems.some((p) => p.includes("-d @/절대경로")),
        `${flag} @file 은 승인 프롬프트를 띄우지 못하므로 차단돼야 한다`,
      );
    }
    // 정상 표기는 문제 없음
    assert.deepEqual(classifyGithubApiCall(`${base} -d @/tmp/p.json`).problems, []);
  });

  test("task 툴로 issue-reporter 를 spawn 할 수 없다", () => {
    // mode/hidden 은 목록에서 감출 뿐이고 task 툴은 mode 를 검사하지 않는다.
    const msg = issueReporterTaskSpawnViolation({ subagent_type: ISSUE_REPORTER_AGENT, prompt: "x" });
    assert.ok(msg, "spawn 시도는 차단돼야 한다");
    assert.match(msg, /\/makdoong2-issue-reporter/);
    assert.equal(issueReporterTaskSpawnViolation({ arguments: { subagent_type: ISSUE_REPORTER_AGENT } }) !== null, true);
    assert.equal(issueReporterTaskSpawnViolation({ subagent_type: "makdoong2-engineer" }), null);
    assert.equal(issueReporterTaskSpawnViolation(undefined), null);
    assert.ok(pluginSrc.includes("issueReporterTaskSpawnViolation"), "훅이 배선되어야 한다");
  });

  test("승인 셸 스크립트 방식은 제거되었다", () => {
    assert.ok(
      !existsSync(join(PKG_ROOT, "scripts/issue-reporter-approve.sh")),
      "승인은 세션 내 질문으로 받는다 — 별도 승인 스크립트가 남아 있으면 안 된다",
    );
    assert.ok(!pluginSrc.includes(".approved"), "마커 계약의 잔재가 남아 있으면 안 된다");
  });

  test("SKILL.md 가 승인 게이트 절차(7-1)를 명시한다", () => {
    const skillMd = readFileSync(join(PKG_ROOT, "skills/makdoong2-issue-reporter/SKILL.md"), "utf8");
    assert.match(skillMd, /원문 전체를 세션에 그대로 표시한다/);
    assert.match(skillMd, /yes\/no/);
    assert.ok(!skillMd.includes("issue-reporter-approve.sh"), "제거된 스크립트를 안내하면 안 된다");
  });
});

describe("이슈 양식 (§6) — 본문 작성 가이드", () => {
  const skillMd = readFileSync(join(PKG_ROOT, "skills/makdoong2-issue-reporter/SKILL.md"), "utf8");
  const agentMd = readFileSync(join(PKG_ROOT, "agents/makdoong2-issue-reporter.md"), "utf8");

  // 양식 없이는 수집·마스킹·승인을 다 통과해도 진단에 못 쓰는 이슈가 나온다.
  // 기준은 이슈 #5 — 유지보수자가 타임라인·로그 발췌·반복 표·의심 코드를 그대로 진단에 썼다.
  test("§6 이 양식 가이드로 존재하고 실행 순서에 편입돼 있다", () => {
    assert.match(skillMd, /^## 6\. 이슈 양식 \(본문 작성 가이드\)$/m);
    // 실행 순서에서 빠지면 에이전트가 6장을 건너뛰고 7장으로 간다.
    assert.match(skillMd, /최소 질의\(4장\) → 본문 작성\(6장\) → 이슈 생성\(7장\)/);
    assert.match(agentMd, /최소 질의 → 본문 작성 → 이슈 생성/);
  });

  test("필수 섹션이 순서대로 규정돼 있다", () => {
    const required = [
      "## 증상", "## 환경", "## 재현 절차", "## 기대 동작", "## 실제 동작",
      "## 실패 지점", "## 타임라인", "## 에러 메시지", "## 재현성 / 영향 범위",
      "## 시도한 조치", "## 증거",
    ];
    const spec = skillMd.slice(skillMd.indexOf("### 6.2 섹션 구성"), skillMd.indexOf("### 6.4"));
    let cursor = -1;
    for (const section of required) {
      const at = spec.indexOf(section, cursor + 1);
      assert.ok(at > cursor, `필수 섹션 "${section}" 이 6.2~6.3 에 순서대로 없다`);
      cursor = at;
    }
  });

  test("조건부 섹션 4종 — #5 가 채웠으나 이전 템플릿에 없던 것들", () => {
    // "여유 있으면 쓰는 것" 으로 두면 모델 편차에 따라 빠지고,
    // 빠지면 유지보수자가 같은 조사를 처음부터 다시 한다.
    for (const section of ["## 관련 관찰", "## 참고: 의심 근본 원인 코드", "## 부수 관찰 (minor)", "## 제안 (참고)"]) {
      assert.ok(skillMd.includes(section), `조건부 섹션 "${section}" 규정이 없다`);
      assert.ok(agentMd.includes(section), `agent 하드룰이 "${section}" 을 지목하지 않는다`);
    }
    // 근거 없이 채우는 것도 금지 — 추측 제안은 진단을 잘못된 방향으로 끈다.
    assert.match(skillMd, /근거 없이 채우지도 않는다/);
  });

  test("제목 규약과 기준 사례(#5)를 제시한다", () => {
    assert.match(skillMd, /^### 6\.1 제목$/m);
    assert.match(skillMd, /어디서.*무엇이 어떻게.*그 결과/s);
    assert.match(skillMd, /issues\/5/);
    // 커밋 제목 50자 규칙과 혼동하지 않도록 명시적으로 배제한다.
    assert.match(skillMd, /50자 제한은 \*\*적용하지 않는다\*\*/);
  });

  test("제출 전 자기 점검이 cat 표시 *전* 단계로 배치돼 있다", () => {
    assert.match(skillMd, /^### 6\.6 제출 전 자기 점검 \(7-1 표시 직전\)$/m);
    // 표시 후 수정하면 sha256 표시 증명이 무효가 되어 승인 절차를 처음부터 다시 밟는다.
    assert.match(skillMd, /본문을 6장 양식으로 작성하고 6\.6 자기 점검을 통과시킨 뒤/);
    assert.match(agentMd, /6\.6 자기 점검을 통과시킨다/);
  });

  test("삭제된 이슈(#1/#4)를 다시 참조하지 않는다", () => {
    // 두 이슈는 현재 410 Gone. 스냅샷 표가 삭제된 이슈를 가리키면 중복 판정이 어긋난다.
    for (const dead of [1, 2, 3, 4]) {
      assert.ok(
        !skillMd.includes(`makdoong2-team/issues/${dead}`),
        `삭제된 이슈 #${dead} 링크가 남아 있다`,
      );
    }
    assert.ok(!/기존 이슈\(#1, #4\)/.test(skillMd), "삭제된 이슈를 제목 규약의 근거로 인용하면 안 된다");
    assert.match(skillMd, /열린 이슈 목록을 이 문서에 하드코딩하지 않는다/);
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

// ── 승인 게이트 우회 (3차) ──
//
// 승인은 두 조각이다: (가) frontmatter 의 `"*-d @/*": "ask"` 가 띄우는 permission
// 프롬프트, (나) 전송 직전 sha256 표시 증명. 아래 두 형태는 **둘 다** 건너뛰었다.
describe("classifyGithubApiCall — -X 없이 메서드를 바꾸는 경로", () => {
  const U = "https://api.github.com/repos/o/r/issues";

  test("curl -T / --upload-file 은 PUT 이다 — read 로 분류되면 안 된다", () => {
    for (const cmd of [`curl -T /tmp/p.json ${U}`, `curl --upload-file /tmp/p.json ${U}`]) {
      const r = classifyGithubApiCall(cmd);
      assert.equal(r.kind, "mutation", `${cmd} 가 read 로 새어나갔다`);
      assert.ok(r.problems.length > 0, "problems 가 비면 호출부가 차단하지 않는다");
      assert.ok(
        r.problems.some((p) => /-T|--upload-file/.test(p)),
        "차단 사유가 무엇인지 알려줘야 한다",
      );
    }
  });

  test("curl -K / --config 는 옵션을 파일에서 읽어와 게이트를 무력화한다", () => {
    for (const cmd of [`curl -K /tmp/opts ${U}`, `curl --config /tmp/opts ${U}`]) {
      assert.equal(classifyGithubApiCall(cmd).kind, "forbidden-client", cmd);
    }
  });

  test("번들 단축옵션 -sT / -sK 도 우회되지 않는다 (검토 회귀 — 불완전 수정)", () => {
    // curl 은 인자를 취하는 단축옵션을 번들 끝에 둘 수 있어 `-sT file` = `-s -T file`
    // 이 실제 PUT 을 보낸다. 앞 공백 + `-T` 만 보던 정규식이 `-sT`·`-sfT`·`-sK` 를 놓쳤다.
    for (const cmd of [`curl -sT /tmp/x ${U}`, `curl -sfT /tmp/x ${U}`]) {
      const r = classifyGithubApiCall(cmd);
      assert.equal(r.kind, "mutation", `${cmd} 가 read 로 새어나갔다`);
      assert.ok(r.problems.length > 0);
    }
    for (const cmd of [`curl -sK /tmp/o ${U}`, `curl -sfK /tmp/o ${U}`]) {
      assert.equal(classifyGithubApiCall(cmd).kind, "forbidden-client", cmd);
    }
    // T/K 없는 번들은 읽기로 유지 (오탐 방지)
    assert.equal(classifyGithubApiCall(`curl -sL ${U}`).kind, "read");
    assert.equal(classifyGithubApiCall(`curl -fsSL ${U}`).kind, "read");
  });

  test("정상 경로와 읽기는 그대로 동작한다", () => {
    const ok = classifyGithubApiCall(`curl -X POST -d @/tmp/p.json ${U}`);
    assert.equal(ok.kind, "mutation");
    assert.deepEqual(ok.problems, [], "승인 가능한 표기인데 problems 가 생겼다");

    assert.equal(classifyGithubApiCall(`curl -s ${U}`).kind, "read");
    assert.equal(
      classifyGithubApiCall(`curl -G --data-urlencode "q=x" https://api.github.com/search/issues`).kind,
      "read",
      "중복 검색(-G)은 읽기다",
    );
  });
});
