// test/entry-artifacts.test.mjs — 진입점 산출물의 계약을 고정한다.
//
// 배경: bin/cli.js · postinstall.mjs · scripts/*.mjs 는 손으로 쓴 JS 가 아니라
// 같은 이름의 .ts / .mts 를 `tsc -p tsconfig.entry.json` 으로 제자리 컴파일한
// 산출물이다 (`npm run build:entry`). 이 방식의 이점은 "파일이 이동하지 않아
// package.json 의 bin/postinstall/files/main/exports 계약과 pkgRoot 경로 계산이
// 그대로 유효하다" 는 것 하나인데, 그 이점은 아래 불변식이 유지될 때만 성립한다.
//
// 그래서 주석이 아니라 테스트로 강제한다:
//   ① 산출물이 계약 경로에 정확히 존재한다
//   ② postinstall.mjs 는 리포 루트 (depth 0) — pkgRoot = 자기 디렉토리
//   ③ bin/cli.js 는 리포 루트/bin (depth 1) — pkgRoot = resolve(HERE, "..")
//   ④ dist/ 에 하위 디렉토리가 없다 (flat-dist 불변식)
//   ⑤ 실행 진입점의 1행이 셰방이다
//   ⑥ 실행 진입점에 exec 비트가 있다
//   ⑦ 산출물이 ESM 이다 ("type":"module" 이 컴파일러 계약이 되었으므로)
//   ⑧ 소스를 out-of-tree 로 재컴파일하면 커밋된 산출물과 바이트가 같다
//
// ⑧ 이 없으면 누가 .mjs 를 직접 고치고 .mts 를 방치해도 아무도 모른다.
// ④ 는 이 이전과 직접 관계는 없지만, src/<하위디렉토리>/x.ts 를 만드는 순간
// dist/<하위>/x.js 가 되어 src/config.ts 의 `join(here, "..")` 가 <pkg>/dist 를
// 가리키는 무성 결함을 막는다 — 에러도 예외도 없이 조용히 틀어지는 부류다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync, statSync, existsSync, readdirSync, mkdtempSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** tsconfig.entry.json 의 `files` 가 계약하는 소스 → 산출물 대응. */
const ARTIFACTS = [
  { src: "bin/cli.ts", out: "bin/cli.js", exec: true },
  { src: "postinstall.mts", out: "postinstall.mjs", exec: true },
  { src: "scripts/install-lib.mts", out: "scripts/install-lib.mjs", exec: false },
  { src: "scripts/model-policy.mts", out: "scripts/model-policy.mjs", exec: false },
  { src: "scripts/smoke-test.mts", out: "scripts/smoke-test.mjs", exec: false },
  { src: "scripts/run-tests.mts", out: "scripts/run-tests.mjs", exec: true },
  { src: "scripts/test-postinstall.mts", out: "scripts/test-postinstall.mjs", exec: true },
];

describe("entry artifacts — 경로/셰방/권한 계약", () => {
  test("① 소스와 산출물이 계약 경로에 모두 존재한다", () => {
    for (const { src, out } of ARTIFACTS) {
      assert.ok(existsSync(join(REPO, src)), `소스 없음: ${src}`);
      assert.ok(
        existsSync(join(REPO, out)),
        `산출물 없음: ${out} — 'npm run build:entry' 를 실행하고 결과를 커밋하라`,
      );
    }
  });

  test("② postinstall.mjs 는 리포 루트에 있다 (pkgRoot = 자기 디렉토리)", () => {
    // postinstall.mts 는 pkgRoot 를 `dirname(import.meta.url)` 로 잡고 `..` 를
    // 붙이지 않는다. 한 단계라도 깊어지면 agents/skills 복사가 ENOENT 로 죽고
    // external_directory 에 <pkg>/dist/** 를 심어 gates/stages 읽기를 조용히
    // 차단하며 캐시 심링크가 dist 를 가리킨다.
    assert.equal(dirname(join(REPO, "postinstall.mjs")), REPO);
    const src = readFileSync(join(REPO, "postinstall.mts"), "utf8");
    assert.match(src, /pkgRoot:\s*HERE\b/, "postinstall 의 pkgRoot 계약이 바뀌었다");
  });

  test("③ bin/cli.js 는 리포 루트/bin 에 있다 (pkgRoot = resolve(HERE, '..'))", () => {
    assert.equal(dirname(join(REPO, "bin/cli.js")), join(REPO, "bin"));
    const src = readFileSync(join(REPO, "bin/cli.ts"), "utf8");
    assert.match(src, /PKG_ROOT\s*=\s*resolve\(HERE,\s*"\.\."\)/);
  });

  test("④ dist/ 에 하위 디렉토리가 없다 (flat-dist 불변식)", () => {
    const dist = join(REPO, "dist");
    if (!existsSync(dist)) return; // 빌드 전이면 검사 대상 없음
    const subdirs = readdirSync(dist, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    assert.deepEqual(
      subdirs, [],
      `dist/ 하위 디렉토리 발견: ${subdirs.join(", ")}\n` +
      `src/ 에 하위 디렉토리를 만들면 dist/<하위>/x.js 가 되어 src/config.ts 의 ` +
      `packageRoot() = join(here, "..") 가 <pkg>/dist 를 가리킨다 (무성 실패).`,
    );
  });

  test("⑤ 실행 진입점의 1행이 셰방이다", () => {
    for (const { out, exec } of ARTIFACTS.filter((a) => a.exec)) {
      const first = readFileSync(join(REPO, out), "utf8").split("\n")[0];
      assert.equal(first, "#!/usr/bin/env node", `${out}: 셰방 유실 (exec=${exec})`);
    }
  });

  test("⑥ 실행 진입점에 exec 비트가 있다", () => {
    for (const { out } of ARTIFACTS.filter((a) => a.exec)) {
      const mode = statSync(join(REPO, out)).mode;
      assert.ok((mode & 0o111) !== 0, `${out}: exec 비트 없음 (mode=${(mode & 0o777).toString(8)})`);
    }
  });

  test("⑦ 산출물이 ESM 이다 — package.json \"type\":\"module\" 이 컴파일러 계약", () => {
    // tsc 는 package.json 의 `type` 을 보고 .ts 의 emit 형식을 정한다. `type` 이
    // 사라지면 CJS 가 나오고, 그 순간 opencode 로더와 node ESM 소비자가 함께 깨진다.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    for (const { out } of ARTIFACTS) {
      const text = readFileSync(join(REPO, out), "utf8");
      assert.match(text, /(^|\n)(import|export)\s/, `${out}: ESM 구문(import/export)이 없다`);
      assert.doesNotMatch(text, /\brequire\(/, `${out}: CJS require( 가 섞였다`);
      assert.doesNotMatch(text, /\bmodule\.exports\b/, `${out}: CJS module.exports 가 섞였다`);
    }
  });

  test("⑦-b scripts/model-policy.mjs 는 import 0개를 유지한다", () => {
    // 이 순수성이 "bin/cli.js 가 dist/ 없이 돈다" 는 성질의 근거다. 여기에
    // import 를 하나라도 들이면 doctor/validate 가 진단 대상에 의존하게 된다.
    const text = readFileSync(join(REPO, "scripts/model-policy.mjs"), "utf8");
    assert.doesNotMatch(text, /(^|\n)import[\s{]/, "model-policy.mjs 에 import 가 생겼다");
    assert.doesNotMatch(text, /\bprocess\./, "model-policy.mjs 가 process 에 의존한다");
  });

  test("⑦-c bin/cli.js 는 dist/ 를 import 하지 않는다", () => {
    // doctor/validate 는 설치가 깨졌을 때 실행하는 진단 도구다. dist/ 는
    // .gitignore 대상이라 빌드 전 체크아웃에서 사라져 있다.
    const text = readFileSync(join(REPO, "bin/cli.js"), "utf8");
    assert.doesNotMatch(text, /from\s+["'][^"']*\bdist\//, "bin/cli.js 가 dist/ 를 import 한다");
  });
});

describe("entry artifacts — 소스와 산출물의 동기화", () => {
  test("⑧ out-of-tree 재컴파일 결과가 커밋된 산출물과 바이트 단위로 같다", () => {
    // 누가 .mjs 를 직접 고치고 .mts 를 방치하면 여기서 잡힌다. 결정성은
    // package-lock.json 이 typescript 버전을 고정하는 것으로 성립한다.
    const outDir = mkdtempSync(join(tmpdir(), "mkd2-entry-"));
    try {
      execFileSync(
        process.execPath,
        [join(REPO, "node_modules", "typescript", "bin", "tsc"),
         "-p", join(REPO, "tsconfig.entry.json"), "--outDir", outDir],
        { cwd: REPO, stdio: "pipe" },
      );
      const stale = [];
      for (const { src, out } of ARTIFACTS) {
        const fresh = join(outDir, out);
        assert.ok(existsSync(fresh), `재컴파일 산출물 없음: ${out}`);
        if (!readFileSync(fresh).equals(readFileSync(join(REPO, out)))) {
          stale.push(`${out}  (소스: ${src})`);
        }
      }
      assert.deepEqual(
        stale, [],
        `커밋된 산출물이 소스와 어긋난다:\n  ${stale.join("\n  ")}\n` +
        `.mjs / .js 는 산출물이다 — 소스(.mts / .ts)를 고치고 'npm run build:entry' 를 실행하라.`,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
