// test/shell-portability.test.mjs — 셸 스크립트 크로스 플랫폼 회귀 테스트
//
// 배경:
//   scripts/rollback-commits.sh 에 `취소된 커밋 $N개` 가 있었다. bash 는 `$NAME`
//   의 변수명을 legal_variable_char = isalnum() 로 "바이트 단위" 판정하는데,
//   Darwin libc 는 UTF-8 로케일에서 "개"(EA B0 9C) 의 첫 바이트 0xEA 를 alnum 으로
//   보고한다. 그 결과 변수명이 N + 0xEA 가 되어 `set -u` 아래에서 unbound variable
//   로 즉시 죽었다. glibc 는 상위 바이트를 alnum 으로 보지 않으므로 Linux 에서는
//   멀쩡히 동작한다 — 즉 Ubuntu CI 로는 절대 잡히지 않는 macOS 전용 런타임 버그다.
//
// 그래서 런타임이 아니라 정적으로 막는다. `${NAME}` 로 감싸면 어느 libc 에서든
// 파싱이 명확해진다.
//
// Run via: node --test test/shell-portability.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

// 패키지에 실제로 실려나가거나 개발 중 실행되는 셸/스크립트 트리만 검사한다.
const SCAN_DIRS = ["gates", "scripts", "skills", "src", "bin", ".husky"];
const SCAN_EXTS = [".sh", ".mjs", ".ts", ".js"];

/** SCAN_DIRS 아래의 SCAN_EXTS 파일을 모두 수집 (dist/ 및 node_modules 제외) */
function collectFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    let entries;
    try {
      if (!statSync(abs).isDirectory()) continue;
      entries = readdirSync(abs, { recursive: true, withFileTypes: true });
    } catch {
      continue;                       // 없는 디렉토리는 조용히 건너뛴다
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const parent = e.parentPath ?? e.path;
      if (parent.includes("node_modules") || parent.includes(`${REPO_ROOT}/dist`)) continue;
      if (!SCAN_EXTS.some((ext) => e.name.endsWith(ext))) continue;
      out.push(join(parent, e.name));
    }
  }
  return out;
}

// `$NAME` (중괄호 없음) 바로 뒤에 non-ASCII 바이트가 오는 경우.
// `${NAME}` 형태와 `$1` 같은 위치 인자는 매칭되지 않는다.
const UNBRACED_BEFORE_NON_ASCII = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g;

describe("셸 변수 확장 이식성", () => {
  test("`$VAR` 바로 뒤에 non-ASCII 문자가 오면 안 된다 (${VAR} 로 감쌀 것)", () => {
    const violations = [];

    for (const file of collectFiles()) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, idx) => {
        for (const m of line.matchAll(UNBRACED_BEFORE_NON_ASCII)) {
          violations.push({
            file: relative(REPO_ROOT, file),
            line: idx + 1,
            name: m[1],
            snippet: line.trim().slice(0, 120),
          });
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      "unbraced 변수 뒤에 non-ASCII 문자가 붙어 있다. Darwin libc 는 UTF-8 로케일에서\n" +
        "멀티바이트 첫 바이트를 isalnum() 으로 보고하므로 bash 가 변수명에 포함시켜\n" +
        "`unbound variable` 로 죽는다 (glibc/Linux 에서는 재현되지 않음).\n" +
        "`${VAR}` 로 감싸서 고칠 것:\n" +
        violations.map((v) => `  ${v.file}:${v.line}  $${v.name}  ->  ${v.snippet}`).join("\n"),
    );
  });
});
