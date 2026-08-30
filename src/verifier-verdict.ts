// verifier-verdict.ts — dispatch_verifier 응답의 순수 분류기.
//
// 왜 별도 파일인가: opencode 의 플러그인 로더는 `src/opencode-plugin.ts` 의
// **모든 named export 를 plugin factory 로 호출**한다. 헬퍼를 거기에 export 하면
// 로더가 그것을 팩토리로 부르고 downstream `for (S of hooks) { S.auth }` 에서
// 터진다 (`test/plugin-exports-shape.test.ts` 가 export 집합을 고정한다).
// 그래서 순수 로직은 항상 별도 모듈에 두고 import 한다.
//
// ── 무엇을 고치는가 ────────────────────────────────────────────────────────
// 종전 dispatch_verifier 는 다섯 갈래의 결과를 `verdictSource` 로 **구분해 로그에
// 남기면서도** 툴 반환값의 `verdict` 는 전부 `REJECTED` 하나로 눌러 내보냈다.
// 그래서 호출자(team-leader)는 다음 둘을 구별할 수 없었다:
//
//   (가) 콘텐츠 반려 — verifier 가 실제로 검사하고 산출물을 물렸다.
//        → 올바른 조치: `.done=false` 로 되돌리고 stage 를 재실행한다.
//   (나) 인프라 실패 — verifier 세션이 판정을 내리지 못하고 죽었다.
//        → 올바른 조치: **verifier 만 재실행한다.** stage 산출물은 멀쩡하다.
//
// 실제로 (나)가 (가)로 보고되어, 마커가 전부 정상인 `1_planning.jira` 를
// team-leader 가 통째로 재실행했다 (planner 200초 재가동). 재검증 결과는
// VERIFIED 였다 — 원 작업에는 처음부터 결함이 없었다 (GitHub issue #7).
//
// 구분에 필요한 정보는 이미 전부 있었다. 계약에 반영하지 않았을 뿐이다.

/** verdict 가 어떤 경로로 정해졌는지. 종전에도 로그에는 이 값이 남고 있었다. */
export type VerifierVerdictSource =
  /** 응답에 `<verifier-verdict>` 태그가 있었다 — 유일하게 권위 있는 경로. */
  | "verdict_tag"
  /** 태그는 없지만 본문 JSON 에 `"verdict"` 키가 있었다. */
  | "json_fallback"
  /** 세션은 정상 종료했는데 판정을 못 읽었다 — verifier 출력 형식 위반. */
  | "malformed_output_default"
  /** 세션이 실패했다 (abort / empty / timeout). 판정 자체가 없다. */
  | "session_failed_default"
  /** 세션이 사라졌다 (status_absent / message_stall). 판정 자체가 없다. */
  | "session_gone_default";

/**
 * `ERROR` 는 "검증이 수행되지 않았다" 는 제3의 값이다. `REJECTED`(반려)와
 * 섞으면 안 된다 — 조치가 정반대다.
 */
export type VerifierVerdict = "VERIFIED" | "REJECTED" | "ERROR";

export interface VerifierOutcomeInput {
  /** verifier 세션의 최종 텍스트 (pollOutcomeToLegacy 의 text). */
  raw: string;
  /** pollOutcomeToLegacy 의 success — 세션이 텍스트를 산출했는가. */
  success: boolean;
  /** pollSubSession 이 session_gone 을 반환했는가. */
  sessionGone: boolean;
}

export interface VerifierClassification {
  verdict: VerifierVerdict;
  source: VerifierVerdictSource;
  /** true 면 같은 입력으로 verifier 를 다시 돌리는 것이 올바른 조치다. */
  retryable: boolean;
  /** true 일 때만 `rejected_count` / `same_reason_streak` 에 집계한다. */
  countsAsRejection: boolean;
  /** 사람이 읽는 한 줄 설명 (툴 반환값의 `parsed`). */
  parsed: string;
  /** 호출자가 그대로 따라야 할 조치. 애매하면 여기서 못을 박는다. */
  nextAction: string;
}

const VERDICT_TAG_RE =
  /<verifier-verdict>\s*(VERIFIED|REJECTED)\s*<\/verifier-verdict>/i;
const VERDICT_JSON_RE = /"verdict"\s*:\s*"(VERIFIED|REJECTED)"/i;

const NEXT_ACTION_VERIFIED = "다음 substage 로 진행한다.";

const NEXT_ACTION_REJECTED =
  "검증이 산출물을 반려했다. 해당 substage 의 `.done` 을 false 로 되돌리고 " +
  "dispatch_stage 를 재호출한다 (이전 실패 사유는 프롬프트에 자동 주입된다).";

const NEXT_ACTION_ERROR =
  "검증이 **수행되지 않았다** (verifier 세션 인프라 실패). 같은 인자로 " +
  "dispatch_verifier 만 재호출한다. stage 를 재실행하지 말고 `.done` 을 false 로 " +
  "되돌리지도 말 것 — 판정을 못 얻었을 뿐 stage 산출물은 그대로다. " +
  "verifier 는 idempotent 하므로 재호출이 안전하다.";

/**
 * verifier 세션 결과 → 판정 분류.
 *
 * 판정 태그는 세션 실패보다 우선한다: 태그를 이미 뱉은 뒤 세션 꼬리가 죽었다면
 * 그 판정은 실제로 산출된 것이므로 존중한다.
 *
 * `malformed_output_default`(세션은 살아서 끝났는데 태그가 없음)는 `ERROR` 로
 * 올리지 않고 종전대로 `REJECTED` 를 유지한다 — 형식 위반은 verifier 가 관측
 * 가능한 콘텐츠 결함이고, `same_reason_streak` 이 이미 무한루프를 막는다.
 * 여기서 완화 대상은 판정이 물리적으로 존재하지 않는 두 경로뿐이다.
 */
export function classifyVerifierOutcome(
  input: VerifierOutcomeInput,
): VerifierClassification {
  const tag = input.raw.match(VERDICT_TAG_RE);
  if (tag) {
    const verdict = tag[1].toUpperCase() as "VERIFIED" | "REJECTED";
    return {
      verdict,
      source: "verdict_tag",
      retryable: false,
      countsAsRejection: verdict === "REJECTED",
      parsed: "verdict tag found",
      nextAction: verdict === "VERIFIED" ? NEXT_ACTION_VERIFIED : NEXT_ACTION_REJECTED,
    };
  }

  const json = input.raw.match(VERDICT_JSON_RE);
  if (json) {
    const verdict = json[1].toUpperCase() as "VERIFIED" | "REJECTED";
    return {
      verdict,
      source: "json_fallback",
      retryable: false,
      countsAsRejection: verdict === "REJECTED",
      parsed: `verdict tag missing — extracted from JSON body (${verdict})`,
      nextAction: verdict === "VERIFIED" ? NEXT_ACTION_VERIFIED : NEXT_ACTION_REJECTED,
    };
  }

  if (input.sessionGone || !input.success) {
    const source: VerifierVerdictSource = input.sessionGone
      ? "session_gone_default"
      : "session_failed_default";
    return {
      verdict: "ERROR",
      source,
      retryable: true,
      countsAsRejection: false,
      parsed:
        `verifier session failed — 판정 없음 (${source}): ${input.raw.slice(0, 120)}`,
      nextAction: NEXT_ACTION_ERROR,
    };
  }

  return {
    verdict: "REJECTED",
    source: "malformed_output_default",
    retryable: false,
    countsAsRejection: true,
    parsed: "verdict tag missing — defaulted to REJECTED (verifier output malformed)",
    nextAction: NEXT_ACTION_REJECTED,
  };
}

/**
 * 인프라 실패로 판정을 못 얻은 횟수의 연속 상한.
 *
 * `same_reason_streak`(REJECTED 무한루프 차단)의 ERROR 판 대응물이다. ERROR 는
 * 집계에서 빠지므로 그쪽 상한이 걸리지 않는다 — 별도 상한이 없으면 verifier 만
 * 재호출하는 루프가 영원히 돈다. 3회로 잡은 것은 재호출이 저렴하고(단일 read-only
 * 세션) 3회 연속 실패면 모델·인프라 문제라 자동 재시도로 풀리지 않기 때문이다.
 */
export const VERIFIER_ERROR_STREAK_LIMIT = 3;

/** 이번 결과를 반영한 ERROR 연속 횟수. ERROR 가 아니면 0 으로 리셋된다. */
export function nextVerifierErrorStreak(
  previousStreak: number,
  classification: Pick<VerifierClassification, "verdict">,
): number {
  if (classification.verdict !== "ERROR") return 0;
  const prev = Number.isFinite(previousStreak) && previousStreak > 0 ? previousStreak : 0;
  return prev + 1;
}

/** 상한 도달 여부. 도달하면 team-leader 는 재호출을 멈추고 사용자에게 보고한다. */
export function verifierErrorStreakExceeded(
  streak: number,
  limit: number = VERIFIER_ERROR_STREAK_LIMIT,
): boolean {
  return streak >= limit;
}
