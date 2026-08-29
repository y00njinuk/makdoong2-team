// state-access-guard.ts — state.json 을 건드리는 bash 명령의 "읽기 / 쓰기" 판정.
//
// 왜 별도 모듈인가: opencode 플러그인 로더는 진입 파일(opencode-plugin.ts)의 모든
// named export 를 plugin factory 로 호출한다 (ARCHITECTURE.md §2). 신규 helper 는
// 이 파일에 두고 import 한다. `test/plugin-exports-shape.test.mjs` 가 진입 파일의
// export 집합을 고정한다.
//
// ── 배경 (issue #5) ──
// 종전 구현은 "명령 문자열에 state.json 경로가 있는가" 만 보고 차단했다. 그래서
// `auto_advance_stage` 의 state_unreadable next_action 이 지시하는 존재·유효성 확인
// (`ls` / `file` / `head`) 까지 "우회 조작 시도" 로 막혔고, leader 는 안내받은 복구
// 명령을 한 줄도 실행하지 못한 채 자체 abort 했다. 하드룰이 지키려는 것은 *쓰기*
// 경로다 — 훅의 에러 메시지도 쓰기 행위만 열거한다. 읽기는 스키마 정합성에 영향을
// 주지 않으므로 막을 이유가 없다.
//
// ── 판정 원칙: 애매하면 차단한다 ──
// 오탐(읽기를 막음)에는 `state.sh status` 라는 승인된 우회로가 있지만, 미탐(쓰기를
// 허용)은 state.json 정합성을 깨고 되돌릴 수단이 없다. 그래서 읽기 허용은
// allowlist 로만 한다 — 읽기 전용임이 증명된 명령만 통과하고, 모르는 명령은 차단.

/** `.makdoong2-team/<issue>/state.json` 리터럴 경로. */
export const STATE_JSON_PATH_RE = /\.makdoong2-team\/[^/\s]+\/state\.json/;

/**
 * `scripts/state.sh` 가 실제로 구현하는 서브커맨드.
 *
 * 이 배열이 유일한 출처다 — 훅 에러 메시지와 allowlist 정규식이 모두 여기서
 * 파생된다. 종전에는 세 곳(regex 2개 + 메시지)이 각자 다른 목록을 갖고 있어서
 * 존재하지 않는 `update` 는 허용되고 실재하는 `append`/`migrate` 는 누락돼 있었다.
 */
export const STATE_SH_SUBCOMMANDS = [
  "root",
  "issue",
  "init",
  "status",
  "get",
  "set",
  "append",
  "migrate",
] as const;

/** `state.sh <승인 서브커맨드>` 호출 탐지. 목록은 STATE_SH_SUBCOMMANDS 하나에서만 온다. */
export const STATE_SH_CALL_RE = new RegExp(
  String.raw`state\.sh\s+(?:${STATE_SH_SUBCOMMANDS.join("|")})(?![\w-])`,
);

/**
 * 따옴표 안의 내용을 공백으로 덮는다 (따옴표 자체와 **문자 오프셋**은 보존).
 *
 * ── 배경 (issue #6-③) ──
 * 셸에서 따옴표 안의 `>`·`|`·`;` 는 메타문자가 아니라 리터럴인데, 종전 판정은
 * 명령 문자열 전체를 훑었다. 그래서 analyzer 가 자기 산출물을 검증하려고 실행한
 *   jq -e '… and (.task_relevant_files | length >= 1)' …
 * 의 `>=` 가 "출력 리디렉션" 으로, `|` 가 "파이프 세그먼트 경계" 로 잡혀
 * 읽기 전용 술어가 3회 차단됐다 (리디렉션도 파이프도 없었다). `>=` 하나만 예외
 * 처리하면 `awk '$1 > 2'`·`grep '>'` 같은 같은 계열이 계속 남는다 — 셸 문법을
 * 그대로 모델링하는 쪽이 맞다.
 *
 * 길이를 보존하는 이유: 마스킹된 문자열에서 찾은 위치를 **원문에 그대로** 대응시켜
 * 세그먼트를 잘라내기 위해서다 (`splitUnquotedSegments`).
 *
 * 보수적 처리 두 가지 — 오탐(막음)에는 우회로가 있지만 미탐(허용)은 복구 수단이 없다:
 *   - 따옴표가 닫히지 않으면 그 지점부터 원문을 그대로 남긴다.
 *   - 큰따옴표 안에 명령 치환(`$(` / 백틱)이 있으면 그 span 은 덮지 않는다.
 *     큰따옴표 안에서는 치환이 실제로 실행되므로 `"$(cat a > b)"` 가 숨겨진다.
 */
export function stripQuotedSpans(cmd: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch !== "'" && ch !== '"') {
      out.push(ch);
      i++;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < cmd.length; j++) {
      if (cmd[j] === "\\" && ch === '"') { j++; continue; }
      if (cmd[j] === ch) { close = j; break; }
    }
    if (close < 0) {
      // 미종료 따옴표 — 남은 전부를 원문으로 둔다 (메타문자가 계속 보이므로 차단 쪽).
      out.push(cmd.slice(i));
      break;
    }
    const body = cmd.slice(i + 1, close);
    if (ch === '"' && /\$\(|`/.test(body)) {
      // 큰따옴표 안의 명령 치환은 실제로 실행된다 → 덮지 않는다.
      out.push(cmd.slice(i, close + 1));
    } else {
      out.push(ch, " ".repeat(body.length), ch);
    }
    i = close + 1;
  }
  return out.join("");
}

/**
 * 출력 리디렉션(`>` / `>>`) 탐지. `2>/dev/null`, `1>&2`, `>/dev/null` 은 제외한다.
 *
 * 인용 구간을 덮은 문자열로만 판정한다 — 따옴표 안의 `>` 는 리디렉션이 아니다.
 * `looksLikeFileWrite`(leader/planner/analyzer 하드룰)와 아래 WRITE_INDICATORS 가
 * 같은 함수를 쓴다. 한쪽만 고치면 다른 쪽에서 같은 오탐이 남는다.
 */
export function looksLikeRedirection(cmd: string): boolean {
  return /(?:^|[|&;\s(`{])>>?\s*(?!&|\/dev\/(?:null|stderr|stdout|tty)(?![\w/]))\S/
    .test(stripQuotedSpans(cmd));
}

/** 세그먼트 구분자 — 인용 밖에서만 유효하다. */
const SEGMENT_SPLIT_RE = /\|\||&&|[;|&\n]/g;

/**
 * 인용 밖의 `;` `|` `&` `\n` 에서만 자른 **원문** 세그먼트.
 *
 * 종전에는 원문을 그대로 split 해서 `jq '.a | length'` 의 파이프가 세그먼트를
 * 갈랐고, 뒷조각의 선두 토큰(`length`)이 읽기 allowlist 에 없어 차단됐다 (#6-③).
 */
export function splitUnquotedSegments(cmd: string): string[] {
  const masked = stripQuotedSpans(cmd);
  const segments: string[] = [];
  let start = 0;
  SEGMENT_SPLIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEGMENT_SPLIT_RE.exec(masked)) !== null) {
    segments.push(cmd.slice(start, m.index));
    start = m.index + m[0].length;
  }
  segments.push(cmd.slice(start));
  return segments;
}

/**
 * 쓰기 의도 지표. 하나라도 매칭되면 명령 전체를 차단한다.
 *
 * state.sh 호출 여부보다 먼저 검사한다 — `state.sh get … ; rm …/state.json` 처럼
 * 승인된 호출에 쓰기를 끼워 넣는 밀수 경로를 막기 위해서다.
 */
const WRITE_INDICATORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[|&;(`{])\s*(?:tee|dd|sponge)\b/, "tee / dd / sponge"],
  [/\bsed\b[^|;&]*\s-i(?:\b|['"])/, "sed -i (in-place 편집)"],
  [/\b(?:perl|ruby)\b[^|;&]*\s-\w*i\b/, "perl / ruby -i (in-place 편집)"],
  // 인터프리터 인라인 스크립트는 읽기/쓰기를 정적으로 구분할 수 없다 → 전부 차단.
  // 읽기가 필요하면 cat / jq / head 를 쓴다.
  [/\b(?:python3?|node|bun|deno|ruby|perl|php)\b\s+-\w*[ce]\b/, "인터프리터 인라인 스크립트 (-c / -e)"],
  // 셸 인라인 스크립트도 정적으로 분해할 수 없다. 인용 구간을 지우면서(#6-③)
  // `bash -c 'echo x > f'` 의 리디렉션이 보이지 않게 되므로 여기서 함께 막는다.
  // 스크립트 파일 실행(`bash <SCRIPTS_DIR>/state.sh …`)은 `-c` 가 없어 매치되지 않는다.
  [/\b(?:ba|z|k|da)?sh\b\s+-\w*c\b/, "셸 인라인 스크립트 (sh -c)"],
  [/(?:^|[|&;\s(`{])eval\s/, "eval"],
  [/(?:^|[|&;\s(`{])(?:cp|mv|rm|ln|install|touch|truncate|shred|chmod|chown|unlink|rsync|mkfifo)\s/, "파일 조작 명령"],
  [/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+(?:add|rm|mv|checkout|restore|stash|apply|clean|update-index|reset|commit)\b/, "git 쓰기 서브커맨드"],
  [/(?:^|[|&;\s(`{])(?:vi|vim|nano|emacs|ed|ex|patch)\s/, "편집기 / patch"],
];

/** 세그먼트의 선두에 올 수 있는 읽기 전용 명령. 여기 없는 명령은 차단된다. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "bat", "head", "tail", "file", "stat", "wc", "du",
  "jq", "yq", "grep", "egrep", "fgrep", "rg", "awk", "sed", "tr", "cut",
  "sort", "uniq", "nl", "fold", "column", "strings", "xxd", "od", "hexdump",
  "diff", "cmp", "cksum", "md5", "md5sum", "shasum", "sha1sum", "sha256sum",
  "find", "realpath", "readlink", "dirname", "basename", "test", "[",
  "echo", "printf", "pwd", "true", "false",
]);

/** 읽기 전용으로 확인된 git 서브커맨드. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "check-ignore", "check-attr", "status", "ls-files", "diff", "show", "log",
  "cat-file", "rev-parse", "blame", "grep", "describe",
]);

/** 값을 뒤 토큰으로 받는 git 전역 옵션 — 서브커맨드 추출 시 건너뛴다. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
]);

/** 세그먼트 선두의 괄호·역따옴표·환경변수 대입을 벗겨 실제 명령 토큰을 얻는다. */
function segmentHead(segment: string): { head: string; rest: string } {
  let s = segment;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/^[\s(){}`]+/, "")
      .replace(/^\$\(/, "")
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
    if (s === before) break;
  }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
  if (!m) return { head: "", rest: "" };
  return { head: m[1].replace(/^.*\//, ""), rest: m[2] };
}

function gitSubcommand(rest: string): string {
  const tokens = rest.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (GIT_OPTIONS_WITH_VALUE.has(t)) { i++; continue; }
    if (t.startsWith("-")) continue;
    return t;
  }
  return "";
}

export type StateAccessVerdict =
  /** 명령에 state.json 경로가 없다 — 이 가드의 관심 밖. */
  | { kind: "unrelated" }
  /** 승인된 `state.sh <서브커맨드>` 호출. */
  | { kind: "approved-helper" }
  /** 읽기 전용임이 확인됨 (진단·복구 절차). */
  | { kind: "read-only"; readers: string[] }
  /** 쓰기 의도가 있거나 읽기 전용임을 증명할 수 없음 → 차단. */
  | { kind: "write"; reason: string };

/**
 * state.json 을 참조하는 명령을 분류한다.
 *
 * 순서가 계약이다:
 *   1. 경로 없음 → unrelated
 *   2. 리디렉션(인용 구간 제외) → write
 *   2'. 그 밖의 쓰기 지표 → write (state.sh 호출이 같이 있어도 차단)
 *   3. state.sh 승인 호출 → approved-helper
 *   4. state.json 을 언급하는 모든 세그먼트가 읽기 전용 allowlist → read-only
 *   5. 그 외 → write (모르는 명령은 차단)
 */
export function classifyStateJsonAccess(cmd: string): StateAccessVerdict {
  if (!STATE_JSON_PATH_RE.test(cmd)) return { kind: "unrelated" };

  if (looksLikeRedirection(cmd)) return { kind: "write", reason: "출력 리디렉션 (> / >>)" };

  for (const [re, reason] of WRITE_INDICATORS) {
    if (re.test(cmd)) return { kind: "write", reason };
  }

  if (STATE_SH_CALL_RE.test(cmd)) return { kind: "approved-helper" };

  const readers: string[] = [];
  for (const segment of splitUnquotedSegments(cmd)) {
    if (!STATE_JSON_PATH_RE.test(segment)) continue;
    const { head, rest } = segmentHead(segment);

    if (head === "git") {
      const sub = gitSubcommand(rest);
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
        return { kind: "write", reason: `읽기 전용으로 확인되지 않은 git 서브커맨드: git ${sub || "?"}` };
      }
      readers.push(`git ${sub}`);
      continue;
    }

    if (!READ_ONLY_COMMANDS.has(head)) {
      return { kind: "write", reason: `읽기 전용으로 확인되지 않은 명령: ${head || "(빈 세그먼트)"}` };
    }
    readers.push(head);
  }

  return { kind: "read-only", readers };
}

/**
 * 훅이 에이전트에게 throw 할 차단 메시지.
 *
 * 종전 메시지는 "무엇이 금지인가" 만 말하고 "그럼 무엇으로 확인하나" 를 말하지
 * 않았다. 그 결과 leader 는 차단을 leader 하드룰 2(bash 파일 쓰기) 위반으로
 * 오인해 자체 abort 했다 (issue #5). 그래서 ① 어떤 규칙인지, ② 무엇이 걸렸는지,
 * ③ 읽기는 무엇으로 하는지, ④ abort 사유가 아님을 모두 적는다.
 */
export function buildStateWriteBlockMessage(reason: string, agent: string | undefined): string {
  return (
    `[makdoong2-team state hardrule] state.json 쓰기는 오직 state.sh ` +
    `(${STATE_SH_SUBCOMMANDS.join("/")}) 로만 할 수 있다.\n` +
    `차단 사유: ${reason}\n` +
    `금지: 직접 편집 (python -c open, node -e writeFileSync, sed -i, jq > , tee, cat > , echo > , cp/mv/rm, git add 등)\n` +
    `허용: 읽기 전용 진단은 그대로 쓸 수 있다 — 'bash <SCRIPTS_DIR>/state.sh status <이슈키>' (존재·유효성·phantom 키 보고), ` +
    `또는 ls / file / head / cat / jq / git check-ignore 로 state.json 을 조회.\n` +
    `이 차단은 state.json 전용 하드룰이며 leader 하드룰 2(bash 파일 쓰기) 위반이 아니다. ` +
    `자체 abort 사유가 아니므로 읽기 전용 명령으로 바꿔 진단을 계속하라.\n` +
    `caller agent="${agent ?? "unknown"}"`
  );
}
