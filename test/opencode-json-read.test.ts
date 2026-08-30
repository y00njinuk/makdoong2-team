// test/opencode-json-read.test.ts — 런타임이 opencode.json 을 실제로 읽는지,
// 그리고 install 이 쓰는 파서와 읽는 파서가 같은 동작인지 고정한다.
//
// ── 결함 ──
// 플러그인은 서브세션의 permission 요청을 자동 승인/거부할 때
// `permission.external_directory` 의 allow 목록을 참고한다. 그런데 그 목록을
//
//     const externalDirConfig = (config as any).permission?.external_directory ?? {};
//
// 로 만들었다. 여기서 `config` 는 `loadConfig()` = **makdoong2-team.json** 이고,
// 그 스키마에는 `permission` 키가 아예 없다 (additionalProperties:false).
// `permission.external_directory` 는 **opencode.json** 에 있다 — install-lib 의
// `computeExternalDirPaths()` 가 거기에 쓴다.
//
// 결과: `configuredAllowPatterns` 가 **항상 빈 배열**이었다. 사용자가 opencode.json
// 에 명시적으로 allow 해 둔 외부 디렉터리도 인식되지 않아, 서브세션이 그 경로를
// 요청하면 "outside worktree scope" 로 auto-reject 됐다.
//
// ── 파서 동치 ──
// 쓰는 쪽(scripts/install-lib.mjs:parseJsonc)과 읽는 쪽(dist/config.js:
// parseJsoncLoose)이 갈리면 "install 은 성공했다는데 런타임이 못 읽는" 상태가 된다.
// install-lib 은 bin/cli 의 dist-무의존 성질 때문에 dist 를 import 할 수 없어
// 공용 모듈로 합칠 수 없다 — 그래서 동치를 테스트로 강제한다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsoncLoose, loadOpencodeExternalDirAllows } from "../dist/config.js";
import { parseJsonc } from "../scripts/install-lib.mjs";

/** XDG_CONFIG_HOME 을 임시 디렉터리로 돌린 뒤 opencode.json 을 심는다. */
function withOpencodeJson(text, fn) {
  const base = mkdtempSync(join(tmpdir(), "makdoong2-ocjson-"));
  mkdirSync(join(base, "opencode"), { recursive: true });
  if (text !== null) writeFileSync(join(base, "opencode", "opencode.json"), text);
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = base;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

describe("loadOpencodeExternalDirAllows — opencode.json 을 읽는다", () => {
  test("allow 로 표시된 패턴만 돌려준다", () => {
    const oc = JSON.stringify({
      permission: {
        external_directory: {
          "/opt/pkg/**": "allow",
          "/home/u/.config/opencode/**": "allow",
          "/etc/secrets/**": "deny",
          "/tmp/**": "ask",
        },
      },
    });
    const got = withOpencodeJson(oc, () => loadOpencodeExternalDirAllows());
    assert.deepEqual(got.sort(), ["/home/u/.config/opencode/**", "/opt/pkg/**"]);
  });

  test("makdoong2-team.json 이 아니라 opencode.json 에서 읽는다", () => {
    // 종전 구현이 보던 자리에 값을 넣어도 잡히면 안 된다.
    const base = mkdtempSync(join(tmpdir(), "makdoong2-wrongfile-"));
    mkdirSync(join(base, "opencode"), { recursive: true });
    writeFileSync(
      join(base, "opencode", "makdoong2-team.json"),
      JSON.stringify({ permission: { external_directory: { "/wrong/**": "allow" } } }),
    );
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = base;
    try {
      assert.deepEqual(loadOpencodeExternalDirAllows(), [],
        "makdoong2-team.json 의 permission 은 스키마에 없는 키다 — 읽으면 안 된다");
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });

  test("JSONC (주석 · 후행 쉼표) 도 읽는다 — opencode 가 그렇게 파싱한다", () => {
    const oc = `{
      // 사내 도구 경로
      "permission": {
        "external_directory": {
          "/opt/pkg/**": "allow",   /* 블록 주석 */
        },
      },
    }`;
    assert.deepEqual(withOpencodeJson(oc, () => loadOpencodeExternalDirAllows()), ["/opt/pkg/**"]);
  });

  test("파일 부재 · 손상 JSON 은 빈 배열 (throw 하지 않는다)", () => {
    assert.deepEqual(withOpencodeJson(null, () => loadOpencodeExternalDirAllows()), []);
    assert.deepEqual(withOpencodeJson("{ broken", () => loadOpencodeExternalDirAllows()), []);
  });

  test("external_directory 가 없으면 빈 배열", () => {
    assert.deepEqual(
      withOpencodeJson(JSON.stringify({ plugin: ["makdoong2-team"] }), () => loadOpencodeExternalDirAllows()),
      [],
    );
  });
});

describe("JSONC 파서 동치 — 쓰는 쪽(install-lib)과 읽는 쪽(config)", () => {
  const SAMPLES = [
    '{"a":1}',
    '{\n  // line comment\n  "a": 1\n}',
    '{ "a": 1, /* block */ "b": [1,2,] , }',
    '{"url":"https://x/y // not-a-comment","s":"a/*b*/c"}',
    '{"esc":"a\\"b // still string","n":null}',
    '{\n  "plugin": ["makdoong2-team"],\n  "tools": { "verify_stage": true, },\n}',
    '{"permission":{"external_directory":{"/a/**":"allow"}}}',
  ];

  for (const [i, src] of SAMPLES.entries()) {
    test(`샘플 ${i + 1} 이 같은 값으로 파싱된다`, () => {
      assert.deepEqual(parseJsoncLoose(src), parseJsonc(src), src);
    });
  }

  test("둘 다 같은 입력에서 실패한다", () => {
    for (const bad of ["{ broken", "", "[1,2"]) {
      let a = null, b = null;
      try { parseJsoncLoose(bad); } catch (e) { a = "throw"; }
      try { parseJsonc(bad); } catch (e) { b = "throw"; }
      assert.equal(a, b, `실패 여부가 갈렸다: ${JSON.stringify(bad)}`);
    }
  });
});
