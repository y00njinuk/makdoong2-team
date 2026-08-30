// test/model-policy-parity.test.ts — 정본과 CLI 미러의 동치를 강제한다.
//
// ── 왜 필요한가 ──
// 모델 정책은 두 벌로 존재한다.
//   - 정본:  src/model-fallback-policy.ts  → dist/model-fallback-policy.js
//            (플러그인 런타임. 모듈 전역을 mutate 하고, 실패하면 롤백 + 로그)
//   - 미러:  scripts/model-policy.mts      → scripts/model-policy.mjs
//            (bin/cli.js 의 doctor/validate. 순수 함수 · import 0개 · throw)
//
// 미러가 존재하는 이유는 정당하다 — doctor/validate 는 설치가 깨졌을 때 실행하는
// 진단 도구인데, 정본은 `logger → config` 를 끌고 오고 config 는 진단 대상 설정
// (`logging.mode="file"` + path 누락)에서 throw 한다. 진단 도구가 진단 대상 때문에
// 죽으면 안 된다. 그래서 미러는 유지한다.
//
// 문제는 **동치를 아무도 검증하지 않았다**는 것이다. scripts/smoke-test 는 미러만
// import 하면서 주석으로는 "정본과의 일치를 검증한다" 고 주장했다(거짓). 그 결과
// 초기 커밋부터 로직이 갈려 있었고, 실제로 세 가지가 관측됐다:
//
//   ① `allowed_primaries` 를 배열이 아닌 문자열로 쓰면 —
//      validate 는 `OK ✓  engineer → claude-sonnet-4.6` 을 출력하는데
//      런타임은 TypeError 로 전체 롤백해 gpt-5.6-luna 를 썼다. CLI 가 실제로
//      쓰일 모델을 **적극적으로 오보**했다.
//   ② 잘못된 tier 라벨(`"ultra"`)을 정본은 통과시켰다. `TIER_RANK["ultra"]` 가
//      undefined 라 `NaN >= 2` 가 false 가 되어 "폴백은 primary 보다 낮아야 한다"
//      가 조용히 무력화됐다. 미러는 잡았다.
//   ③ `fallback_models: [{}]` 을 정본은 `{tier:"low"}`(id 없음)로 만들었고,
//      그것이 dist/model-chain-cli.js → with-fallback.sh 의 `jq -r ".[$i].id"`
//      에서 `null` 이 되어 **`opencode --model null`** 이 실행됐다. 미러는 throw.
//
// 이 스위트는 "둘이 같은 입력에 같은 판정을 내리는가" 를 매트릭스로 고정한다.
// 데이터 테이블(허용 목록·기본 정책)의 동일성도 함께 본다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALLOWED_PRIMARIES as MIRROR_ALLOWED,
  DEFAULT_POLICIES as MIRROR_POLICIES,
  buildPoliciesFromConfig,
} from "../scripts/model-policy.mjs";

import {
  DEFAULT_ALLOWED_PRIMARIES as CANON_ALLOWED,
  POLICIES as CANON_POLICIES,
  applyConfigOverrides,
} from "../dist/model-fallback-policy.js";

/** 정본은 전역을 mutate 하므로 매 케이스마다 스냅샷을 뜨고 되돌린다. */
function withCanonicalSnapshot(fn) {
  const snapshot = JSON.parse(JSON.stringify(CANON_POLICIES));
  try {
    return fn();
  } finally {
    for (const k of Object.keys(CANON_POLICIES)) delete CANON_POLICIES[k];
    for (const [k, v] of Object.entries(snapshot)) CANON_POLICIES[k] = v;
    applyConfigOverrides(undefined, { allowed_primaries: [] }); // 확장 목록 초기화
  }
}

/**
 * 같은 설정을 양쪽에 먹이고 "거부했는가 / 적용 결과가 무엇인가" 를 비교 가능한
 * 모양으로 돌려준다. 정본은 throw 대신 롤백하므로 "정책이 기본값 그대로인가" 로
 * 거부를 판정한다.
 */
function evaluate(cfg) {
  const mirror = (() => {
    try {
      const { policies } = buildPoliciesFromConfig(cfg);
      return { rejected: false, policies };
    } catch (e) {
      return { rejected: true, message: e.message };
    }
  })();

  const canonical = withCanonicalSnapshot(() => {
    const before = JSON.stringify(CANON_POLICIES);
    applyConfigOverrides(cfg.agents, cfg.model_policy);
    const after = JSON.stringify(CANON_POLICIES);
    return { rejected: before === after, policies: JSON.parse(after) };
  });

  return { mirror, canonical };
}

describe("model policy — 데이터 테이블 동일성", () => {
  test("DEFAULT_ALLOWED_PRIMARIES 가 완전히 같다", () => {
    assert.deepEqual([...MIRROR_ALLOWED].sort(), [...CANON_ALLOWED].sort());
  });

  test("기본 정책의 에이전트 집합과 체인이 같다", () => {
    assert.deepEqual(Object.keys(MIRROR_POLICIES).sort(), Object.keys(CANON_POLICIES).sort());
    for (const agent of Object.keys(MIRROR_POLICIES)) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(MIRROR_POLICIES[agent])),
        JSON.parse(JSON.stringify(CANON_POLICIES[agent])),
        `${agent}: 체인이 갈렸다`,
      );
    }
  });
});

describe("model policy — 잘못된 설정에 대한 판정 동치", () => {
  const REJECT_CASES = [
    {
      name: "① allowed_primaries 가 배열이 아니다 (CLI 가 모델을 오보하던 케이스)",
      cfg: {
        model_policy: { allowed_primaries: "github-copilot/claude-sonnet-4.6" },
        agents: { "makdoong2-engineer": { model: "github-copilot/claude-sonnet-4.6" } },
      },
    },
    {
      name: "② tier 라벨이 유효하지 않다 (정본이 조용히 통과시키던 케이스)",
      cfg: {
        agents: {
          "makdoong2-engineer": {
            model: "local/qwen3.6-27b",
            fallback_models: [{ id: "github-copilot/claude-haiku-4.5", tier: "ultra" }],
          },
        },
      },
    },
    {
      name: "③ fallback 항목에 id 가 없다 (--model null 로 이어지던 케이스)",
      cfg: {
        agents: {
          "makdoong2-engineer": { model: "local/qwen3.6-27b", fallback_models: [{}] },
        },
      },
    },
    {
      name: "허용 목록 밖의 primary",
      cfg: { agents: { "makdoong2-engineer": { model: "rogue-provider/rogue-model" } } },
    },
    {
      name: "폴백 tier 가 primary 보다 낮지 않다",
      cfg: {
        agents: {
          "makdoong2-engineer": {
            model: "local/qwen3.6-27b",
            fallback_models: [{ id: "github-copilot/claude-haiku-4.5", tier: "medium" }],
          },
        },
      },
    },
  ];

  for (const { name, cfg } of REJECT_CASES) {
    test(`양쪽 다 거부한다 — ${name}`, () => {
      const { mirror, canonical } = evaluate(cfg);
      assert.equal(mirror.rejected, true, "미러(CLI)가 통과시켰다 — validate 가 OK 를 낸다");
      assert.equal(canonical.rejected, true, "정본(런타임)이 통과시켰다");
    });
  }
});

describe("model policy — 정상 설정에 대한 결과 동치", () => {
  const ACCEPT_CASES = [
    { name: "빈 설정", cfg: {} },
    {
      name: "primary + 문자열 폴백",
      cfg: {
        agents: {
          "makdoong2-engineer": {
            model: "github-copilot/claude-sonnet-4.6",
            fallback_models: ["github-copilot/claude-haiku-4.5"],
          },
        },
      },
    },
    {
      name: "객체 폴백 {id, tier}",
      cfg: {
        agents: {
          "makdoong2-planner": {
            model: "github-copilot/claude-sonnet-4.6",
            fallback_models: [{ id: "github-copilot/claude-haiku-4.5", tier: "low" }],
          },
        },
      },
    },
    {
      name: "allowed_primaries 로 허용 목록 확장",
      cfg: {
        model_policy: { allowed_primaries: ["custom-provider/custom-model"] },
        agents: {
          "makdoong2-engineer": {
            model: "custom-provider/custom-model",
            fallback_models: ["github-copilot/claude-haiku-4.5"],
          },
        },
      },
    },
    {
      name: "여러 에이전트 동시 오버라이드",
      cfg: {
        agents: {
          "makdoong2-engineer": { model: "github-copilot/claude-sonnet-4.6" },
          "makdoong2-planner": { model: "github-copilot/gpt-5.5" },
        },
      },
    },
  ];

  for (const { name, cfg } of ACCEPT_CASES) {
    test(`양쪽이 같은 체인을 낸다 — ${name}`, () => {
      const { mirror, canonical } = evaluate(cfg);
      assert.equal(mirror.rejected, false, `미러가 거부: ${mirror.message}`);

      // 정본은 "변화 없음" 을 거부로 판정하므로, 오버라이드가 없는 빈 설정은
      // 양쪽 모두 기본값이면 통과로 본다.
      const mirrorJson = JSON.parse(JSON.stringify(mirror.policies));
      assert.deepEqual(
        mirrorJson, canonical.policies,
        "같은 설정인데 CLI 가 보여주는 체인과 런타임이 실제로 쓰는 체인이 다르다",
      );
    });
  }
});
