import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Host-side resources a deleted environment can leave behind. Each step is
 * idempotent: running it against something already gone succeeds.
 */
export const ENVIRONMENT_CLEANUP_STEPS = ["container", "worktree", "branch", "state-dirs"] as const;

export type EnvironmentCleanupStep = (typeof ENVIRONMENT_CLEANUP_STEPS)[number];

/**
 * What one environment deletion still owes the host. Written before the first
 * destructive step, so a failure, crash, or swallowed error after the
 * environment record is gone still leaves a precise description of what to
 * retry. The reconciler removes only what an entry names.
 */
export interface EnvironmentCleanupEntry {
  version: 1;
  environmentId: string;
  recordedAt: string;
  /** The project checkout that owns the worktree and branch, when local. */
  projectPath: string | null;
  worktreePath: string | null;
  /** The environment's branch name at deletion time. */
  branch: string | null;
  /** True when the environment's PR was merged, which covers squash merges. */
  prMerged: boolean;
  createdFromCommit: string | null;
  /** Branches worth checking for the merge test besides `origin/HEAD`. */
  baseBranches: string[];
  containerId: string | null;
  stateDirectories: string[];
  pending: EnvironmentCleanupStep[];
  attempts: number;
  lastAttemptAt: string | null;
  /** Redacted failure summary: no paths, command output, or credentials. */
  lastError: string | null;
}

interface EnvironmentCleanupLedgerFile {
  version: 1;
  entries: Record<string, EnvironmentCleanupEntry>;
}

export const ENVIRONMENT_CLEANUP_LEDGER_FILE = "environment-cleanup-ledger.json";

/**
 * An entry is bounded by what a single deletion can name, and the ledger by
 * how many deletions can fail without recovering. The cap keeps a pathological
 * host from growing the file without limit; the oldest entries go first.
 */
const MAX_LEDGER_ENTRIES = 1_000;

function emptyLedger(): EnvironmentCleanupLedgerFile {
  return { version: 1, entries: {} };
}

function isStep(value: unknown): value is EnvironmentCleanupStep {
  return (
    typeof value === "string" && (ENVIRONMENT_CLEANUP_STEPS as readonly string[]).includes(value)
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseEntry(value: unknown): EnvironmentCleanupEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const environmentId = stringOrNull(record.environmentId);
  if (record.version !== 1 || !environmentId) return null;
  const strings = (items: unknown) =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  return {
    version: 1,
    environmentId,
    recordedAt: stringOrNull(record.recordedAt) ?? new Date(0).toISOString(),
    projectPath: stringOrNull(record.projectPath),
    worktreePath: stringOrNull(record.worktreePath),
    branch: stringOrNull(record.branch),
    prMerged: record.prMerged === true,
    createdFromCommit: stringOrNull(record.createdFromCommit),
    baseBranches: strings(record.baseBranches),
    containerId: stringOrNull(record.containerId),
    stateDirectories: strings(record.stateDirectories),
    pending: Array.isArray(record.pending) ? [...new Set(record.pending.filter(isStep))] : [],
    attempts:
      typeof record.attempts === "number" && Number.isSafeInteger(record.attempts)
        ? Math.max(0, record.attempts)
        : 0,
    lastAttemptAt: stringOrNull(record.lastAttemptAt),
    lastError: stringOrNull(record.lastError),
  };
}

export class EnvironmentCleanupLedger {
  private readonly filePath: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, ENVIRONMENT_CLEANUP_LEDGER_FILE);
  }

  async list(): Promise<EnvironmentCleanupEntry[]> {
    await this.mutation.catch(() => undefined);
    const ledger = await this.load();
    return Object.values(ledger.entries);
  }

  async get(environmentId: string): Promise<EnvironmentCleanupEntry | null> {
    await this.mutation.catch(() => undefined);
    return (await this.load()).entries[environmentId] ?? null;
  }

  /**
   * Records the intent to clean up. A deletion retried after an earlier abort
   * keeps whatever the earlier attempt still owed, because its record may
   * describe resources the environment no longer names.
   */
  async record(entry: EnvironmentCleanupEntry): Promise<void> {
    await this.mutate((ledger) => {
      const existing = ledger.entries[entry.environmentId];
      ledger.entries[entry.environmentId] = existing
        ? {
            ...entry,
            projectPath: entry.projectPath ?? existing.projectPath,
            worktreePath: entry.worktreePath ?? existing.worktreePath,
            branch: entry.branch ?? existing.branch,
            containerId: entry.containerId ?? existing.containerId,
            prMerged: entry.prMerged || existing.prMerged,
            baseBranches: [...new Set([...entry.baseBranches, ...existing.baseBranches])],
            stateDirectories: [
              ...new Set([...entry.stateDirectories, ...existing.stateDirectories]),
            ],
            pending: [...new Set([...entry.pending, ...existing.pending])],
            attempts: existing.attempts,
            recordedAt: existing.recordedAt,
          }
        : entry;
      trimLedger(ledger);
    });
  }

  /** Marks one step done and drops the entry once nothing is pending. */
  async complete(environmentId: string, step: EnvironmentCleanupStep): Promise<void> {
    await this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry) return;
      entry.pending = entry.pending.filter((pending) => pending !== step);
      if (entry.pending.length === 0) delete ledger.entries[environmentId];
    });
  }

  async fail(environmentId: string, step: EnvironmentCleanupStep, error: string): Promise<void> {
    await this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry) return;
      entry.lastError = `${step}: ${error}`;
    });
  }

  /** Counts one reconciliation pass over the entry, successful or not. */
  async noteAttempt(environmentId: string, at: Date): Promise<void> {
    await this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry) return;
      entry.attempts += 1;
      entry.lastAttemptAt = at.toISOString();
    });
  }

  private async load(): Promise<EnvironmentCleanupLedgerFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        return emptyLedger();
      }
      const ledger = emptyLedger();
      for (const value of Object.values(parsed.entries as Record<string, unknown>)) {
        const entry = parseEntry(value);
        if (entry) ledger.entries[entry.environmentId] = entry;
      }
      return ledger;
    } catch {
      // The ledger is recovery metadata. A torn file loses retries for the
      // entries it held, which the orphan sweeps partly cover, but must not
      // stop deletion from recording new ones.
      return emptyLedger();
    }
  }

  private async save(ledger: EnvironmentCleanupLedgerFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (Object.keys(ledger.entries).length === 0) {
      await rm(this.filePath, { force: true });
      return;
    }
    const temp = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private mutate(operation: (ledger: EnvironmentCleanupLedgerFile) => void): Promise<void> {
    const run = this.mutation.then(async () => {
      const ledger = await this.load();
      operation(ledger);
      await this.save(ledger);
    });
    this.mutation = run.catch(() => undefined);
    return run;
  }
}

function trimLedger(ledger: EnvironmentCleanupLedgerFile): void {
  const entries = Object.values(ledger.entries);
  if (entries.length <= MAX_LEDGER_ENTRIES) return;
  entries.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  for (const entry of entries.slice(0, entries.length - MAX_LEDGER_ENTRIES)) {
    delete ledger.entries[entry.environmentId];
  }
}

const ledgers = new Map<string, EnvironmentCleanupLedger>();

/** One ledger per data directory so deletion and reconciliation share a queue. */
export function environmentCleanupLedger(dataDir: string): EnvironmentCleanupLedger {
  const key = path.resolve(dataDir);
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = new EnvironmentCleanupLedger(key);
    ledgers.set(key, ledger);
  }
  return ledger;
}
