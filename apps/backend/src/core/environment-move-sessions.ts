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
  const accountsRoot = path.join(context.storage.agentAccounts.agentAccountsDirectory(), "codex");
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
      if (await pathExists(homes.claudeJsonPath)) {
        const copied = await copyClaudeProjectEntry(homes.claudeJsonPath, from, to);
        if (!copied) throw new Error("Claude configuration is busy; relocation must retry");
      }
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
    const sourceFile = path.join(source, entry);
    // Persist the relocation marker before publication so a crash cannot leave
    // an unmarked transcript at the destination that a retry would skip.
    if (entry.endsWith(".jsonl")) {
      await appendJsonLine(sourceFile, {
        type: "relocated",
        sessionId: entry.slice(0, -".jsonl".length),
        relocatedCwd: to,
      });
    }
    await fs.rename(sourceFile, destination);
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

function sameCodexSessionIdentity(target: unknown, source: unknown): boolean {
  const a = asRecord(target);
  const b = asRecord(source);
  return (
    !!a &&
    !!b &&
    typeof a.bridgeSessionId === "string" &&
    typeof a.threadId === "string" &&
    a.bridgeSessionId === b.bridgeSessionId &&
    a.threadId === b.threadId &&
    a.cwdHash === b.cwdHash &&
    asRecord(a.config)?.cwd === asRecord(b.config)?.cwd
  );
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

async function readMigrationJson(file: string): Promise<unknown> {
  const handle = await fs.open(file, "r");
  try {
    const limit = 1024 * 1024;
    if ((await handle.stat()).size > limit)
      throw new Error("Codex migration file exceeds byte limit");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new Error("Codex migration file exceeds byte limit");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function mergeMigrationRows(target: unknown[], source: unknown[], key: string): unknown[] {
  const rows = new Map<string, unknown>();
  for (const value of [...target, ...source]) {
    const id = asRecord(value)?.[key];
    if (typeof id !== "string") throw new Error("Invalid Codex migration record identity");
    if (rows.has(id)) {
      if (key === "bridgeSessionId" && sameCodexSessionIdentity(rows.get(id), value)) continue;
      if (JSON.stringify(rows.get(id)) !== JSON.stringify(value))
        throw new Error("Conflicting Codex migration record identity");
    }
    rows.set(id, value);
  }
  return Array.from(rows.values());
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
  if (await pathExists(legacy)) {
    const parsed = asRecord(await readMigrationJson(legacy));
    const target = (await pathExists(legacyTarget))
      ? asRecord(await readMigrationJson(legacyTarget))
      : null;
    if (!parsed || !Array.isArray(parsed.sessions) || (target && !Array.isArray(target.sessions))) {
      throw new Error("Invalid Codex session registry during relocation");
    }
    const sessions = mergeMigrationRows(
      (target?.sessions as unknown[]) ?? [],
      parsed.sessions.map((session) => rekeyCodexSession(session, from, to)),
      "bridgeSessionId",
    );
    await writePrivateJson(legacyTarget, { ...parsed, ...target, sessions });
    await fs.rm(legacy);
  }

  const records = path.join(directory, `bridge-sessions-${oldHash}`);
  const recordsTarget = path.join(directory, `bridge-sessions-${newHash}`);
  await fs.mkdir(recordsTarget, { recursive: true, mode: 0o700 });
  // Also re-key records published by the previous rename-based implementation.
  for (const name of await fs.readdir(recordsTarget)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(recordsTarget, name);
    const value = await readMigrationJson(file);
    const rekeyed = rekeyCodexSession(value, from, to);
    if (rekeyed !== value) await writePrivateJson(file, rekeyed);
  }
  for (const name of await fs.readdir(records).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(records, name);
    const target = path.join(recordsTarget, name);
    const value = rekeyCodexSession(await readMigrationJson(file), from, to);
    if (await pathExists(target)) {
      if (!sameCodexSessionIdentity(await readMigrationJson(target), value)) {
        throw new Error("Conflicting Codex session records during relocation");
      }
    } else {
      await writePrivateJson(target, value);
    }
    await fs.rm(file);
  }
  await fs.rmdir(records).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });

  const journal = path.join(directory, `dispatch-journal-${oldHash}.json`);
  const journalTarget = path.join(directory, `dispatch-journal-${newHash}.json`);
  if (await pathExists(journal)) {
    if (!(await pathExists(journalTarget))) await fs.rename(journal, journalTarget);
    else {
      const source = asRecord(await readMigrationJson(journal));
      const target = asRecord(await readMigrationJson(journalTarget));
      if (
        source?.version !== 1 ||
        target?.version !== 1 ||
        !Array.isArray(source.records) ||
        !Array.isArray(target.records)
      ) {
        throw new Error("Invalid Codex dispatch journal during relocation");
      }
      const records = mergeMigrationRows(target.records, source.records, "requestId");
      if (records.length > 500)
        throw new Error("Codex dispatch journal relocation exceeds record limit");
      const merged = { ...target, records };
      if (Buffer.byteLength(JSON.stringify(merged)) > 1024 * 1024)
        throw new Error("Codex dispatch journal relocation exceeds byte limit");
      await writePrivateJson(journalTarget, merged);
      await fs.rm(journal);
    }
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
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
