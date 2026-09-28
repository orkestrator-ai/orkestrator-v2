import { recordFileStem, sha256Hex } from "./keyed-record-format.js";
import {
  isMigrationProgress,
  newMigrationProgress,
  readMetaJson,
  writeMetaJson,
  type MigrationProgress,
} from "./keyed-record-meta.js";
import type { KeyedRecordStore } from "./keyed-record-store.js";

/**
 * Idempotent import of a legacy source into a keyed-record namespace.
 *
 * Each record is written with create-only CAS, so a live write that landed
 * first always wins and a retried import never overwrites newer data. A
 * tombstone is checked inside the record's critical section, so a deletion
 * racing the import wins even if the legacy source still holds the record.
 * Progress is checkpointed so a crash resumes near where it stopped, and the
 * completion marker is published only after the whole enumeration.
 *
 * This is not a multi-file transaction: every record rename is atomic, but a
 * crash leaves some records imported and others not. That is exactly what the
 * progress marker and create-only CAS make safe to retry.
 */
export interface KeyedRecordMigrationEntry {
  key: string;
  payload: Buffer | string;
  owner?: Record<string, string>;
  updatedAt?: number;
}

export type KeyedRecordMigrationFaultStage = "after-record" | "before-complete";

export interface KeyedRecordMigrationOptions {
  /** Stable migration identity, e.g. `legacy-display-tails-json`. */
  id: string;
  /** Changes whenever the source changes; a mismatch restarts progress from zero. */
  sourceFingerprint: string;
  /**
   * Enumerates the source in a stable order. `null` marks an entry that is
   * present but invalid (counted and skipped explicitly).
   */
  entries: () => Iterable<KeyedRecordMigrationEntry | null>;
  maxEntries: number;
  progressEvery?: number;
  now?: () => number;
  faults?: {
    at?(stage: KeyedRecordMigrationFaultStage, detail: { processed: number }): void | Promise<void>;
  };
}

export interface KeyedRecordMigrationResult {
  status: "completed" | "already-complete";
  imported: number;
  existing: number;
  tombstoned: number;
  invalid: number;
  rejected: number;
  truncated: number;
}

const MAX_PROGRESS_BYTES = 16 * 1024;

export function migrationProgressPath(store: KeyedRecordStore, id: string): string {
  return store.metaPath(`migration-${sha256Hex(id).slice(0, 32)}.json`);
}

export async function readMigrationProgress(
  store: KeyedRecordStore,
  id: string,
): Promise<MigrationProgress | null> {
  const read = await readMetaJson(
    migrationProgressPath(store, id),
    MAX_PROGRESS_BYTES,
    isMigrationProgress,
  );
  return read.status === "ok" && read.value.id === id ? read.value : null;
}

/** Publishes a completion marker without importing (source absent or retired). */
export async function markMigrationComplete(
  store: KeyedRecordStore,
  id: string,
  sourceFingerprint: string,
  now = Date.now(),
): Promise<void> {
  await store.ensureDirectory();
  const progress = newMigrationProgress(id, store.schema, sourceFingerprint);
  progress.completedAt = now;
  await writeMetaJson(migrationProgressPath(store, id), progress, {
    durable: true,
    maxBytes: MAX_PROGRESS_BYTES,
  });
}

export async function runKeyedRecordMigration(
  store: KeyedRecordStore,
  options: KeyedRecordMigrationOptions,
): Promise<KeyedRecordMigrationResult> {
  const result: KeyedRecordMigrationResult = {
    status: "completed",
    imported: 0,
    existing: 0,
    tombstoned: 0,
    invalid: 0,
    rejected: 0,
    truncated: 0,
  };
  await store.ensureDirectory();
  const now = options.now ?? Date.now;
  const progressPath = migrationProgressPath(store, options.id);
  const existingProgress = await readMigrationProgress(store, options.id);
  if (existingProgress?.completedAt !== undefined) return { ...result, status: "already-complete" };
  const progress =
    existingProgress &&
    existingProgress.sourceFingerprint === options.sourceFingerprint &&
    existingProgress.targetSchema === store.schema
      ? existingProgress
      : newMigrationProgress(options.id, store.schema, options.sourceFingerprint);
  const resumeAt = progress.processed;
  const every = Math.max(1, options.progressEvery ?? 16);
  const saveProgress = () =>
    writeMetaJson(progressPath, progress, { durable: true, maxBytes: MAX_PROGRESS_BYTES });

  let position = 0;
  for (const entry of options.entries()) {
    if (position >= options.maxEntries) {
      result.truncated += 1;
      continue;
    }
    position += 1;
    // Entries before the checkpoint were handled by an earlier attempt.
    // Replaying them would be harmless (create-only CAS) but wasted work.
    if (position <= resumeAt) continue;
    if (!entry) {
      result.invalid += 1;
    } else {
      const stem = recordFileStem(store.namespace, entry.key);
      const owner = entry.owner ?? {};
      const outcome = await store.put(entry.key, entry.payload, {
        owner,
        expectedRevision: null,
        ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
        fence: async () => !(await store.tombstones.isTombstoned(stem, owner)),
      });
      if (outcome.status === "written") result.imported += 1;
      else if (outcome.status === "conflict") result.existing += 1;
      else if (outcome.reason === "fenced") result.tombstoned += 1;
      else result.rejected += 1;
    }
    progress.processed = position;
    await options.faults?.at?.("after-record", { processed: position });
    if (position % every === 0) await saveProgress();
  }
  progress.imported += result.imported;
  progress.skipped +=
    result.existing + result.tombstoned + result.invalid + result.rejected + result.truncated;
  await options.faults?.at?.("before-complete", { processed: position });
  progress.completedAt = now();
  await saveProgress();
  return result;
}
