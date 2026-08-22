/**
 * Regression test: isOmoTmuxManaged configDir fallback
 *
 * Bug (BEFORE FIX):
 *   const configDir = process.env.XDG_CONFIG_HOME
 *     ? `${process.env.XDG_CONFIG_HOME}/opencode`
 *     : `${process.env.HOME}/.config/opencode`;
 *
 *   process.env.HOME 가 설정되지 않은 환경(일부 컨테이너/CI)에서
 *   template literal 이 "undefined/.config/opencode" 를 만들어 낸다.
 *
 * Fix (AFTER FIX):
 *   os.homedir() — Node.js 표준 API, HOME 없이도 /etc/passwd fallback 사용.
 *   src/config.ts 가 이미 동일 패턴을 사용하므로 일관성도 확보.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { isOmoTmuxManaged } from "../dist/opencode-plugin.js";

// --------------------------------------------------------------------------
// Test 1 — 전제 조건 증명: HOME 미설정 시 process.env.HOME 보간이 "undefined" 생성
// --------------------------------------------------------------------------
describe("configDir HOME fallback — 전제 조건 및 수정 검증", () => {
  test("HOME 미설정 시 buggy template literal은 'undefined' 문자열을 생성한다 (전제 조건 확인)", () => {
    const origHome = process.env.HOME;
    try {
      delete process.env.HOME;
      // 수정 전 formula: `${process.env.HOME}/.config/opencode`
      // HOME 없으면 undefined → 문자열 "undefined" 로 강제 변환
      const buggyPath = `${process.env.HOME}/.config/opencode`;
      assert.ok(
        buggyPath.startsWith("undefined"),
        `HOME 미설정 시 buggy formula가 "undefined"로 시작해야 함. 실제: "${buggyPath}"`,
      );
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
    }
  });

  test("os.homedir()는 HOME 미설정 시에도 'undefined'를 포함하지 않는 경로를 반환한다", () => {
    const origHome = process.env.HOME;
    try {
      delete process.env.HOME;
      // os.homedir()는 HOME 없으면 /etc/passwd (getpwuid_r) fallback → 실제 홈 경로
      const dir = homedir();
      assert.ok(
        typeof dir === "string" && dir.length > 0,
        `homedir()가 non-empty string을 반환해야 함. 실제: "${dir}"`,
      );
      assert.ok(
        !dir.includes("undefined"),
        `homedir() 결과가 "undefined"를 포함하면 안 됨. 실제: "${dir}"`,
      );
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
    }
  });

  // --------------------------------------------------------------------------
  // Test 2 (primary RED/GREEN) — dist 빌드 산출물 정적 검사
  // --------------------------------------------------------------------------
  test("dist/opencode-plugin.js 에 process.env.HOME 직접 참조가 없어야 한다 (os.homedir() 사용 필수)", () => {
    // RED: 수정 전 — dist에 process.env.HOME 포함 → 이 assert 실패
    // GREEN: 수정 후 rebuild — dist에 process.env.HOME 없음 → 통과
    const distPath = new URL("../dist/opencode-plugin.js", import.meta.url);
    const src = readFileSync(distPath, "utf8");
    assert.ok(
      !src.includes("process.env.HOME"),
      "opencode-plugin.js 빌드 산출물에 process.env.HOME 이 남아 있습니다. " +
        "isOmoTmuxManaged의 configDir fallback을 os.homedir()로 교체했는지 확인하세요.\n" +
        `(발견 위치: 파일 내 첫 번째 매칭 offset: ${src.indexOf("process.env.HOME")})`,
    );
  });

  // --------------------------------------------------------------------------
  // Test 3 — XDG_CONFIG_HOME 경로가 올바르게 동작해야 한다 (behavioral, non-intrusive)
  // --------------------------------------------------------------------------
  test("XDG_CONFIG_HOME 설정 시 해당 경로의 opencode.json 을 읽어 OMO 포함 여부를 반환한다", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "omo-cfgdir-test-"));
    const configDir = join(tmpBase, "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["oh-my-openagent@3.17.15"] }),
    );

    const origXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tmpBase;
      assert.equal(
        isOmoTmuxManaged(),
        true,
        "XDG_CONFIG_HOME 내 opencode.json에 oh-my-openagent 포함 시 true 반환 필요",
      );
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("XDG_CONFIG_HOME 내 opencode.json에 OMO 없으면 false 반환", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "omo-cfgdir-test-"));
    const configDir = join(tmpBase, "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["some-other-plugin"] }),
    );

    const origXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tmpBase;
      assert.equal(
        isOmoTmuxManaged(),
        false,
        "OMO 미포함 opencode.json → false 반환 필요",
      );
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Test 4 — HOME 없는 환경에서 throw 하지 않아야 한다 (안전성 확인)
  // --------------------------------------------------------------------------
  test("HOME 미설정 환경에서 isOmoTmuxManaged() 가 throw 없이 false 를 반환한다", () => {
    const origHome = process.env.HOME;
    const origXdg = process.env.XDG_CONFIG_HOME;
    // 임시 XDG_CONFIG_HOME에 opencode.json 없는 빈 디렉토리 사용
    const tmpBase = mkdtempSync(join(tmpdir(), "omo-nohome-test-"));
    try {
      delete process.env.HOME;
      // XDG_CONFIG_HOME 을 빈 임시 디렉토리로 지정 → opencode.json 없음 → false
      process.env.XDG_CONFIG_HOME = tmpBase;
      let result;
      assert.doesNotThrow(() => {
        result = isOmoTmuxManaged();
      }, "HOME 미설정 시에도 예외를 던지면 안 됩니다");
      assert.equal(result, false, "opencode.json 없는 디렉토리 → false");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
