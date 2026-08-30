import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeFileWrite, looksLikeSealedStateWrite } from "../dist/opencode-plugin.js";

describe("looksLikeFileWrite — bash redirect and file-mutation patterns", () => {
  test("blocks plain `>` redirect", () => {
    assert.equal(looksLikeFileWrite("cat foo > bar"), true);
  });
  test("blocks `tee` and `sed -i`", () => {
    assert.equal(looksLikeFileWrite("echo hi | tee file"), true);
    assert.equal(looksLikeFileWrite("sed -i 's/a/b/' file"), true);
  });
  test("allows FD redirects and /dev/null", () => {
    assert.equal(looksLikeFileWrite("cmd 2>/dev/null"), false);
    assert.equal(looksLikeFileWrite("cmd 1>&2"), false);
  });
  test("allows whitelisted git subcommands", () => {
    assert.equal(looksLikeFileWrite("git commit -m 'msg'"), false);
    assert.equal(looksLikeFileWrite("git push origin main"), false);
  });
  test("allows whitelisted state.sh subcommands", () => {
    assert.equal(looksLikeFileWrite("bash scripts/state.sh set ISSUE '.foo' 'true'"), false);
    assert.equal(looksLikeFileWrite("state.sh get ISSUE '.foo'"), false);
  });
});

describe("looksLikeFileWrite — state.json direct-access guard (new)", () => {
  test("blocks python -c writing state.json", () => {
    const cmd = "python3 -c \"open('/w/.makdoong2-team/PROJ-1/state.json','w').write('{}')\"";
    assert.equal(looksLikeFileWrite(cmd), true);
  });
  test("blocks jq piped into state.json redirect", () => {
    const cmd = "jq '.foo=1' /w/.makdoong2-team/PROJ-1/state.json > /tmp/out";
    assert.equal(looksLikeFileWrite(cmd), true);
  });
  test("blocks sed -i on state.json", () => {
    const cmd = "sed -i 's/false/true/' /w/.makdoong2-team/PROJ-1/state.json";
    assert.equal(looksLikeFileWrite(cmd), true);
  });
  test("allows state.sh get on state.json (whitelist)", () => {
    const cmd = "bash scripts/state.sh get PROJ-1 '.stages.\"2_implementation\".substages.\"test\".unit'";
    assert.equal(looksLikeFileWrite(cmd), false);
  });
  test("allows state.sh set on state.json (whitelist)", () => {
    const cmd = "bash scripts/state.sh set PROJ-1 '.foo' '\"bar\"'";
    assert.equal(looksLikeFileWrite(cmd), false);
  });
});

describe("looksLikeSealedStateWrite — sealed sub-agent state.json guard", () => {
  test("blocks direct python edit", () => {
    const cmd = "python3 -c \"open('/w/.makdoong2-team/PROJ-1/state.json','w').write('{}')\"";
    assert.equal(looksLikeSealedStateWrite(cmd), true);
  });
  test("blocks node fs.writeFileSync", () => {
    const cmd = "node -e \"require('fs').writeFileSync('/w/.makdoong2-team/PROJ-1/state.json','{}')\"";
    assert.equal(looksLikeSealedStateWrite(cmd), true);
  });
  test("blocks bash redirect into state.json", () => {
    const cmd = "echo '{}' > /w/.makdoong2-team/PROJ-1/state.json";
    assert.equal(looksLikeSealedStateWrite(cmd), true);
  });
  test("allows state.sh get / set / init on state.json", () => {
    assert.equal(looksLikeSealedStateWrite("state.sh get PROJ-1 '.foo'"), false);
    assert.equal(looksLikeSealedStateWrite("bash scripts/state.sh set PROJ-1 '.foo' 'true'"), false);
    assert.equal(looksLikeSealedStateWrite("state.sh init PROJ-1"), false);
  });
  test("allows state.sh append / migrate (whitelist — internal jq-based writers)", () => {
    assert.equal(
      looksLikeSealedStateWrite("bash scripts/state.sh append PROJ-1 '.stages.\"2_implementation\".substages.\"dev\".hang_history' '{\"a\":1}'"),
      false,
    );
    assert.equal(looksLikeSealedStateWrite("bash scripts/state.sh migrate PROJ-1"), false);
  });
  test("ignores commands without state.json path", () => {
    assert.equal(looksLikeSealedStateWrite("git commit -m 'msg'"), false);
    assert.equal(looksLikeSealedStateWrite("ls -la"), false);
  });

  test("allows read-only diagnostics on state.json (issue #5)", () => {
    // state_unreadable 복구 절차가 요구하는 존재/유효성 확인 명령. 이걸 막으면
    // next_action 을 따를 방법이 사라져 leader 가 자체 abort 한다.
    // 분류 계약 전체는 test/state-access-guard.test.ts 참조.
    const p = "/w/.makdoong2-team/PROJ-1/state.json";
    assert.equal(looksLikeSealedStateWrite(`ls -la ${p}`), false);
    assert.equal(looksLikeSealedStateWrite(`file ${p}; head -c 500 ${p}`), false);
    assert.equal(looksLikeSealedStateWrite(`git check-ignore -v ${p}`), false);
  });
});

describe("looksLikeFileWrite — python/node/cp/mv 추가 패턴", () => {
  test("python -c with open write mode → blocked", () => {
    assert.equal(looksLikeFileWrite("python -c \"open('todo/db.py', 'w').write('data')\""), true);
  });

  test("python3 -c with open append mode → blocked", () => {
    assert.equal(looksLikeFileWrite("python3 -c \"open('file.txt', 'a').write('x')\""), true);
  });

  test("node -e with writeFileSync → blocked", () => {
    assert.equal(looksLikeFileWrite("node -e \"require('fs').writeFileSync('out.txt', 'data')\""), true);
  });

  test("node -e with appendFileSync → blocked", () => {
    assert.equal(looksLikeFileWrite("node -e \"require('fs').appendFileSync('log.txt', 'line')\""), true);
  });

  test("cp command → blocked (read-only agents)", () => {
    assert.equal(looksLikeFileWrite("cp src/foo.ts dist/foo.ts"), true);
  });

  test("mv command → blocked (read-only agents)", () => {
    assert.equal(looksLikeFileWrite("mv old.py new.py"), true);
  });

  test("python -c without file write (read only) → allowed", () => {
    assert.equal(looksLikeFileWrite("python3 -c \"print('hello')\""), false);
  });

  test("node -e without file write → allowed", () => {
    assert.equal(looksLikeFileWrite("node -e \"console.log(JSON.parse(process.argv[1]))\""), false);
  });
});
