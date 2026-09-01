/**
 * apply_patch 대상 경로 추출 — 순수 계약.
 *
 * ── 왜 필요한가 ──
 * opencode 1.18 의 `ToolRegistry.tools` 는 모델 id 에 따라 **파일 쓰기 툴 자체를
 * 바꿔 끼운다**. 1.18.23 바이너리에서 확인한 필터:
 *
 *   const isGpt = modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
 *   if (tool.id === apply_patch) return isGpt      // gpt-5 계열에만 노출
 *   if (tool.id === edit || tool.id === write) return !isGpt   // 그 외 모델에만 노출
 *
 * 즉 `github-copilot/gpt-5.6-luna` 같은 세션에는 `write` · `edit` 가 **툴 스키마에
 * 아예 없고** `apply_patch` 하나만 있다. "산출물은 write 툴로 만들어라" 는 stage
 * 지침은 그 세션에서 물리적으로 수행 불가능한 지시가 된다 (GitHub #8 재발).
 *
 * ── 왜 경로 파싱인가 ──
 * `apply_patch` 의 인자는 `{ patchText }` 한 덩어리라 `filePath` 인자가 없다.
 * 그래서 산출물 제한 훅은 대상 파일을 몰라 **보수적으로 전부 차단**했고, 그
 * 결과 planner 에게는 초안을 만들 합법적 수단이 하나도 남지 않아 워크플로가
 * 구조적으로 정지했다. 패치 본문에서 대상 경로를 뽑아내면 write 와 동일한
 * 정밀도로 허용/차단을 판정할 수 있다 — 우회가 아니라 같은 규칙의 확장이다.
 *
 * 파싱은 opencode 의 `Patch.parsePatch` 를 그대로 모사한다 (Begin/End 마커,
 * `*** Add|Delete|Update File:`, `*** Move to:`). 훅과 실제 적용기가 서로 다른
 * 파일을 본다고 믿게 되면 방어가 무너지므로 관대하게 파싱하지 않는다.
 */

export type ApplyPatchPaths =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** opencode 가 apply_patch 로 노출하는 툴 이름들 (소문자 비교 기준). */
export const APPLY_PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "applypatch", "patch"]);

export const isApplyPatchTool = (toolName: string): boolean =>
  APPLY_PATCH_TOOLS.has(toolName.toLowerCase());

/**
 * opencode 의 정규화 단계: 패치 본문이 heredoc 으로 감싸여 오는 경우를 벗긴다.
 * (`Patch` 모듈의 동일 정규식)
 */
const stripHeredoc = (text: string): string =>
  text.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)?.[2] ?? text;

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

/** 패치 본문에서 대상 경로를 모두 뽑는다. 형식 위반이면 실패로 보고한다. */
export const parsePatchTargets = (patchText: string): ApplyPatchPaths => {
  if (typeof patchText !== "string" || patchText.trim() === "") {
    return { ok: false, reason: "patch_text_empty" };
  }
  const lines = stripHeredoc(patchText.trim()).split("\n");
  const begin = lines.findIndex((l) => l.trim() === BEGIN);
  const end = lines.findIndex((l) => l.trim() === END);
  if (begin === -1 || end === -1 || begin >= end) {
    return { ok: false, reason: "missing_begin_end_markers" };
  }

  const paths: string[] = [];
  for (let i = begin + 1; i < end; i++) {
    const line = lines[i];
    if (line.startsWith("*** Add File:")) {
      const p = line.slice("*** Add File:".length).trim();
      if (!p) return { ok: false, reason: "empty_path_in_add" };
      paths.push(p);
    } else if (line.startsWith("*** Delete File:")) {
      const p = line.slice("*** Delete File:".length).trim();
      if (!p) return { ok: false, reason: "empty_path_in_delete" };
      paths.push(p);
    } else if (line.startsWith("*** Update File:")) {
      const p = line.slice("*** Update File:".length).trim();
      if (!p) return { ok: false, reason: "empty_path_in_update" };
      paths.push(p);
      // Update 바로 다음 줄에만 올 수 있는 이동 대상. 원본과 목적지 둘 다
      // 쓰기 대상이므로 둘 다 검사 대상에 넣는다.
      const next = lines[i + 1];
      if (next && next.startsWith("*** Move to:")) {
        const mv = next.slice("*** Move to:".length).trim();
        if (!mv) return { ok: false, reason: "empty_path_in_move" };
        paths.push(mv);
        i++;
      }
    }
  }
  if (paths.length === 0) return { ok: false, reason: "no_target_path" };
  return { ok: true, paths };
};

/**
 * apply_patch 툴 인자에서 대상 경로를 뽑는다.
 *
 * 두 가지 인자 모양을 모두 받는다:
 *  - opencode 내장 툴: `{ patchText }` (별칭 `patch`)
 *  - OpenAI provider tool 경유: `{ callId, operation: { type, path, move_path } }`
 */
export const extractApplyPatchPaths = (args: unknown): ApplyPatchPaths => {
  if (!args || typeof args !== "object") return { ok: false, reason: "args_not_object" };
  const a = args as Record<string, unknown>;

  const op = a.operation;
  if (op && typeof op === "object") {
    const o = op as Record<string, unknown>;
    const paths: string[] = [];
    for (const key of ["path", "move_path", "movePath"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim() !== "") paths.push(v.trim());
    }
    if (paths.length > 0) return { ok: true, paths };
    return { ok: false, reason: "operation_without_path" };
  }

  for (const key of ["patchText", "patch_text", "patch", "input"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim() !== "") return parsePatchTargets(v);
  }
  return { ok: false, reason: "no_patch_text" };
};
