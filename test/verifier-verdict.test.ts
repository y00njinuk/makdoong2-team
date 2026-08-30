/**
 * dispatch_verifier 반환 계약 회귀 — GitHub issue #7.
 *
 * 종전 구현은 다섯 갈래의 결과를 `verdictSource` 로 **구분해 로그에 남기면서도**
 * 툴 반환값의 `verdict` 는 전부 `REJECTED` 하나로 눌러 내보냈다. 그래서 호출자는
 * 다음 둘을 구별할 수 없었다:
 *
 *   (가) 콘텐츠 반려 — verifier 가 실제로 검사하고 산출물을 물렸다.
 *   (나) 인프라 실패 — verifier 세션이 판정을 내리지 못하고 죽었다.
 *
 * 조치가 정반대다. (가)는 stage 재실행, (나)는 verifier 재호출. 실제로 (나)가
 * (가)로 보고되어 마커가 전부 정상인 `1_planning.jira` 가 통째로 재실행됐고
 * (planner 200초), 재검증은 VERIFIED 였다 — 원 작업에는 처음부터 결함이 없었다.
 *
 * 여기서 고정하는 것: 판정이 **물리적으로 존재하지 않는** 두 경로만 ERROR 로
 * 가르고, 나머지는 종전 그대로 둔다는 경계.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVerifierOutcome,
  nextVerifierErrorStreak,
  verifierErrorStreakExceeded,
  VERIFIER_ERROR_STREAK_LIMIT,
} from "../dist/verifier-verdict.js";

const tag = (v) => `<verifier-verdict>${v}</verifier-verdict>`;

describe("classifyVerifierOutcome — 판정 태그가 최우선", () => {
  test("VERIFIED 태그 → VERIFIED, 반려 집계 아님", () => {
    const c = classifyVerifierOutcome({ raw: `검사 완료.\n${tag("VERIFIED")}`, success: true, sessionGone: false });
    assert.equal(c.verdict, "VERIFIED");
    assert.equal(c.source, "verdict_tag");
    assert.equal(c.countsAsRejection, false);
    assert.equal(c.retryable, false);
  });

  test("REJECTED 태그 → REJECTED, 반려로 집계", () => {
    const c = classifyVerifierOutcome({ raw: `마커 누락.\n${tag("REJECTED")}`, success: true, sessionGone: false });
    assert.equal(c.verdict, "REJECTED");
    assert.equal(c.source, "verdict_tag");
    assert.equal(c.countsAsRejection, true);
    assert.equal(c.retryable, false);
  });

  test("태그를 뱉은 뒤 세션이 죽어도 그 판정을 존중한다", () => {
    // 판정은 실제로 산출됐다. 세션 꼬리가 사라졌다는 이유로 버리면 멀쩡한 검증
    // 결과를 재실행으로 되돌리게 된다.
    const c = classifyVerifierOutcome({ raw: tag("VERIFIED"), success: false, sessionGone: true });
    assert.equal(c.verdict, "VERIFIED");
    assert.equal(c.source, "verdict_tag");
  });

  test("대소문자·공백이 섞여도 태그를 읽는다", () => {
    const c = classifyVerifierOutcome({
      raw: "<VERIFIER-VERDICT>  rejected  </VERIFIER-VERDICT>",
      success: true,
      sessionGone: false,
    });
    assert.equal(c.verdict, "REJECTED");
    assert.equal(c.source, "verdict_tag");
  });
});

describe("classifyVerifierOutcome — JSON 폴백", () => {
  test("태그 없이 본문 JSON 의 verdict 를 읽는다", () => {
    const c = classifyVerifierOutcome({
      raw: '{"verdict": "REJECTED", "findings": []}',
      success: true,
      sessionGone: false,
    });
    assert.equal(c.verdict, "REJECTED");
    assert.equal(c.source, "json_fallback");
    assert.equal(c.countsAsRejection, true);
  });
});

describe("classifyVerifierOutcome — 인프라 실패는 ERROR (issue #7 본체)", () => {
  test("세션 실패(preamble_only) → ERROR, 반려 집계에서 제외", () => {
    // 사고 당시의 실제 입력이다.
    const c = classifyVerifierOutcome({
      raw: "(session complete, no text output — preamble_only)",
      success: false,
      sessionGone: false,
    });
    assert.equal(c.verdict, "ERROR", "REJECTED 로 환원하면 stage 전체가 재실행된다");
    assert.equal(c.source, "session_failed_default");
    assert.equal(c.retryable, true);
    assert.equal(c.countsAsRejection, false,
      "rejected_count / same_reason_streak 에 집계되면 안 된다");
  });

  test("session_gone → ERROR, source 가 구분된다", () => {
    const c = classifyVerifierOutcome({
      raw: "(session_gone[message_stall]: ...)",
      success: false,
      sessionGone: true,
    });
    assert.equal(c.verdict, "ERROR");
    assert.equal(c.source, "session_gone_default");
    assert.equal(c.retryable, true);
    assert.equal(c.countsAsRejection, false);
  });

  test("next_action 이 'verifier 만 재호출' 을 명시한다", () => {
    // leader 의 오판(전체 재-dispatch)은 이 안내가 없어서 발생했다. 지시가
    // 반환값에 없으면 모델은 REJECTED 프로토콜을 문자 그대로 적용한다.
    const c = classifyVerifierOutcome({ raw: "(timeout: ...)", success: false, sessionGone: false });
    assert.match(c.nextAction, /dispatch_verifier/);
    assert.match(c.nextAction, /stage 를 재실행하지 말/);
    assert.doesNotMatch(c.nextAction, /dispatch_stage 를 재호출/);
  });

  test("parsed 에 판정 부재와 source 가 드러난다", () => {
    const c = classifyVerifierOutcome({ raw: "(aborted: ...)", success: false, sessionGone: false });
    assert.match(c.parsed, /판정 없음/);
    assert.match(c.parsed, /session_failed_default/);
  });
});

describe("classifyVerifierOutcome — 형식 위반은 ERROR 로 올리지 않는다", () => {
  test("세션은 정상 종료했는데 태그가 없으면 종전대로 REJECTED", () => {
    // 완화 대상은 판정이 물리적으로 없는 경로뿐이다. 형식 위반은 verifier 가
    // 관측 가능한 콘텐츠 결함이고, same_reason_streak 이 이미 루프를 막는다.
    // 여기까지 ERROR 로 올리면 무한 재호출을 여는 대신 아무것도 얻지 못한다.
    const c = classifyVerifierOutcome({
      raw: "검증했고 문제 없어 보입니다. 끝.",
      success: true,
      sessionGone: false,
    });
    assert.equal(c.verdict, "REJECTED");
    assert.equal(c.source, "malformed_output_default");
    assert.equal(c.countsAsRejection, true);
    assert.equal(c.retryable, false);
  });
});

describe("verifier ERROR 연속 상한", () => {
  test("ERROR 가 누적되고 판정을 얻으면 0 으로 리셋된다", () => {
    const err = { verdict: "ERROR" };
    assert.equal(nextVerifierErrorStreak(0, err), 1);
    assert.equal(nextVerifierErrorStreak(1, err), 2);
    assert.equal(nextVerifierErrorStreak(2, { verdict: "VERIFIED" }), 0);
    assert.equal(nextVerifierErrorStreak(2, { verdict: "REJECTED" }), 0);
  });

  test("손상된 이전 값은 0 으로 취급한다", () => {
    const err = { verdict: "ERROR" };
    assert.equal(nextVerifierErrorStreak(NaN, err), 1);
    assert.equal(nextVerifierErrorStreak(-3, err), 1);
  });

  test("상한 도달 시에만 exceeded", () => {
    assert.equal(verifierErrorStreakExceeded(VERIFIER_ERROR_STREAK_LIMIT - 1), false);
    assert.equal(verifierErrorStreakExceeded(VERIFIER_ERROR_STREAK_LIMIT), true);
    assert.equal(verifierErrorStreakExceeded(VERIFIER_ERROR_STREAK_LIMIT + 1), true);
  });

  test("ERROR 는 same_reason_streak 과 독립된 상한을 갖는다", () => {
    // ERROR 가 반려 집계에서 빠지므로 same_reason_streak 은 영영 오르지 않는다.
    // 별도 상한이 없으면 verifier 재호출 루프가 무한히 돈다.
    assert.notEqual(VERIFIER_ERROR_STREAK_LIMIT, 0);
    const c = classifyVerifierOutcome({ raw: "(timeout)", success: false, sessionGone: false });
    assert.equal(c.countsAsRejection, false);
  });
});
