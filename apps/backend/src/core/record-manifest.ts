import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ByteCountSemaphore, KeyedSerialQueue } from "./keyed-record-concurrency.js";
import {
  KEYED_RECORD_TEMP_EXTENSION,
  KEYED_RECORD_EXTENSION,
  ensureNamespaceDirectory,
  readBoundedFile,
  recordFileStem,
  sha256Hex,
  syncDirectory,
  writeExclusivePrivateFile,
  type RecordRetentionClass,
} from "./keyed-record-format.js";
import {
  KeyedRecordStore,
  type KeyedRecordLock,
  type KeyedRecordObserver,
  type KeyedRecordWriteResult,
} from "./keyed-record-store.js";

/**
 * Chunked records whose commit point is a small versioned manifest.
 *
 * Chunks are immutable, content-addressed per key (`<key stem>-<sha256>`), and
 * written before the manifest that references them. The manifest itself is a
 * keyed record, so it inherits bounded reads, CAS revisions, quota admission
 * and (for durable namespaces) one retained previous generation. Readers take
 * exactly one manifest revision and verify every chunk's length and checksum
 * against it; they never mix chunks from two revisions.
 *
 * Recovery matrix (see plan step 06):
 * - Crash before chunks/manifest complete: the old manifest still wins; new
 *   chunks are orphans that `repair()` removes after the grace window.
 * - Manifest committed, cleanup interrupted: the new record is readable; the
 *   unreferenced chunks of the dropped generation are removed by `repair()`.
 * - Corrupt/missing chunk of a durable record: the previous validated
 *   generation is returned (and reported as such) or the record is reported
 *   unavailable. Never an empty or partial transcript.
 *
 * Callers own their payload schema (step 16 owns durable transcripts). Prefer
 * whole-message chunks; a single oversized message becomes one chunk up to
 * `maxChunkBytes` or is rejected explicitly, never split mid-JSON here.
 */
export const RECORD_MANIFEST_FORMAT = "ork-record-manifest-v1";
const CHUNK_EXTENSION = ".chunk";

export interface ChunkRef {
  name: string;
  length: number;
  checksum: string;
}

export interface RecordManifest {
  format: typeof RECORD_MANIFEST_FORMAT;
  chunks: ChunkRef[];
  totalBytes: number;
  /** Small caller metadata (bounded by the manifest byte cap). */
  meta?: unknown;
}

export type ManifestRead =
  | { status: "missing" }
  | { status: "unavailable"; reason: string }
  | {
      status: "found";
      revision: number;
      manifest: RecordManifest;
      chunks: Buffer[];
      generation: "current" | "previous";
    };

export type ManifestFaultStage = "after-chunks" | "after-manifest" | "before-cleanup";

export interface RecordManifestStoreOptions {
  directory: string;
  namespace: string;
  schema: string;
  retentionClass: RecordRetentionClass;
  maxChunkBytes: number;
  maxChunksPerRecord: number;
  maxRecords: number;
  maxTotalBytes: number;
  maxManifestBytes?: number;
  maxConcurrentChunkWrites?: number;
  maxQueuedOperations?: number;
  tempGraceMs?: number;
  maxRepairEntries?: number;
  lock?: KeyedRecordLock;
  now?: () => number;
  faults?: { at?(stage: ManifestFaultStage, detail: { key: string }): void | Promise<void> };
  observer?: KeyedRecordObserver;
}

export type ManifestCommitResult =
  | KeyedRecordWriteResult
  | {
      status: "rejected";
      reason: "too-many-chunks" | "chunk-too-large" | "unknown-chunk" | "corrupt-current";
    };

function isChunkRef(value: unknown): value is ChunkRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.name === "string" &&
    /^[0-9a-f]{64}-[0-9a-f]{64}\.chunk$/.test(ref.name) &&
    typeof ref.length === "number" &&
    Number.isSafeInteger(ref.length) &&
    ref.length >= 0 &&
    typeof ref.checksum === "string" &&
    /^[0-9a-f]{64}$/.test(ref.checksum)
  );
}

function parseManifest(payload: Buffer): RecordManifest | null {
  try {
    const value = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    if (
      value.format !== RECORD_MANIFEST_FORMAT ||
      !Array.isArray(value.chunks) ||
      !value.chunks.every(isChunkRef) ||
      typeof value.totalBytes !== "number"
    ) {
      return null;
    }
    return value as unknown as RecordManifest;
  } catch {
    return null;
  }
}

export class RecordManifestStore {
  readonly manifests: KeyedRecordStore;
  private readonly chunksDirectory: string;
  private readonly keyQueue = new KeyedSerialQueue();
  private readonly chunkWrites: ByteCountSemaphore;
  private directoryReady: Promise<void> | null = null;

  constructor(private readonly options: RecordManifestStoreOptions) {
    const maxManifestBytes = options.maxManifestBytes ?? 256 * 1024;
    this.manifests = new KeyedRecordStore({
      directory: path.join(options.directory, "manifests"),
      namespace: options.namespace,
      schema: `${options.schema}+manifest`,
      retentionClass: options.retentionClass,
      maxPayloadBytes: maxManifestBytes,
      maxRecords: options.maxRecords,
      // Manifests account for the chunk bytes they reference.
      maxTotalPayloadBytes: options.maxTotalBytes,
      ...(options.maxQueuedOperations === undefined
        ? {}
        : { maxQueuedOperations: options.maxQueuedOperations }),
      ...(options.tempGraceMs === undefined ? {} : { tempGraceMs: options.tempGraceMs }),
      ...(options.lock ? { lock: options.lock } : {}),
      crossProcessKeyLocks: options.retentionClass === "durable",
      ...(options.now ? { now: options.now } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
    });
    this.chunksDirectory = path.join(options.directory, "chunks");
    this.chunkWrites = new ByteCountSemaphore(
      options.maxConcurrentChunkWrites ?? 2,
      options.maxChunkBytes * 2,
      options.maxQueuedOperations ?? 256,
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ensureDirectories(): Promise<void> {
    this.directoryReady ??= (async () => {
      await ensureNamespaceDirectory(this.options.directory);
      await ensureNamespaceDirectory(this.chunksDirectory);
      await this.manifests.ensureDirectory();
    })().catch((error) => {
      this.directoryReady = null;
      throw error;
    });
    return this.directoryReady;
  }

  private chunkPath(name: string): string {
    return path.join(this.chunksDirectory, name);
  }

  chunkName(key: string, checksum: string): string {
    return `${recordFileStem(this.options.namespace, key)}-${checksum}${CHUNK_EXTENSION}`;
  }

  /** Reads and validates one committed manifest (current generation first). */
  async readManifest(
    key: string,
    generation: "current" | "previous" = "current",
  ): Promise<{ revision: number; manifest: RecordManifest } | null> {
    const read =
      generation === "current"
        ? await this.manifests.getCurrentOnly(key)
        : await this.manifests.getPrevious(key);
    if (read.status !== "found" || (generation === "current" && read.generation !== "current")) {
      return null;
    }
    const manifest = parseManifest(read.payload);
    return manifest ? { revision: read.header.revision, manifest } : null;
  }

  /** Bounded, verified read of one referenced chunk (paging). */
  async readChunk(key: string, ref: ChunkRef): Promise<Buffer | null> {
    if (!isChunkRef(ref) || !ref.name.startsWith(recordFileStem(this.options.namespace, key))) {
      return null;
    }
    const read = await readBoundedFile(this.chunkPath(ref.name), ref.length);
    if (read.status !== "ok") return null;
    if (read.bytes.length !== ref.length || sha256Hex(read.bytes) !== ref.checksum) return null;
    return read.bytes;
  }

  private async readAll(
    key: string,
    loaded: { revision: number; manifest: RecordManifest },
    generation: "current" | "previous",
  ): Promise<ManifestRead> {
    const chunks: Buffer[] = [];
    for (const ref of loaded.manifest.chunks) {
      const chunk = await this.readChunk(key, ref);
      if (!chunk) return { status: "unavailable", reason: "chunk-unreadable" };
      chunks.push(chunk);
    }
    return {
      status: "found",
      revision: loaded.revision,
      manifest: loaded.manifest,
      chunks,
      generation,
    };
  }

  async read(key: string): Promise<ManifestRead> {
    const raw = await this.manifests.get(key);
    if (raw.status === "missing") return { status: "missing" };
    let current: ManifestRead = { status: "unavailable", reason: "manifest-corrupt" };
    if (raw.status === "found") {
      const manifest = parseManifest(raw.payload);
      if (manifest) {
        current = await this.readAll(
          key,
          { revision: raw.header.revision, manifest },
          raw.generation,
        );
        if (current.status === "found") return current;
      }
    }
    if (this.options.retentionClass !== "durable") return current;
    // A durable record whose current generation cannot be fully verified
    // falls back to the previous validated generation, reported as such.
    const previous = await this.readManifest(key, "previous");
    if (!previous) return current;
    const fallback = await this.readAll(key, previous, "previous");
    return fallback.status === "found" ? fallback : current;
  }

  /**
   * Commits a new revision from new chunk bytes and/or references to chunks
   * the key's current manifest already owns. Unchanged chunks are neither
   * rewritten nor re-read.
   */
  async commit(
    key: string,
    parts: Array<Buffer | ChunkRef>,
    options: {
      expectedRevision?: number | null;
      owner?: Record<string, string>;
      meta?: unknown;
    } = {},
  ): Promise<ManifestCommitResult> {
    if (parts.length > this.options.maxChunksPerRecord) {
      return { status: "rejected", reason: "too-many-chunks" };
    }
    for (const part of parts) {
      if (Buffer.isBuffer(part) && part.length > this.options.maxChunkBytes) {
        return { status: "rejected", reason: "chunk-too-large" };
      }
    }
    await this.ensureDirectories();
    const stem = recordFileStem(this.options.namespace, key);
    return this.keyQueue.run(stem, async () => {
      const currentFile = await this.manifests.getCurrentOnly(key);
      // A corrupt current can still have the only viable previous manifest.
      // Repair must resolve it before a new commit can rotate generations.
      if (this.options.retentionClass === "durable" && currentFile.status === "corrupt") {
        return { status: "rejected", reason: "corrupt-current" };
      }
      if (
        this.options.retentionClass === "durable" &&
        currentFile.status === "found" &&
        !parseManifest(currentFile.payload)
      ) {
        return { status: "rejected", reason: "corrupt-current" };
      }
      const before = await this.readManifest(key, "current");
      const beforePrevious =
        this.options.retentionClass === "durable" ? await this.readManifest(key, "previous") : null;
      if (options.expectedRevision !== undefined) {
        const currentRevision = before?.revision ?? null;
        if (currentRevision !== options.expectedRevision) {
          return { status: "conflict", currentRevision };
        }
      }
      const owned = new Set([
        ...(before?.manifest.chunks.map((chunk) => chunk.name) ?? []),
        ...(beforePrevious?.manifest.chunks.map((chunk) => chunk.name) ?? []),
      ]);
      // A reference may only name a chunk this key's committed generations
      // own; validate them all before writing anything.
      for (const part of parts) {
        if (!Buffer.isBuffer(part) && (!isChunkRef(part) || !owned.has(part.name))) {
          return { status: "rejected", reason: "unknown-chunk" };
        }
      }
      const refs: ChunkRef[] = [];
      const written: string[] = [];
      for (const part of parts) {
        if (!Buffer.isBuffer(part)) {
          refs.push(part);
          continue;
        }
        const checksum = sha256Hex(part);
        const name = this.chunkName(key, checksum);
        if (!owned.has(name) && (await this.writeChunk(name, part))) written.push(name);
        refs.push({ name, length: part.length, checksum });
      }
      await this.options.faults?.at?.("after-chunks", { key });
      const totalBytes = refs.reduce((sum, ref) => sum + ref.length, 0);
      const manifest: RecordManifest = {
        format: RECORD_MANIFEST_FORMAT,
        chunks: refs,
        totalBytes,
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      };
      const payload = Buffer.from(JSON.stringify(manifest), "utf8");
      const result = await this.manifests.put(key, payload, {
        ...(options.owner ? { owner: options.owner } : {}),
        expectedRevision: before?.revision ?? null,
        accountedBytes: totalBytes + payload.length,
      });
      if (result.status !== "written") {
        // Nothing references the chunks this attempt created.
        await Promise.all(written.map((name) => fs.rm(this.chunkPath(name), { force: true })));
        return result;
      }
      await this.options.faults?.at?.("after-manifest", { key });
      // Only after the new manifest is known readable may the generation it
      // displaced lose its chunks.
      const committed = await this.readManifest(key, "current");
      if (!committed || committed.revision !== result.revision) return result;
      await this.options.faults?.at?.("before-cleanup", { key });
      const retainedPrevious =
        this.options.retentionClass === "durable" ? await this.readManifest(key, "previous") : null;
      const keep = new Set([
        ...committed.manifest.chunks.map((chunk) => chunk.name),
        ...(retainedPrevious?.manifest.chunks.map((chunk) => chunk.name) ?? []),
      ]);
      const dropped = [
        ...(beforePrevious?.manifest.chunks ?? []),
        ...(this.options.retentionClass === "durable" ? [] : (before?.manifest.chunks ?? [])),
      ];
      for (const chunk of dropped) {
        if (!keep.has(chunk.name)) await fs.rm(this.chunkPath(chunk.name), { force: true });
      }
      return result;
    });
  }

  /** Writes one immutable chunk; returns false when an identical chunk already exists. */
  private async writeChunk(name: string, bytes: Buffer): Promise<boolean> {
    const target = this.chunkPath(name);
    try {
      const stat = await fs.lstat(target);
      if (stat.isFile() && stat.size === bytes.length) return false;
      await fs.rm(target, { force: true });
    } catch {
      // Missing: write it below.
    }
    const release = await this.chunkWrites.acquire(bytes.length);
    const temp = path.join(
      this.chunksDirectory,
      `.${name}.${randomUUID()}${KEYED_RECORD_TEMP_EXTENSION}`,
    );
    try {
      const durable = this.options.retentionClass === "durable";
      await writeExclusivePrivateFile(temp, bytes, durable);
      await fs.rename(temp, target);
      if (durable) await syncDirectory(this.chunksDirectory);
      return true;
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  /** Deletes the manifest generations and every chunk they reference. */
  async delete(key: string, options: { tombstone?: boolean } = {}): Promise<boolean> {
    await this.ensureDirectories();
    const stem = recordFileStem(this.options.namespace, key);
    return this.keyQueue.run(stem, async () => {
      const current = await this.readManifest(key, "current");
      const previous =
        this.options.retentionClass === "durable" ? await this.readManifest(key, "previous") : null;
      const existed = await this.manifests.delete(key, options);
      // A crash here leaves only unreferenced chunks, which repair() removes.
      for (const chunk of [
        ...(current?.manifest.chunks ?? []),
        ...(previous?.manifest.chunks ?? []),
      ]) {
        await fs.rm(this.chunkPath(chunk.name), { force: true });
      }
      return existed;
    });
  }

  /**
   * Bounded startup repair: reconciles the manifest index, then removes chunk
   * and temporary files no committed manifest generation references once they
   * are older than the grace window (an active writer's fresh chunks survive).
   */
  async repair(): Promise<{ removedChunks: number; scannedChunks: number; complete: boolean }> {
    await this.ensureDirectories();
    const manifestReport = await this.manifests.repair();
    const referenced = new Set<string>();
    const indexed = await this.manifests.list();
    const indexedStems = new Set(
      indexed.map((entry) => recordFileStem(this.options.namespace, entry.key)),
    );
    const maxEntries =
      this.options.maxRepairEntries ??
      this.options.maxRecords * this.options.maxChunksPerRecord + 1_024;
    // Reconciliation leaves a corrupt durable current on disk so its .prev
    // can answer reads. If that stem is absent from the index, chunk GC cannot
    // prove its previous generation unreferenced.
    let unindexedDurableCurrent = false;
    if (this.options.retentionClass === "durable") {
      const manifestsDirectory = await fs.opendir(path.join(this.options.directory, "manifests"));
      let inspected = 0;
      for await (const entry of manifestsDirectory) {
        if (++inspected > maxEntries) {
          unindexedDurableCurrent = true;
          break;
        }
        const name = entry.name;
        if (
          name.endsWith(KEYED_RECORD_EXTENSION) &&
          !indexedStems.has(name.slice(0, -KEYED_RECORD_EXTENSION.length))
        ) {
          unindexedDurableCurrent = true;
          break;
        }
      }
    }
    for (const metadata of indexed) {
      for (const generation of ["current", "previous"] as const) {
        const loaded = await this.readManifest(metadata.key, generation);
        for (const chunk of loaded?.manifest.chunks ?? []) referenced.add(chunk.name);
      }
    }
    const grace = this.options.tempGraceMs ?? 60_000;
    let scannedChunks = 0;
    let removedChunks = 0;
    let complete = manifestReport.complete && !unindexedDurableCurrent;
    const directory = await fs.opendir(this.chunksDirectory, { bufferSize: 64 });
    try {
      for await (const dirent of directory) {
        if (scannedChunks >= maxEntries) {
          complete = false;
          break;
        }
        scannedChunks += 1;
        if (referenced.has(dirent.name)) continue;
        const fullPath = this.chunkPath(dirent.name);
        const stat = await fs.lstat(fullPath).catch(() => null);
        if (!stat || this.now() - stat.mtimeMs <= grace) continue;
        // An incomplete manifest scan cannot prove a chunk unreferenced.
        if (!complete) continue;
        await fs.rm(fullPath, { force: true });
        removedChunks += 1;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return { removedChunks, scannedChunks, complete };
  }
}
