import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  copyClaudeProjectEntry,
  hostClaudeConfigDir,
  hostClaudeJsonPath,
  hostCodexHome,
} from "./agent-accounts-homes.js";
import { runtimeHostCodexHome } from "./agent-accounts-active.js";
import type { CommandContext } from "./commands-context.js";
import { environmentStateDirectory } from "./environment-state-paths.js";
import { pathExists } from "./shell.js";

/**
 * Agents remember the folder they ran in. When an environment's worktree
 * moves, the state each provider keys by that folder is moved to the new one,
 * so its conversations resume there instead of being reported missing and
 * replaced. Runs inside the move, after the bridges stopped and before any
 * of them can start again.
 *
 * Covered: Claude (transcripts and the `.claude.json` project entry), Codex
 * (the bridge's session registry and dispatch journal) and Cursor (the SDK's
 * agent rows). Pi reopens sessions by file, so it needs nothing. OpenCode and
 * Grok keep sessions in their own internal stores keyed by folder; those are
 * not rewritten, and their earlier conversations are not resumed.
 */
export interface SessionRelocationHomes {
  claudeConfigDir: string;
  claudeJsonPath: string;
  codexHomes: string[];
  cursorStateDir: string;
}

export async function defaultSessionRelocationHomes(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
): Promise<SessionRelocationHomes> {
  const codexHomes = new Set([runtimeHostCodexHome(), hostCodexHome()]);
  const accountsRoot = path.join(context.storage.agentAccountsDirectory(), "codex");
  for (const entry of await fs.readdir(accountsRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) codexHomes.add(path.join(accountsRoot, entry.name));
  }
  return {
    // Every account's `projects` links to the host's, so one tree holds them all.
    claudeConfigDir: hostClaudeConfigDir(),
    claudeJsonPath: hostClaudeJsonPath(),
    codexHomes: [...codexHomes],
    cursorStateDir: environmentStateDirectory(
      context.storage.getDataDir(),
      "cursor-bridge-state",
      environmentId,
    ),
  };
}

/**
 * Moves every provider's folder-keyed state from `fromPaths` (the recorded
 * worktree path and its resolved spelling) to `to`. Best effort per provider:
 * a failure is reported and the others still run.
 */
export async function relocateAgentSessionState(
  fromPaths: readonly string[],
  to: string,
  homes: SessionRelocationHomes,
): Promise<string[]> {
  const sources = [...new Set(fromPaths.filter((candidate) => candidate && candidate !== to))];
  const failures: string[] = [];
  const attempt = async (provider: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failures.push(provider);
      console.warn(
        `[backend] ${provider} sessions could not follow the moved environment:`,
        error instanceof Error ? error.message : error,
      );
    }
  };
  await attempt("Claude", async () => {
    for (const from of sources) {
      await relocateClaudeTranscripts(from, to, homes.claudeConfigDir);
      await copyClaudeProjectEntry(homes.claudeJsonPath, from, to);
    }
  });
  await attempt("Codex", async () => {
    for (const home of homes.codexHomes) {
      for (const from of sources) await relocateCodexBridgeState(from, to, home);
    }
  });
  await attempt("Cursor", () => relocateCursorAgents(sources, to, homes.cursorStateDir));
  return failures;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const CLAUDE_SLUG_MAX = 200;

/** Claude Code's 32-bit string hash, used to shorten long transcript folder names. */
function claudeStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Claude Code's transcript folder name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= CLAUDE_SLUG_MAX) return slug;
  return `${slug.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(claudeStringHash(cwd)).toString(36)}`;
}

/**
 * Claude only finds a conversation under the folder it is resumed in, and
 * reads a transcript's working directory from its last `relocated` line. This
 * is what Claude Code itself does when it relocates a session: move the
 * `<id>.jsonl` and its `<id>/` folder, then append the new directory. Entries
 * already present at the destination are left as they are.
 */
export async function relocateClaudeTranscripts(
  from: string,
  to: string,
  claudeConfigDir: string,
): Promise<void> {
  const fromSlug = claudeProjectSlug(from);
  const toSlug = claudeProjectSlug(to);
  if (fromSlug === toSlug) return;
  const root = path.join(claudeConfigDir, "projects");
  const source = path.join(root, fromSlug);
  const sourceStats = await fs.lstat(source).catch(() => null);
  if (!sourceStats?.isDirectory()) return;
  const target = path.join(root, toSlug);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source)) {
    const destination = path.join(target, entry);
    if (await pathExists(destination)) continue;
    await fs.rename(path.join(source, entry), destination);
    if (entry.endsWith(".jsonl")) {
      await appendJsonLine(destination, {
        type: "relocated",
        sessionId: entry.slice(0, -".jsonl".length),
        relocatedCwd: to,
      });
    }
  }
  await fs.rmdir(source).catch(() => undefined);
}

async function appendJsonLine(file: string, value: Record<string, unknown>): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    const { size } = await handle.stat();
    let separator = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) separator = "\n";
    }
    await handle.write(`${separator}${JSON.stringify(value)}\n`, size);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** The Codex bridge's key for a working directory (`hashCwd` in its persistence). */
export function codexCwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function rekeyCodexSession(value: unknown, from: string, to: string): unknown {
  const session = asRecord(value);
  if (!session || session.cwdHash !== codexCwdHash(from)) return value;
  const config = asRecord(session.config);
  return {
    ...session,
    cwdHash: codexCwdHash(to),
    ...(config && config.cwd === from ? { config: { ...config, cwd: to } } : {}),
  };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * The Codex bridge keeps its session registry and dispatch journal under a
 * hash of its working directory, and each record repeats that hash. Without
 * this a restarted bridge finds no sessions and the backend starts new ones.
 */
export async function relocateCodexBridgeState(
  from: string,
  to: string,
  codexHome: string,
): Promise<void> {
  const directory = path.join(codexHome, "orkestrator-bridge");
  if (!(await pathExists(directory))) return;
  const oldHash = codexCwdHash(from);
  const newHash = codexCwdHash(to);
  if (oldHash === newHash) return;

  const legacy = path.join(directory, `bridge-sessions-${oldHash}.json`);
  const legacyTarget = path.join(directory, `bridge-sessions-${newHash}.json`);
  if ((await pathExists(legacy)) && !(await pathExists(legacyTarget))) {
    const parsed = asRecord(JSON.parse(await fs.readFile(legacy, "utf8")));
    if (parsed && Array.isArray(parsed.sessions)) {
      await writePrivateJson(legacyTarget, {
        ...parsed,
        sessions: parsed.sessions.map((session) => rekeyCodexSession(session, from, to)),
      });
      await fs.rm(legacy, { force: true });
    }
  }

  const records = path.join(directory, `bridge-sessions-${oldHash}`);
  const recordsTarget = path.join(directory, `bridge-sessions-${newHash}`);
  if ((await pathExists(records)) && !(await pathExists(recordsTarget))) {
    await fs.rename(records, recordsTarget);
    for (const name of await fs.readdir(recordsTarget)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(recordsTarget, name);
      try {
        const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
        const rekeyed = rekeyCodexSession(value, from, to);
        if (rekeyed !== value) await writePrivateJson(file, rekeyed);
      } catch {
        // An unreadable record is skipped by the bridge too.
      }
    }
  }

  const journal = path.join(directory, `dispatch-journal-${oldHash}.json`);
  const journalTarget = path.join(directory, `dispatch-journal-${newHash}.json`);
  if ((await pathExists(journal)) && !(await pathExists(journalTarget))) {
    await fs.rename(journal, journalTarget);
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * The Cursor SDK only reads agents whose stored `cwd` is the bridge's working
 * directory. Its store is per environment, so every matching row moves.
 */
export async function relocateCursorAgents(
  fromPaths: readonly string[],
  to: string,
  cursorStateDir: string,
): Promise<void> {
  const file = path.join(cursorStateDir, "cursor-sdk", "agents.ndjson");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  let changed = false;
  const lines = raw.split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      const row = asRecord(JSON.parse(line));
      if (!row || typeof row.cwd !== "string" || !fromPaths.includes(row.cwd)) return line;
      changed = true;
      return JSON.stringify({ ...row, cwd: to });
    } catch {
      return line;
    }
  });
  if (!changed) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, lines.join("\n"), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
