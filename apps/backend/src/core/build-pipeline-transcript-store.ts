import { createHash, randomUUID } from "node:crypto";
import { promises as fs, lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  PIPELINE_TRANSCRIPT_REFERENCE_VERSION,
  type PipelineTranscriptReference,
} from "@orkestrator/protocol/build-pipeline";
import {
  ensureNamespaceDirectory,
  isMissingPathError,
  readBoundedFile,
  recordFileStem,
  sha256Hex,
  syncDirectory,
  writeExclusivePrivateFile,
} from "./keyed-record-format.js";
import {
  MAX_TRANSCRIPT_ROW_CHANGES,
  TranscriptManifestRows,
  type TranscriptChunkRef,
  type TranscriptManifestRow,
  type TranscriptRowChange,
} from "./build-pipeline-transcript-manifests.js";
import {
  importLegacyManifest,
  legacyManifestsSettled,
  migrateLegacyManifests,
  type LegacyManifestDeps,
  type LegacyManifestMigrationReport,
} from "./build-pipeline-transcript-legacy-manifests.js";
import type { StorageDatabase } from "./storage-database.js";

/**
 * Durable build-pipeline display transcripts, stored apart from the workflow
 * control record (plan step 16, finding E14).
 *
 * Metadata lives in the database (`build-pipeline-transcript-layout.ts`): one
 * manifest row per pipeline session naming its ordered chunks, plus quota
 * totals. The message bodies stay files:
 *
 *   build-pipeline-transcripts/chunks/<stem>-<sha256>.chunk
 *
 * immutable, content-addressed JSON-array slices of messages. Completed
 * chunks are never rewritten: an active turn writes only its unsealed tail
 * chunk.
 *
 * A checkpoint has two steps:
 *
 * 1. {@link BuildPipelineTranscriptStore.stage} (async, outside any
 *    transaction) writes and fsyncs the new chunk files and keeps the new
 *    manifest in memory, returning the reference the control record will carry.
 * 2. The control-record write commits the manifest row in the SAME database
 *    transaction as the control row ({@link commitStagedInTransaction}), after
 *    checking the manifest's base revision, the quota and that its new chunks
 *    are on disk. Either both land or neither does: a control record never
 *    references a manifest that is not committed, and a committed manifest
 *    always has its control record.
 *
 * Chunk files are only ever unlinked while holding the database write lock
 * and only when no committed row references them ({@link unlinkUnreferenced});
 * a commit checks its new chunks exist under that same lock. So a chunk can
 * never disappear under a committed manifest, in this process or another.
 * A crash leaves at worst unreferenced chunk files, which {@link repair}
 * collects after the grace window.
 *
 * Unlike native display tails (a regenerable cache), this is the offline copy
 * the user was promised: fsynced, never evicted. Oversized content is recorded
 * as explicitly incomplete rather than failing the workflow write.
 */
export const BUILD_PIPELINE_TRANSCRIPT_DIRECTORY = "build-pipeline-transcripts";
export const BUILD_PIPELINE_TRANSCRIPT_NAMESPACE = "build-pipeline-transcript/v1";
const CHUNKS_DIRECTORY = "chunks";
const CHUNK_EXTENSION = ".chunk";
const TEMP_EXTENSION = ".tmp";

export interface BuildPipelineTranscriptLimits {
  /** Chunks are packed up to this size; a smaller final chunk is the mutable tail. */
  targetChunkBytes: number;
  /** A single message larger than this cannot be stored and is omitted explicitly. */
  maxChunkBytes: number;
  /** Retained history per session; older messages beyond it are omitted explicitly. */
  maxSessionBytes: number;
  maxChunksPerSession: number;
  maxSessions: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
}

export const BUILD_PIPELINE_TRANSCRIPT_LIMITS: Readonly<BuildPipelineTranscriptLimits> =
  Object.freeze({
    targetChunkBytes: 256 * 1024,
    maxChunkBytes: 8 * 1024 * 1024,
    // Above the old 32 MiB whole-snapshot bound. Migration keeps an inline
    // body when an individual message cannot fit one chunk.
    maxSessionBytes: 48 * 1024 * 1024,
    maxChunksPerSession: 1_024,
    maxSessions: 16_384,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
    maxManifestBytes: 512 * 1024,
  });

/**
 * How long an unreferenced chunk (or a manifest row without a control record)
 * must age before repair may remove it. Covers a staged checkpoint waiting
 * for its control write.
 */
export const BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS = 10 * 60_000;
/** Staged checkpoints kept for their control write; older ones are dropped. */
const MAX_STAGED = 256;
/** Chunk unlinks per write-locked transaction. */
const UNLINK_BATCH = 64;
/** Concurrent stage operations (each may hold a whole session's chunks in memory). */
const MAX_CONCURRENT_STAGES = 2;
const MAX_LEGACY_MISSES = 4_096;
/** Sessions whose tail message digests are kept for the next checkpoint's edit detection. */
const MAX_TAIL_DIGEST_SESSIONS = 64;

export type BuildPipelineTranscriptFaultStage =
  | "after-chunks"
  | "after-commit"
  | "before-control-save"
  | "after-control-save"
  | "migration-after-import"
  | "migration-before-control-commit"
  | "delete-after-control"
  | "legacy-manifest-batch";

export interface BuildPipelineTranscriptFaults {
  /** Test-only hook. Throw to simulate a crash at `stage`; on-disk state is left as is. */
  at?(stage: BuildPipelineTranscriptFaultStage, detail: { key: string }): void | Promise<void>;
}

export interface BuildPipelineTranscriptStoreOptions {
  /** `<data>/build-pipeline-transcripts`: chunk files and the legacy manifests. */
  directory: string;
  database: () => StorageDatabase;
  /**
   * Whether a pipeline tag still has a control record. Synchronous: called
   * inside transactions (legacy import, orphan sweep). Defaults to "yes".
   */
  isLivePipeline?: (pipelineTag: string) => boolean;
  now?: () => number;
  limits?: Partial<BuildPipelineTranscriptLimits>;
  faults?: () => BuildPipelineTranscriptFaults | null | undefined;
}

export interface TranscriptCommitInput {
  pipelineId: string;
  sessionKey: string;
  sdkSessionId: string;
  messages: readonly unknown[];
  /** Display revision to record when the content differs from the stored copy. */
  revision: number;
  /** Change-detector digest of `messages` (see `transcriptFingerprint`). */
  fingerprint: string;
  /** Control-record revision the messages were imported from (migration only). */
  sourceRevision?: number;
}

/** A checkpoint whose chunks are durable and whose manifest awaits its control write. */
export interface StagedTranscript {
  readonly key: string;
  readonly pipelineTag: string;
  readonly sessionKey: string;
  /** Committed manifest revision this one replaces (`null`: none). */
  readonly baseRevision: number | null;
  readonly row: TranscriptManifestRow;
  readonly serialized: string;
  readonly reference: PipelineTranscriptReference;
  readonly fingerprint: string;
  /** Chunks the base manifest does not reference. */
  readonly newChunks: readonly TranscriptChunkRef[];
  /** Base chunks this manifest no longer references. */
  readonly droppedChunks: readonly string[];
  readonly stagedAt: number;
  readonly chunkWrites: number;
  readonly chunkBytesWritten: number;
}

export type TranscriptCommitResult =
  | {
      status: "staged";
      reference: PipelineTranscriptReference;
      fingerprint: string;
      /**
       * False when identical content is already committed (idempotent retry):
       * the reference is the committed one and nothing awaits a commit.
       */
      written: boolean;
      staged?: StagedTranscript;
    }
  | { status: "rejected"; reason: string };

export type TranscriptRead =
  | {
      status: "found";
      messages: unknown[];
      /** Index of `messages[0]` within the stored transcript. */
      startIndex: number;
      messageCount: number;
      revision: number;
      /** Store generation, including checkpoints that reuse a display revision. */
      manifestRevision?: number;
      complete: boolean;
      /**
       * True when the committed manifest is not the revision the reference
       * names: a control record written before the commit and the reference
       * became one transaction, or migrated from the file store. The
       * committed manifest answered.
       */
      substituted: boolean;
      /** The window stopped early at `maxBytes`; more messages follow. */
      truncated?: true;
      /** Recent edits ending at `revision`, oldest first (see {@link stablePrefix}). */
      changes?: readonly TranscriptRowChange[];
    }
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

export interface TranscriptReadWindow {
  fromIndex?: number;
  toIndex?: number;
  /**
   * Stop before the message that would take the serialized messages (each
   * `JSON.stringify`, comma-separated) past this many bytes.
   */
  maxBytes?: number;
}

export interface BuildPipelineTranscriptStats {
  /** Manifest rows committed. */
  commits: number;
  idempotentCommits: number;
  chunkWrites: number;
  chunkBytesWritten: number;
  manifestBytesWritten: number;
  chunkReads: number;
  chunkBytesRead: number;
  rejected: number;
  /** fsyncs issued for chunk files and their directory (the commit's own is SQLite's). */
  fileSyncs: number;
  chunkUnlinks: number;
}

export type StagedCommitOutcome = { ok: true } | { ok: false; reason: string };

function tag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Content-free owner tag: deletion and the orphan sweep match on it. */
export function transcriptPipelineTag(pipelineId: string): string {
  return tag(`pipeline\0${pipelineId}`);
}

/** Row key of one session's manifest. */
export function transcriptSessionKey(pipelineId: string, sessionKey: string): string {
  return `${transcriptPipelineTag(pipelineId)}/${tag(`session\0${sessionKey}`)}`;
}

function encodeChunk(serialized: readonly string[]): Buffer {
  return Buffer.from(`[${serialized.join(",")}]`, "utf8");
}

function serializeMessage(message: unknown): string {
  try {
    return JSON.stringify(message) ?? "null";
  } catch {
    // Provider messages arrive as parsed JSON; anything else is not display data.
    return "null";
  }
}

function referenceKey(reference: PipelineTranscriptReference): string {
  return [
    reference.manifestRevision,
    reference.committedAt,
    reference.sdkSessionId,
    reference.revision,
    reference.messageCount,
    reference.bytes,
  ].join("|");
}

/** Short per-message digest, compared only between two copies of one session. */
function digestMessage(item: string): string {
  return createHash("sha256").update(item).digest("base64").slice(0, 22);
}

/**
 * How many leading messages a reader holding display revision `held` shares
 * with the revision the edits end at: the smallest `from` along the chain of
 * edits back to `held`. Undefined when the chain does not reach it (too old,
 * another provider session, or a row from before edits were recorded).
 */
export function stablePrefix(
  read: { revision: number; changes?: readonly TranscriptRowChange[] },
  held: number,
): number | undefined {
  if (held === read.revision) return Number.POSITIVE_INFINITY;
  const changes = read.changes ?? [];
  let revision = read.revision;
  let from = Number.POSITIVE_INFINITY;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]!;
    if (change.revision !== revision) return undefined;
    from = Math.min(from, change.from);
    revision = change.base;
    if (revision === held) return from;
  }
  return undefined;
}

function digestContent(items: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(String(items.length));
  for (const item of items) {
    hash.update("\0");
    hash.update(item);
  }
  return hash.digest("hex");
}

/** Per-key FIFO without the keyed-record engine. */
class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class BuildPipelineTranscriptStore {
  readonly limits: BuildPipelineTranscriptLimits;
  readonly rows: TranscriptManifestRows;
  private readonly chunksDirectory: string;
  private readonly queue = new SerialQueue();
  private readonly stages = new Semaphore(MAX_CONCURRENT_STAGES);
  /** Staged checkpoints by row key, oldest first. */
  private readonly staged = new Map<string, StagedTranscript[]>();
  private stagedCount = 0;
  private directoryReady: Promise<void> | null = null;
  private legacySettled = false;
  private readonly legacyMisses = new Set<string>();
  private stemIndex: { revision: number | null; stems: Map<string, string> } | null = null;
  /**
   * Per session, the digests of the messages in the unsealed last chunk a
   * checkpoint staged (from `start` on), keyed by its content. The next
   * checkpoint compares its own repacked messages against them to find the
   * first edited message. Memory only: after a restart an edit is located at
   * chunk granularity.
   */
  private readonly tailDigests = new Map<
    string,
    Array<{ contentDigest: string; start: number; digests: string[] }>
  >();
  private readonly counters: BuildPipelineTranscriptStats = {
    commits: 0,
    idempotentCommits: 0,
    chunkWrites: 0,
    chunkBytesWritten: 0,
    manifestBytesWritten: 0,
    chunkReads: 0,
    chunkBytesRead: 0,
    rejected: 0,
    fileSyncs: 0,
    chunkUnlinks: 0,
  };

  constructor(private readonly options: BuildPipelineTranscriptStoreOptions) {
    this.limits = { ...BUILD_PIPELINE_TRANSCRIPT_LIMITS, ...options.limits };
    this.rows = new TranscriptManifestRows(options.database);
    this.chunksDirectory = path.join(options.directory, CHUNKS_DIRECTORY);
  }

  private get database(): StorageDatabase {
    return this.options.database();
  }

  stats(): BuildPipelineTranscriptStats {
    return { ...this.counters };
  }

  async fault(stage: BuildPipelineTranscriptFaultStage, key: string): Promise<void> {
    await this.options.faults?.()?.at?.(stage, { key });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isLive(pipelineTag: string): boolean {
    return this.options.isLivePipeline?.(pipelineTag) ?? true;
  }

  private ensureDirectories(): Promise<void> {
    this.directoryReady ??= (async () => {
      await ensureNamespaceDirectory(this.options.directory);
      await ensureNamespaceDirectory(this.chunksDirectory);
    })().catch((error) => {
      this.directoryReady = null;
      throw error;
    });
    return this.directoryReady;
  }

  private chunkPath(name: string): string {
    return path.join(this.chunksDirectory, name);
  }

  private chunkName(key: string, checksum: string): string {
    return `${recordFileStem(BUILD_PIPELINE_TRANSCRIPT_NAMESPACE, key)}-${checksum}${CHUNK_EXTENSION}`;
  }

  // ---------------------------------------------------------------------------
  // Legacy (file) manifests

  private legacyDeps(): LegacyManifestDeps {
    return {
      database: this.options.database,
      rows: this.rows,
      namespace: BUILD_PIPELINE_TRANSCRIPT_NAMESPACE,
      directory: this.options.directory,
      maxManifestBytes: this.limits.maxManifestBytes,
      isLive: (pipelineTag) => this.isLive(pipelineTag),
      now: () => this.now(),
    };
  }

  private legacyDone(): boolean {
    if (this.legacySettled) return true;
    this.legacySettled = legacyManifestsSettled(this.legacyDeps());
    return this.legacySettled;
  }

  /**
   * Imports one session's pre-database manifest ahead of the background job,
   * so a read or checkpoint never sees "missing" for data that still exists.
   */
  private async ensureImported(
    key: string,
    options: { preferRevision?: number; ownerIsLive?: boolean } = {},
  ): Promise<void> {
    if (this.legacyDone() || this.legacyMisses.has(key) || this.rows.has(key)) return;
    if ((await importLegacyManifest(this.legacyDeps(), key, options)) === "absent") {
      this.legacyMisses.add(key);
      if (this.legacyMisses.size > MAX_LEGACY_MISSES) {
        this.legacyMisses.delete(this.legacyMisses.values().next().value as string);
      }
    }
  }

  /** Imports the given sessions' legacy manifests (before deleting their pipeline). */
  async ensureSessionsImported(pipelineId: string, sessionKeys: readonly string[]): Promise<void> {
    if (this.legacyDone()) return;
    for (const sessionKey of sessionKeys) {
      await this.ensureImported(transcriptSessionKey(pipelineId, sessionKey));
    }
  }

  /**
   * Before a control write: imports the pre-database manifest of every
   * referenced session this process did not stage, so the commit transaction
   * can tell a committed reference from an expired staged one.
   */
  async ensureReferencesImported(
    pipelineId: string,
    sessions: ReadonlyArray<{ sessionKey: string; transcript?: PipelineTranscriptReference }>,
  ): Promise<void> {
    if (this.legacyDone()) return;
    for (const { sessionKey, transcript } of sessions) {
      if (!transcript || this.stagedFor(pipelineId, sessionKey, transcript)) continue;
      await this.ensureImported(transcriptSessionKey(pipelineId, sessionKey), {
        preferRevision: transcript.manifestRevision,
        ownerIsLive: true,
      });
    }
  }

  /** Background import of the pre-database manifest files (see the legacy module). */
  async migrateLegacyManifests(
    options: {
      batchSize?: number;
      shouldContinue?: () => boolean;
      preferRevision?: (key: string) => number | undefined;
    } = {},
  ): Promise<LegacyManifestMigrationReport> {
    if (this.legacyDone()) return { imported: 0, skipped: 0, complete: true };
    const report = await migrateLegacyManifests(this.legacyDeps(), {
      ...options,
      afterBatch: (cursor) => this.fault("legacy-manifest-batch", cursor),
    });
    if (report.complete) this.legacySettled = true;
    return report;
  }

  // ---------------------------------------------------------------------------
  // Staging

  /**
   * Writes the chunks of a new session transcript and stages its manifest
   * for the control write that will reference it. Nothing is committed: the
   * returned reference becomes durable only through
   * {@link commitStagedInTransaction}.
   */
  async stage(input: TranscriptCommitInput): Promise<TranscriptCommitResult> {
    const pipelineTag = transcriptPipelineTag(input.pipelineId);
    return this.queue.run(pipelineTag, () =>
      this.stages.run(async () => {
        const key = transcriptSessionKey(input.pipelineId, input.sessionKey);
        await this.ensureImported(key);
        await this.pruneStaged();
        const serialized = input.messages.map(serializeMessage);
        const retained = this.retain(serialized);
        const contentDigest = digestContent(retained.items);
        const read = this.rows.read(key);
        const current = read.status === "found" ? read.row : null;
        const baseRevision = this.rows.revisionOf(key);
        if (
          current &&
          current.sdkSessionId === input.sdkSessionId &&
          current.contentDigest === contentDigest &&
          current.fingerprint === input.fingerprint &&
          current.omittedMessages === retained.omitted
        ) {
          this.counters.idempotentCommits += 1;
          return {
            status: "staged",
            reference: this.reference(current),
            fingerprint: current.fingerprint,
            written: false,
          };
        }
        const base = current?.sdkSessionId === input.sdkSessionId ? current : null;
        const plan = this.plan(key, retained.items, retained.sizes, base);
        const digests = retained.items.slice(plan.reused).map(digestMessage);
        const changes = base
          ? this.changesFrom(key, base, input.revision, plan.reused, digests)
          : [];
        if (plan.chunks.length > this.limits.maxChunksPerSession) {
          return this.reject("too-many-chunks");
        }
        const row: TranscriptManifestRow = {
          v: 1,
          revision: (baseRevision ?? 0) + 1,
          pipeline: pipelineTag,
          sdkSessionId: input.sdkSessionId,
          displayRevision: input.revision,
          fingerprint: input.fingerprint,
          contentDigest,
          messageCount: retained.items.length,
          bytes: retained.bytes,
          omittedMessages: retained.omitted,
          committedAt: new Date(this.now()).toISOString(),
          ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
          totalBytes: plan.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          chunks: plan.chunks,
          ...(changes.length > 0 ? { changes } : {}),
        };
        const rowJson = JSON.stringify(row);
        if (Buffer.byteLength(rowJson, "utf8") > this.limits.maxManifestBytes) {
          return this.reject("manifest-too-large");
        }
        // Early admission; the commit transaction checks again authoritatively.
        const admission = this.admit(key, rowJson, row);
        if (admission) return this.reject(admission);
        await this.ensureDirectories();
        const previousNames = new Set(current?.chunks.map((chunk) => chunk.name) ?? []);
        const newChunks: TranscriptChunkRef[] = [];
        let chunkWrites = 0;
        let chunkBytesWritten = 0;
        for (const chunk of plan.chunks) {
          if (previousNames.has(chunk.name)) continue;
          newChunks.push(chunk);
          const bytes = plan.bytes.get(chunk.name);
          if (!bytes) continue;
          if (await this.writeChunk(chunk.name, bytes)) {
            chunkWrites += 1;
            chunkBytesWritten += bytes.length;
          }
        }
        if (chunkWrites > 0) {
          await syncDirectory(this.chunksDirectory);
          this.counters.fileSyncs += 1;
        }
        this.counters.chunkWrites += chunkWrites;
        this.counters.chunkBytesWritten += chunkBytesWritten;
        await this.fault("after-chunks", key);
        const kept = new Set(plan.chunks.map((chunk) => chunk.name));
        const staged: StagedTranscript = {
          key,
          pipelineTag,
          sessionKey: input.sessionKey,
          baseRevision,
          row,
          serialized: rowJson,
          reference: this.reference(row),
          fingerprint: row.fingerprint,
          newChunks,
          droppedChunks: (current?.chunks ?? [])
            .map((chunk) => chunk.name)
            .filter((name) => !kept.has(name)),
          stagedAt: this.now(),
          chunkWrites,
          chunkBytesWritten,
        };
        const entries = this.staged.get(key) ?? [];
        entries.push(staged);
        this.staged.set(key, entries);
        this.stagedCount += 1;
        // The next checkpoint repacks at most this row's unsealed last chunk.
        const last = plan.chunks.at(-1);
        const tailStart =
          last && last.length < this.limits.targetChunkBytes
            ? Math.max(last.firstIndex, plan.reused)
            : retained.items.length;
        this.rememberTail(key, contentDigest, tailStart, digests.slice(tailStart - plan.reused));
        return {
          status: "staged",
          reference: staged.reference,
          fingerprint: staged.fingerprint,
          written: true,
          staged,
        };
      }),
    );
  }

  /**
   * The row's edit history after this checkpoint: the base's edits plus one
   * naming the first message that differs from the base. Messages in reused
   * chunks are unchanged by construction; within the repacked tail they are
   * compared against the digests the base's checkpoint kept, when this
   * process staged it.
   */
  private changesFrom(
    key: string,
    base: TranscriptManifestRow,
    revision: number,
    reused: number,
    digests: readonly string[],
  ): TranscriptRowChange[] {
    // The same display revision for different content cannot be told apart.
    if (revision === base.displayRevision) return [];
    const previous = this.tailDigests
      .get(key)
      ?.find((entry) => entry.contentDigest === base.contentDigest);
    const end = Math.min(base.messageCount, reused + digests.length);
    let from = reused;
    if (previous && previous.start <= reused) {
      while (
        from < end &&
        from - previous.start < previous.digests.length &&
        previous.digests[from - previous.start] === digests[from - reused]
      ) {
        from += 1;
      }
    }
    return [...(base.changes ?? []), { revision, base: base.displayRevision, from }].slice(
      -MAX_TRANSCRIPT_ROW_CHANGES,
    );
  }

  private rememberTail(key: string, contentDigest: string, start: number, digests: string[]): void {
    // Two candidates per session: a staged checkpoint may not commit.
    const entries = (this.tailDigests.get(key) ?? [])
      .filter((entry) => entry.contentDigest !== contentDigest)
      .slice(-1);
    entries.push({ contentDigest, start, digests });
    this.tailDigests.delete(key);
    this.tailDigests.set(key, entries);
    if (this.tailDigests.size > MAX_TAIL_DIGEST_SESSIONS) {
      this.tailDigests.delete(this.tailDigests.keys().next().value as string);
    }
  }

  private reject(reason: string): TranscriptCommitResult {
    this.counters.rejected += 1;
    return { status: "rejected", reason };
  }

  /** Quota admission for replacing `key` with `row`; a reason when refused. */
  private admit(key: string, serialized: string, row: TranscriptManifestRow): string | null {
    const next = this.rows.admission(key, serialized, row);
    if (next.sessions > this.limits.maxSessions) return "too-many-sessions";
    if (next.bytes > this.limits.maxTotalBytes) return "quota-exceeded";
    return null;
  }

  /** The staged checkpoint a control record's reference names, if this process staged it. */
  stagedFor(
    pipelineId: string,
    sessionKey: string,
    reference: PipelineTranscriptReference,
  ): StagedTranscript | null {
    const entries = this.staged.get(transcriptSessionKey(pipelineId, sessionKey));
    if (!entries) return null;
    const wanted = referenceKey(reference);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (referenceKey(entries[index]!.reference) === wanted) return entries[index]!;
    }
    return null;
  }

  /**
   * Commits a staged manifest row. Must run inside the transaction that
   * writes the control record referencing it. Refuses (without throwing) when
   * another commit moved the session since staging, when a new chunk is no
   * longer on disk, or when the quota no longer admits it; the caller then
   * keeps the control record's previous reference.
   *
   * The chunk check stats files inside the write transaction on purpose: it
   * must be atomic with respect to {@link unlinkUnreferenced}, which holds the
   * same lock. These are a few metadata syscalls, never content I/O.
   */
  commitStagedInTransaction(staged: StagedTranscript): StagedCommitOutcome {
    if (!this.database.db.inTransaction) {
      throw new Error("Staged transcripts commit inside the control-record transaction");
    }
    if (this.rows.revisionOf(staged.key) !== staged.baseRevision) {
      return { ok: false, reason: "conflict" };
    }
    for (const chunk of staged.newChunks) {
      try {
        const stat = statSync(this.chunkPath(chunk.name));
        if (!stat.isFile() || stat.size !== chunk.length)
          return { ok: false, reason: "chunk-missing" };
      } catch {
        return { ok: false, reason: "chunk-missing" };
      }
    }
    const admission = this.admit(staged.key, staged.serialized, staged.row);
    if (admission) return { ok: false, reason: admission };
    this.rows.put(staged.key, staged.row, staged.serialized);
    return { ok: true };
  }

  /**
   * After the transaction that committed `committed` (and possibly refused
   * `refused`): forgets them, drops staged siblings the commit made stale,
   * and unlinks chunks no committed manifest references any more.
   */
  async settleCommitted(
    committed: readonly StagedTranscript[],
    refused: readonly StagedTranscript[] = [],
  ): Promise<void> {
    if (refused.length > 0) this.counters.rejected += refused.length;
    const candidates: string[] = [];
    for (const staged of committed) {
      this.counters.commits += 1;
      this.counters.manifestBytesWritten += Buffer.byteLength(staged.serialized, "utf8");
      candidates.push(...staged.droppedChunks);
      // Every other checkpoint staged on an older base can never commit now.
      const entries = this.staged.get(staged.key) ?? [];
      const stale = entries.filter(
        (entry) => entry === staged || entry.baseRevision !== staged.row.revision,
      );
      this.forgetStaged(staged.key, stale);
      for (const entry of stale) {
        if (entry !== staged) candidates.push(...entry.newChunks.map((chunk) => chunk.name));
      }
    }
    if (candidates.length > 0) await this.unlinkUnreferenced(candidates);
  }

  private forgetStaged(key: string, remove: readonly StagedTranscript[]): void {
    const entries = this.staged.get(key);
    if (!entries) return;
    const kept = entries.filter((entry) => !remove.includes(entry));
    this.stagedCount -= entries.length - kept.length;
    if (kept.length > 0) this.staged.set(key, kept);
    else this.staged.delete(key);
  }

  /** Drops staged checkpoints past the grace window or over the bound, unlinking their unique chunks. */
  private async pruneStaged(): Promise<void> {
    const cutoff = this.now() - BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS;
    const expired: StagedTranscript[] = [];
    const all = [...this.staged.values()].flat().sort((a, b) => a.stagedAt - b.stagedAt);
    for (const [index, entry] of all.entries()) {
      if (entry.stagedAt < cutoff || all.length - index > MAX_STAGED) expired.push(entry);
    }
    if (expired.length === 0) return;
    for (const entry of expired) this.forgetStaged(entry.key, [entry]);
    await this.unlinkUnreferenced(expired.flatMap((entry) => entry.newChunks.map((c) => c.name)));
  }

  /** Forgets specific staged checkpoints (they will not be committed) and unlinks their unique chunks. */
  async discard(entries: readonly StagedTranscript[]): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) this.forgetStaged(entry.key, [entry]);
    await this.unlinkUnreferenced(entries.flatMap((entry) => entry.newChunks.map((c) => c.name)));
  }

  /** Forgets every staged checkpoint of a pipeline and unlinks its unique chunks. */
  async discardStaged(pipelineId: string): Promise<void> {
    const pipelineTag = transcriptPipelineTag(pipelineId);
    const dropped: StagedTranscript[] = [];
    for (const [key, entries] of this.staged) {
      if (!key.startsWith(`${pipelineTag}/`)) continue;
      dropped.push(...entries);
      this.forgetStaged(key, entries);
    }
    if (dropped.length > 0) {
      await this.unlinkUnreferenced(dropped.flatMap((entry) => entry.newChunks.map((c) => c.name)));
    }
  }

  reference(row: TranscriptManifestRow): PipelineTranscriptReference {
    return {
      version: PIPELINE_TRANSCRIPT_REFERENCE_VERSION,
      sdkSessionId: row.sdkSessionId,
      manifestRevision: row.revision,
      revision: row.displayRevision,
      messageCount: row.messageCount,
      bytes: row.bytes,
      complete: row.omittedMessages === 0,
      ...(row.omittedMessages > 0 ? { omittedMessages: row.omittedMessages } : {}),
      committedAt: row.committedAt,
    };
  }

  /**
   * Applies the retention bounds. A message that cannot fit one chunk is
   * omitted (it could never be stored whole); then the oldest messages are
   * dropped until the session fits. Either way the reference says so.
   */
  private retain(serialized: string[]): {
    items: string[];
    sizes: number[];
    bytes: number;
    omitted: number;
  } {
    const maxMessageBytes = this.limits.maxChunkBytes - 2;
    let items: string[] = [];
    let sizes: number[] = [];
    let omitted = 0;
    for (const item of serialized) {
      const size = Buffer.byteLength(item, "utf8");
      if (size > maxMessageBytes) {
        omitted += 1;
        continue;
      }
      items.push(item);
      sizes.push(size);
    }
    let bytes = sizes.reduce((sum, size) => sum + size + 1, 0);
    if (bytes > this.limits.maxSessionBytes) {
      let drop = 0;
      while (drop < items.length && bytes > this.limits.maxSessionBytes) {
        bytes -= sizes[drop]! + 1;
        drop += 1;
      }
      items = items.slice(drop);
      sizes = sizes.slice(drop);
      omitted += drop;
    }
    return { items, sizes, bytes, omitted };
  }

  /**
   * Reuses the committed prefix of sealed chunks whose content is unchanged
   * and packs everything after it. The previous final chunk is reused only
   * once it reached the target size: otherwise it is the mutable tail and is
   * repacked with the new messages, which keeps the chunk count bounded no
   * matter how often a streaming turn checkpoints.
   */
  private plan(
    key: string,
    items: string[],
    sizes: number[],
    previous: TranscriptManifestRow | null,
  ): { chunks: TranscriptChunkRef[]; bytes: Map<string, Buffer>; reused: number } {
    const chunks: TranscriptChunkRef[] = [];
    const bytes = new Map<string, Buffer>();
    let index = 0;
    if (previous) {
      for (const [position, ref] of previous.chunks.entries()) {
        const last = position === previous.chunks.length - 1;
        if (last && ref.length < this.limits.targetChunkBytes) break;
        if (index + ref.count > items.length) break;
        const candidate = encodeChunk(items.slice(index, index + ref.count));
        if (candidate.length !== ref.length || sha256Hex(candidate) !== ref.checksum) break;
        chunks.push({ ...ref, firstIndex: index });
        index += ref.count;
      }
    }
    const reused = index;
    let pending: string[] = [];
    let pendingBytes = 2;
    const flush = () => {
      if (pending.length === 0) return;
      const encoded = encodeChunk(pending);
      const checksum = sha256Hex(encoded);
      const name = this.chunkName(key, checksum);
      chunks.push({
        name,
        firstIndex: index - pending.length,
        count: pending.length,
        length: encoded.length,
        checksum,
      });
      bytes.set(name, encoded);
      pending = [];
      pendingBytes = 2;
    };
    for (; index < items.length; index += 1) {
      const size = sizes[index]! + 1;
      if (pending.length > 0 && pendingBytes + size > this.limits.targetChunkBytes) flush();
      pending.push(items[index]!);
      pendingBytes += size;
    }
    flush();
    return { chunks, bytes, reused };
  }

  /**
   * Writes one immutable chunk (temp file, fsync, rename); returns false when
   * an identical chunk already exists. A reused file gets a fresh mtime so the
   * repair grace window protects it until the staged manifest commits.
   */
  private async writeChunk(name: string, bytes: Buffer): Promise<boolean> {
    const target = this.chunkPath(name);
    try {
      const stat = await fs.lstat(target);
      if (stat.isFile() && stat.size === bytes.length) {
        const now = new Date(this.now());
        await fs.utimes(target, now, now).catch(() => undefined);
        return false;
      }
      await fs.rm(target, { force: true });
    } catch {
      // Missing: write it below.
    }
    const temp = path.join(this.chunksDirectory, `.${name}.${randomUUID()}${TEMP_EXTENSION}`);
    try {
      await writeExclusivePrivateFile(temp, bytes, true);
      this.counters.fileSyncs += 1;
      await fs.rename(temp, target);
      return true;
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Reads

  /**
   * Reads messages `[fromIndex, toIndex)` of a session's transcript, touching
   * only the chunks that overlap the window, each once. Every chunk is
   * verified against the manifest (length, checksum, message count); a
   * mismatch is reported as unavailable rather than returning a partial
   * transcript.
   */
  async read(
    pipelineId: string,
    sessionKey: string,
    reference: Pick<PipelineTranscriptReference, "manifestRevision"> &
      Partial<PipelineTranscriptReference>,
    window: TranscriptReadWindow = {},
  ): Promise<TranscriptRead> {
    const key = transcriptSessionKey(pipelineId, sessionKey);
    const staged =
      reference.committedAt !== undefined
        ? this.stagedFor(pipelineId, sessionKey, reference as PipelineTranscriptReference)
        : null;
    if (staged) return this.readWindow(staged.row, window, false);
    await this.ensureImported(key, { preferRevision: reference.manifestRevision });
    const loaded = this.rows.read(key);
    if (loaded.status === "missing") return { status: "missing" };
    if (loaded.status === "corrupt")
      return { status: "unavailable", reason: "manifest-unreadable" };
    return this.readWindow(loaded.row, window, loaded.row.revision !== reference.manifestRevision);
  }

  /** Reads and verifies every chunk of a staged manifest (migration verifies before committing). */
  async verifyStaged(staged: StagedTranscript): Promise<boolean> {
    const read = await this.readWindow(staged.row, {}, false);
    return read.status === "found" && read.messages.length === staged.row.messageCount;
  }

  private async readChunk(ref: TranscriptChunkRef): Promise<Buffer | null> {
    const read = await readBoundedFile(this.chunkPath(ref.name), ref.length);
    if (read.status !== "ok") return null;
    if (read.bytes.length !== ref.length || sha256Hex(read.bytes) !== ref.checksum) return null;
    return read.bytes;
  }

  private async readWindow(
    row: TranscriptManifestRow,
    window: TranscriptReadWindow,
    substituted: boolean,
  ): Promise<TranscriptRead> {
    const fromIndex = Math.max(0, Math.min(window.fromIndex ?? 0, row.messageCount));
    const toIndex = Math.max(
      fromIndex,
      Math.min(window.toIndex ?? row.messageCount, row.messageCount),
    );
    const maxBytes = window.maxBytes ?? Number.POSITIVE_INFINITY;
    const messages: unknown[] = [];
    let used = 0;
    let truncated = false;
    // Chunks are contiguous and ordered: find the first overlapping one.
    let low = 0;
    let high = row.chunks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const chunk = row.chunks[middle]!;
      if (chunk.firstIndex + chunk.count <= fromIndex) low = middle + 1;
      else high = middle;
    }
    for (let position = low; position < row.chunks.length && !truncated; position += 1) {
      const ref = row.chunks[position]!;
      if (ref.firstIndex >= toIndex) break;
      const bytes = await this.readChunk(ref);
      if (!bytes) return { status: "unavailable", reason: "chunk-unreadable" };
      this.counters.chunkReads += 1;
      this.counters.chunkBytesRead += bytes.length;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return { status: "unavailable", reason: "chunk-corrupt" };
      }
      if (!Array.isArray(parsed) || parsed.length !== ref.count) {
        return { status: "unavailable", reason: "chunk-count-mismatch" };
      }
      const from = Math.max(0, fromIndex - ref.firstIndex);
      const to = Math.min(ref.count, toIndex - ref.firstIndex);
      for (let offset = from; offset < to; offset += 1) {
        const message = parsed[offset];
        if (Number.isFinite(maxBytes)) {
          const size =
            Buffer.byteLength(JSON.stringify(message) ?? "null", "utf8") +
            (messages.length > 0 ? 1 : 0);
          if (used + size > maxBytes) {
            truncated = true;
            break;
          }
          used += size;
        }
        messages.push(message);
      }
    }
    return {
      status: "found",
      messages,
      startIndex: fromIndex,
      messageCount: row.messageCount,
      revision: row.displayRevision,
      manifestRevision: row.revision,
      complete: row.omittedMessages === 0,
      substituted,
      ...(truncated ? { truncated: true as const } : {}),
      ...(row.changes ? { changes: row.changes } : {}),
    };
  }

  /** Metadata of the committed manifest for one session, without reading chunks. */
  async describe(
    pipelineId: string,
    sessionKey: string,
  ): Promise<{ reference: PipelineTranscriptReference; fingerprint: string } | null> {
    const key = transcriptSessionKey(pipelineId, sessionKey);
    await this.ensureImported(key);
    const loaded = this.rows.read(key);
    if (loaded.status !== "found") return null;
    return { reference: this.reference(loaded.row), fingerprint: loaded.row.fingerprint };
  }

  /**
   * Committed reference for a session, read inside a transaction (used to
   * restore a control record whose staged checkpoint was refused).
   */
  committedReference(pipelineId: string, sessionKey: string): TranscriptManifestRow | null {
    const loaded = this.rows.read(transcriptSessionKey(pipelineId, sessionKey));
    return loaded.status === "found" ? loaded.row : null;
  }

  // ---------------------------------------------------------------------------
  // Deletion and repair

  /**
   * Deletes every manifest row a pipeline owns. Must run inside the
   * transaction that deletes its control record. Returns the chunk names to
   * unlink once that transaction committed ({@link unlinkUnreferenced}).
   */
  deletePipelineInTransaction(pipelineId: string): { sessions: number; chunks: string[] } {
    const pipelineTag = transcriptPipelineTag(pipelineId);
    const chunks: string[] = [];
    let sessions = 0;
    for (const { key, row } of this.rows.byOwner(pipelineTag)) {
      if (this.rows.delete(key)) sessions += 1;
      if (row) chunks.push(...row.chunks.map((chunk) => chunk.name));
      else chunks.push(...this.chunksOnDiskFor(key));
    }
    return { sessions, chunks };
  }

  /** Chunk files named for `key` (a corrupt row cannot list its own). Synchronous, bounded by the directory. */
  private chunksOnDiskFor(key: string): string[] {
    const stem = recordFileStem(BUILD_PIPELINE_TRANSCRIPT_NAMESPACE, key);
    try {
      return readdirSync(this.chunksDirectory).filter(
        (name) => name.startsWith(`${stem}-`) && name.endsWith(CHUNK_EXTENSION),
      );
    } catch {
      return [];
    }
  }

  /** Row key of a chunk's session, from the stem its name starts with. */
  private keyForStem(stem: string): string | undefined {
    const revision = this.rows.storeRevision();
    let index = this.stemIndex;
    if (!index || (!index.stems.has(stem) && index.revision !== revision)) {
      const stems = new Map<string, string>();
      for (const key of this.rows.keys()) {
        stems.set(recordFileStem(BUILD_PIPELINE_TRANSCRIPT_NAMESPACE, key), key);
      }
      index = { revision, stems };
      this.stemIndex = index;
    }
    return index.stems.get(stem);
  }

  /**
   * Unlinks chunk files that no committed manifest row (and no checkpoint
   * staged in this process) references. Each batch checks and unlinks while
   * holding the database write lock, so a concurrent commit either sees the
   * file gone (and refuses) or lands first (and the file is kept). Batches
   * are small and the event loop runs between them. `minAgeMs` keeps files
   * modified more recently (repair's grace window). Idempotent.
   */
  async unlinkUnreferenced(
    names: Iterable<string>,
    options: { minAgeMs?: number } = {},
  ): Promise<number> {
    const unique = [...new Set(names)];
    let removed = 0;
    for (let offset = 0; offset < unique.length; offset += UNLINK_BATCH) {
      const batch = unique.slice(offset, offset + UNLINK_BATCH);
      removed += this.database.transaction(() => {
        const stagedNames = new Set<string>();
        for (const entries of this.staged.values()) {
          for (const entry of entries) {
            for (const chunk of entry.row.chunks) stagedNames.add(chunk.name);
          }
        }
        // `null`: an unparseable row, which cannot prove its chunks unreferenced.
        const referencedByKey = new Map<string, Set<string> | null>();
        let count = 0;
        for (const name of batch) {
          if (stagedNames.has(name)) continue;
          const isTemp = name.startsWith(".") && name.endsWith(TEMP_EXTENSION);
          if (!isTemp) {
            const key = this.keyForStem(name.slice(0, 64));
            if (key) {
              let referenced = referencedByKey.get(key);
              if (referenced === undefined) {
                const loaded = this.rows.read(key);
                referenced =
                  loaded.status === "found"
                    ? new Set(loaded.row.chunks.map((chunk) => chunk.name))
                    : loaded.status === "corrupt"
                      ? null
                      : new Set();
                referencedByKey.set(key, referenced);
              }
              if (referenced === null || referenced.has(name)) continue;
            }
          }
          const file = this.chunkPath(name);
          try {
            if (options.minAgeMs !== undefined) {
              const stat = lstatSync(file);
              if (this.now() - stat.mtimeMs <= options.minAgeMs) continue;
            }
            unlinkSync(file);
            count += 1;
          } catch (error) {
            if (!isMissingPathError(error)) throw error;
          }
        }
        return count;
      });
      if (offset + UNLINK_BATCH < unique.length) await yieldToEventLoop();
    }
    this.counters.chunkUnlinks += removed;
    return removed;
  }

  /**
   * Removes manifest rows whose pipeline no longer has a control record (a
   * defensive check: commits and deletes are atomic with the control record,
   * so this finds only damage), then their chunks. Rows committed within the
   * grace window are kept.
   */
  async sweepOrphans(graceMs = BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS): Promise<number> {
    const cutoff = this.now() - graceMs;
    const { sessions, chunks } = this.database.transaction(() => {
      const names: string[] = [];
      let removed = 0;
      for (const owner of this.rows.owners()) {
        if (this.isLive(owner)) continue;
        for (const { key, row } of this.rows.byOwner(owner)) {
          const committedAt = row ? Date.parse(row.committedAt) : Number.NEGATIVE_INFINITY;
          if (Number.isFinite(committedAt) && committedAt > cutoff) continue;
          if (this.rows.delete(key)) removed += 1;
          if (row) names.push(...row.chunks.map((chunk) => chunk.name));
        }
      }
      return { sessions: removed, chunks: names };
    });
    if (sessions > 0) {
      this.database.scrubDeletedContent();
      await this.unlinkUnreferenced(chunks);
    }
    return sessions;
  }

  /**
   * Startup repair: chunk and temp files on disk minus the chunks any
   * committed manifest references, once older than the grace window. Skipped
   * (incomplete) while legacy manifests still await import, since their
   * chunks have no row yet. Also recounts the quota totals.
   */
  async repair(
    graceMs = BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS,
  ): Promise<{ removedChunks: number; scannedChunks: number; complete: boolean }> {
    if (!this.legacyDone()) return { removedChunks: 0, scannedChunks: 0, complete: false };
    this.database.transaction(() => this.rows.rebuildTotals());
    const maxEntries = this.limits.maxSessions * this.limits.maxChunksPerSession + 1_024;
    let directory;
    try {
      directory = await fs.opendir(this.chunksDirectory, { bufferSize: 64 });
    } catch (error) {
      if (isMissingPathError(error)) return { removedChunks: 0, scannedChunks: 0, complete: true };
      throw error;
    }
    let scannedChunks = 0;
    let removedChunks = 0;
    let complete = true;
    let batch: string[] = [];
    try {
      for await (const dirent of directory) {
        if (scannedChunks >= maxEntries) {
          complete = false;
          break;
        }
        scannedChunks += 1;
        if (!dirent.isFile()) continue;
        batch.push(dirent.name);
        if (batch.length >= UNLINK_BATCH * 4) {
          removedChunks += await this.unlinkUnreferenced(batch, { minAgeMs: graceMs });
          batch = [];
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (batch.length > 0) {
      removedChunks += await this.unlinkUnreferenced(batch, { minAgeMs: graceMs });
    }
    return { removedChunks, scannedChunks, complete };
  }
}
