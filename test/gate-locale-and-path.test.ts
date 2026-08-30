// test/gate-locale-and-path.test.ts — 로케일·경로·파일명 때문에 게이트가
// 구조적으로 차단되는 결함의 회귀.
//
// 세 결함 모두 배포 대상(Ubuntu WSL2 + 한글 커밋 규약)에서만 드러나고 개발기
// (macOS, LANG=ko_KR.UTF-8, ASCII 경로)에서는 재현되지 않아 정적 이식성 검사
// (test/shell-portability.test.ts)로도 잡히지 않았다. 그래서 여기서는 텍스트를
// 훑는 대신 **실제로 실행해서** 동작을 고정한다.
//
//  ① worktree 경로 파싱: `awk '/^worktree /{print $2}'` 는 첫 공백에서 자른다.
//     WSL2 의 /mnt/c/Users/<이름 공백>/… 은 Windows 사용자명에 공백이 흔하고,
//     이 한 줄이 wt-sync-ignored.sh 와 게이트 4곳에 복제돼 있어 동시에 오작동한다.
//  ② 커밋 제목 길이: `wc -m` 은 로케일 기준이라 LANG 없는 셸(WSL2 non-login 에서
//     흔하다)에서 바이트 수가 된다. 한글 제목 17자만 넘어도 "50자 초과" 로
//     영구 재작업 루프에 빠진다.
//  ③ 한글 파일명: git 의 core.quotePath 기본값이 비ASCII 를 "\355\225\234…" 로
//     escape 하므로 `grep -qxF "$F"` 가 원문 UTF-8 과 절대 매치되지 않는다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const sh = (script, opts = {}) =>
  spawnSync("bash", ["-c", script], { encoding: "utf8", ...opts });

describe("① worktree 경로 파싱 — 공백이 든 경로를 자르지 않는다", () => {
  const PORCELAIN = "worktree /mnt/c/Users/First Last/proj/main repo\\nHEAD abc123\\n";

  test("현재 구현이 공백 경로를 온전히 돌려준다", () => {
    const r = sh(`printf '${PORCELAIN}' | sed -n 's|^worktree ||p' | head -1`);
    assert.equal(r.stdout.trim(), "/mnt/c/Users/First Last/proj/main repo");
  });

  test("종전 구현(awk $2)은 실제로 잘렸다 — 회귀 기준선", () => {
    const r = sh(`printf '${PORCELAIN}' | awk '/^worktree /{print $2; exit}'`);
    assert.equal(r.stdout.trim(), "/mnt/c/Users/First");
  });

  test("파싱하는 파일 전부가 sed 형태를 쓴다", () => {
    // 한 곳만 고치면 나머지 게이트가 그대로 어긋난다. 다섯 곳이 같은 줄이다.
    const files = [
      "scripts/wt-sync-ignored.sh",
      "gates/stage4-dev-verify.sh",
      "gates/stage5-test-verify.sh",
      "gates/stage6-post-commit-verify.sh",
      "gates/stage7-pr-verify.sh",
    ];
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(join(REPO, f), "utf8");
      if (!/worktree list --porcelain/.test(src)) continue;
      if (/print \$2/.test(src)) offenders.push(f);
      assert.match(src, /sed -n 's\|\^worktree \|\|p'/, `${f}: sed 형태가 아니다`);
    }
    assert.deepEqual(offenders, [], "awk $2 파싱이 남아 있다");
  });
});

describe("② 커밋 제목 길이 — 로케일과 무관하게 문자 수로 센다", () => {
  const SUBJ = "Feat: PROJ-1 - 한글제목입니다";
  const CHARS = String(SUBJ.length);                              // 22
  const BYTES = String(Buffer.byteLength(SUBJ, "utf8"));          // 36
  const COUNT = `printf '%s' "$SUBJ" | LC_ALL=C tr -d '\\200-\\277' | LC_ALL=C wc -c | tr -d '[:space:]'`;

  for (const locale of ["en_US.UTF-8", "C", "POSIX"]) {
    test(`LC_ALL=${locale} 에서 문자 수(${CHARS})를 센다`, () => {
      const r = sh(COUNT, { env: { ...process.env, SUBJ, LC_ALL: locale, LANG: locale } });
      assert.equal(r.stdout.trim(), CHARS, `${locale}: 로케일에 따라 값이 달라졌다`);
    });
  }

  test("종전 구현(wc -m)은 구현에 따라 답이 갈린다 — 회귀 기준선", () => {
    // 이 결함은 플랫폼 비대칭이다 (실측):
    //   macOS(BSD wc)           → LC_ALL=C 에서 바이트 수(36)
    //   Ubuntu 26.04(uutils wc) → 모든 로케일에서 문자 수(22)
    // 즉 **개발기에서만** 한글 제목이 3배로 세어졌고 배포 대상에서는 재현되지
    // 않았다. 그래서 어느 쪽 값을 기대할지 하드코딩하면 다른 플랫폼에서 이
    // 테스트 자체가 깨진다 — "둘 중 하나" 를 단언하고, 우리 방식이 그 갈림에
    // 무관하다는 것만 위 케이스들이 고정한다.
    assert.notEqual(BYTES, CHARS, "한글이 없으면 이 회귀 기준선이 무의미하다");
    const r = sh(`printf '%s' "$SUBJ" | wc -m | tr -d '[:space:]'`,
      { env: { ...process.env, SUBJ, LC_ALL: "C", LANG: "C" } });
    assert.ok(
      [BYTES, CHARS].includes(r.stdout.trim()),
      `wc -m 이 예상 밖의 값을 냈다: ${r.stdout.trim()} (기대: ${BYTES} 또는 ${CHARS})`,
    );
  });

  test("게이트 소스에 wc -m 이 남아 있지 않다", () => {
    const src = readFileSync(join(REPO, "gates/stage6-post-commit-verify.sh"), "utf8");
    assert.doesNotMatch(src, /\|\s*wc -m\b/, "wc -m 은 로케일 의존이다");
    assert.match(src, /tr -d '\\200-\\277'/, "연속 바이트 제거 방식이 아니다");
  });
});

describe("③ 한글 파일명 — core.quotePath 로 escape 되지 않는다", () => {
  function repoWithKoreanFile() {
    const wt = mkdtempSync(join(tmpdir(), "makdoong2-qp-"));
    spawnSync("git", ["init", "-q"], { cwd: wt });
    spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: wt });
    spawnSync("git", ["config", "user.name", "t"], { cwd: wt });
    writeFileSync(join(wt, "한글파일.txt"), "x\n");
    spawnSync("git", ["add", "한글파일.txt"], { cwd: wt });
    return wt;
  }

  test("quotePath=false 면 staged 목록이 원문 UTF-8 이다", () => {
    const wt = repoWithKoreanFile();
    const r = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--cached", "--name-only"],
      { cwd: wt, encoding: "utf8" });
    assert.equal(r.stdout.trim(), "한글파일.txt");
  });

  test("기본값에서는 escape 되어 grep -qxF 가 실패했다 — 회귀 기준선", () => {
    const wt = repoWithKoreanFile();
    const r = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: wt, encoding: "utf8" });
    assert.notEqual(r.stdout.trim(), "한글파일.txt");
    assert.match(r.stdout, /\\3\d\d/, "octal escape 형태여야 결함이 재현된 것");
  });

  test("dev_post 게이트의 파일명 비교가 전부 quotePath=false 다", () => {
    const src = readFileSync(join(REPO, "gates/stage4-dev-post-verify.sh"), "utf8");
    const gitReads = src
      .split("\n")
      .filter((l) => /git -C "\$WT"/.test(l) && /(--name-only|ls-files)/.test(l));
    assert.ok(gitReads.length >= 3, "검사 대상 git 호출을 찾지 못했다");
    for (const line of gitReads) {
      assert.match(line, /-c core\.quotePath=false/, `quotePath 미지정: ${line.trim()}`);
    }
  });
});
