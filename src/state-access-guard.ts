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
 * 쓰기 의도 지표. 하나라도 매칭되면 명령 전체를 차단한다.
 *
 * state.sh 호출 여부보다 먼저 검사한다 — `state.sh get … ; rm …/state.json` 처럼
 * 승인된 호출에 쓰기를 끼워 넣는 밀수 경로를 막기 위해서다.
 */
const WRITE_INDICATORS: ReadonlyArray<readonly [RegExp, string]> = [
  // `>` / `>>` 리디렉션. `2>/dev/null`, `1>&2`, `>/dev/null` 은 제외한다.
  [/(?:^|[|&;\s(`{])>>?\s*(?!&|\/dev\/(?:null|stderr|stdout|tty)(?![\w/]))\S/, "출력 리디렉션 (> / >>)"],
  [/(?:^|[|&;(`{])\s*(?:tee|dd|sponge)\b/, "tee / dd / sponge"],
  [/\bsed\b[^|;&]*\s-i(?:\b|['"])/, "sed -i (in-place 편집)"],
  [/\b(?:perl|ruby)\b[^|;&]*\s-\w*i\b/, "perl / ruby -i (in-place 편집)"],
  // 인터프리터 인라인 스크립트는 읽기/쓰기를 정적으로 구분할 수 없다 → 전부 차단.
  // 읽기가 필요하면 cat / jq / head 를 쓴다.
  [/\b(?:python3?|node|bun|deno|ruby|perl|php)\b\s+-\w*[ce]\b/, "인터프리터 인라인 스크립트 (-c / -e)"],
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

const SEGMENT_SPLIT_RE = /\|\||&&|[;|&\n]/;

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
 *   2. 쓰기 지표 → write (state.sh 호출이 같이 있어도 차단)
 *   3. state.sh 승인 호출 → approved-helper
 *   4. state.json 을 언급하는 모든 세그먼트가 읽기 전용 allowlist → read-only
 *   5. 그 외 → write (모르는 명령은 차단)
 */
export function classifyStateJsonAccess(cmd: string): StateAccessVerdict {
  if (!STATE_JSON_PATH_RE.test(cmd)) return { kind: "unrelated" };

  for (const [re, reason] of WRITE_INDICATORS) {
    if (re.test(cmd)) return { kind: "write", reason };
  }

  if (STATE_SH_CALL_RE.test(cmd)) return { kind: "approved-helper" };

  const readers: string[] = [];
  for (const segment of cmd.split(SEGMENT_SPLIT_RE)) {
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
