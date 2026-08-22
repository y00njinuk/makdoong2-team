import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as plugin from "../dist/opencode-plugin.js";

describe("opencode-plugin.js — public exports contract (v0.21.0 shape)", () => {
  test("exports exactly the v0.21.0 set (no extra named exports)", () => {
    const actual = Object.keys(plugin).sort();
    const expected = [
      "Makdoong2TeamPlugin",
      "default",
      "isOmoTmuxManaged",
      "looksLikeFileWrite",
      "looksLikeSealedStateWrite",
      "shouldOverrideEmptyOutcome",
      "shouldOverrideSessionGoneOutcome",
    ];
    assert.deepEqual(
      actual,
      expected,
      "opencode 1.4.x plugin loader iterates through EVERY named export as a factory " +
      "(qq0 → jq0 in opencode binary). Any new export that returns null/undefined when " +
      "called with (context, options) crashes downstream in `for (S of hooks) { S.auth }` " +
      "loop. See PROJ-40406 root-cause analysis. If a new helper is truly needed, add it " +
      "to a NEW file (src/*.ts) and import it — never re-export from opencode-plugin.ts.",
    );
  });

  test("Makdoong2TeamPlugin and default are the same reference (deduplication safety)", () => {
    assert.equal(plugin.Makdoong2TeamPlugin, plugin.default,
      "opencode's plugin loader uses Set-based reference dedup; both entries must point " +
      "to the same factory to avoid being invoked twice.");
  });

  test("every non-plugin export returns a boolean (safe .auth access)", () => {
    assert.equal(typeof plugin.isOmoTmuxManaged(), "boolean");
    assert.equal(typeof plugin.looksLikeFileWrite("ls"), "boolean");
    assert.equal(typeof plugin.looksLikeSealedStateWrite("ls"), "boolean");
    assert.equal(typeof plugin.shouldOverrideEmptyOutcome("text", true, "true"), "boolean");
    assert.equal(typeof plugin.shouldOverrideSessionGoneOutcome("text", true, "true"), "boolean");
  });
});
