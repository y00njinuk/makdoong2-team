import { createHash } from "node:crypto";

export function computeVerdictHash(raw: string, stage: string): string {
  if (typeof raw !== "string") {
    return createHash("sha256").update(`__nonstring__::${stage}`).digest("hex").slice(0, 16);
  }
  const trimmed = raw.trim();
  const parsed = parseVerdictJSON(trimmed);
  if (parsed && Array.isArray(parsed.findings)) {
    const items = parsed.findings
      .map((f: any) => {
        const severity = String(f?.severity ?? "").toLowerCase();
        const key = String(f?.item ?? f?.key ?? f?.name ?? "").toLowerCase();
        return `${severity}::${key}`;
      })
      .filter((s: string) => s !== "::")
      .sort();
    const signature = JSON.stringify({
      stage,
      verdict: String(parsed.verdict ?? parsed.status ?? "").toUpperCase(),
      items,
    });
    return createHash("sha256").update(signature).digest("hex").slice(0, 16);
  }
  return createHash("sha256").update(trimmed.slice(0, 800)).digest("hex").slice(0, 16);
}

function parseVerdictJSON(raw: string): any | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    const tail = raw.slice(firstBrace);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < tail.length; i++) {
      const ch = tail[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end > 0) candidates.push(tail.slice(0, end));
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === "object") return obj;
    } catch {
      /* candidate not valid JSON — try next */
    }
  }
  return null;
}
