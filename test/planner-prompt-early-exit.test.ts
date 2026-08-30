import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANNER_MD = resolve(HERE, "..", "agents", "makdoong2-planner.md");
const PROMPT = readFileSync(PLANNER_MD, "utf8");

describe("planner.md — early-exit guard for already-done substage (regression: PROJ-40406)", () => {
  test("has '0-exit' section header with mandatory-check marker", () => {
    assert.match(
      PROMPT,
      /###\s+0-exit\..*이미 완료된 경우.*필수/,
      "planner.md must contain a '0-exit' section marked as 필수 (mandatory)",
    );
  });

  test("0-exit section instructs immediate session termination on done=true", () => {
    assert.match(
      PROMPT,
      /즉시.*종료/,
      "0-exit must instruct '즉시 종료' (immediate termination) on done=true",
    );
    assert.match(
      PROMPT,
      /\[EARLY-EXIT\]/,
      "0-exit must define an [EARLY-EXIT] output tag",
    );
  });

  test("0-exit references auto_advance_stage as the recovery path", () => {
    assert.match(
      PROMPT,
      /auto_advance_stage/,
      "0-exit must instruct 부장님 to call auto_advance_stage",
    );
  });

  test("each substage section (§1/§2/§3) has a 선행 skip 체크", () => {
    const jiraSection = PROMPT.split("## §1. Substage: jira")[1]?.split("## §2.")[0] ?? "";
    const reqSection = PROMPT.split("## §2. Substage: requirements")[1]?.split("## §3.")[0] ?? "";
    const scopeSection = PROMPT.split("## §3. Substage: scope")[1]?.split("## 완료 조건")[0] ?? "";

    assert.ok(jiraSection.length > 0, "must find §1 jira section");
    assert.ok(reqSection.length > 0, "must find §2 requirements section");
    assert.ok(scopeSection.length > 0, "must find §3 scope section");

    for (const [name, section] of [
      ["§1 jira", jiraSection],
      ["§2 requirements", reqSection],
      ["§3 scope", scopeSection],
    ]) {
      assert.match(section, /선행 skip 체크/, `${name} must reference '선행 skip 체크'`);
      assert.match(section, /0-exit/, `${name} skip check must point back to 0-exit`);
    }
  });

  test("§1 jira skip check queries jira.done", () => {
    const jiraSection = PROMPT.split("## §1. Substage: jira")[1]?.split("## §2.")[0] ?? "";
    assert.match(
      jiraSection,
      /\.stages\."1_planning"\.substages\."jira"\.done/,
      "§1 skip check must query hierarchical jira.done path",
    );
  });

  test("§2 requirements skip check queries requirements.done", () => {
    const reqSection = PROMPT.split("## §2. Substage: requirements")[1]?.split("## §3.")[0] ?? "";
    assert.match(
      reqSection,
      /\.stages\."1_planning"\.substages\."requirements"\.done/,
      "§2 skip check must query hierarchical requirements.done path",
    );
  });

  test("§3 scope skip check queries scope.done", () => {
    const scopeSection = PROMPT.split("## §3. Substage: scope")[1]?.split("## 완료 조건")[0] ?? "";
    assert.match(
      scopeSection,
      /\.stages\."1_planning"\.substages\."scope"\.done/,
      "§3 skip check must query hierarchical scope.done path",
    );
  });

  test("has '0-final' section requiring textual summary before session end", () => {
    assert.match(
      PROMPT,
      /###\s+0-final\./,
      "planner.md must contain a '0-final' section enforcing textual output",
    );
    assert.match(
      PROMPT,
      /outcome_kind=empty/,
      "0-final must explain the empty-output failure mode",
    );
  });
});
