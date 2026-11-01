import fs from "node:fs";
import path from "node:path";
import { StoreCorruptError, type StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

/**
 * Host-side resources a deleted environment can leave behind. Each step is
 * idempotent: running it against something already gone succeeds.
 */
export const ENVIRONMENT_CLEANUP_STEPS = [
  "container",
  "volumes",
  "network",
  "worktree",
  "branch",
  "state-dirs",
] as const;

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
  /**
   * The folder the worktree was created in, which deletion is confined to.
   * Absent for environments created before the location was recorded; those
   * live under the backend's startup worktree root.
   */
  worktreeRoot?: string | null;
  /** The environment's branch name at deletion time. */
  branch: string | null;
  /** True when the environment's PR was merged, which covers squash merges. */
  prMerged: boolean;
  createdFromCommit: string | null;
  /** Branches worth checking for the merge test besides `origin/HEAD`. */
  baseBranches: string[];
  containerId: string | null;
  /**
   * Recovery copies the environment kept (earlier runtimes). Removed with the
   * current runtime in the container step; absent in entries written before
   * recovery copies existed.
   */
  retainedContainers: string[];
  /**
   * Owner-labelled storage volumes of the environment. Removed only after the
   * container is gone, and only while their labels still name this owner and
   * environment.
   */
  volumes: string[];
  stateDirectories: string[];
  pending: EnvironmentCleanupStep[];
  attempts: number;
  lastAttemptAt: string | null;
  /**
   * Backend versions ordered by most recent attempt, newest last (at most 16;
   * least-recently seen versions are evicted). An entry at
   * the attempt cap gets one more retry cycle from a version not listed here.
   * Absent in entries written before versions were recorded.
   */
  attemptedVersions?: string[];
  /** Redacted failure summary: no paths, command output, or credentials. */
  lastError: string | null;
}

interface EnvironmentCleanupLedgerFile {
  version: 1;
  entries: Record<string, EnvironmentCleanupEntry>;
}

/** The backend database store that replaced `environment-cleanup-ledger.json`. */
export const ENVIRONMENT_CLEANUP_LEDGER_STORE = "environment-cleanup-ledger";

/** After this many passes an entry is kept for inspection but no longer retried. */
export const MAX_ENVIRONMENT_CLEANUP_ATTEMPTS = 8;

/**
 * True once the reconciler has stopped retrying an entry. The entry stays in
 * the ledger, so `disk:report` can show what a deletion never finished.
 */
export function isEnvironmentCleanupExhausted(
  entry: Pick<EnvironmentCleanupEntry, "attempts">,
): boolean {
  return entry.attempts >= MAX_ENVIRONMENT_CLEANUP_ATTEMPTS;
}

/** Older versions beyond this are forgotten, so the list stays bounded. */
const MAX_ATTEMPTED_VERSIONS = 16;

/**
 * True when `backendVersion` has never counted an attempt on the entry, which
 * entitles an exhausted entry to one more retry cycle: an upgrade is the
 * likeliest fix for a failure that outlasted every retry.
 */
export function isEnvironmentCleanupRetryableByVersion(
  entry: Pick<EnvironmentCleanupEntry, "attemptedVersions">,
  backendVersion: string,
): boolean {
  return !(entry.attemptedVersions ?? []).includes(backendVersion);
}

/**
 * An entry is bounded by what a single deletion can name, and the ledger by
 * how many deletions can fail without recovering. The cap keeps a pathological
 * host from growing the store without limit; the oldest entries go first.
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
    worktreeRoot: stringOrNull(record.worktreeRoot),
    branch: stringOrNull(record.branch),
    prMerged: record.prMerged === true,
    createdFromCommit: stringOrNull(record.createdFromCommit),
    baseBranches: strings(record.baseBranches),
    containerId: stringOrNull(record.containerId),
    retainedContainers: strings(record.retainedContainers).slice(0, 32),
    volumes: strings(record.volumes).slice(0, 64),
    stateDirectories: strings(record.stateDirectories),
    pending: Array.isArray(record.pending) ? [...new Set(record.pending.filter(isStep))] : [],
    attempts:
      typeof record.attempts === "number" && Number.isSafeInteger(record.attempts)
        ? Math.max(0, record.attempts)
        : 0,
    lastAttemptAt: stringOrNull(record.lastAttemptAt),
    lastError: stringOrNull(record.lastError),
    attemptedVersions: [...new Set(strings(record.attemptedVersions))].slice(
      -MAX_ATTEMPTED_VERSIONS,
    ),
  };
}

function normalizeLedger(value: unknown): EnvironmentCleanupLedgerFile {
  const ledger = emptyLedger();
  if (!value || typeof value !== "object") return ledger;
  const candidate = value as { version?: unknown; entries?: unknown };
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
    return ledger;
  }
  for (const raw of Object.values(candidate.entries as Record<string, unknown>)) {
    const entry = parseEntry(raw);
    if (entry) ledger.entries[entry.environmentId] = entry;
  }
  return ledger;
}

/**
 * The entries of a stored ledger value, normalized exactly as the ledger reads
 * them. For read-only callers (`disk:report`) that load the store themselves.
 */
export function parseEnvironmentCleanupLedger(value: unknown): EnvironmentCleanupEntry[] {
  return Object.values(normalizeLedger(value).entries);
}

/**
 * A stored value that is not valid JSON. The ledger and the sweep state are
 * recovery metadata: an unreadable store loses retries for the entries it
 * held, which the orphan sweeps partly cover, but must not stop deletion from
 * recording new ones. Every other error (an I/O or locking failure) still
 * throws, so a caller that must not act without the ledger fails safe.
 */
function isUnreadable(error: unknown): boolean {
  return error instanceof StoreCorruptError || error instanceof SyntaxError;
}

interface LedgerConnection {
  database: StorageDatabase;
  dev: number;
  ino: number;
}

/**
 * Process-wide on purpose, as are `ledgers` and `sweepStates`: each is keyed by
 * a resolved data directory, so two backends share an entry only when they
 * share a data directory, and then they share its database too.
 */
const connections = new Map<string, LedgerConnection>();

function sameDatabaseFile(connection: LedgerConnection): boolean {
  try {
    const stat = fs.statSync(connection.database.path);
    return stat.dev === connection.dev && stat.ino === connection.ino;
  } catch {
    return false;
  }
}

/**
 * The data directory's database, opened on first use and shared by the
 * ledger and the sweep state. A data directory deleted and recreated at the
 * same path (tests, a reset profile) leaves the old connection writing to an
 * unlinked file; the inode check reopens it against the current one.
 */
function cleanupDatabase(dataDir: string): StorageDatabase {
  const key = path.resolve(dataDir);
  const open = connections.get(key);
  if (open && !open.database.isClosed() && sameDatabaseFile(open)) return open.database;
  open?.database.close();
  connections.delete(key);
  const database = openBackendDatabase(key);
  try {
    const stat = fs.statSync(database.path);
    connections.set(key, { database, dev: stat.dev, ino: stat.ino });
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/** Reads never create a data directory that does not exist; it holds nothing. */
function readableCleanupDatabase(dataDir: string): StorageDatabase | null {
  if (!fs.existsSync(path.resolve(dataDir))) return null;
  return cleanupDatabase(dataDir);
}

/**
 * Closes the connections the ledger and sweep state opened (all of them, or
 * one data directory's). Call on backend shutdown and between tests; a later
 * use reopens lazily.
 */
export function closeEnvironmentCleanupStorage(dataDir?: string): void {
  for (const [key, connection] of Array.from(connections)) {
    if (dataDir !== undefined && key !== path.resolve(dataDir)) continue;
    connection.database.close();
    connections.delete(key);
  }
}

/**
 * The ledger lives in the backend database as an envelope store (`version`
 * plus one row per environment). Every mutation is one synchronous
 * read-modify-write transaction, so two backends sharing the data directory
 * cannot lose each other's records, and a crash leaves the previous commit.
 */
export class EnvironmentCleanupLedger {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  async list(): Promise<EnvironmentCleanupEntry[]> {
    const database = readableCleanupDatabase(this.dataDir);
    if (!database) return [];
    let value: unknown;
    try {
      value = database.readStore(ENVIRONMENT_CLEANUP_LEDGER_STORE)?.value;
    } catch (error) {
      if (isUnreadable(error)) return [];
      throw error;
    }
    return parseEnvironmentCleanupLedger(value);
  }

  async get(environmentId: string): Promise<EnvironmentCleanupEntry | null> {
    const database = readableCleanupDatabase(this.dataDir);
    if (!database) return null;
    let value: unknown;
    try {
      value = database.readStoreRow(ENVIRONMENT_CLEANUP_LEDGER_STORE, environmentId, "entries");
    } catch (error) {
      if (isUnreadable(error)) return null;
      throw error;
    }
    const entry = parseEntry(value);
    return entry?.environmentId === environmentId ? entry : null;
  }

  /**
   * Records the intent to clean up. A deletion retried after an earlier abort
   * keeps whatever the earlier attempt still owed, because its record may
   * describe resources the environment no longer names.
   */
  async record(entry: EnvironmentCleanupEntry): Promise<void> {
    this.mutate((ledger) => {
      const existing = ledger.entries[entry.environmentId];
      ledger.entries[entry.environmentId] = existing
        ? {
            ...entry,
            projectPath: entry.projectPath ?? existing.projectPath,
            worktreePath: entry.worktreePath ?? existing.worktreePath,
            worktreeRoot: entry.worktreePath
              ? (entry.worktreeRoot ?? null)
              : (existing.worktreeRoot ?? null),
            branch: entry.branch ?? existing.branch,
            containerId: entry.containerId ?? existing.containerId,
            prMerged: entry.prMerged || existing.prMerged,
            baseBranches: [...new Set([...entry.baseBranches, ...existing.baseBranches])],
            stateDirectories: [
              ...new Set([...entry.stateDirectories, ...existing.stateDirectories]),
            ],
            pending: [...new Set([...entry.pending, ...existing.pending])],
            attempts: existing.attempts,
            attemptedVersions: existing.attemptedVersions ?? [],
            recordedAt: existing.recordedAt,
          }
        : entry;
      trimLedger(ledger);
    });
  }

  /** Marks one step done and drops the entry once nothing is pending. */
  async complete(environmentId: string, step: EnvironmentCleanupStep): Promise<void> {
    this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry) return;
      entry.pending = entry.pending.filter((pending) => pending !== step);
      if (entry.pending.length === 0) delete ledger.entries[environmentId];
    });
  }

  async fail(environmentId: string, step: EnvironmentCleanupStep, error: string): Promise<void> {
    this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry) return;
      entry.lastError = `${step}: ${error}`;
    });
  }

  /**
   * Counts one reconciliation pass over the entry, successful or not, and
   * records the backend version that made it.
   */
  async noteAttempt(environmentId: string, at: Date, backendVersion?: string): Promise<void> {
    this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry) return;
      entry.attempts += 1;
      entry.lastAttemptAt = at.toISOString();
      if (backendVersion) {
        const versions = (entry.attemptedVersions ?? []).filter(
          (version) => version !== backendVersion,
        );
        entry.attemptedVersions = [...versions, backendVersion].slice(-MAX_ATTEMPTED_VERSIONS);
      }
    });
  }

  /**
   * Gives an exhausted entry one more retry cycle under a backend version that
   * has never attempted it, by resetting its attempts. The version is recorded
   * at once, so it cannot re-arm the entry again. True when it re-armed.
   */
  async rearmForVersion(environmentId: string, backendVersion: string): Promise<boolean> {
    let rearmed = false;
    this.mutate((ledger) => {
      const entry = ledger.entries[environmentId];
      if (!entry || !isEnvironmentCleanupExhausted(entry)) return;
      if (!isEnvironmentCleanupRetryableByVersion(entry, backendVersion)) return;
      entry.attempts = 0;
      entry.attemptedVersions = [...(entry.attemptedVersions ?? []), backendVersion].slice(
        -MAX_ATTEMPTED_VERSIONS,
      );
      rearmed = true;
    });
    return rearmed;
  }

  /**
   * One IMMEDIATE transaction: read (an unreadable store reads as empty and is
   * replaced), normalize, change, write. An empty ledger stays as an empty
   * envelope rather than a deleted store, so its revision keeps moving forward.
   */
  private mutate(operation: (ledger: EnvironmentCleanupLedgerFile) => void): void {
    const database = cleanupDatabase(this.dataDir);
    database.transaction(() => {
      const ledger = normalizeLedger(
        database.readStoreValueInTransaction(ENVIRONMENT_CLEANUP_LEDGER_STORE)?.value,
      );
      operation(ledger);
      database.writeStoreInTransaction(ENVIRONMENT_CLEANUP_LEDGER_STORE, ledger);
    });
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

/** One ledger per data directory, shared by deletion and reconciliation. */
export function environmentCleanupLedger(dataDir: string): EnvironmentCleanupLedger {
  const key = path.resolve(dataDir);
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = new EnvironmentCleanupLedger(key);
    ledgers.set(key, ledger);
  }
  return ledger;
}

interface EnvironmentCleanupSweepFile {
  version: 1;
  /** Project id -> ISO time the orphaned-branch sweep last completed for it. */
  branchSweeps: Record<string, string>;
  /** Last candidate examined in a capped pass, per project. */
  branchCursors: Record<string, string>;
}

/** The backend database store that replaced `environment-cleanup-sweeps.json`. */
export const ENVIRONMENT_CLEANUP_SWEEPS_STORE = "environment-cleanup-sweeps";

function normalizeSweeps(value: unknown): EnvironmentCleanupSweepFile {
  const state: EnvironmentCleanupSweepFile = { version: 1, branchSweeps: {}, branchCursors: {} };
  if (!value || typeof value !== "object") return state;
  const parsed = value as { version?: unknown; branchSweeps?: unknown; branchCursors?: unknown };
  if (parsed.version !== 1 || !parsed.branchSweeps || typeof parsed.branchSweeps !== "object") {
    return state;
  }
  for (const [id, at] of Object.entries(parsed.branchSweeps as Record<string, unknown>)) {
    if (typeof at === "string" && Number.isFinite(Date.parse(at))) state.branchSweeps[id] = at;
  }
  if (parsed.branchCursors && typeof parsed.branchCursors === "object") {
    for (const [id, cursor] of Object.entries(parsed.branchCursors as Record<string, unknown>)) {
      if (typeof cursor === "string" && cursor.startsWith("refs/heads/")) {
        state.branchCursors[id] = cursor;
      }
    }
  }
  return state;
}

/**
 * When the throttled orphan sweeps last ran. Losing this state only makes the
 * next sweep run early, so an unreadable store reads as empty.
 */
export class EnvironmentCleanupSweepState {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  async branchSweeps(): Promise<Record<string, string>> {
    return this.load().branchSweeps;
  }

  async branchCursors(): Promise<Record<string, string>> {
    return this.load().branchCursors;
  }

  /**
   * Records a completed branch sweep. Projects outside `knownProjectIds` are
   * dropped, which bounds the state by the number of projects.
   */
  async recordBranchSweep(
    projectId: string,
    at: Date,
    knownProjectIds: string[],
    cursor: string | null = null,
  ): Promise<void> {
    const known = new Set([...knownProjectIds, projectId]);
    const database = cleanupDatabase(this.dataDir);
    database.transaction(() => {
      const state = normalizeSweeps(
        database.readStoreValueInTransaction(ENVIRONMENT_CLEANUP_SWEEPS_STORE)?.value,
      );
      state.branchSweeps[projectId] = at.toISOString();
      if (cursor) state.branchCursors[projectId] = cursor;
      else delete state.branchCursors[projectId];
      for (const id of Object.keys(state.branchSweeps)) {
        if (!known.has(id)) delete state.branchSweeps[id];
      }
      for (const id of Object.keys(state.branchCursors)) {
        if (!known.has(id)) delete state.branchCursors[id];
      }
      database.writeStoreInTransaction(ENVIRONMENT_CLEANUP_SWEEPS_STORE, state);
    });
  }

  private load(): EnvironmentCleanupSweepFile {
    const database = readableCleanupDatabase(this.dataDir);
    if (!database) return normalizeSweeps(undefined);
    try {
      return normalizeSweeps(database.readStore(ENVIRONMENT_CLEANUP_SWEEPS_STORE)?.value);
    } catch (error) {
      if (isUnreadable(error)) return normalizeSweeps(undefined);
      throw error;
    }
  }
}

const sweepStates = new Map<string, EnvironmentCleanupSweepState>();

export function environmentCleanupSweepState(dataDir: string): EnvironmentCleanupSweepState {
  const key = path.resolve(dataDir);
  let state = sweepStates.get(key);
  if (!state) {
    state = new EnvironmentCleanupSweepState(key);
    sweepStates.set(key, state);
  }
  return state;
}
