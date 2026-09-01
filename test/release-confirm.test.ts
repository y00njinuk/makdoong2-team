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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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

// ── 커밋 목록 출력이 릴리스를 죽이지 않는다 (SIGPIPE 141) ────────────────────
//
// `git log --oneline "$LAST_TAG..HEAD" | head -20` 은 `set -o pipefail` 아래서
// 커밋이 20개를 넘는 순간 릴리스를 통째로 중단시킨다: head 가 먼저 종료하면 git 이
// SIGPIPE(141)로 죽고 그 코드가 파이프라인 상태가 되어 errexit 가 발화한다.
// "1 파일 = 1 commit" 규약을 지키면 커밋 수는 쉽게 20을 넘으므로, 이 형태가
// 되돌아오면 큰 릴리스마다 재현된다. 실제로 48커밋 릴리스에서 발화했다.
describe("release.sh — 커밋 요약 출력에 SIGPIPE 유발 파이프가 없다", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts/release.sh"), "utf8");

  test("set -o pipefail 이 켜져 있다 (이 테스트의 전제)", () => {
    assert.match(src, /^set -euo pipefail$/m);
  });

  test("git log 를 head 로 자르지 않는다", () => {
    // 주석 줄(`# …`)은 제외한다 — 이 결함을 설명하는 주석 자체가 패턴에 걸린다.
    const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.ok(
      !/git log[^\n|]*\|\s*head/.test(code),
      "git log | head 형태가 남아 있다 — 커밋 20개 초과 릴리스에서 SIGPIPE 로 중단된다",
    );
  });

  test("개수 제한을 git 자체 옵션으로 건다", () => {
    assert.match(src, /git log --oneline -20 "\$\{LAST_TAG\}\.\.HEAD"/);
  });

  test("잘린 개수 안내를 `[ … ] && …` 가 아니라 if 로 쓴다", () => {
    // 조건이 거짓이면 AND 리스트 전체가 1을 반환해 errexit 가 그 자리에서 끝낸다.
    assert.ok(
      !/\[ "\$COMMIT_TOTAL" -gt 20 \] &&/.test(src),
      "AND 리스트 형태는 조건 거짓일 때 릴리스를 중단시킨다",
    );
    assert.match(src, /if \[ "\$COMMIT_TOTAL" -gt 20 \]; then/);
  });

  test("실제로 21개 커밋 이력에서 이 블록이 141 로 죽지 않는다", () => {
    const wt = mkdtempSync(join(tmpdir(), "mkd2-release-log-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: wt, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      writeFileSync(join(wt, "f"), "0");
      git("add", "f");
      git("commit", "-qm", "base");
      git("tag", "v0.0.1");
      for (let i = 0; i < 21; i++) {
        writeFileSync(join(wt, "f"), `content-${i}`);
        git("add", "f");
        git("commit", "-qm", `c${i}`);
      }
      // 수정된 형태를 그대로 떼어 실행한다.
      const snippet = [
        "set -euo pipefail",
        'LAST_TAG="$(git describe --tags --abbrev=0)"',
        'COMMIT_TOTAL="$(git rev-list --count "${LAST_TAG}..HEAD")"',
        'git log --oneline -20 "${LAST_TAG}..HEAD"',
        'if [ "$COMMIT_TOTAL" -gt 20 ]; then echo "... 외 $((COMMIT_TOTAL - 20))개"; fi',
      ].join("\n");
      const out = execFileSync("bash", ["-c", snippet], { cwd: wt, encoding: "utf8" });
      assert.match(out, /외 1개/, "잘린 개수 안내가 나오지 않았다");
      assert.equal(out.trim().split("\n").length, 21, "20줄 + 안내 1줄이어야 한다");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
