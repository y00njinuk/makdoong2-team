/**
 * Legacy 절대경로 state.json 자동 마이그레이션 회귀 테스트.
 *
 * 배경: 이전 버전 플러그인은 draft_path 등 산출물 경로를 절대경로로 저장했다.
 * refactor 후 dispatch_stage dev 진입 시 프롬프트에 삽입되는 bash 스니펫이
 * legacy 절대경로를 감지하여 상대경로로 자동 재저장한다 (idempotent).
 *
 * 본 테스트는 마이그레이션 로직의 sh 스니펫을 직접 실행하여 검증한다.
 * `src/opencode-plugin.ts` 의 `buildDraftPathReadSnippet` 함수가 프롬프트에 주입하는
 * bash 와 논리적으로 동일한 스니펫을 test harness 에서 실행한다.
 *
 * 배경 문서: .sisyphus/plans/2026-07-27-worktree-path-refactor.md
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const STATE_SH = join(REPO_ROOT, "scripts", "state.sh");

function sh(cwd, cmd, ...args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}
function stateSh(cwd, ...args) { return sh(cwd, "bash", STATE_SH, ...args); }
function makeRepo() {
  const p = mkdtempSync(join(tmpdir(), "makdoong2-migrate-"));
  sh(p, "git", "init", "-q");
  return p;
}

// buildDraftPathReadSnippet 이 프롬프트에 주입하는 bash 스니펫의 마이그레이션 부분과
// 논리적으로 동일한 스니펫. state.sh 의 절대경로 사용 (SCRIPTS_DIR 미주입 환경 대응).
function makeMigrationSnippet(issue, jqPath) {
  return `
set -e
DRAFT_REL=$(bash '${STATE_SH}' get '${issue}' '${jqPath}' | tr -d '"')
if [ -n "$DRAFT_REL" ] && [ "$DRAFT_REL" != "null" ] && [[ "$DRAFT_REL" == /* ]] && [[ "$DRAFT_REL" == */.makdoong2-team/* ]]; then
  DRAFT_REL=".makdoong2-team/\${DRAFT_REL##*/.makdoong2-team/}"
  bash '${STATE_SH}' set '${issue}' '${jqPath}' "\\"$DRAFT_REL\\"" >/dev/null
  echo "migrated:$DRAFT_REL"
else
  echo "no-op:$DRAFT_REL"
fi
`;
}

function runMigration(cwd, issue, jqPath) {
  const snippet = makeMigrationSnippet(issue, jqPath);
  const r = spawnSync("bash", ["-c", snippet], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("legacy 절대경로 감지 및 상대경로로 자동 마이그레이션", () => {
  const JQ = `.stages."1_planning".substages."requirements".draft_path`;

  test("legacy 절대경로 → 상대경로로 정규화", () => {
    const wt = makeRepo();
    try {
      const issue = "TEST-MIG-1";
      stateSh(wt, "init", issue, wt);
      const legacyAbs = `/root/IdeaProjects/some-repo/.makdoong2-team/${issue}/requirements-draft.md`;
      stateSh(wt, "set", issue, JQ, `"${legacyAbs}"`);

      const r = runMigration(wt, issue, JQ);
      assert.equal(r.code, 0, `snippet 실패: ${r.stderr}`);
      assert.match(r.stdout, /^migrated:/,
        `마이그레이션 로그 없음. stdout=${r.stdout}`);

      const after = stateSh(wt, "get", issue, JQ);
      assert.equal(after.stdout, `.makdoong2-team/${issue}/requirements-draft.md`,
        "저장된 값이 상대경로로 변환되지 않았음");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("이미 상대경로 → 마이그레이션 skip (idempotent)", () => {
    const wt = makeRepo();
    try {
      const issue = "TEST-MIG-2";
      stateSh(wt, "init", issue, wt);
      const rel = `.makdoong2-team/${issue}/requirements-draft.md`;
      stateSh(wt, "set", issue, JQ, `"${rel}"`);

      const r = runMigration(wt, issue, JQ);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^no-op:/,
        "이미 상대경로인데 마이그레이션이 발생함");

      const after = stateSh(wt, "get", issue, JQ);
      assert.equal(after.stdout, rel, "상대경로가 손상됨");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("2회 연속 실행 후 결과 불변 (idempotency)", () => {
    const wt = makeRepo();
    try {
      const issue = "TEST-MIG-3";
      stateSh(wt, "init", issue, wt);
      const legacyAbs = `/tmp/some/.makdoong2-team/${issue}/requirements-draft.md`;
      stateSh(wt, "set", issue, JQ, `"${legacyAbs}"`);

      runMigration(wt, issue, JQ);
      const after1 = stateSh(wt, "get", issue, JQ).stdout;
      runMigration(wt, issue, JQ);
      const after2 = stateSh(wt, "get", issue, JQ).stdout;
      assert.equal(after1, after2,
        `2회 실행 후 값이 달라짐: '${after1}' vs '${after2}'`);
      assert.equal(after1, `.makdoong2-team/${issue}/requirements-draft.md`);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("필드 미기록 (null) → 마이그레이션 no-op", () => {
    const wt = makeRepo();
    try {
      const issue = "TEST-MIG-4";
      stateSh(wt, "init", issue, wt);
      // draft_path 필드는 존재하지 않음 (init 은 만들지 않음)

      const r = runMigration(wt, issue, JQ);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^no-op:/,
        "미기록 필드에 마이그레이션이 발생함");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test(".makdoong2-team 접두어를 포함하지 않는 legacy 절대경로 → 안전한 skip", () => {
    // 방어적 케이스: 만약 legacy 가 아예 다른 경로면 마이그레이션 skip 하여
    // 예기치 못한 손상을 방지한다.
    const wt = makeRepo();
    try {
      const issue = "TEST-MIG-5";
      stateSh(wt, "init", issue, wt);
      const weirdAbs = `/some/weird/path/without/marker.md`;
      stateSh(wt, "set", issue, JQ, `"${weirdAbs}"`);

      const r = runMigration(wt, issue, JQ);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^no-op:/,
        ".makdoong2-team 미포함 절대경로에 마이그레이션이 발생함 (손상 위험)");

      const after = stateSh(wt, "get", issue, JQ);
      assert.equal(after.stdout, weirdAbs, "값이 손상됨");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("4개 필드 모두 동일 패턴으로 마이그레이션 가능", () => {
    const wt = makeRepo();
    try {
      const issue = "TEST-MIG-6";
      stateSh(wt, "init", issue, wt);
      const jqPaths = [
        `.stages."1_planning".substages."requirements".draft_path`,
        `.stages."2_implementation".substages."analysis".artifact_path`,
        `.stages."3_delivery".substages."commit".report_path`,
        `.stages."3_delivery".substages."review".plan_path`,
      ];
      const files = [
        "requirements-draft.md",
        "workspace-analysis.json",
        "change-report.md",
        "review-comment-plan.json",
      ];
      // 각 필드에 legacy 절대경로 저장
      jqPaths.forEach((jq, i) => {
        stateSh(wt, "set", issue, jq,
          `"/legacy/repo/.makdoong2-team/${issue}/${files[i]}"`);
      });
      // 각 필드 마이그레이션
      jqPaths.forEach((jq, i) => {
        const r = runMigration(wt, issue, jq);
        assert.equal(r.code, 0, `field=${jq} 실패: ${r.stderr}`);
        assert.match(r.stdout, /^migrated:/, `field=${jq} 마이그레이션 미실행`);
        const after = stateSh(wt, "get", issue, jq);
        assert.equal(after.stdout, `.makdoong2-team/${issue}/${files[i]}`,
          `field=${jq}: expected relative, got '${after.stdout}'`);
      });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
