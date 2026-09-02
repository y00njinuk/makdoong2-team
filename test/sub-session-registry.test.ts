// 프로세스 전역 서브세션 레지스트리 — GitHub issue #10 회귀.
//
// opencode 1.18 은 디렉토리(Instance)마다 플러그인을 따로 초기화한다. worktree
// 서브세션의 훅은 worktree 사본에서, 그 세션의 폴러는 main 사본에서 돈다. 사본마다
// Map 을 들면 폴러는 언제나 빈 Map 을 봐서 `isToolExecuting()` 이 영영 false 였고,
// 60초를 넘는 모든 툴(sbt test)이 `permission_stall`(tool_call_stall) 로 죽었다.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeToolCount,
  clearToolCalls,
  createSubSessionRegistry,
  forgetSession,
  isToolExecuting,
  normalizePermissionEvent,
  notifySessionDeleted,
  pendingPermissionsFor,
  permissionAsked,
  permissionReplied,
  resetSharedSubSessionRegistryForTests,
  settleToolCalls,
  sharedSubSessionRegistry,
  toolFinished,
  toolStarted,
} from "../dist/sub-session-registry.js";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("sharedSubSessionRegistry — 사본을 가로지르는 단일 객체", () => {
  beforeEach(() => resetSharedSubSessionRegistryForTests());

  test("두 번 불러도 같은 객체다 (두 플러그인 사본이 같은 Map 을 본다)", () => {
    const hookCopy = sharedSubSessionRegistry();
    const pollerCopy = sharedSubSessionRegistry();
    assert.equal(hookCopy, pollerCopy);
  });

  test("globalThis 의 버전 키에 산다 — 모듈 캐시가 갈려도 같은 객체", () => {
    const reg = sharedSubSessionRegistry();
    const g = globalThis as unknown as Record<symbol, unknown>;
    assert.equal(g[Symbol.for("makdoong2-team.sub-session-registry.v1")], reg);
  });

  test("issue #10 시나리오: 훅 사본이 올린 신호를 폴러 사본이 읽는다", () => {
    // 훅 사본 (worktree Instance)
    toolStarted(sharedSubSessionRegistry(), "ses_wt", "call_sbt");
    // 폴러 사본 (main Instance) — 종전에는 자기 Map 이라 false 였다
    assert.equal(isToolExecuting(sharedSubSessionRegistry(), "ses_wt"), true);
    toolFinished(sharedSubSessionRegistry(), "ses_wt", "call_sbt");
    assert.equal(isToolExecuting(sharedSubSessionRegistry(), "ses_wt"), false);
  });

  test("형태가 다른 객체가 키에 있으면 덮어쓰지 않고 새로 만들지도 않는다 — version 이 맞을 때만 재사용", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[Symbol.for("makdoong2-team.sub-session-registry.v1")] = { version: 99 };
    const reg = sharedSubSessionRegistry();
    assert.equal(reg.version, 1);
    assert.equal(g[Symbol.for("makdoong2-team.sub-session-registry.v1")], reg);
  });
});

describe("툴 실행 신호 — callID 단위 짝맞춤", () => {
  test("started/finished 가 짝을 이루면 비어 있다", () => {
    const reg = createSubSessionRegistry();
    toolStarted(reg, "s1", "c1", 100);
    toolStarted(reg, "s1", "c2", 200);
    assert.equal(activeToolCount(reg, "s1"), 2);
    assert.equal(toolFinished(reg, "s1", "c1", 300), true);
    assert.equal(activeToolCount(reg, "s1"), 1);
    assert.equal(toolFinished(reg, "s1", "c2", 400), true);
    assert.equal(isToolExecuting(reg, "s1"), false);
    assert.equal(reg.activeToolCalls.has("s1"), false, "빈 Map 은 남기지 않는다");
    assert.equal(reg.lastToolExecuteAt.get("s1"), 400, "마지막 발화 시각을 갱신한다");
  });

  test("finished 는 멱등이다 — 같은 callID 두 번, 모르는 callID 는 아무 일도 없다", () => {
    const reg = createSubSessionRegistry();
    toolStarted(reg, "s1", "c1");
    assert.equal(toolFinished(reg, "s1", "c1"), true);
    assert.equal(toolFinished(reg, "s1", "c1"), false);
    assert.equal(toolFinished(reg, "s1", "nope"), false);
    assert.equal(toolFinished(reg, "never-started", "c1"), false);
  });

  test("callID 없는 before 훅은 익명 키를 받고, callID 없는 after 는 가장 최근 항목을 뺀다", () => {
    const reg = createSubSessionRegistry();
    const k1 = toolStarted(reg, "s1", undefined, 100);
    const k2 = toolStarted(reg, "s1", "", 200);
    assert.notEqual(k1, k2);
    assert.match(k1, /^anon#/);
    assert.equal(activeToolCount(reg, "s1"), 2);
    assert.equal(toolFinished(reg, "s1", undefined), true);
    assert.equal(reg.activeToolCalls.get("s1")?.has(k1), true, "최근(k2) 이 먼저 빠진다");
    assert.equal(toolFinished(reg, "s1", undefined), true);
    assert.equal(isToolExecuting(reg, "s1"), false);
  });

  test("settleToolCalls — 스냅샷에서 끝난 callID 만 뺀다, 아직 없는 것은 둔다 (110ms 창)", () => {
    // 툴이 throw 하면 tool.execute.after 가 오지 않는다. 폴러가 스냅샷의
    // completed/error part 로 정리하지 않으면 isToolExecuting 이 영영 true 로 굳어
    // 완료 판정이 타임아웃까지 유보된다.
    const reg = createSubSessionRegistry();
    toolStarted(reg, "s1", "threw");
    toolStarted(reg, "s1", "just-started");
    const n = settleToolCalls(reg, "s1", new Set(["threw", "unrelated"]));
    assert.equal(n, 1);
    assert.equal(reg.activeToolCalls.get("s1")?.has("just-started"), true);
    assert.equal(isToolExecuting(reg, "s1"), true);
    assert.equal(settleToolCalls(reg, "s1", ["just-started"]), 1);
    assert.equal(isToolExecuting(reg, "s1"), false);
    assert.equal(settleToolCalls(reg, "s1", ["x"]), 0);
  });

  test("clearToolCalls — idle 전이는 남은 항목을 전부 지운다", () => {
    const reg = createSubSessionRegistry();
    toolStarted(reg, "s1", "a");
    toolStarted(reg, "s1", "b");
    toolStarted(reg, "s2", "c");
    clearToolCalls(reg, "s1");
    assert.equal(isToolExecuting(reg, "s1"), false);
    assert.equal(isToolExecuting(reg, "s2"), true, "다른 세션은 건드리지 않는다");
  });
});

describe("권한 요청 관측", () => {
  test("permission.asked (1.18 v1 PermissionRequest 형태) 를 받는다", () => {
    const req = normalizePermissionEvent("permission.asked", {
      id: "per_1", sessionID: "s1", permission: "external_directory",
      patterns: ["/home/u/proj-X/*"], metadata: {}, always: [],
    }, 123);
    assert.deepEqual(req, {
      id: "per_1", sessionID: "s1", permission: "external_directory",
      patterns: ["/home/u/proj-X/*"], askedAt: 123,
    });
  });

  test("permission.updated (구 SDK 형태: type / pattern 문자열) 도 같은 shape 로 받는다", () => {
    const req = normalizePermissionEvent("permission.updated", {
      id: "per_2", sessionID: "s1", type: "bash", pattern: "rm -rf *", title: "x",
    });
    assert.equal(req?.permission, "bash");
    assert.deepEqual(req?.patterns, ["rm -rf *"]);
    const arr = normalizePermissionEvent("permission.updated", {
      id: "per_3", sessionID: "s1", type: "edit", pattern: ["a", 7, "b"],
    });
    assert.deepEqual(arr?.patterns, ["a", "b"], "문자열이 아닌 항목은 버린다");
  });

  test("요청으로 볼 수 없는 페이로드는 null", () => {
    assert.equal(normalizePermissionEvent("permission.replied", { id: "x", sessionID: "s" }), null);
    assert.equal(normalizePermissionEvent("permission.asked", null), null);
    assert.equal(normalizePermissionEvent("permission.asked", { sessionID: "s" }), null);
    assert.equal(normalizePermissionEvent("permission.asked", { id: "x" }), null);
    assert.equal(normalizePermissionEvent("permission.asked", { id: "x", sessionID: "s" })?.permission, "unknown");
  });

  test("asked → pending 목록(오래된 순) → replied 로 제거", () => {
    const reg = createSubSessionRegistry();
    permissionAsked(reg, { id: "b", sessionID: "s1", permission: "bash", patterns: [], askedAt: 20 });
    permissionAsked(reg, { id: "a", sessionID: "s1", permission: "external_directory", patterns: ["/x/*"], askedAt: 10 });
    permissionAsked(reg, { id: "c", sessionID: "s2", permission: "bash", patterns: [], askedAt: 5 });
    assert.deepEqual(pendingPermissionsFor(reg, "s1").map(p => p.id), ["a", "b"]);
    permissionReplied(reg, "s1", "a");
    assert.deepEqual(pendingPermissionsFor(reg, "s1").map(p => p.id), ["b"]);
    permissionReplied(reg, "s1", "b");
    assert.deepEqual(pendingPermissionsFor(reg, "s1"), []);
    assert.equal(reg.pendingPermissions.has("s1"), false);
    permissionReplied(reg, "nope", "x"); // 모르는 세션은 무해
    assert.deepEqual(pendingPermissionsFor(reg, "s2").map(p => p.id), ["c"]);
  });
});

describe("수명", () => {
  test("forgetSession 은 그 세션의 흔적만 전부 지운다", () => {
    const reg = createSubSessionRegistry();
    toolStarted(reg, "s1", "c");
    permissionAsked(reg, { id: "p", sessionID: "s1", permission: "bash", patterns: [], askedAt: 1 });
    reg.sessionIssue.set("s1", "PROJ-1");
    reg.sessionWorktree.set("s1", "/wt");
    reg.sessionIssue.set("s2", "PROJ-2");
    forgetSession(reg, "s1");
    assert.equal(isToolExecuting(reg, "s1"), false);
    assert.equal(reg.lastToolExecuteAt.has("s1"), false);
    assert.deepEqual(pendingPermissionsFor(reg, "s1"), []);
    assert.equal(reg.sessionIssue.has("s1"), false);
    assert.equal(reg.sessionWorktree.has("s1"), false);
    assert.equal(reg.sessionIssue.get("s2"), "PROJ-2");
  });

  test("notifySessionDeleted 는 대기자를 전부 깨우고, throw 하는 대기자가 다른 대기자를 막지 않는다", () => {
    const reg = createSubSessionRegistry();
    const calls: string[] = [];
    reg.sessionDeletedWaiters.set("s1", [
      () => { calls.push("w1"); throw new Error("boom"); },
      () => { calls.push("w2"); },
    ]);
    assert.equal(notifySessionDeleted(reg, "s1"), 2);
    assert.deepEqual(calls, ["w1", "w2"]);
    assert.equal(notifySessionDeleted(reg, "none"), 0);
  });
});

describe("플러그인 배선 — 사본을 가로지르는 신호는 레지스트리로만 흐른다", () => {
  const plugin = read("src/opencode-plugin.ts");

  test("사본-로컬 카운터가 되살아나지 않는다", () => {
    assert.doesNotMatch(plugin, /sessionActiveToolCount|sessionLastToolExecuteAt|releaseActiveTool/,
      "툴 실행 신호를 플러그인 사본 안의 Map 에 두면 worktree 서브세션에서 다시 issue #10 이 난다");
    assert.match(plugin, /const registry = sharedSubSessionRegistry\(\)/);
  });

  test("이슈키 · worktree · deleted 대기자는 레지스트리의 Map 을 그대로 쓴다", () => {
    assert.match(plugin, /const sessionIssue = registry\.sessionIssue;/);
    assert.match(plugin, /const sessionWorktree = registry\.sessionWorktree;/);
    assert.match(plugin, /const sessionDeletedWaiters = registry\.sessionDeletedWaiters;/);
    assert.doesNotMatch(plugin, /const session(Issue|Worktree|DeletedWaiters) = new Map/);
  });

  test("훅이 레지스트리에 쓴다 — before/after · permission.* · message.part.updated · session.idle/deleted", () => {
    assert.match(plugin, /toolStarted\(registry, sessionID, \(input as any\)\.callID/);
    assert.match(plugin, /toolFinished\(registry, afterSessionID, \(input as any\)\.callID/);
    assert.match(plugin, /event\?\.type === "permission\.asked" \|\| event\?\.type === "permission\.updated"/);
    assert.match(plugin, /permissionAsked\(registry, req\)/);
    assert.match(plugin, /event\?\.type === "permission\.replied"/);
    assert.match(plugin, /event\?\.type === "message\.part\.updated"/);
    assert.match(plugin, /event\?\.type === "session\.idle"[\s\S]{0,300}clearToolCalls\(registry/);
    assert.match(plugin, /event\?\.type === "session\.deleted"[\s\S]{0,400}notifySessionDeleted\(registry, sid\)/);
  });

  test("폴러는 스냅샷으로 정리한 뒤 레지스트리를 읽고, 권한 소스는 레지스트리 + 세션-라우팅 응답이다", () => {
    assert.match(plugin, /isToolExecuting: \(snapshot\) => \{[\s\S]{0,200}settleToolCalls\(registry, sessionId, snapshot\.settledCallIDs\)/);
    assert.match(plugin, /pollSubSessionCore\(\{ session: \(client as any\)\.session, permission: permissionSourceFor\(sessionId\) \}/);
    assert.match(plugin, /pendingPermissionsFor\(registry, sessionId\)/);
    assert.match(plugin, /postSessionIdPermissionsPermissionId\(\{[\s\S]{0,120}path: \{ id: sessionId, permissionID: req\.path\.requestID \}/);
    assert.doesNotMatch(plugin, /pollSubSessionCore\(client as any/,
      "클라이언트를 그대로 넘기면 client.permission 이 없어 자동 승인·거부 루프가 한 번도 돌지 않는다");
  });

  test("사본 식별 로그 — [init] 과 [permission] 에 directory 가 실린다", () => {
    assert.match(plugin, /logger\.debug\(`\[init\] plugin instance directory=\$\{directory\} worktree=\$\{worktree\} pid=\$\{process\.pid\}`\)/);
    assert.match(plugin, /\[permission\] configured external_directory allows:[\s\S]{0,300}directory=\$\{directory\}/);
    assert.match(plugin, /loadOpencodeExternalDirAllows\(\(reason\) =>[\s\S]{0,200}logger\.warn/,
      "빈 배열로 끝난 이유를 warn 으로 남겨야 7개→5개 같은 차이를 로그만으로 설명할 수 있다");
  });

  test("레지스트리 모듈은 플러그인에서 re-export 되지 않는다 (로더가 named export 를 factory 로 부른다)", () => {
    assert.doesNotMatch(plugin, /export \{[^}]*\} from "\.\/sub-session-registry\.js"/);
    assert.doesNotMatch(plugin, /export \* from "\.\/sub-session-registry\.js"/);
  });
});
