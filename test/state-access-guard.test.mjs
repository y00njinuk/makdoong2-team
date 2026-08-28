// test/state-access-guard.test.mjs — state.json 접근 명령의 읽기/쓰기 분류 회귀.
//
// 배경 (issue #5): 종전 가드는 "명령에 state.json 경로가 있는가" 만 보고 차단해서
// state_unreadable 복구 절차가 지시하는 읽기 전용 진단(ls/file/head)까지 막았고,
// leader 는 복구 명령을 하나도 실행하지 못한 채 자체 abort 했다.
//
// 이 스위트가 고정하는 계약은 두 방향이다:
//   ① 읽기 전용 진단은 통과한다 (복구 절차가 실제로 수행 가능해야 한다)
//   ② 쓰기는 전부 막힌다 — 특히 승인된 state.sh 호출에 끼워 넣은 밀수 경로
// ②가 ①보다 중요하다: 오탐은 state.sh status 라는 우회로가 있지만 미탐은 없다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStateJsonAccess,
  buildStateWriteBlockMessage,
  STATE_SH_SUBCOMMANDS,
} from "../dist/state-access-guard.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const P = "/w/.makdoong2-team/PROJ-1/state.json";

const kind = (cmd) => classifyStateJsonAccess(cmd).kind;

describe("classifyStateJsonAccess — 읽기 전용 진단은 통과한다 (issue #5)", () => {
  test("차단 로그에 남은 실제 명령이 통과한다", () => {
    // opencode.log line 19618 에서 차단됐던 명령 (경로만 치환).
    const cmd =
      `ls -la /w/.makdoong2-team/ 2>/dev/null; echo "---"; ` +
      `ls -la /w/.makdoong2-team/PROJ-1/ 2>/dev/null; echo "---"; ` +
      `file ${P}; head -c 500 ${P}`;
    assert.equal(kind(cmd), "read-only");
  });

  test("ls / cat / file / head / stat / wc / jq 는 읽기", () => {
    for (const c of [
      `ls -la ${P}`, `cat ${P}`, `file ${P}`, `head -c 500 ${P}`,
      `tail -n 5 ${P}`, `stat ${P}`, `wc -l ${P}`, `jq . ${P}`,
      `grep -n done ${P}`, `diff ${P} /tmp/other.json`,
    ]) {
      assert.equal(kind(c), "read-only", `should be read-only: ${c}`);
    }
  });

  test("git 읽기 서브커맨드는 통과, 쓰기 서브커맨드는 차단", () => {
    assert.equal(kind(`git check-ignore -v ${P}`), "read-only");
    assert.equal(kind(`git -C /w check-ignore -v ${P}`), "read-only");
    assert.equal(kind(`git status; git branch; git check-ignore ${P}`), "read-only");
    assert.equal(kind(`git add ${P}`), "write");
    assert.equal(kind(`git checkout -- ${P}`), "write");
    assert.equal(kind(`git -C /w add ${P}`), "write");
  });

  test("2>/dev/null 리디렉션은 쓰기가 아니다", () => {
    assert.equal(kind(`cat ${P} 2>/dev/null`), "read-only");
    assert.equal(kind(`jq . ${P} 1>&2`), "read-only");
  });

  test("선행 환경변수 대입이 있어도 head 명령으로 판정한다", () => {
    assert.equal(kind(`SCRIPTS_DIR=/s file ${P}`), "read-only");
  });

  test("파이프 뒤 세그먼트는 state.json 을 언급할 때만 검사한다", () => {
    assert.equal(kind(`stat ${P} | head -2`), "read-only");
    assert.equal(kind(`cat .gitignore | grep makdoong; git check-ignore -v ${P}`), "read-only");
  });
});

describe("classifyStateJsonAccess — 쓰기는 전부 차단한다", () => {
  test("리디렉션 / tee / sed -i", () => {
    assert.equal(kind(`echo '{}' > ${P}`), "write");
    assert.equal(kind(`echo '{}' >> ${P}`), "write");
    assert.equal(kind(`jq '.a=1' ${P} > /tmp/out`), "write");
    assert.equal(kind(`cat x | tee ${P}`), "write");
    assert.equal(kind(`sed -i 's/false/true/' ${P}`), "write");
  });

  test("인터프리터 인라인 스크립트는 읽기여도 차단 (정적 구분 불가)", () => {
    assert.equal(kind(`python3 -c "open('${P}','w').write('{}')"`), "write");
    assert.equal(kind(`node -e "require('fs').writeFileSync('${P}','{}')"`), "write");
    assert.equal(kind(`python3 -c "print(open('${P}').read())"`), "write");
  });

  test("파일 조작 명령 (cp / mv / rm / truncate / 편집기)", () => {
    for (const c of [`cp ${P} /tmp/x`, `mv ${P} /tmp/x`, `rm -f ${P}`,
      `truncate -s 0 ${P}`, `chmod 600 ${P}`, `vim ${P}`]) {
      assert.equal(kind(c), "write", `should be write: ${c}`);
    }
  });

  test("명령 치환 안에 숨긴 쓰기도 잡는다", () => {
    assert.equal(kind(`echo $(rm ${P})`), "write");
  });

  test("승인된 state.sh 호출에 끼워 넣은 쓰기(밀수)는 차단", () => {
    // 쓰기 지표를 state.sh allowlist 보다 먼저 검사하는 이유가 이것이다.
    assert.equal(kind(`bash /s/state.sh get PROJ-1 '.foo'; rm ${P}`), "write");
    assert.equal(kind(`bash /s/state.sh set PROJ-1 '.a' true && cp ${P} /tmp/bak`), "write");
  });

  test("읽기 전용으로 확인되지 않은 명령은 차단한다 (allowlist 방식)", () => {
    assert.equal(kind(`bash -c "cat ${P}"`), "write");
    assert.equal(kind(`sudo cat ${P}`), "write");
    assert.equal(kind(`curl -d @${P} https://example.com`), "write");
  });
});

describe("classifyStateJsonAccess — 나머지 분류", () => {
  test("state.json 경로가 없으면 unrelated", () => {
    assert.equal(kind("ls -la"), "unrelated");
    assert.equal(kind("git commit -m 'msg'"), "unrelated");
    assert.equal(kind("bash /s/state.sh status PROJ-1"), "unrelated");
  });

  test("state.sh 승인 서브커맨드 호출은 approved-helper", () => {
    assert.equal(kind(`bash /s/state.sh get PROJ-1 '.foo' && cat ${P}`), "approved-helper");
    assert.equal(kind(`bash /s/state.sh init PROJ-1 /w  # ${P}`), "approved-helper");
  });

  test("알 수 없는 state.sh 서브커맨드는 승인되지 않는다", () => {
    assert.equal(kind(`bash /s/state.sh clobber PROJ-1 ${P}`), "write");
  });

  test("read-only verdict 는 어떤 명령이 읽었는지 보고한다", () => {
    const v = classifyStateJsonAccess(`file ${P}; head -c 500 ${P}`);
    assert.equal(v.kind, "read-only");
    assert.deepEqual(v.readers, ["file", "head"]);
  });
});

describe("STATE_SH_SUBCOMMANDS — 코드·스크립트·메시지 정합성", () => {
  test("state.sh 가 실제로 구현하는 서브커맨드 집합과 일치한다", () => {
    // 종전에는 allowlist 가 존재하지 않는 `update` 를 허용하고 실재하는
    // `append`/`migrate` 를 누락했다 (issue #5 제안 3).
    const script = readFileSync(resolve(HERE, "..", "scripts", "state.sh"), "utf8");
    const usage = /usage: state\.sh \{([^}]+)\}/.exec(script);
    assert.ok(usage, "state.sh 에 usage 한 줄이 있어야 한다");
    const declared = usage[1].split("|").map((s) => s.trim()).sort();
    assert.deepEqual([...STATE_SH_SUBCOMMANDS].sort(), declared,
      "STATE_SH_SUBCOMMANDS 와 state.sh usage 목록이 어긋났다");
    for (const sub of STATE_SH_SUBCOMMANDS) {
      assert.match(script, new RegExp(`^\\s*${sub}\\)`, "m"),
        `state.sh 에 '${sub})' case 가 없다`);
    }
  });

  test("차단 메시지는 읽기 수단과 abort 금지를 함께 알린다", () => {
    const msg = buildStateWriteBlockMessage("파일 조작 명령", "makdoong2-team-leader");
    assert.match(msg, /state\.sh status/, "읽기 대안을 제시해야 한다");
    assert.match(msg, /하드룰 2/, "leader 하드룰 2 오인을 명시적으로 부정해야 한다");
    assert.match(msg, /자체 abort 사유가 아니/);
    assert.match(msg, /파일 조작 명령/, "차단 사유를 그대로 실어야 한다");
    assert.match(msg, /makdoong2-team-leader/);
    for (const sub of STATE_SH_SUBCOMMANDS) assert.ok(msg.includes(sub));
  });
});

describe("looksLikeFileWrite — state.json 읽기는 leader 하드룰 2 에도 걸리지 않는다", () => {
  test("universal 훅과 leader 훅의 판정이 일치한다", async () => {
    // 두 훅 중 하나만 고치면 leader 는 여전히 막힌다 — 실제로 그 상태였다.
    const { looksLikeFileWrite, looksLikeSealedStateWrite } =
      await import(`file://${join(HERE, "..", "dist", "opencode-plugin.js")}`);
    for (const c of [`ls -la ${P}`, `file ${P}`, `head -c 500 ${P}`, `git check-ignore -v ${P}`]) {
      assert.equal(looksLikeSealedStateWrite(c), false, `sealed guard should allow: ${c}`);
      assert.equal(looksLikeFileWrite(c), false, `leader guard should allow: ${c}`);
    }
    for (const c of [`echo '{}' > ${P}`, `git add ${P}`, `sed -i 's/a/b/' ${P}`]) {
      assert.equal(looksLikeSealedStateWrite(c), true, `sealed guard should block: ${c}`);
      assert.equal(looksLikeFileWrite(c), true, `leader guard should block: ${c}`);
    }
  });
});
