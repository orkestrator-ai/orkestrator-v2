import { createHash } from "node:crypto";
import {
  PIPELINE_TRANSCRIPT_REFERENCE_VERSION,
  type PipelineTranscriptReference,
} from "@orkestrator/protocol/build-pipeline";
import { KeyedSerialQueue } from "./keyed-record-concurrency.js";
import { sha256Hex } from "./keyed-record-format.js";
import type { KeyedRecordLock, KeyedRecordObserver } from "./keyed-record-store.js";
import {
  RecordManifestStore,
  type ChunkRef,
  type ManifestFaultStage,
  type RecordManifest,
} from "./record-manifest.js";

/**
 * Durable build-pipeline display transcripts, stored apart from the workflow
 * control record (plan step 16, finding E14).
 *
 * Layout under the backend data directory:
 *
 *   build-pipeline-transcripts/
 *     manifests/<sha256>.rec        one manifest per pipeline session (+ .prev)
 *     manifests/_meta/index.json    quota/owner metadata only
 *     chunks/<stem>-<sha256>.chunk  immutable JSON-array slices of messages
 *
 * A session's transcript is a sequence of immutable chunks named by a small
 * versioned manifest (step 06). Completed chunks are never rewritten: an
 * active turn rewrites only its unsealed tail chunk plus the manifest. The
 * manifest commits before the workflow record references it, so a crash leaves
 * either the old reference (still readable: the durable store retains the
 * previous generation and its chunks) or orphans that `repair`/`sweep` remove.
 *
 * Unlike native display tails (a regenerable cache), this is the offline copy
 * the user was promised, so it is `durable`: fsynced, one previous generation
 * kept, never evicted. Oversized content is recorded as explicitly incomplete
 * rather than failing the workflow write that carries it.
 */
export const BUILD_PIPELINE_TRANSCRIPT_DIRECTORY = "build-pipeline-transcripts";
export const BUILD_PIPELINE_TRANSCRIPT_NAMESPACE = "build-pipeline-transcript/v1";
export const BUILD_PIPELINE_TRANSCRIPT_SCHEMA = "build-pipeline-transcript-v1";
const META_VERSION = 1;

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

/** How long an unreferenced manifest must age before the orphan sweep may remove it. */
export const BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS = 10 * 60_000;
const MAX_FENCE_MEMORY = 4_096;

export type BuildPipelineTranscriptFaultStage =
  | ManifestFaultStage
  | "before-control-save"
  | "after-control-save"
  | "migration-after-import"
  | "migration-before-control-commit"
  | "delete-after-control";

export interface BuildPipelineTranscriptFaults {
  /** Test-only hook. Throw to simulate a crash at `stage`; on-disk state is left as is. */
  at?(stage: BuildPipelineTranscriptFaultStage, detail: { key: string }): void | Promise<void>;
}

export interface BuildPipelineTranscriptStoreOptions {
  directory: string;
  lock?: KeyedRecordLock;
  now?: () => number;
  limits?: Partial<BuildPipelineTranscriptLimits>;
  faults?: () => BuildPipelineTranscriptFaults | null | undefined;
  observer?: KeyedRecordObserver;
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

export type TranscriptCommitResult =
  | {
      status: "committed";
      reference: PipelineTranscriptReference;
      fingerprint: string;
      /** False when identical content was already committed (idempotent retry). */
      written: boolean;
    }
  | { status: "fenced" }
  | { status: "rejected"; reason: string };

export type TranscriptRead =
  | {
      status: "found";
      messages: unknown[];
      /** Index of `messages[0]` within the stored transcript. */
      startIndex: number;
      messageCount: number;
      revision: number;
      complete: boolean;
      /** True when the referenced revision was unreadable and another generation answered. */
      substituted: boolean;
    }
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

export interface BuildPipelineTranscriptStats {
  commits: number;
  idempotentCommits: number;
  chunkWrites: number;
  chunkBytesWritten: number;
  manifestBytesWritten: number;
  chunkReads: number;
  chunkBytesRead: number;
  rejected: number;
}

interface TranscriptManifestMeta {
  v: typeof META_VERSION;
  sdkSessionId: string;
  revision: number;
  fingerprint: string;
  /** Full-content digest; makes a retried import or checkpoint idempotent. */
  contentDigest: string;
  messageCount: number;
  /** Messages per chunk, in manifest order. */
  counts: number[];
  bytes: number;
  omittedMessages: number;
  committedAt: string;
  sourceRevision?: number;
}

function isMeta(value: unknown, chunks: number): value is TranscriptManifestMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    meta.v === META_VERSION &&
    typeof meta.sdkSessionId === "string" &&
    Number.isSafeInteger(meta.revision) &&
    typeof meta.fingerprint === "string" &&
    typeof meta.contentDigest === "string" &&
    Number.isSafeInteger(meta.messageCount) &&
    Array.isArray(meta.counts) &&
    meta.counts.length === chunks &&
    meta.counts.every((count) => Number.isSafeInteger(count) && (count as number) > 0) &&
    (meta.counts as number[]).reduce((sum, count) => sum + count, 0) === meta.messageCount &&
    Number.isSafeInteger(meta.bytes) &&
    Number.isSafeInteger(meta.omittedMessages) &&
    typeof meta.committedAt === "string"
  );
}

function tag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Content-free owner tag: deletion and the orphan sweep match on it. */
export function transcriptPipelineTag(pipelineId: string): string {
  return tag(`pipeline\0${pipelineId}`);
}

function sessionRecordKey(pipelineId: string, sessionKey: string): string {
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

export class BuildPipelineTranscriptStore {
  readonly manifests: RecordManifestStore;
  readonly limits: BuildPipelineTranscriptLimits;
  private readonly queue = new KeyedSerialQueue();
  private readonly fences = new Map<string, true>();
  private readonly counters: BuildPipelineTranscriptStats = {
    commits: 0,
    idempotentCommits: 0,
    chunkWrites: 0,
    chunkBytesWritten: 0,
    manifestBytesWritten: 0,
    chunkReads: 0,
    chunkBytesRead: 0,
    rejected: 0,
  };

  constructor(private readonly options: BuildPipelineTranscriptStoreOptions) {
    this.limits = { ...BUILD_PIPELINE_TRANSCRIPT_LIMITS, ...options.limits };
    this.manifests = new RecordManifestStore({
      directory: options.directory,
      namespace: BUILD_PIPELINE_TRANSCRIPT_NAMESPACE,
      schema: BUILD_PIPELINE_TRANSCRIPT_SCHEMA,
      retentionClass: "durable",
      maxChunkBytes: this.limits.maxChunkBytes,
      maxChunksPerRecord: this.limits.maxChunksPerSession,
      maxRecords: this.limits.maxSessions,
      maxTotalBytes: this.limits.maxTotalBytes,
      maxManifestBytes: this.limits.maxManifestBytes,
      ...(options.lock ? { lock: options.lock } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      faults: { at: (stage, detail) => this.fault(stage, detail.key) },
    });
  }

  stats(): BuildPipelineTranscriptStats {
    return {
      ...this.counters,
      // Manifest bytes are counted by the keyed store that writes them.
      manifestBytesWritten: this.manifests.manifests.stats().bytesWritten,
    };
  }

  async fault(stage: BuildPipelineTranscriptFaultStage, key: string): Promise<void> {
    await this.options.faults?.()?.at?.(stage, { key });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Refuses later commits for a deleted pipeline in this process. A checkpoint
   * that was already past its read when the pipeline was deleted must not
   * recreate the transcript afterwards; the cross-process equivalent is the
   * orphan sweep. The memory is bounded; a forgotten fence only means the
   * sweep, not the fence, removes such a late orphan.
   */
  fencePipeline(pipelineId: string): void {
    const id = transcriptPipelineTag(pipelineId);
    this.fences.delete(id);
    this.fences.set(id, true);
    while (this.fences.size > MAX_FENCE_MEMORY) {
      const oldest = this.fences.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.fences.delete(oldest);
    }
  }

  /** A pipeline id written again after deletion (legacy re-import) may store transcripts again. */
  unfence(pipelineId: string): void {
    this.fences.delete(transcriptPipelineTag(pipelineId));
  }

  private fenced(pipelineId: string): boolean {
    return this.fences.has(transcriptPipelineTag(pipelineId));
  }

  async commit(input: TranscriptCommitInput): Promise<TranscriptCommitResult> {
    const pipelineTag = transcriptPipelineTag(input.pipelineId);
    return this.queue.run(pipelineTag, async () => {
      if (this.fenced(input.pipelineId)) return { status: "fenced" };
      const key = sessionRecordKey(input.pipelineId, input.sessionKey);
      const serialized = input.messages.map(serializeMessage);
      const retained = this.retain(serialized);
      const contentDigest = digestContent(retained.items);
      const current = await this.manifests.readManifest(key, "current");
      const currentMeta =
        current && isMeta(current.manifest.meta, current.manifest.chunks.length)
          ? current.manifest.meta
          : null;
      if (
        current &&
        currentMeta &&
        currentMeta.sdkSessionId === input.sdkSessionId &&
        currentMeta.contentDigest === contentDigest &&
        currentMeta.fingerprint === input.fingerprint &&
        currentMeta.omittedMessages === retained.omitted
      ) {
        this.counters.idempotentCommits += 1;
        return {
          status: "committed",
          reference: this.reference(current.revision, currentMeta),
          fingerprint: currentMeta.fingerprint,
          written: false,
        };
      }
      const plan = this.plan(
        retained.items,
        retained.sizes,
        currentMeta?.sdkSessionId === input.sdkSessionId && current ? current.manifest : null,
        currentMeta,
      );
      if (plan.parts.length > this.limits.maxChunksPerSession) {
        this.counters.rejected += 1;
        return { status: "rejected", reason: "too-many-chunks" };
      }
      const meta: TranscriptManifestMeta = {
        v: META_VERSION,
        sdkSessionId: input.sdkSessionId,
        revision: input.revision,
        fingerprint: input.fingerprint,
        contentDigest,
        messageCount: retained.items.length,
        counts: plan.counts,
        bytes: retained.bytes,
        omittedMessages: retained.omitted,
        committedAt: new Date(this.now()).toISOString(),
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
      };
      const existing = new Set(current?.manifest.chunks.map((chunk) => chunk.name) ?? []);
      const result = await this.manifests.commit(key, plan.parts, {
        owner: { pipeline: pipelineTag },
        meta,
      });
      if (result.status !== "written") {
        this.counters.rejected += 1;
        return { status: "rejected", reason: "reason" in result ? result.reason : result.status };
      }
      this.counters.commits += 1;
      for (const part of plan.parts) {
        if (!Buffer.isBuffer(part)) continue;
        if (existing.has(this.manifests.chunkName(key, sha256Hex(part)))) continue;
        this.counters.chunkWrites += 1;
        this.counters.chunkBytesWritten += part.length;
      }
      return {
        status: "committed",
        reference: this.reference(result.revision, meta),
        fingerprint: meta.fingerprint,
        written: true,
      };
    });
  }

  private reference(
    manifestRevision: number,
    meta: TranscriptManifestMeta,
  ): PipelineTranscriptReference {
    return {
      version: PIPELINE_TRANSCRIPT_REFERENCE_VERSION,
      sdkSessionId: meta.sdkSessionId,
      manifestRevision,
      revision: meta.revision,
      messageCount: meta.messageCount,
      bytes: meta.bytes,
      complete: meta.omittedMessages === 0,
      ...(meta.omittedMessages > 0 ? { omittedMessages: meta.omittedMessages } : {}),
      committedAt: meta.committedAt,
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
    items: string[],
    sizes: number[],
    previous: RecordManifest | null,
    previousMeta: TranscriptManifestMeta | null,
  ): { parts: Array<Buffer | ChunkRef>; counts: number[] } {
    const parts: Array<Buffer | ChunkRef> = [];
    const counts: number[] = [];
    let index = 0;
    if (previous && previousMeta) {
      for (let chunk = 0; chunk < previous.chunks.length; chunk += 1) {
        const ref = previous.chunks[chunk]!;
        const count = previousMeta.counts[chunk]!;
        const last = chunk === previous.chunks.length - 1;
        if (last && ref.length < this.limits.targetChunkBytes) break;
        if (index + count > items.length) break;
        const candidate = encodeChunk(items.slice(index, index + count));
        if (candidate.length !== ref.length || sha256Hex(candidate) !== ref.checksum) break;
        parts.push(ref);
        counts.push(count);
        index += count;
      }
    }
    let pending: string[] = [];
    let pendingBytes = 2;
    const flush = () => {
      if (pending.length === 0) return;
      parts.push(encodeChunk(pending));
      counts.push(pending.length);
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
    return { parts, counts };
  }

  /**
   * Reads messages `[fromIndex, toIndex)` of the referenced revision, touching
   * only the chunks that overlap the window. Every chunk is verified against
   * the manifest (length, checksum, message count); a mismatch is reported as
   * unavailable rather than returning a partial transcript.
   */
  async read(
    pipelineId: string,
    sessionKey: string,
    reference: Pick<PipelineTranscriptReference, "manifestRevision">,
    window: { fromIndex?: number; toIndex?: number } = {},
  ): Promise<TranscriptRead> {
    const key = sessionRecordKey(pipelineId, sessionKey);
    const usable = (
      candidate: { revision: number; manifest: RecordManifest } | null,
    ): candidate is { revision: number; manifest: RecordManifest } =>
      candidate !== null && isMeta(candidate.manifest.meta, candidate.manifest.chunks.length);
    let failure: string | null = null;
    const current = await this.manifests.readManifest(key, "current");
    if (usable(current) && current.revision === reference.manifestRevision) {
      const read = await this.readWindow(key, current.manifest, window);
      if (read.status === "found") return { ...read, substituted: false };
      failure = read.reason;
    }
    const previous = await this.manifests.readManifest(key, "previous");
    if (usable(previous) && previous.revision === reference.manifestRevision) {
      const read = await this.readWindow(key, previous.manifest, window);
      if (read.status === "found") return { ...read, substituted: false };
      failure = read.reason;
    }
    // The referenced revision is gone or unreadable. A newer current exists
    // when a checkpoint committed but its workflow write lost; an older one is
    // the durable fallback. Either is served, marked as substituted.
    for (const candidate of [current, previous]) {
      if (!usable(candidate) || candidate.revision === reference.manifestRevision) continue;
      const read = await this.readWindow(key, candidate.manifest, window);
      if (read.status === "found") return { ...read, substituted: true };
      failure = read.reason;
    }
    if (failure) return { status: "unavailable", reason: failure };
    return (await this.manifests.manifests.has(key))
      ? { status: "unavailable", reason: "manifest-unreadable" }
      : { status: "missing" };
  }

  private async readWindow(
    key: string,
    manifest: RecordManifest,
    window: { fromIndex?: number; toIndex?: number },
  ): Promise<
    | Omit<Extract<TranscriptRead, { status: "found" }>, "substituted">
    | { status: "unavailable"; reason: string }
  > {
    const meta = manifest.meta as TranscriptManifestMeta;
    const fromIndex = Math.max(0, Math.min(window.fromIndex ?? 0, meta.messageCount));
    const toIndex = Math.max(
      fromIndex,
      Math.min(window.toIndex ?? meta.messageCount, meta.messageCount),
    );
    const messages: unknown[] = [];
    let chunkStart = 0;
    let startIndex = fromIndex;
    for (let chunk = 0; chunk < manifest.chunks.length; chunk += 1) {
      const count = meta.counts[chunk]!;
      const chunkEnd = chunkStart + count;
      if (chunkEnd > fromIndex && chunkStart < toIndex) {
        const ref = manifest.chunks[chunk]!;
        const bytes = await this.manifests.readChunk(key, ref);
        if (!bytes) return { status: "unavailable", reason: "chunk-unreadable" };
        this.counters.chunkReads += 1;
        this.counters.chunkBytesRead += bytes.length;
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          return { status: "unavailable", reason: "chunk-corrupt" };
        }
        if (!Array.isArray(parsed) || parsed.length !== count) {
          return { status: "unavailable", reason: "chunk-count-mismatch" };
        }
        const from = Math.max(0, fromIndex - chunkStart);
        const to = Math.min(count, toIndex - chunkStart);
        if (messages.length === 0) startIndex = chunkStart + from;
        messages.push(...parsed.slice(from, to));
      }
      chunkStart = chunkEnd;
      if (chunkStart >= toIndex) break;
    }
    return {
      status: "found",
      messages,
      startIndex,
      messageCount: meta.messageCount,
      revision: meta.revision,
      complete: meta.omittedMessages === 0,
    };
  }

  /** Metadata of the committed manifest for one session, without reading chunks. */
  async describe(
    pipelineId: string,
    sessionKey: string,
  ): Promise<{ reference: PipelineTranscriptReference; fingerprint: string } | null> {
    const loaded = await this.manifests.readManifest(
      sessionRecordKey(pipelineId, sessionKey),
      "current",
    );
    if (!loaded || !isMeta(loaded.manifest.meta, loaded.manifest.chunks.length)) return null;
    return {
      reference: this.reference(loaded.revision, loaded.manifest.meta),
      fingerprint: loaded.manifest.meta.fingerprint,
    };
  }

  /**
   * Fences further commits and deletes every session transcript the pipeline
   * owns (both retained generations and their chunks). Returns the number of
   * session records removed.
   */
  async deletePipeline(pipelineId: string): Promise<number> {
    const pipelineTag = transcriptPipelineTag(pipelineId);
    this.fencePipeline(pipelineId);
    return this.queue.run(pipelineTag, async () => {
      let removed = 0;
      for (const metadata of await this.manifests.manifests.list()) {
        if (metadata.owner.pipeline !== pipelineTag) continue;
        if (await this.manifests.delete(metadata.key)) removed += 1;
      }
      return removed;
    });
  }

  /**
   * Removes transcripts whose pipeline no longer exists: a crash between the
   * control-record delete and the transcript delete, a checkpoint that lost a
   * race with another process's delete, or an import whose control commit
   * never landed. Records younger than the grace window are kept, because a
   * brand-new pipeline's first checkpoint can precede its control commit.
   */
  async sweepOrphans(
    livePipelineIds: Iterable<string>,
    graceMs = BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS,
  ): Promise<number> {
    const live = new Set(Array.from(livePipelineIds, transcriptPipelineTag));
    const cutoff = this.now() - graceMs;
    let removed = 0;
    for (const metadata of await this.manifests.manifests.list()) {
      const owner = metadata.owner.pipeline;
      if (!owner || live.has(owner) || metadata.updatedAt > cutoff) continue;
      const deleted = await this.queue.run(owner, () => this.manifests.delete(metadata.key));
      if (deleted) removed += 1;
    }
    return removed;
  }

  /** Startup repair: index reconciliation plus unreferenced-chunk collection. */
  repair(): Promise<{ removedChunks: number; scannedChunks: number; complete: boolean }> {
    return this.manifests.repair();
  }
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
