/**
 * state.json 산출물 경로 필드 상대경로 저장 규약 회귀 테스트.
 *
 * 배경: opencode 1.4.17 Read tool 은 worktree 밖 절대경로 접근 시 hang 이 발생한다.
 * 이를 원천 차단하기 위해 draft_path / artifact_path / report_path / plan_path 4개
 * 필드는 반드시 `state.sh root()` 기준 상대경로로 저장해야 한다.
 *
 * 본 테스트가 검증하는 것:
 *   1) stages/*.md 명세에 절대경로 저장 스니펫이 남아있지 않음
 *   2) opencode-plugin.ts dispatch_stage dev 분기가 상대→절대 해석 로직을 프롬프트에 주입함
 *   3) state.sh root() + 상대경로 join 이 어느 cwd 에서든 유효한 절대경로를 반환함
 *   4) wt-sync (FORWARD/REVERSE) 가 상대경로 필드를 손상 없이 양방향 전파함
 *
 * 배경 문서: .sisyphus/plans/2026-07-27-worktree-path-refactor.md
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");
const WTI_SH = join(REPO_ROOT, "scripts", "wt-sync-ignored.sh");
const STAGES_DIR = join(REPO_ROOT, "stages");
const PLUGIN_SRC = join(REPO_ROOT, "src", "opencode-plugin.ts");
const PLUGIN_DIST = join(REPO_ROOT, "dist", "opencode-plugin.js");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function sh(cwd, cmd, ...args) {
  const r = spawnSync(cmd, args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}
function stateSh(cwd, ...args) { return sh(cwd, "bash", STATE_SH, ...args); }
function wtSync(cwd, ...args)  { return sh(cwd, "bash", WTI_SH, ...args); }

function makeMainRepo() {
  const main = mkdtempSync(join(tmpdir(), "makdoong2-path-main-"));
  sh(main, "git", "init", "-q");
  sh(main, "git", "config", "user.email", "test@test.com");
  sh(main, "git", "config", "user.name", "test");
  sh(main, "git", "commit", "--allow-empty", "-m", "init");
  return main;
}
function makeSiblingWorktree(main, issue) {
  const parent = dirname(main);
  const wt = join(parent, `${basename(main)}-${issue}`);
  const r = sh(main, "git", "worktree", "add", wt, "-b", `feature/${issue}`);
  assert.equal(r.code, 0, `git worktree add 실패: ${r.stderr}`);
  return wt;
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) stages/*.md 명세: 절대경로 저장 스니펫 잔존 없음
// ─────────────────────────────────────────────────────────────────────────────

describe("stages/*.md — 절대경로 저장 스니펫 잔존 검증", () => {
  const targetFiles = [
    "01-planning.md", "02-requirements.md", "04-analysis.md",
    "07-commit.md", "09-review-comments.md",
  ];

  for (const f of targetFiles) {
    test(`${f} 는 절대경로 저장 스니펫을 포함하지 않는다`, () => {
      const src = readFileSync(join(STAGES_DIR, f), "utf8");
      const forbidden = [
        `'"<worktree>/.makdoong2-team`,
        `'"<WORKTREE>/.makdoong2-team`,
        `'"<worktree 절대경로>/.makdoong2-team`,
        `\"\\\"$WT/.makdoong2-team`,
      ];
      for (const pat of forbidden) {
        assert.ok(
          !src.includes(pat),
          `${f} 안에 절대경로 저장 스니펫 발견: '${pat}'`,
        );
      }
    });
  }

  test("모든 5개 파일에 상대경로 저장 스니펫 (`'\".makdoong2-team/`) 이 존재한다", () => {
    for (const f of targetFiles) {
      const src = readFileSync(join(STAGES_DIR, f), "utf8");
      assert.ok(
        src.includes(`'".makdoong2-team/`),
        `${f} 안에 상대경로 저장 스니펫이 없다 — Phase 1 미완`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) dispatch_stage dev 분기 프롬프트: 상대→절대 해석 로직 주입
// ─────────────────────────────────────────────────────────────────────────────

describe("opencode-plugin.ts — dispatch_stage dev 분기 상대→절대 해석 로직", () => {
  const src = readFileSync(PLUGIN_SRC, "utf8");

  test("buildDraftPathReadSnippet helper 가 정의됨", () => {
    assert.match(src, /function buildDraftPathReadSnippet\(/,
      "helper 함수 정의 부재 — Phase 2 미완");
  });

  test("helper 는 상대→절대 해석을 위해 state.sh root 를 호출함", () => {
    assert.match(src, /buildDraftPathReadSnippet[\s\S]*?state\.sh root/,
      "helper 안에 state.sh root 호출이 없음 — cwd 종속 hang 재발 위험");
  });

  test("helper 는 legacy 절대경로 마이그레이션 로직을 포함함", () => {
    const match = src.match(/function buildDraftPathReadSnippet\([\s\S]*?\n\}/);
    assert.ok(match, "helper 함수 body 추출 실패");
    const body = match[0];
    assert.match(body, /DRAFT_REL.*==.*\/\*/,
      "절대경로 감지 조건 (`DRAFT_REL == /*`) 이 없음");
    assert.match(body, /\.makdoong2-team\//,
      "마이그레이션 시 상대경로로 변환하는 로직이 없음");
    assert.match(body, /state\.sh set/,
      "마이그레이션 후 state.sh set 으로 재저장하는 로직이 없음");
  });

  test("dev 신규 진입 분기가 helper 를 호출함", () => {
    const devEntryIdx = src.indexOf(`args.target_stage === "2_implementation.dev"`);
    assert.ok(devEntryIdx > 0, "dev 분기 조건이 없음");
    const nearby = src.slice(devEntryIdx, devEntryIdx + 2000);
    assert.match(nearby, /buildDraftPathReadSnippet/,
      "dev 신규 진입 분기가 helper 를 호출하지 않음");
  });

  test("built dist 도 helper 를 포함함", () => {
    if (!existsSync(PLUGIN_DIST)) return;
    const dist = readFileSync(PLUGIN_DIST, "utf8");
    assert.match(dist, /buildDraftPathReadSnippet/,
      "dist 에 helper 가 없음 — npm run build 필요");
    assert.match(dist, /state\.sh root/,
      "dist 에 state.sh root 호출이 없음");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) state.sh root() + 상대경로 join = 유효한 cwd-local 절대경로
// ─────────────────────────────────────────────────────────────────────────────

describe("state.sh root() + 상대경로 join — cwd 독립적 접근", () => {
  test("main repo cwd 에서 root()+상대 join = main-local 절대경로", () => {
    const main = makeMainRepo();
    try {
      const issue = "TEST-REL-1";
      stateSh(main, "init", issue, main);
      const rel = `.makdoong2-team/${issue}/requirements-draft.md`;
      // 물리 파일 생성
      mkdirSync(join(main, ".makdoong2-team", issue), { recursive: true });
      writeFileSync(join(main, rel), "content");
      // state.json 에 상대경로 저장
      stateSh(main, "set", issue,
        `.stages."1_planning".substages."requirements".draft_path`,
        `"${rel}"`);
      // root() 조회
      const rootR = stateSh(main, "root");
      assert.equal(rootR.code, 0);
      const abs = `${rootR.stdout}/${rel}`;
      assert.ok(existsSync(abs), `join 결과 파일 없음: ${abs}`);
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("worktree cwd 에서 root()+상대 join = worktree-local 절대경로 (NOT main)", () => {
    const main = makeMainRepo();
    let wt;
    try {
      const issue = "TEST-REL-2";
      stateSh(main, "init", issue, main);
      wt = makeSiblingWorktree(main, issue);
      // wt-sync 로 worktree 에 .makdoong2-team/ 복사
      const s1 = wtSync(main, wt, issue);
      assert.equal(s1.code, 0, `wt-sync 실패: ${s1.stderr}`);
      // 상대경로 저장 (main repo state.json 에)
      const rel = `.makdoong2-team/${issue}/requirements-draft.md`;
      writeFileSync(join(wt, ".makdoong2-team", issue, "requirements-draft.md"), "content");
      stateSh(wt, "set", issue,
        `.stages."1_planning".substages."requirements".draft_path`,
        `"${rel}"`);
      // worktree cwd 에서 root() 호출
      const rootR = stateSh(wt, "root");
      assert.equal(rootR.code, 0);
      // realpath 정규화 (심볼릭 링크)
      const realWt = sh(wt, "realpath", wt).stdout;
      const realGot = sh(wt, "realpath", rootR.stdout).stdout;
      const realMain = sh(wt, "realpath", main).stdout;
      assert.equal(realGot, realWt, "worktree cwd 에서 root() 는 worktree 를 반환해야 함");
      assert.notEqual(realGot, realMain, "root() 가 main repo 를 반환하면 안 됨 (hang 재발)");
      // join 결과가 worktree-local 파일을 가리키는지
      const abs = `${rootR.stdout}/${rel}`;
      assert.ok(existsSync(abs), `worktree-local join 결과 파일 없음: ${abs}`);
    } finally {
      if (wt) sh(main, "git", "worktree", "remove", "--force", wt);
      rmSync(main, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) wt-sync FORWARD/REVERSE 가 상대경로 필드를 손상 없이 전파
// ─────────────────────────────────────────────────────────────────────────────

describe("wt-sync — 상대경로 필드 양방향 전파", () => {
  test("FORWARD: main → worktree state.json 상대경로 그대로 전파", () => {
    const main = makeMainRepo();
    let wt;
    try {
      const issue = "TEST-REL-3";
      stateSh(main, "init", issue, main);
      wt = makeSiblingWorktree(main, issue);
      // 각 필드에 상대경로 저장 (main repo state.json 에)
      const fields = {
        [`.stages."1_planning".substages."requirements".draft_path`]:
          `.makdoong2-team/${issue}/requirements-draft.md`,
        [`.stages."2_implementation".substages."analysis".artifact_path`]:
          `.makdoong2-team/${issue}/workspace-analysis.json`,
        [`.stages."3_delivery".substages."commit".report_path`]:
          `.makdoong2-team/${issue}/change-report.md`,
        [`.stages."3_delivery".substages."review".plan_path`]:
          `.makdoong2-team/${issue}/review-comment-plan.json`,
      };
      for (const [jq, val] of Object.entries(fields)) {
        stateSh(main, "set", issue, jq, `"${val}"`);
      }
      // FORWARD sync
      const s = wtSync(main, wt, issue);
      assert.equal(s.code, 0, `FORWARD sync 실패: ${s.stderr}`);
      // worktree state.json 에서 각 필드 조회 → 상대경로 그대로여야 함
      for (const [jq, expected] of Object.entries(fields)) {
        const r = stateSh(wt, "get", issue, jq);
        assert.equal(r.stdout, expected,
          `FORWARD sync 후 ${jq}: expected='${expected}', got='${r.stdout}'`);
      }
    } finally {
      if (wt) sh(main, "git", "worktree", "remove", "--force", wt);
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("REVERSE: worktree → main state.json 상대경로 그대로 전파", () => {
    const main = makeMainRepo();
    let wt;
    try {
      const issue = "TEST-REL-4";
      stateSh(main, "init", issue, main);
      wt = makeSiblingWorktree(main, issue);
      wtSync(main, wt, issue);
      const rel = `.makdoong2-team/${issue}/workspace-analysis.json`;
      // worktree state.json 에 상대경로 저장 (analyzer 시나리오)
      stateSh(wt, "set", issue,
        `.stages."2_implementation".substages."analysis".artifact_path`,
        `"${rel}"`);
      // REVERSE sync
      const r = wtSync(wt, "--reverse", wt, issue);
      assert.equal(r.code, 0, `REVERSE sync 실패: ${r.stderr}`);
      // main state.json 에 상대경로 그대로 전파됐는지
      const g = stateSh(main, "get", issue,
        `.stages."2_implementation".substages."analysis".artifact_path`);
      assert.equal(g.stdout, rel,
        `REVERSE sync 후 main 의 artifact_path: expected='${rel}', got='${g.stdout}'`);
    } finally {
      if (wt) sh(main, "git", "worktree", "remove", "--force", wt);
      rmSync(main, { recursive: true, force: true });
    }
  });
});
