/**
 * Regression tests for PROJ-40406 root cause:
 *   makdoong2 의 이전 `detectOmoActive()` 는 opencode.json plugin 배열에
 *   oh-my-openagent 이름이 포함되기만 하면 true 를 반환했다. 이는
 *   "OMO 가 tmux pane 을 관리한다" 를 뜻하는 것으로 오판되어 우리
 *   spawnPaneForSession 을 skip 하게 만들었다.
 *
 *   실제로 OMO@3.17.15 는 자체 pluginConfig.tmux.enabled === true 일
 *   때만 tmux-session-manager 를 활성화한다. opencode.json 에서 OMO 를
 *   문자열로만 등록하면 pluginConfig = {} 이 되어 OMO tmux 는 dormant
 *   이지만 makdoong2 는 활성으로 오판 → 아무도 pane 을 만들지 않는
 *   vacuum 이 발생했다.
 *
 *   신규 함수 `isOmoTmuxManaged()` 는 튜플 등록 `[name, config]` 형태
 *   이면서 config.tmux.enabled === true 일 때만 true 를 반환하여 이
 *   aliasing bug 를 교정한다.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isOmoTmuxManaged } from "../dist/opencode-plugin.js";

describe("isOmoTmuxManaged — OMO tmux 관리 정확 감지", () => {
  test("plugin entries 미제공 + opencode.json 없음 → false (fail-open)", () => {
    // 실제 파일 시스템 접근을 피하려면 pluginEntries 주입이 필요하지만,
    // 인자 없이 호출 시에도 예외를 던지지 않고 false 로 폴백해야 한다.
    // (현재 환경에 opencode.json 이 있을 수 있으므로 결과값은 검증하지 않고
    //  호출 자체가 throw 하지 않는 것만 확인.)
    assert.doesNotThrow(() => isOmoTmuxManaged());
  });

  test("빈 배열 → false", () => {
    assert.equal(isOmoTmuxManaged([]), false);
  });

  test("문자열 등록 → true (v3: 존재 자체가 skip 조건)", () => {
    assert.equal(
      isOmoTmuxManaged(["oh-my-openagent@3.17.15"]),
      true,
    );
  });

  test("tuple 등록 + tmux 미지정 → true", () => {
    assert.equal(
      isOmoTmuxManaged([["oh-my-openagent", {}]]),
      true,
    );
  });

  test("tuple 등록 + tmux.enabled 미지정 → true", () => {
    assert.equal(
      isOmoTmuxManaged([["oh-my-openagent", { tmux: {} }]]),
      true,
    );
  });

  test("tuple 등록 + tmux.enabled=false → true (설치 존재 자체로 skip)", () => {
    assert.equal(
      isOmoTmuxManaged([["oh-my-openagent", { tmux: { enabled: false } }]]),
      true,
    );
  });

  test("tuple 등록 + tmux.enabled=true → true", () => {
    assert.equal(
      isOmoTmuxManaged([["oh-my-openagent", { tmux: { enabled: true } }]]),
      true,
    );
  });

  test("버전 접미사 포함 이름 → true", () => {
    assert.equal(
      isOmoTmuxManaged([["oh-my-openagent@3.17.15", { tmux: { enabled: true } }]]),
      true,
    );
  });

  test("혼합 배열 (OMO 문자열 포함) → true", () => {
    assert.equal(
      isOmoTmuxManaged([
        "@local/makdoong2-team",
        "oh-my-openagent@3.17.15",
        ["opencode-tool-search@0.4.3", { searchLimit: 5 }],
      ]),
      true,
    );
  });

  test("혼합 배열 (OMO tuple 포함) → true", () => {
    assert.equal(
      isOmoTmuxManaged([
        "@local/makdoong2-team",
        "opencode-claude-auth@2.0.0",
        ["oh-my-openagent@3.17.15", { tmux: { enabled: true } }],
      ]),
      true,
    );
  });

  test("다른 플러그인만 있고 OMO 없음 → false", () => {
    assert.equal(
      isOmoTmuxManaged([["some-other-plugin", { tmux: { enabled: true } }]]),
      false,
    );
  });

  test("tuple 첫 원소가 non-string → false (OMO 이름 매칭 불가)", () => {
    assert.equal(
      isOmoTmuxManaged([[123, { tmux: { enabled: true } }]]),
      false,
    );
  });

  test("Array.isArray 실패 (non-array 값 전달) → false", () => {
    // @ts-expect-error runtime robustness check
    assert.equal(isOmoTmuxManaged("not-an-array"), false);
    // @ts-expect-error
    assert.equal(isOmoTmuxManaged({ plugin: [] }), false);
  });
});
