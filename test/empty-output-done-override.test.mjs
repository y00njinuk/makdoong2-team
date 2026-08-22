/**
 * Regression tests for PROJ-40406 empty output false negative:
 *   dispatch_stage 는 pollSubSession 이 kind:"empty" (assistant 최종
 *   메시지에 text part 없음) 를 반환하면 ok:false 로 오보고했다. 로컬
 *   LLM(qwen 계열 등)이 tool_call 로 작업을 마치고 최종 text 요약을
 *   생성하지 않는 케이스에서 실제 sub-session 은 정상 완료(파일 생성 등)
 *   했음에도 오류로 보고돼 team-leader 가 재-dispatch 를 시도하는 문제가
 *   발생했다.
 *
 *   신규 pure predicate `shouldOverrideEmptyOutcome` 는 state.json 의
 *   해당 substage `.done=true` 마커가 있으면 성공으로 override 를 지시한다.
 *   sealed subagent 규약상 자기 stage 만 done 처리 가능하고 state.sh
 *   runtime guard 가 직접 편집을 차단하므로 false positive 위험이 낮다.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  shouldOverrideEmptyOutcome,
  shouldOverrideSessionGoneOutcome,
} from "../dist/opencode-plugin.js";

describe("shouldOverrideEmptyOutcome — empty output 시 done 마커 기반 override", () => {
  test("empty + done=true + 현재 실패 → true (override)", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("empty", false, "true"),
      true,
      "sub-agent 가 done 마커를 남겼으면 empty 여도 성공으로 간주.",
    );
  });

  test("empty + done=false → false", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("empty", false, "false"),
      false,
      "done 미완이면 empty 는 실제 실패.",
    );
  });

  test("empty + done 마커 null → false", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("empty", false, null),
      false,
      "state.sh get 실패 (마커 자체 없음) 이면 override 금지.",
    );
  });

  test("empty + done 마커 빈 문자열 → false", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("empty", false, ""),
      false,
    );
  });

  test('done 마커 문자열 "TRUE" → false (엄격 매칭)', () => {
    assert.equal(
      shouldOverrideEmptyOutcome("empty", false, "TRUE"),
      false,
      '대소문자 엄격 매칭. state.sh 출력은 소문자 "true" 만.',
    );
  });

  test("kind:text + done=true → false (이미 성공)", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("text", false, "true"),
      false,
      "empty 케이스만 override 대상. text 는 그대로 사용.",
    );
  });

  test("kind:timeout + done=true → false", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("timeout", false, "true"),
      false,
      "timeout 은 override 하지 않는다 — session 이 정말 안 끝난 것.",
    );
  });

  test("kind:aborted + done=true → false", () => {
    assert.equal(
      shouldOverrideEmptyOutcome("aborted", false, "true"),
      false,
      "aborted 도 override 하지 않는다 — safety limit 초과 등 비정상 종료.",
    );
  });

  test("currentSuccess=true 이면 empty 여도 무시 → false", () => {
    // 방어적 케이스: pollOutcomeToLegacy 는 empty 를 항상 success=false
    // 로 리턴하지만, 미래 로직 변경으로 이미 true 가 들어오면 override
    // 재수행하지 않도록 pre-condition 체크.
    assert.equal(
      shouldOverrideEmptyOutcome("empty", true, "true"),
      false,
    );
  });

  test("done 마커 문자열 앞뒤 공백은 이미 trim 되어 들어와야 함", () => {
    // 호출 지점(dispatch_stage)에서 doneResult.stdout.trim() 후 전달.
    // 함수 자체는 trim 하지 않으므로 공백 포함 값이 들어오면 매칭 실패.
    assert.equal(
      shouldOverrideEmptyOutcome("empty", false, " true "),
      false,
      "trim 은 호출자 책임. 이 함수는 정확한 문자열 매칭만 수행.",
    );
  });
});

/**
 * PROJ-40406 fix — session_gone override.
 *
 * pollSubSession 이 kind:"session_gone" 을 반환해도 sub-agent 가 실제로
 * 작업을 마치고 state.json 의 `.done=true` 를 기록해 둔 경우가 있다
 * (특히 로컬 LLM 이 요약 text 를 생성하지 못한 채 세션 tail 만 사라진 케이스).
 * shouldOverrideSessionGoneOutcome 는 shouldOverrideEmptyOutcome 와 동일한
 * 안전 조건 아래에서 성공으로 override 한다.
 */
describe("shouldOverrideSessionGoneOutcome — session_gone 시 done 마커 기반 override", () => {
  test("session_gone + done=true + 현재 실패 → true (override)", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("session_gone", false, "true"),
      true,
      "sub-agent 가 done 마커를 남겼으면 session_gone 여도 성공으로 간주.",
    );
  });

  test("session_gone + done=false → false", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("session_gone", false, "false"),
      false,
      "done 미완이면 session_gone 은 실제 실패.",
    );
  });

  test("session_gone + done 마커 null → false", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("session_gone", false, null),
      false,
      "state.sh get 실패 (마커 자체 없음) 이면 override 금지.",
    );
  });

  test('session_gone + done 마커 "TRUE" → false (엄격 매칭)', () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("session_gone", false, "TRUE"),
      false,
      '대소문자 엄격 매칭. state.sh 출력은 소문자 "true" 만.',
    );
  });

  test("kind:empty + done=true → false (empty 는 별도 override 함수 사용)", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("empty", false, "true"),
      false,
      "session_gone 케이스만 override 대상. empty 는 shouldOverrideEmptyOutcome 담당.",
    );
  });

  test("kind:timeout + done=true → false", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("timeout", false, "true"),
      false,
      "timeout 은 override 하지 않는다.",
    );
  });

  test("kind:text + done=true → false (이미 성공)", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("text", false, "true"),
      false,
      "session_gone 만 대상.",
    );
  });

  test("currentSuccess=true 이면 session_gone 여도 무시 → false", () => {
    assert.equal(
      shouldOverrideSessionGoneOutcome("session_gone", true, "true"),
      false,
      "이미 성공 판정된 결과는 override 하지 않는다.",
    );
  });
});
