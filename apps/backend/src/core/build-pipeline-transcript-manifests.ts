import type { StorageDatabase } from "./storage-database.js";
import {
  BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE,
  BUILD_PIPELINE_TRANSCRIPT_TOTALS_STORE,
} from "./build-pipeline-transcript-layout.js";

/**
 * Row-level access to the transcript manifest store.
 *
 * `StorageDatabase.readStoreRow`/`updateStoreRow` load and cache every row of
 * a store whenever its revision moved, which for this store (up to 16,384
 * manifests of up to 512 KiB) would turn every foreign checkpoint into a
 * whole-store reload. These helpers go through the database's uncached row
 * access (`StorageDatabase.rows`), touching exactly the rows they name; every
 * committing write moves the store's revision so `StorageDatabase`'s own
 * caches (and other processes) still observe the change. Writes join the
 * caller's `StorageDatabase.transaction` (as a savepoint), together with the
 * quota totals they adjust.
 */

const MANIFEST_VERSION = 1;
const TOTALS_VERSION = 1;
const CHUNK_NAME = /^[0-9a-f]{64}-[0-9a-f]{64}\.chunk$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

export interface TranscriptChunkRef {
  name: string;
  /** Index of the chunk's first message within the stored transcript. */
  firstIndex: number;
  count: number;
  length: number;
  /** sha256 hex of the chunk bytes. */
  checksum: string;
}

/**
 * One checkpoint's edit: messages before `from` are identical, index for
 * index, to those of display revision `base`. Lets a reader holding `base`
 * (or an older revision the chain reaches) be patched from the first changed
 * message instead of from zero.
 */
export interface TranscriptRowChange {
  revision: number;
  base: number;
  from: number;
}

/** Newest-last edits kept per session; a reader further behind is reconciled from zero. */
export const MAX_TRANSCRIPT_ROW_CHANGES = 32;

export interface TranscriptManifestRow {
  v: typeof MANIFEST_VERSION;
  /** Manifest revision; the control record's `transcript.manifestRevision`. */
  revision: number;
  /** Content-free pipeline tag (the row owner). */
  pipeline: string;
  sdkSessionId: string;
  /** Display revision; the session's `messageRevision`. */
  displayRevision: number;
  fingerprint: string;
  /** Full-content digest; makes a retried checkpoint or import idempotent. */
  contentDigest: string;
  messageCount: number;
  /** Serialized bytes of the retained messages. */
  bytes: number;
  omittedMessages: number;
  committedAt: string;
  sourceRevision?: number;
  /** Sum of the chunk lengths: the bytes this session holds on disk. */
  totalBytes: number;
  chunks: TranscriptChunkRef[];
  /** Recent edits of the same provider session, oldest first; absent on older rows. */
  changes?: TranscriptRowChange[];
}

export interface TranscriptTotals {
  sessions: number;
  /** Chunk bytes plus serialized manifest bytes of every committed session. */
  bytes: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTranscriptChunkRef(value: unknown): value is TranscriptChunkRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.name === "string" &&
    CHUNK_NAME.test(ref.name) &&
    isNonNegativeInteger(ref.firstIndex) &&
    isNonNegativeInteger(ref.count) &&
    (ref.count as number) > 0 &&
    isNonNegativeInteger(ref.length) &&
    typeof ref.checksum === "string" &&
    CHECKSUM.test(ref.checksum)
  );
}

function isTranscriptRowChanges(value: unknown): value is TranscriptRowChange[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TRANSCRIPT_ROW_CHANGES &&
    value.every(
      (change) =>
        !!change &&
        typeof change === "object" &&
        isNonNegativeInteger((change as TranscriptRowChange).revision) &&
        isNonNegativeInteger((change as TranscriptRowChange).base) &&
        isNonNegativeInteger((change as TranscriptRowChange).from),
    )
  );
}

export function isTranscriptManifestRow(value: unknown): value is TranscriptManifestRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    row.v !== MANIFEST_VERSION ||
    !isNonNegativeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    typeof row.pipeline !== "string" ||
    typeof row.sdkSessionId !== "string" ||
    !isNonNegativeInteger(row.displayRevision) ||
    typeof row.fingerprint !== "string" ||
    typeof row.contentDigest !== "string" ||
    !isNonNegativeInteger(row.messageCount) ||
    !isNonNegativeInteger(row.bytes) ||
    !isNonNegativeInteger(row.omittedMessages) ||
    typeof row.committedAt !== "string" ||
    (row.sourceRevision !== undefined && !isNonNegativeInteger(row.sourceRevision)) ||
    !isNonNegativeInteger(row.totalBytes) ||
    !Array.isArray(row.chunks) ||
    (row.changes !== undefined && !isTranscriptRowChanges(row.changes))
  ) {
    return false;
  }
  let next = 0;
  let total = 0;
  for (const chunk of row.chunks as unknown[]) {
    if (!isTranscriptChunkRef(chunk) || chunk.firstIndex !== next) return false;
    next += chunk.count;
    total += chunk.length;
  }
  return next === row.messageCount && total === row.totalBytes;
}

export type ManifestRowRead =
  { status: "found"; row: TranscriptManifestRow } | { status: "missing" } | { status: "corrupt" };

function parseRow(serialized: string): TranscriptManifestRow | null {
  try {
    const value = JSON.parse(serialized) as unknown;
    return isTranscriptManifestRow(value) ? value : null;
  } catch {
    return null;
  }
}

function isTotals(value: unknown): value is TranscriptTotals & { v: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const totals = value as Record<string, unknown>;
  return (
    totals.v === TOTALS_VERSION &&
    isNonNegativeInteger(totals.sessions) &&
    isNonNegativeInteger(totals.bytes)
  );
}

/** Bytes a committed row accounts for in the namespace quota. */
export function accountedBytes(row: TranscriptManifestRow, serialized: string): number {
  return row.totalBytes + Buffer.byteLength(serialized, "utf8");
}

/** Serialized `totalBytes` of a manifest row, or 0 when it is not readable (SQL `json_extract` semantics). */
function serializedTotalBytes(serialized: string): number {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    const totalBytes = (value as Record<string, unknown>).totalBytes;
    return typeof totalBytes === "number" && Number.isFinite(totalBytes) ? totalBytes : 0;
  } catch {
    return 0;
  }
}

export class TranscriptManifestRows {
  constructor(private readonly database: () => StorageDatabase) {}

  private get rows() {
    return this.database().rows(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE);
  }

  /** Runs a write in the caller's transaction (a savepoint) or its own. */
  private write<T>(fn: () => T): T {
    return this.database().transaction(fn);
  }

  read(key: string): ManifestRowRead {
    const found = this.rows.get(key);
    if (found === undefined) return { status: "missing" };
    const row = parseRow(found);
    return row ? { status: "found", row } : { status: "corrupt" };
  }

  /** The committed manifest revision, or `null` when absent. */
  revisionOf(key: string): number | null {
    const found = this.rows.get(key);
    if (found === undefined) return null;
    let revision: unknown;
    try {
      const value = JSON.parse(found) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        revision = (value as Record<string, unknown>).revision;
      }
    } catch {
      // Corrupt: below.
    }
    // A corrupt row still occupies the key: report revision 0 so a commit
    // planned against "absent" cannot silently replace it.
    return isNonNegativeInteger(revision) ? revision : 0;
  }

  has(key: string): boolean {
    return this.rows.has(key);
  }

  keys(): string[] {
    return this.rows
      .list({ collection: "", values: false })
      .map((entry) => entry.key)
      .sort(compareKeys);
  }

  owners(): string[] {
    return this.rows.owners();
  }

  /** Every row one pipeline owns (unparseable rows come back as `null`). */
  byOwner(owner: string): Array<{ key: string; row: TranscriptManifestRow | null }> {
    return this.rows
      .list({ owner })
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((entry) => ({ key: entry.key, row: parseRow(entry.value!) }));
  }

  totals(): TranscriptTotals {
    try {
      const value = this.database().readStoreValueInTransaction(
        BUILD_PIPELINE_TRANSCRIPT_TOTALS_STORE,
      )?.value;
      if (isTotals(value)) return { sessions: value.sessions, bytes: value.bytes };
    } catch {
      // Unreadable totals: recomputed below.
    }
    return this.computeTotals();
  }

  /**
   * Recounts the totals from the rows: the row sizes come from the listing,
   * and each row is then read and parsed alone, so memory stays one row.
   */
  computeTotals(): TranscriptTotals {
    const rows = this.rows;
    const entries = rows.list({ collection: "", values: false });
    let bytes = 0;
    for (const entry of entries) {
      bytes += entry.bytes;
      const value = rows.get(entry.key);
      if (value !== undefined) bytes += serializedTotalBytes(value);
    }
    return { sessions: entries.length, bytes };
  }

  /** Rewrites the totals from the rows (repair). */
  rebuildTotals(): TranscriptTotals {
    return this.write(() => {
      const totals = this.computeTotals();
      this.writeTotals(totals);
      return totals;
    });
  }

  private writeTotals(totals: TranscriptTotals): void {
    this.database().writeStoreInTransaction(BUILD_PIPELINE_TRANSCRIPT_TOTALS_STORE, {
      v: TOTALS_VERSION,
      sessions: Math.max(0, totals.sessions),
      bytes: Math.max(0, totals.bytes),
    });
  }

  private accountedOf(key: string): number | null {
    const found = this.rows.get(key);
    if (found === undefined) return null;
    return Buffer.byteLength(found, "utf8") + serializedTotalBytes(found);
  }

  /**
   * Quota delta of replacing `key` with `row`: what admission must check
   * before {@link put}. Inside a transaction for an authoritative answer.
   */
  admission(key: string, serialized: string, row: TranscriptManifestRow) {
    const previous = this.accountedOf(key);
    const totals = this.totals();
    return {
      sessions: totals.sessions + (previous === null ? 1 : 0),
      bytes: totals.bytes - (previous ?? 0) + accountedBytes(row, serialized),
    };
  }

  /** Inserts or replaces one row and adjusts the totals. Returns the serialized bytes. */
  put(key: string, row: TranscriptManifestRow, serialized = JSON.stringify(row)): number {
    return this.write(() => {
      const next = this.admission(key, serialized, row);
      // Position 0 throughout: rows list in key order.
      this.rows.put(key, serialized, { owner: row.pipeline, position: 0 });
      this.writeTotals(next);
      return Buffer.byteLength(serialized, "utf8");
    });
  }

  /** Inserts `row` only when `key` has no row yet. */
  insertIfAbsent(key: string, row: TranscriptManifestRow): boolean {
    return this.write(() => {
      if (this.has(key)) return false;
      this.put(key, row);
      return true;
    });
  }

  delete(key: string): boolean {
    return this.write(() => {
      const previous = this.accountedOf(key);
      if (previous === null) return false;
      // Read before the delete: absent totals are recounted from the rows.
      const totals = this.totals();
      this.rows.delete(key);
      this.writeTotals({ sessions: totals.sessions - 1, bytes: totals.bytes - previous });
      return true;
    });
  }

  storeRevision(): number | null {
    return this.database().storeRevision(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE);
  }
}

/** Key order of the listing (keys are ASCII tags, where code-unit order is byte order). */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
