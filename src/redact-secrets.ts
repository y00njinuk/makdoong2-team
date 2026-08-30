const SECRET_KEY_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "APIKEY",
  "API_KEY",
  "API_TOKEN",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
  "PRIVATE_KEY",
  "PRIVKEY",
  "ACCESS_KEY",
  "SESSION_KEY",
  "COOKIE",
  // `PAT` 는 뒤에 알파벳이 오면 안 된다. 종전에는 부분 문자열로만 매칭해서
  // `PATH=/usr/bin` · `PATTERN=x` · `COMPATIBILITY_MODE=1` 이 통째로 마스킹됐다.
  // 진단 로그에서 PATH 가 사라지면 사후 분석의 가치가 크게 깎인다.
  // (`PAT` / `PAT_TOKEN` / `GITHUB_PAT` 는 계속 매칭된다.)
  "PAT(?![A-Za-z])",
] as const;

const KEY_NAME_ALTERNATION = SECRET_KEY_SUBSTRINGS.join("|");
const IDENT_CORE = `[A-Za-z0-9_]*(?:${KEY_NAME_ALTERNATION})[A-Za-z0-9_]*`;

export const REDACTED = "***REDACTED***";

// Shell KEY=VALUE with optional `export` prefix. `(?:^|[\s;&|(])` anchors the
// match to a shell-boundary so URL query strings / JSON blobs are not eaten.
// Value alternatives capture double-quoted, single-quoted, and bare forms —
// bare stops at whitespace or shell operators to preserve command boundaries.
const SHELL_ASSIGN_RE = new RegExp(
  `((?:^|[\\s;&|(])(?:export\\s+)?)(${IDENT_CORE})(=)(?:"([^"]*)"|'([^']*)'|([^\\s;&|)>]+))`,
  "gi",
);

// CLI long-flag forms: --token=... / --api-key ... / --password="..." etc.
// Handles both `=`-joined and space-separated values, matches secret-substring
// keys plus a small set of common CLI-only names not covered by env-style
// identifiers (token, api-key, api_key, bearer, cookie).
const CLI_FLAG_RE = new RegExp(
  `(--(?:${KEY_NAME_ALTERNATION}|token|api[-_]?key|api[-_]?token|password|secret|auth|bearer|cookie)(?:=|\\s+))(?:"([^"]*)"|'([^']*)'|([^\\s;&|)>]+))`,
  "gi",
);

// HTTP Auth 헤더. **대소문자를 구분하지 않는다** — GitHub·Jira 문서의 표준 표기가
// `authorization: bearer <token>` (소문자)이고, 종전 정규식은 그것을 놓쳤다.
// `Authorization:` 접두가 있으면 스킴 뒤 8자 이상을 무조건 마스킹한다.
//
// **스킴이 자기 뒤 공백을 소비한다** (`(?:scheme\s+)?`). 종전
// `…:\s*(?:scheme)?\s*` 는 스킴이 없을 때 인접한 두 `\s*` 가 공백 런을 나눠 갖는
// 방식이 여러 가지여서, `authorization:` 뒤 긴 공백 입력에 O(n²) 백트래킹이 났다
// (40k 입력 ~4s 실측). 스킴 분기 안으로 공백을 넣으면 헤더 뒤 `\s*` 하나만 남아
// 분할 모호성이 사라진다.
const HTTP_AUTH_HEADER_RE =
  /(authorization\s*:\s*(?:(?:bearer|basic|token|digest)\s+)?)([A-Za-z0-9+/=._~\-]{8,})/gi;

// 헤더 접두 없이 스킴만 나오는 형태. 8자 최소 길이만 두고 **의도적으로 과잉
// 마스킹**한다 — 산문의 "Bearer strategy_here" 가 지워지는 것은 실제 토큰이
// 새는 것보다 낫다는 것이 이 sanitizer 의 명시적 선택이다
// (test/redact-secrets.test.mjs 의 "conservative: over-masking …" 케이스가 고정).
const HTTP_AUTH_BARE_RE = /\b(Bearer|Basic|Token|Digest)\s+([A-Za-z0-9+/=._~\-]{8,})/g;

// `curl -u user:pass` / `--user user:pass`.
const CURL_USERINFO_RE = /((?:^|\s)(?:-u|--user)(?:=|\s+))(?:"([^"]*)"|'([^']*)'|([^\s;&|)>]+))/g;

// URL 에 매립된 자격증명: https://user:pass@host → user 는 남기고 비밀만 지운다.
const URL_CREDENTIAL_RE = /(\b[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/g;

// Well-known token prefixes with distinctive shapes: Slack, GitHub(구형 + 신형
// fine-grained `github_pat_`), GitLab, AWS IAM, npm registry, Google API,
// Atlassian PAT. Loose length filters chosen to avoid matching short identifiers
// that happen to share the prefix.
const KNOWN_PREFIX_RE = /\b((?:xox[abps]-[A-Za-z0-9-]{10,})|(?:github_pat_[A-Za-z0-9_]{20,})|(?:gh[posur]_[A-Za-z0-9]{16,})|(?:glpat-[A-Za-z0-9_\-]{16,})|(?:AKIA[0-9A-Z]{12,})|(?:npm_[A-Za-z0-9]{20,})|(?:AIza[0-9A-Za-z_-]{20,})|(?:AT[AB][AT]T[A-Za-z0-9._~\-]{20,}))\b/g;

// PEM 개인키 블록 전체. 헤더만 남기고 본문을 지운다.
const PEM_BLOCK_RE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g;

export function redactSecrets(input: string): string {
  if (!input || typeof input !== "string") return input;
  return input
    .replace(SHELL_ASSIGN_RE, (_m, prefix: string, key: string, eq: string, dq?: string, sq?: string) => {
      if (dq !== undefined) return `${prefix}${key}${eq}"${REDACTED}"`;
      if (sq !== undefined) return `${prefix}${key}${eq}'${REDACTED}'`;
      return `${prefix}${key}${eq}${REDACTED}`;
    })
    .replace(CLI_FLAG_RE, (_m, flagAndSep: string, dq?: string, sq?: string) => {
      if (dq !== undefined) return `${flagAndSep}"${REDACTED}"`;
      if (sq !== undefined) return `${flagAndSep}'${REDACTED}'`;
      return `${flagAndSep}${REDACTED}`;
    })
    .replace(CURL_USERINFO_RE, (_m, flagAndSep: string, dq?: string, sq?: string) => {
      if (dq !== undefined) return `${flagAndSep}"${REDACTED}"`;
      if (sq !== undefined) return `${flagAndSep}'${REDACTED}'`;
      return `${flagAndSep}${REDACTED}`;
    })
    .replace(URL_CREDENTIAL_RE, (_m, prefix: string, _secret: string, at: string) => `${prefix}${REDACTED}${at}`)
    .replace(HTTP_AUTH_HEADER_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(HTTP_AUTH_BARE_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PEM_BLOCK_RE, (_m, begin: string, end: string) => `${begin}\n${REDACTED}\n${end}`)
    .replace(KNOWN_PREFIX_RE, () => REDACTED);
}

export function redactAndTruncate(input: string, maxChars: number): string {
  if (!input) return input;
  const redacted = redactSecrets(input);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…(truncated ${redacted.length - maxChars} chars)`;
}
