import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { logger } from "./logger.js";

const SESSION_INDEX_FILE = "session-index.ndjson";

export type SessionIndexEntry = {
  sessionID: string;
  agent: string;
  worktree: string;
  issue: string;
  stage?: string;
  createdAt: string;
};

export function appendSessionIndex(entry: SessionIndexEntry): void {
  try {
    const dir = `${entry.worktree}/.makdoong2-team/${entry.issue}`;
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/${SESSION_INDEX_FILE}`, JSON.stringify(entry) + "\n");
  } catch (err) {
    logger.debug(`[session-index] append failed sessionID=${entry.sessionID}: ${(err as Error).message}`);
  }
}

export function findWorktreeRoot(startFile: string): string | null {
  if (typeof startFile !== "string" || startFile.length === 0) return null;
  let cur = pathResolve(startFile);
  cur = pathDirname(cur);
  for (let i = 0; i < 64; i++) {
    try {
      const st = statSync(`${cur}/.git`);
      if (st.isDirectory() || st.isFile()) return cur;
    } catch {
      /* .git not here — keep walking up */
    }
    const parent = pathDirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export function lookupSessionFromIndex(
  worktreeRoot: string,
  sessionID: string,
): SessionIndexEntry | null {
  if (typeof worktreeRoot !== "string" || typeof sessionID !== "string") return null;
  try {
    const base = `${worktreeRoot}/.makdoong2-team`;
    if (!existsSync(base)) return null;
    const issues = readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const issue of issues) {
      const idx = `${base}/${issue}/${SESSION_INDEX_FILE}`;
      if (!existsSync(idx)) continue;
      const content = readFileSync(idx, "utf8");
      const lines = content.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as SessionIndexEntry;
          if (obj?.sessionID === sessionID) return obj;
        } catch {
          /* malformed line — skip */
        }
      }
    }
  } catch {
    /* index root inaccessible */
  }
  return null;
}
