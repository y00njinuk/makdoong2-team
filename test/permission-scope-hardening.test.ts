/**
 * 워크스페이스 밖 경로 접근 강화 회귀.
 *
 * 세 가지를 고정한다:
 *  1. 플러그인이 자기 실행 경로(scripts/gates/stages/hooks/skills)를 **설정과
 *     무관하게** 스스로 허용한다. 종전에는 opencode.json 시드 하나에만 의존해,
 *     그 패치가 남지 않은 부분 설치에서 서브에이전트가 state.sh 조차 못 부르고
 *     PERMISSION_STALL 로 죽었다 (GitHub #8).
 *  2. permission_stall 이 사유를 구분한다. "허용 경로 밖"(대안 경로로 회복 가능)과
 *     "external_directory 가 아닌 권한"(에이전트 설정 문제)은 조치가 정반대인데
 *     종전에는 한 문장으로 뭉개졌다.
 *  3. `/tmp` 이 정당한 경로로 새어 들어오지 않는다. 서브에이전트에서 그 접근은
 *     프롬프트가 아니라 즉시 거부 + 세션 abort 라, 하던 작업이 통째로 날아간다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginOwnAllowPatterns } from "../src/config.ts";
import { isMatchedByConfiguredRules, pollOutcomeToLegacy } from "../dist/poll-sub-session.js";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("pluginOwnAllowPatterns — 설정과 무관한 자가 허용", () => {
  const paths = {
    hooks: "/opt/mk/src/hooks",
    gates: "/opt/mk/gates",
    scripts: "/opt/mk/scripts",
    stages: "/opt/mk/stages",
    skills: "/home/u/.config/opencode/skills",
  };

  it("다섯 디렉토리를 모두 `/**` 패턴으로 낸다", () => {
    const out = pluginOwnAllowPatterns(paths);
    assert.deepEqual(out, [
      "/opt/mk/src/hooks/**",
      "/opt/mk/gates/**",
      "/opt/mk/scripts/**",
      "/opt/mk/stages/**",
      "/home/u/.config/opencode/skills/**",
    ]);
  });

  it("중복 경로와 후행 슬래시를 정리한다", () => {
    const out = pluginOwnAllowPatterns({ ...paths, gates: "/opt/mk/scripts/", stages: "/opt/mk/scripts" });
    assert.equal(out.filter((p) => p === "/opt/mk/scripts/**").length, 1);
  });

  it("빈 값과 루트는 제외한다 — `/**` 는 파일시스템 전체를 여는 패턴이다", () => {
    const out = pluginOwnAllowPatterns({ ...paths, hooks: "", gates: "/", scripts: "  " });
    assert.ok(!out.includes("/**"));
    assert.ok(!out.some((p) => p.trim() === "/**"));
  });

  it("실제 승인 판정기가 이 패턴으로 state.sh 호출을 통과시킨다", () => {
    // ShellTool.ask 는 `<dir>/*` 형태로 묻는다 (opencode 1.18 실측).
    const asked = ["/opt/mk/scripts/*"];
    assert.equal(isMatchedByConfiguredRules(asked, pluginOwnAllowPatterns(paths)), true);
  });

  it("워크스페이스 밖 임의 경로는 여전히 통과하지 못한다", () => {
    const own = pluginOwnAllowPatterns(paths);
    for (const asked of [["/tmp/*"], ["/home/u/*"], ["/opt/other/*"]]) {
      assert.equal(isMatchedByConfiguredRules(asked, own), false, `${asked[0]} 가 통과했다`);
    }
  });

  it("플러그인 자기 패턴이 사용자 시드보다 앞서 합쳐진다", () => {
    const src = read("src/opencode-plugin.ts");
    assert.match(
      src,
      /const configuredAllowPatterns[\s\S]{0,200}\.\.\.pluginOwnPatterns,[\s\S]{0,120}loadOpencodeExternalDirAllows\(/,
      "자가 허용이 configuredAllowPatterns 에 합쳐지지 않는다 — 부분 설치가 다시 PERMISSION_STALL 로 나타난다",
    );
  });
});

describe("permission_stall — 사유별 처방", () => {
  const base = { kind: "permission_stall" as const, polls: 1, elapsedMs: 1000, stalledMs: 60000 };

  it("허용 경로 밖: /tmp 금지와 대체 경로를 알려준다", () => {
    const r = pollOutcomeToLegacy({
      ...base,
      permissionType: "external_directory",
      permissionPatterns: ["/tmp/*"],
      permissionReason: "outside_allowed_roots",
    });
    assert.equal(r.success, false);
    assert.match(r.text, /\.makdoong2-team\/<이슈키>\/tmp\//, "대체 경로 안내가 없다");
    assert.match(r.text, /\/tmp/, "무엇이 막혔는지 안 알려준다");
  });

  it("external_directory 가 아닌 권한: 경로가 아니라 frontmatter 를 가리킨다", () => {
    const r = pollOutcomeToLegacy({
      ...base,
      permissionType: "edit",
      permissionReason: "non_external_permission",
    });
    assert.match(r.text, /frontmatter/, "에이전트 설정 문제임을 알려주지 않는다");
    assert.ok(!r.text.includes("makdoong2-team/<이슈키>/tmp/"), "경로 처방이 잘못 붙었다");
  });

  it("대상 미상: doctor 를 가리킨다 (부분 설치)", () => {
    const r = pollOutcomeToLegacy({ ...base, permissionReason: "tool_call_stall" });
    assert.match(r.text, /doctor/);
  });

  it("세 사유의 처방이 서로 다르다", () => {
    const texts = (["outside_allowed_roots", "non_external_permission", "tool_call_stall"] as const)
      .map((permissionReason) => pollOutcomeToLegacy({ ...base, permissionReason }).text);
    assert.equal(new Set(texts).size, 3, "사유가 달라도 같은 문장이 나온다 — 뭉개짐이 되돌아왔다");
  });
});

describe("/tmp 가 워크플로우 경로로 새지 않는다", () => {
  it("자격증명 로더가 /tmp 로 폴백하지 않는다", () => {
    const sh = read("skills/_lib/load-secret.sh");
    assert.ok(!/\/tmp\//.test(sh), "load-secret.sh 에 /tmp 폴백이 남아 있다");
    // rm -f /dev/null 은 root 환경에서 장치 노드를 실제로 지운다.
    assert.ok(!/rm -f "?\$jq_err_sink/.test(sh), "sink 를 직접 지우면 /dev/null 을 지울 수 있다");
  });

  it("engineer 프롬프트와 dev 스펙이 임시 파일 경로를 못 박는다", () => {
    for (const p of ["agents/makdoong2-engineer.md", "stages/05-worktree-dev.md"]) {
      const t = read(p);
      assert.match(t, /\.makdoong2-team\/<이슈키>\/tmp\//, `${p} 에 스크래치 경로가 없다`);
      assert.match(t, /\/tmp/, `${p} 에 /tmp 금지 문구가 없다`);
    }
  });
});

// ── primary 세션이 worktree 절대경로를 명령에 싣지 않는다 ────────────────────
// team-leader 는 파일을 고치지 않지만, opencode 는 **bash 명령이 참조하는 디렉토리**
// 마다 external_directory 승인을 묻는다. 그래서 "이 명령을 실행하라" 는 안내에
// worktree 절대경로가 박혀 있으면, 리더가 그대로 따르는 순간 primary 세션이
// 사용자에게 승인을 묻는다 — 정작 다른 모든 동기화는 플러그인이 조용히 처리한다.
describe("primary 세션 안내에 worktree 절대경로가 새지 않는다", () => {
  const src = read("src/opencode-plugin.ts");

  it("state_unreadable 안내가 경로 인자 없는 명령만 제시한다", () => {
    const block = src.slice(src.indexOf('error: "state_unreadable"'));
    const nextAction = block.slice(block.indexOf("next_action:"), block.indexOf("});"));
    assert.ok(
      !/wt-sync-ignored\.sh \$\{effectiveCwd\}/.test(nextAction),
      "리더에게 worktree 경로가 박힌 동기화 명령을 실행시키고 있다",
    );
    assert.ok(
      !/state\.sh init \$\{args\.issue\} \$\{effectiveCwd\}/.test(nextAction),
      "init 안내에 worktree 절대경로가 남아 있다",
    );
    assert.match(nextAction, /state\.sh init \$\{args\.issue\}'/, "경로 없는 init 안내가 없다");
  });

  it("probe 실패 시 플러그인이 동기화를 스스로 1회 시도한다", () => {
    assert.match(
      src,
      /SELF_HEAL/,
      "자가 복구가 없으면 복구를 리더에게 시킬 수밖에 없고, 그 순간 승인 프롬프트가 뜬다",
    );
    const heal = src.slice(src.indexOf("자가 복구 1회"), src.indexOf("SELF_HEAL"));
    assert.match(heal, /wt-sync-ignored\.sh/, "자가 복구가 forward sync 를 부르지 않는다");
    assert.match(heal, /probe = await/, "동기화 후 재probe 를 하지 않으면 복구해도 실패로 반환된다");
  });

  it("리더 프롬프트가 worktree 경로 직접 조회를 금지한다", () => {
    const leader = read("agents/makdoong2-team-leader.md");
    assert.match(leader, /external_directory/, "왜 금지인지 근거가 없다");
    assert.match(leader, /직접 조회\(ls\/cat\/find\)하거나/, "직접 조회 금지 문구가 없다");
    assert.ok(
      !leader.includes("이미 준비된 worktree 경로만 확인하고"),
      "'경로만 확인하고' 문구가 남아 있다 — 조회를 유도한다",
    );
  });
});
