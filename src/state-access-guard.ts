// state-access-guard.ts — state.json 을 건드리는 bash 명령의 "읽기 / 쓰기" 판정.
//
// 왜 별도 모듈인가: opencode 플러그인 로더는 진입 파일(opencode-plugin.ts)의 모든
// named export 를 plugin factory 로 호출한다 (ARCHITECTURE.md §2). 신규 helper 는
// 이 파일에 두고 import 한다. `test/plugin-exports-shape.test.ts` 가 진입 파일의
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

/**
 * `.makdoong2-team/<issue>/state.json` 리터럴 경로.
 *
 * 중복 슬래시(`//`)와 `.` 세그먼트(`/./`)를 허용한다. 셸은 이 셋을 **같은 파일**로
 * 해석하는데 종전 정규식은 정확히 한 개의 `/` 와 세그먼트 하나만 인정해서 아래
 * 셋이 전부 `unrelated` 로 새어나갔다 — 즉 하드룰이 통째로 우회됐다:
 *   echo x > .makdoong2-team//PROJ-1/state.json
 *   echo x > .makdoong2-team/./PROJ-1/state.json
 *   rm       .makdoong2-team/PROJ-1/./state.json
 * (`..` 는 다른 디렉터리를 가리키므로 여기서 다루지 않는다 — 그 경로의 파일은
 *  이 워크플로우의 state.json 이 아니다.)
 *
 * **선형 시간이어야 한다.** 이 정규식은 tool.execute.before 에서 모든 bash 명령
 * 전체와 세그먼트마다 동기 실행되므로, 병리적 입력에 2차 백트래킹이 나면 명령
 * 하나가 플러그인 이벤트 루프(전 세션 폴링 포함)를 수 초 블로킹한다. 종전
 * `(?:\/+\.)*\/+` 는 `\/+` 반복과 `.` 의 이중 소비(`\.` vs `[^/\s]`)가 겹쳐
 * `.makdoong2-team` + `/.` 반복 입력에서 O(n²) 였다 (40k 입력 ~1.4s 실측).
 * `(?:\.?\/)*` 는 매 반복이 슬래시 하나로 결정론적으로 끝나 백트래킹이 없다.
 */
export const STATE_JSON_PATH_RE =
  /\.makdoong2-team\/(?:\.?\/)*[^/\s]+\/(?:\.?\/)*state\.json/;

/** rawHead 가 **온전히** state.json 경로 토큰인지 (선택적 인용·`./` 접두 포함). */
const RAWHEAD_IS_PATH = new RegExp(
  `^["']?(?:\\.\\/)?(?:${STATE_JSON_PATH_RE.source})["']?$`,
);

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
  // 인용 구간을 덮은 뒤에 남은 `>` 는 전부 셸 메타문자다. 종전 정규식은 `>` 앞에
  // 구분자([|&;\s(`{])를 요구해서 **공백 없는 리디렉션을 통째로 놓쳤다**:
  //   echo '{}'>state.json   cat x>state.json   jq . a.json 1>state.json
  // 셋 다 실제로 파일을 덮어쓰는데 "읽기 전용" 으로 판정됐다. 미탐에는 복구
  // 수단이 없다는 이 모듈의 원칙에 정면으로 어긋난다.
  //
  // 그래서 앞 문맥 요구를 없애고 fd 접두(`1>` / `2>`)를 명시적으로 흡수한다.
  //   - `>&` (fd 복제, 예: 2>&1) 는 파일 생성이 아니므로 제외
  //   - `>/dev/{null,stderr,stdout,tty}` 는 종전대로 제외
  //   - `>>` 는 한 토큰으로 소비 (앞의 [^>] 가 두 번째 `>` 에 걸리지 않게)
  return /(?:^|[^>])\d*>>?\s*(?!&|\/dev\/(?:null|stderr|stdout|tty)(?![\w/]))\S/
    .test(stripQuotedSpans(cmd));
}

/** 인용 구간의 **본문** 목록 (따옴표 제외). 스크립트 인자 검사에 쓴다. */
export function quotedSpanBodies(cmd: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch !== "'" && ch !== '"') { i++; continue; }
    let close = -1;
    for (let j = i + 1; j < cmd.length; j++) {
      if (cmd[j] === "\\" && ch === '"') { j++; continue; }
      if (cmd[j] === ch) { close = j; break; }
    }
    if (close < 0) { bodies.push(cmd.slice(i + 1)); break; }
    bodies.push(cmd.slice(i + 1, close));
    i = close + 1;
  }
  return bodies;
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
 * 쓰기 의도 지표 — **원문**(인용 구간 포함)으로 판정하는 것들.
 *
 * 여기 있는 것은 전부 "따옴표 안이 곧 실행 대상" 인 형태다. 인용을 걷어내면
 * 판정 근거 자체가 사라지므로 원문을 봐야 한다.
 */
export const WRITE_INDICATORS_RAW: ReadonlyArray<readonly [RegExp, string]> = [
  // in-place 편집. `--in-place` 는 GNU sed 의 장문형이고 배포 대상이 Ubuntu 라
  // 실제로 쓰이는 표기인데 종전 정규식은 `-i` 단문형만 봤다.
  [/\bsed\b[^|;&]*\s(?:-i(?:\b|['"])|--in-place\b)/, "sed -i / --in-place (in-place 편집)"],
  [/\b(?:perl|ruby)\b[^|;&]*\s-\w*i\b/, "perl / ruby -i (in-place 편집)"],
  // 인터프리터 인라인 스크립트는 읽기/쓰기를 정적으로 구분할 수 없다 → 전부 차단.
  // 읽기가 필요하면 cat / jq / head 를 쓴다.
  [/\b(?:python3?|node|bun|deno|ruby|perl|php)\b\s+-\w*[ce]\b/, "인터프리터 인라인 스크립트 (-c / -e)"],
  // 셸 인라인 스크립트도 정적으로 분해할 수 없다. 인용 구간을 지우면서(#6-③)
  // `bash -c 'echo x > f'` 의 리디렉션이 보이지 않게 되므로 여기서 함께 막는다.
  // 스크립트 파일 실행(`bash <SCRIPTS_DIR>/state.sh …`)은 `-c` 가 없어 매치되지 않는다.
  [/\b(?:ba|z|k|da)?sh\b\s+-\w*c\b/, "셸 인라인 스크립트 (sh -c)"],
  [/(?:^|[|&;\s(`{])eval\s/, "eval"],
];

/**
 * 쓰기 의도 지표 — **인용 구간을 덮은** 문자열로 판정하는 것들.
 *
 * 이쪽을 원문으로 보면 issue #5 계열의 오탐이 난다. 실제로 종전 구현에서
 *   grep -e ' rm ' .makdoong2-team/<이슈>/state.json
 * 이 "파일 조작 명령" 으로 차단됐다 — 따옴표 안의 ` rm ` 은 grep 의 **패턴 인자**
 * 이지 명령이 아니다. #6-③ 의 인용 인지 판정이 리디렉션에만 적용되고 여기엔
 * 적용되지 않은 절반짜리 수정이었다.
 */
export const WRITE_INDICATORS_UNQUOTED: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[|&;(`{])\s*(?:tee|dd|sponge)\b/, "tee / dd / sponge"],
  [/(?:^|[|&;\s(`{])(?:cp|mv|rm|ln|install|touch|truncate|shred|chmod|chown|unlink|rsync|mkfifo)\s/, "파일 조작 명령"],
  [/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+(?:add|rm|mv|checkout|restore|stash|apply|clean|update-index|reset|commit)\b/, "git 쓰기 서브커맨드"],
  [/(?:^|[|&;\s(`{])(?:vi|vim|nano|emacs|ed|ex|patch)\s/, "편집기 / patch"],
  // `find … -delete` / `-exec rm` 은 대상이 glob 이라 리터럴 경로 정규식에 안 걸릴
  // 수 있지만, state.json 을 언급하는 명령 안에 있으면 파괴 의도가 명백하다.
  [/\bfind\b[^|;&]*\s-(?:delete|exec(?:dir)?\b)/, "find -delete / -exec"],
  [/\bxargs\b[^|;&]*\s(?:rm|mv|cp|truncate|sed)\b/, "xargs 경유 파일 조작"],
];

/**
 * allowlist 에 있는 명령이 **자기 문법으로** 파일을 쓰는 형태.
 *
 * `awk` 와 `sed` 는 읽기 전용 명령으로 등록돼 있지만 스크립트 본문에 쓰기 연산을
 * 담을 수 있다. 인용 구간 본문만 검사하므로 `awk '$1 > 2' state.json` 같은 정상
 * 비교 술어(#6-③ 가 고친 바로 그 형태)는 걸리지 않는다 — 리디렉션은 `print` 뒤에
 * 오고 대상이 문자열/변수라는 점이 다르다.
 */
const SCRIPT_BODY_WRITE_INDICATORS: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["awk", /\b(?:print|printf)\b[^;}]*>>?\s*["$(]/, "awk 스크립트 안의 출력 리디렉션 (print > \"file\")"],
  ["sed", /(?:^|[;{\s/])[wW]\s+\S/, "sed 스크립트 안의 w (write) 명령 / 치환 플래그"],
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
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "check-ignore", "check-attr", "status", "ls-files", "diff", "show", "log",
  "cat-file", "rev-parse", "blame", "grep", "describe",
]);

/** 값을 뒤 토큰으로 받는 git 전역 옵션 — 서브커맨드 추출 시 건너뛴다. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
]);

/**
 * 셸 제어 구문 키워드. 세그먼트 선두에 오면 벗겨내고 다음 토큰을 명령으로 본다.
 *
 * 이것이 없으면 정상 존재 확인이 차단된다 (issue #5 재발):
 *   if [ -f <state.json> ]; then cat <state.json>; fi
 * → `;` 로 잘린 세그먼트의 선두가 `if` / `then` / `fi` 라서 "읽기 전용으로
 *   확인되지 않은 명령" 으로 판정됐다. 키워드를 벗기면 `[` 와 `cat` 이 드러나
 *   allowlist 에 걸린다. 쓰기 명령을 감추지는 않는다 — `if rm x; then` 은
 *   벗긴 뒤 head 가 `rm` 이라 여전히 차단된다.
 */
const SHELL_CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "then", "elif", "else", "fi",
  "while", "until", "for", "in", "do", "done",
  "case", "esac", "select", "function", "time", "!",
]);

/** 세그먼트 선두의 괄호·역따옴표·환경변수 대입·제어 키워드를 벗겨 실제 명령 토큰을 얻는다. */
function segmentHead(segment: string): { head: string; rawHead: string; rest: string } {
  let s = segment;
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s
      .replace(/^[\s(){}`]+/, "")
      .replace(/^\$\(/, "")
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
    const kw = /^(\S+)(\s+[\s\S]*)?$/.exec(s);
    if (kw && SHELL_CONTROL_KEYWORDS.has(kw[1])) {
      s = (kw[2] ?? "").replace(/^\s+/, "");
      // `for VAR in LIST` / `select VAR in LIST` — 루프 변수와 `in` 도 함께 벗긴다.
      // 벗기지 않으면 head 가 루프 변수명이 되어 allowlist 에 없다고 차단된다.
      if (kw[1] === "for" || kw[1] === "select") {
        s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*\s+in\s+/, "");
      }
    }
    if (s === before) break;
  }
  // 입력 리디렉션(`< file`, `0< file`)은 읽기다. 선두에 남아 있으면 벗긴다 —
  // 벗기지 않으면 `while …; done < <state.json>` 의 마지막 세그먼트 선두가 `<`
  // 가 되어 "읽기 전용으로 확인되지 않은 명령" 으로 차단된다.
  s = s.replace(/^\d*<<?-?\s*/, "");
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
  if (!m) return { head: "", rawHead: "", rest: "" };
  return { head: m[1].replace(/^.*\//, ""), rawHead: m[1], rest: m[2] };
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

  for (const [re, reason] of WRITE_INDICATORS_RAW) {
    if (re.test(cmd)) return { kind: "write", reason };
  }
  const unquoted = stripQuotedSpans(cmd);
  for (const [re, reason] of WRITE_INDICATORS_UNQUOTED) {
    if (re.test(unquoted)) return { kind: "write", reason };
  }

  // state.sh 승인 호출은 **세그먼트 단위로** 면제한다. 종전에는 명령 어딘가에
  // `state.sh <서브커맨드>` 가 있기만 하면 즉시 approved-helper 를 반환해서 아래
  // 세그먼트 allowlist 검사를 통째로 건너뛰었다. 그래서 단독으로는 차단되는
  // 명령이 접두만 붙이면 통과했다:
  //   someunknowncmd <state.json>                     → write   (차단)
  //   state.sh get P '.a' ; someunknowncmd <state.json> → approved-helper (통과!)
  // `looksLikeFileWrite` 의 git 접두 면제와 정확히 같은 계열의 결함이다.
  let sawApprovedHelper = false;

  const readers: string[] = [];
  for (const segment of splitUnquotedSegments(cmd)) {
    if (STATE_SH_CALL_RE.test(segment)) { sawApprovedHelper = true; continue; }
    if (!STATE_JSON_PATH_RE.test(segment)) continue;
    const { head, rawHead, rest } = segmentHead(segment);

    // 선두 토큰이 **온전히** state.json 경로면 이 세그먼트는 명령이 아니라 단어다.
    //   for f in <state.json>; do …        → `for VAR in` 을 벗기면 경로만 남는다
    //   while …; done < <state.json>       → 입력 리디렉션을 벗기면 경로만 남는다
    // 단어에서 쓰기가 일어날 수는 없다 — 실제 쓰기는 위의 리디렉션 검사와 쓰기
    // 지표가 이미 잡았다. 여기서 차단하면 정상 읽기 루프가 막힌다.
    //
    // **반드시 앵커 매칭이다** (`RAWHEAD_IS_PATH`, `.test()` 아님). 종전에는
    // `STATE_JSON_PATH_RE.test(rawHead)` 로 **부분 문자열**을 봐서, rawHead 안
    // 어디든 경로가 있으면 세그먼트를 통째로 스킵했다. 그 결과 실제 쓰기가 통과했다:
    //   heredoc 본문 줄  open("<state.json>","w").write(...)  → rawHead 안에 경로 포함
    //   변수 대입        X=<state.json>                       → rawHead 안에 경로 포함
    // 둘 다 read-only 로 새어나갔다 (모듈 원칙 "미탐엔 복구 수단 없음" 위반).
    if (rawHead && RAWHEAD_IS_PATH.test(rawHead)) continue;

    // allowlist 명령이 자기 스크립트 문법으로 파일을 쓰는 경우 (awk print > "f",
    // sed 'w f'). 인용 구간 본문만 보므로 정상 비교 술어는 걸리지 않는다.
    for (const [cmdName, re, reason] of SCRIPT_BODY_WRITE_INDICATORS) {
      if (head !== cmdName) continue;
      if (quotedSpanBodies(rest).some((body) => re.test(body))) {
        return { kind: "write", reason };
      }
    }

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

  return sawApprovedHelper ? { kind: "approved-helper" } : { kind: "read-only", readers };
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
