// test/release-confirm.test.ts — 릴리스 승인 프롬프트(scripts/lib/confirm.sh) 회귀.
//
// 배경 (실제로 릴리스를 막았던 결함):
//   confirm() 이 `read -r reply </dev/tty` 로 읽었다. 제어 터미널이 없는 환경
//   (에이전트 셸, 컨테이너, CI)에서는 /dev/tty 열기가 실패한다 — macOS 는
//   "Device not configured". 그런데 read 실패 시 reply 가 빈 값이라 case 가 `*` 로
//   떨어져 "거부" 로 처리됐고, 호출부는 "사용자가 거부함" 을 찍었다. 물어보지도
//   못한 것과 거부당한 것이 구별되지 않아 원인이 은폐됐다.
//
//   publish-if-changed.sh 의 `[ ! -e /dev/tty ]` 가드도 존재만 검사해 무력했다 —
//   macOS 에서 /dev/tty 는 존재하지만 열리지 않으므로 가드를 통과한 뒤 같은 실패.
//
// 그래서 고정한다: stdin 전용, 그리고 종료 코드 2(물어볼 수 없음)를 1(거부)과 분리.
//
// Run via: node --test test/release-confirm.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const LIB = join(REPO_ROOT, "scripts/lib/confirm.sh");

/**
 * confirm() 을 격리 실행하고 종료 코드를 돌려준다.
 * @param {string|null} stdin - 전달할 입력. null 이면 stdin 을 즉시 닫아 EOF 를 만든다.
 * @param {Record<string,string>} env - 추가 환경변수
 */
function runConfirm(stdin, env = {}) {
  const script = `. "${LIB}"; confirm "테스트 승인"; echo "RC=$?"`;
  try {
    const out = execFileSync("bash", ["-c", script], {
      input: stdin ?? "",
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const m = out.match(/RC=(\d+)/);
    return { rc: m ? Number(m[1]) : -1, out };
  } catch (e) {
    return { rc: -1, out: String(e.stdout ?? "") };
  }
}

describe("confirm() — stdin 기반 승인", () => {
  test("y / yes 는 승인(0)", () => {
    assert.equal(runConfirm("y\n").rc, 0);
    assert.equal(runConfirm("yes\n").rc, 0);
    assert.equal(runConfirm("Y\n").rc, 0);
  });

  test("n / 빈 줄 / 그 외는 거부(1)", () => {
    assert.equal(runConfirm("n\n").rc, 1);
    assert.equal(runConfirm("\n").rc, 1);
    assert.equal(runConfirm("아무거나\n").rc, 1);
  });

  test("stdin 이 EOF 면 '물어볼 수 없음'(2) — 거부(1)와 구별된다", () => {
    // 이것이 핵심 회귀. 예전 구현은 여기서 1(거부)을 반환해 원인을 은폐했다.
    assert.equal(runConfirm(null).rc, 2);
  });

  test("CONFIRM_AUTO_YES=1 은 입력 없이 승인(0)", () => {
    assert.equal(runConfirm(null, { CONFIRM_AUTO_YES: "1" }).rc, 0);
  });
});

describe("confirm_unavailable() — 안내 메시지", () => {
  test("재실행 명령과 파이프 우회를 stderr 로 안내한다", () => {
    const script = `. "${LIB}"; confirm_unavailable "npm run release:minor" 2>&1`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
    assert.match(out, /npm run release:minor/);
    assert.match(out, /printf 'y/);
    assert.match(out, /거부당한 것이 아니라/);
  });
});

describe("릴리스 스크립트가 /dev/tty 에 의존하지 않는다", () => {
  const scripts = ["scripts/release.sh", "scripts/publish-if-changed.sh", "scripts/lib/confirm.sh"];

  for (const rel of scripts) {
    test(`${rel} 에 /dev/tty 참조가 없다`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      // 주석의 설명 문구는 허용하고, 실제 리다이렉트/테스트만 잡는다.
      const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      assert.ok(!code.includes("/dev/tty"), `${rel} 코드에 /dev/tty 가 남아 있다`);
    });
  }

  test("두 스크립트가 confirm 을 각자 정의하지 않고 lib 를 source 한다", () => {
    // 예전에는 각자 복사본을 들고 있었고, 그래서 한쪽에만 (틀린) TTY 가드가 있었다.
    for (const rel of ["scripts/release.sh", "scripts/publish-if-changed.sh"]) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      assert.ok(/lib\/confirm\.sh/.test(src), `${rel} 이 lib/confirm.sh 를 source 하지 않는다`);
      assert.ok(!/^confirm\(\)\s*\{/m.test(src), `${rel} 이 confirm 을 자체 정의하고 있다`);
    }
  });
});
