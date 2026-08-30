// test/doctor-exit-code.test.ts — doctor exit code 회귀 테스트
//
// 결함: bin/cli.js의 configDirChecks 배열에 "skills/makdoong2-team"이 포함되어 있으나
// scripts/install-lib.mjs는 해당 디렉토리를 배포하지 않음
// (소스 내 주석: "workflow is agent-only"). 결과적으로 깨끗한 install 직후에도
// doctor가 항상 exit 1을 반환하는 버그가 있다.
//
// 실증 관찰 (scratch 실행):
//   $ node bin/cli.js install --config /tmp/scratch  → exit 0 (성공)
//   $ node bin/cli.js doctor --config /tmp/scratch   → exit 1
//     "! skills/makdoong2-team/ missing in config dir"
//     "doctor: 1 problem(s) found"
//
//   참고: "research-skill secret unset" 경고는 problems++를 하지 않으므로
//   exit code에 영향 없음 (cli.js 174-182번 라인 확인).
//   그래도 secrets를 더미 값으로 채워 원인을 명확히 한다.
//
// 실행: node --test test/doctor-exit-code.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI = join(REPO_ROOT, "bin", "cli.ts");
const CLI_SRC = readFileSync(CLI, "utf8");

describe("doctor — exit code 회귀 테스트", () => {
  test("(정적) configDirChecks 배열에 'skills/makdoong2-team'이 없어야 한다", () => {
    // install이 배포하지 않는 디렉토리를 doctor가 요구하면 항상 exit 1이 된다.
    // 수정: configDirChecks에서 해당 항목을 제거해야 한다.
    const match = CLI_SRC.match(/const configDirChecks\s*=\s*(\[[\s\S]*?\]);/);
    assert.ok(
      match,
      "bin/cli.js에서 configDirChecks 배열 리터럴을 찾을 수 없음"
    );
    const arrayLiteral = match[1];
    assert.ok(
      !arrayLiteral.includes("skills/makdoong2-team"),
      `configDirChecks에 "skills/makdoong2-team"이 포함되어 있음.\n` +
      `install(scripts/install-lib.mjs)은 이 디렉토리를 배포하지 않으므로\n` +
      `doctor가 깨끗한 install 직후에도 항상 exit 1을 반환한다.\n` +
      `실제 배열 내용: ${arrayLiteral}`
    );
  });

  test("(행동) 격리된 install 후 secrets 채운 상태에서 doctor가 exit 0을 반환해야 한다", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkd2-doctor-exit-test-"));
    try {
      // 1) 격리된 configDir에 install
      const installResult = spawnSync(
        process.execPath,
        [CLI, "install", "--config", tmp],
        { encoding: "utf8" }
      );
      assert.equal(
        installResult.status,
        0,
        `install이 실패함 (exit ${installResult.status}):\n` +
        `${installResult.stdout}${installResult.stderr}`
      );

      // 2) "research-skill secret unset" 경고가 exit code 원인으로 오해받지 않도록
      //    4개 secrets를 더미 비어있지 않은 값으로 채운다.
      //    (실증: 해당 경고는 problems++를 하지 않아 exit code에 영향 없음)
      const cfgPath = join(tmp, "makdoong2-team.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      cfg.secrets = {
        ...cfg.secrets,
        BITBUCKET_API_TOKEN: "dummy-token-for-regression-test",
        JIRA_API_TOKEN: "dummy-token-for-regression-test",
        CONFLUENCE_API_TOKEN: "dummy-token-for-regression-test",
        BAMBOO_TOKEN: "dummy-token-for-regression-test",
      };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

      // 3) doctor 실행 — 깨끗한 install 후 exit 0이어야 한다
      const doctorResult = spawnSync(
        process.execPath,
        [CLI, "doctor", "--config", tmp],
        { encoding: "utf8" }
      );
      const doctorOutput = (doctorResult.stdout || "") + (doctorResult.stderr || "");
      assert.equal(
        doctorResult.status,
        0,
        `doctor가 exit 0을 반환하지 않음 (exit ${doctorResult.status}).\n` +
        `원인: configDirChecks에 install이 배포하지 않는 항목이 있을 가능성 높음.\n` +
        `doctor 전체 출력:\n${doctorOutput}`
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("doctor — opencode.json external_directory 시드 점검 (issue #8)", () => {
  // 설치가 심도록 설계된 permission.external_directory allow 가 opencode.json 에
  // 없으면, 서브에이전트가 워크스페이스 외부 경로(<pkgRoot>/stages/*.md 등)를
  // 읽는 순간 응답 불가한 권한 프롬프트에 걸려 PERMISSION_STALL 로 중단된다.
  // 파일 배포만 성공하고 opencode.json 패치가 남지 않은 부분 설치를 종전
  // doctor 는 정상으로 판정했다 — 이 검사가 그 사각을 메운다.
  test("(정적) doctor 가 computeExternalDirPaths 기반 external_directory 검사를 수행한다", () => {
    assert.match(CLI_SRC, /computeExternalDirPaths/,
      "doctor 가 설치와 같은 함수로 필수 경로를 계산해야 한다 (하드코딩 금지)");
    assert.match(CLI_SRC, /external_directory/,
      "doctor 에 permission.external_directory 검사가 없다");
    assert.match(CLI_SRC, /PERMISSION_STALL/,
      "누락 시 증상(PERMISSION_STALL)을 안내해야 사용자가 이슈 #8 계열임을 알 수 있다");
  });

  test("(행동) external_directory 시드가 없으면 doctor 가 exit 1 + 재설치 안내", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkd2-doctor-extdir-test-"));
    try {
      const installResult = spawnSync(
        process.execPath,
        [CLI, "install", "--config", tmp],
        { encoding: "utf8" }
      );
      assert.equal(installResult.status, 0,
        `install 실패 (exit ${installResult.status}):\n${installResult.stdout}${installResult.stderr}`);

      // 사건 상태 재현: 에이전트 배포는 정상인데 external_directory 시드만 부재.
      const ocPath = join(tmp, "opencode.json");
      const oc = JSON.parse(readFileSync(ocPath, "utf8"));
      assert.ok(oc.permission && oc.permission.external_directory,
        "전제 확인: install 은 external_directory 를 시드해야 한다");
      delete oc.permission.external_directory;
      writeFileSync(ocPath, JSON.stringify(oc, null, 2));

      const doctorResult = spawnSync(
        process.execPath,
        [CLI, "doctor", "--config", tmp],
        { encoding: "utf8" }
      );
      const out = (doctorResult.stdout || "") + (doctorResult.stderr || "");
      assert.equal(doctorResult.status, 1,
        `external_directory 시드 부재를 doctor 가 잡지 못함 (exit ${doctorResult.status}):\n${out}`);
      assert.match(out, /external_directory/, "무엇이 빠졌는지 이름을 짚어야 한다");
      assert.match(out, /makdoong2-team install/, "복구 명령(재설치)을 안내해야 한다");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
