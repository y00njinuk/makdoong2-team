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
  "PAT",
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

// HTTP Auth scheme literals as they appear in curl -H / logged request bodies.
// The 8-char minimum on the value guards against matching short scheme names
// used as words (e.g. "Bearer strategy").
const HTTP_AUTH_RE = /((?:Authorization\s*:\s*)?(?:Bearer|Basic|Token|Digest))\s+([A-Za-z0-9+/=._~\-]{8,})/g;

// Well-known token prefixes with distinctive shapes: Slack, GitHub, AWS IAM,
// npm registry, Google API, Atlassian PAT. Loose length filters chosen to
// avoid matching short identifiers that happen to share the prefix.
const KNOWN_PREFIX_RE = /\b((?:xox[abps]-[A-Za-z0-9-]{10,})|(?:gh[posur]_[A-Za-z0-9]{16,})|(?:AKIA[0-9A-Z]{12,})|(?:npm_[A-Za-z0-9]{20,})|(?:AIza[0-9A-Za-z_-]{20,})|(?:AT[AB][AT]T[A-Za-z0-9._~\-]{20,}))\b/g;

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
    .replace(HTTP_AUTH_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KNOWN_PREFIX_RE, () => REDACTED);
}

export function redactAndTruncate(input: string, maxChars: number): string {
  if (!input) return input;
  const redacted = redactSecrets(input);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…(truncated ${redacted.length - maxChars} chars)`;
}
