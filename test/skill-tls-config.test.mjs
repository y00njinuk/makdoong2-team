// test/skill-tls-config.test.mjs — 사내 엔드포인트 접속의 TLS 검증 설정.
//
// ── 결함 ──
// 4개 스킬 런처(jira / confluence / bitbucket / bamboo)가 전부 무조건
//
//     export NODE_TLS_REJECT_UNAUTHORIZED="0"
//
// 를 했다. 그 프로세스는 사용자의 사내 PAT 를 들고 사내 Jira/Confluence/
// Bitbucket/Bamboo 로 나가므로, **인증서 검증을 끈 채 자격증명을 전송**하는
// 상태였다 — 중간자 공격에 무방비다.
//
// ── 왜 그냥 지우지 않았나 ──
// 사내 사설 CA 때문에 넣은 것으로 보이고, 그렇다면 검증을 켜는 순간 사용자의
// 조사 스킬이 전부 죽는다. 그래서 동작을 깨지 않는 쪽으로 고쳤다:
//   ca_bundle 지정 → NODE_EXTRA_CA_CERTS + 검증 켬  (사설 CA 의 정답)
//   tls_reject_unauthorized=true → 검증 켬
//   둘 다 없음 → 종전 동작 유지 + **매 기동 경고**
//
// 이 스위트가 고정하는 것은 "런처가 직접 끄지 않는다" 와 "네 갈래가 의도대로
// 동작한다" 두 가지다.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const LIB = join(REPO, "skills", "_lib", "load-secret.sh");

/** 헬퍼를 source 한 뒤 결과 환경을 돌려준다. */
function probe(configObj) {
  const cfgDir = mkdtempSync(join(tmpdir(), "makdoong2-tls-"));
  if (configObj !== null) {
    writeFileSync(join(cfgDir, "makdoong2-team.json"), JSON.stringify(configObj));
  }
  const script = `
    . "${LIB}"
    configure_tls_from_makdoong2_config "probe"
    printf 'REJECT=%s\\n' "\${NODE_TLS_REJECT_UNAUTHORIZED:-<unset>}"
    printf 'CA=%s\\n' "\${NODE_EXTRA_CA_CERTS:-<unset>}"
  `;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, MAKDOONG2_CONFIG_DIR: cfgDir },
  });
  const get = (k) => (new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout) ?? [])[1];
  return { reject: get("REJECT"), ca: get("CA"), warn: r.stderr, cfgDir };
}

describe("런처는 TLS 검증을 직접 끄지 않는다", () => {
  test("run-*.sh 에 NODE_TLS_REJECT_UNAUTHORIZED 직접 export 가 없다", () => {
    const skillsDir = join(REPO, "skills");
    const offenders = [];
    for (const skill of readdirSync(skillsDir)) {
      const dir = join(skillsDir, skill);
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const f of entries.filter((n) => /^run-.*\.sh$/.test(n))) {
        const src = readFileSync(join(dir, f), "utf8");
        const active = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
        if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(active)) offenders.push(`${skill}/${f}`);
        assert.match(active, /configure_tls_from_makdoong2_config/, `${skill}/${f}: 헬퍼 호출 없음`);
      }
    }
    assert.deepEqual(offenders, [], "런처가 검증을 직접 끄고 있다 — 헬퍼를 쓸 것");
  });
});

describe("configure_tls_from_makdoong2_config — 네 갈래", () => {
  test("설정 없음 → 종전 동작(검증 끔) + 경고", () => {
    const r = probe(null);
    assert.equal(r.reject, "0", "동작을 깨지 않아야 한다");
    assert.match(r.warn, /경고/, "위험을 알리지 않으면 영원히 그대로 남는다");
    assert.match(r.warn, /ca_bundle/, "고치는 방법을 알려줘야 한다");
  });

  test("tls_reject_unauthorized=true → 검증 켬", () => {
    const r = probe({ network: { tls_reject_unauthorized: true } });
    assert.equal(r.reject, "<unset>");
    assert.equal(r.ca, "<unset>");
  });

  test("ca_bundle 지정 (파일 실재) → NODE_EXTRA_CA_CERTS + 검증 켬", () => {
    const dir = mkdtempSync(join(tmpdir(), "makdoong2-ca-"));
    const ca = join(dir, "corp-ca.pem");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\n");
    const r = probe({ network: { ca_bundle: ca } });
    assert.equal(r.ca, ca);
    assert.equal(r.reject, "<unset>", "CA 를 알려줬으면 검증을 켜야 한다");
  });

  test("ca_bundle 경로 오류 → 종전 동작 + 원인 표시", () => {
    const r = probe({ network: { ca_bundle: "/nonexistent/corp-ca.pem" } });
    assert.equal(r.reject, "0");
    assert.match(r.warn, /찾을 수 없다/);
  });
});

describe("설정 스키마", () => {
  test("`network` 블록이 스키마에 등록돼 있다 (additionalProperties:false)", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO, "assets", "makdoong2-team.schema.json"), "utf8"),
    );
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties.network, "등록하지 않으면 설정 파일이 스키마 위반이 된다");
    const np = schema.properties.network.properties;
    assert.ok(np.ca_bundle && np.tls_reject_unauthorized);
  });
});
