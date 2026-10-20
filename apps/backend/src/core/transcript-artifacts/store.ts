/**
 * Durable storage for transcript artifacts.
 *
 * Metadata lives in one envelope store per environment
 * (`transcript-artifacts/<environmentId>`, see store-layout.ts) on this
 * backend's own database connection. Binary bytes are content-addressed files:
 *
 *   <dataDir>/transcript-artifacts/<environmentId>/assets/<sha256>
 *   <dataDir>/transcript-artifacts/<environmentId>/staging/<random>.tmp
 *
 * Writes follow one order: bytes are staged with exclusive creation, verified,
 * fsynced and promoted (never overwriting different bytes), the directory is
 * fsynced, and only then does ONE synchronous transaction commit the rows that
 * reference them. A crash can therefore leave an unreferenced file, never a
 * committed reference to bytes that were not written. Files are unlinked only
 * inside a write transaction after the references were re-checked, and a
 * commit checks its files exist inside its own transaction, so the two can
 * never interleave badly in this process or another.
 *
 * Transactions are synchronous and never span an await. Every write
 * transaction re-checks the environment deletion fence, so late work for a
 * deleted environment cannot recreate its store.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactFailure, artifactError } from "@orkestrator/protocol/transcript-artifacts";
import { ARTIFACT_TOOL_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { StorageDatabase, StoreRows } from "../storage-database.js";
import { deletionMarker, markDeletion } from "../storage-deletion-fences.js";
import { openBackendDatabase } from "../storage-stores.js";
import { syncDirectory, writeExclusivePrivateFile } from "../keyed-record-format.js";
import { sha256Hex } from "./hashing.js";
import {
  TRANSCRIPT_ARTIFACT_DELETION_SCOPE,
  TRANSCRIPT_ARTIFACT_STORE_PREFIX,
  transcriptArtifactStoreName,
  type TranscriptArtifactCollection,
} from "./store-layout.js";
import {
  decodeRecord,
  encodeRecord,
  type RecordKind,
  type RecordTypes,
  type StoredAsset,
  type StoredQuota,
} from "./store-records.js";

export const TRANSCRIPT_ARTIFACT_DIRECTORY = "transcript-artifacts";
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Failure-injection points for crash tests. Synchronous hooks; throwing aborts. */
export type ArtifactStoreFaultStage = "after-promote" | "before-commit" | "after-commit";

export interface TranscriptArtifactStoreOptions {
  dataDir: string;
  /** A connection to use instead of opening (and owning) one. */
  database?: StorageDatabase;
  /** Directory fsync after promotion (default true). */
  syncDirectories?: boolean;
  faults?: (stage: ArtifactStoreFaultStage, environmentId: string) => void;
  assetBytesPerEnvironment?: number;
}

export function isArtifactEnvironmentId(value: string): boolean {
  return ENVIRONMENT_ID.test(value) && !value.includes("..");
}

const COLLECTION_FOR: Record<RecordKind, TranscriptArtifactCollection> = {
  head: "heads",
  revision: "revisions",
  derived: "derived",
  operation: "operations",
  receipt: "receipts",
  publication: "publications",
  idempotency: "idempotency",
  outbox: "outbox",
  conversation: "conversations",
  asset: "assets",
  repair: "repairs",
  quota: "meta",
  staged: "staged-assets",
};

/**
 * Typed row access for one environment's store. Reads work anywhere; writes
 * must run inside {@link TranscriptArtifactStore.transact}.
 */
export class EnvironmentRecords {
  constructor(
    private readonly rows: StoreRows,
    readonly environmentId: string,
  ) {}

  get<K extends RecordKind>(kind: K, key: string): RecordTypes[K] | null {
    const json = this.rows.get(key, COLLECTION_FOR[kind]);
    return json === undefined ? null : decodeRecord(kind, json);
  }

  /** Rows of a collection, optionally one owner's, decoded. */
  list<K extends RecordKind>(
    kind: K,
    options: { owner?: string; prefix?: string } = {},
  ): Array<RecordTypes[K]> {
    const entries = this.rows.list({
      collection: COLLECTION_FOR[kind],
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
      values: options.prefix === undefined,
    });
    const result: Array<RecordTypes[K]> = [];
    for (const entry of entries) {
      if (options.prefix !== undefined && !entry.key.startsWith(options.prefix)) continue;
      const json = entry.value ?? this.rows.get(entry.key, COLLECTION_FOR[kind]);
      if (json === undefined || json === null) continue;
      result.push(decodeRecord(kind, json));
    }
    return result;
  }

  keys(kind: RecordKind, options: { owner?: string } = {}): string[] {
    return this.rows
      .list({
        collection: COLLECTION_FOR[kind],
        ...(options.owner !== undefined ? { owner: options.owner } : {}),
        values: false,
      })
      .map((entry) => entry.key);
  }

  count(kind: RecordKind, options: { owner?: string } = {}): number {
    return this.keys(kind, options).length;
  }

  put<K extends RecordKind>(
    kind: K,
    key: string,
    value: RecordTypes[K],
    owner?: string | null,
  ): void {
    this.rows.put(key, encodeRecord(value as { schemaVersion: 1 }), {
      collection: COLLECTION_FOR[kind],
      owner: owner ?? null,
    });
  }

  delete(kind: RecordKind, key: string): boolean {
    return this.rows.delete(key, COLLECTION_FOR[kind]);
  }

  /** Raw publication-key index: `<artifactId>/<revision>` → publication id. */
  publicationKey(artifactId: string, revision: number): string | null {
    return this.rows.get(`${artifactId}/${revision}`, "publication-keys") ?? null;
  }

  putPublicationKey(artifactId: string, revision: number, publicationId: string): void {
    this.rows.put(`${artifactId}/${revision}`, publicationId, { collection: "publication-keys" });
  }

  deletePublicationKey(artifactId: string, revision: number): void {
    this.rows.delete(`${artifactId}/${revision}`, "publication-keys");
  }

  quota(): StoredQuota {
    return this.get("quota", "quota") ?? { schemaVersion: 1, assetBytes: 0 };
  }
}

export class TranscriptArtifactStore {
  readonly root: string;
  private connection: StorageDatabase | null = null;
  private closed = false;
  private readonly pending = new Map<string, number>();
  private readonly activeStaging = new Set<string>();
  private readonly deleted = new Set<string>();
  readonly assetQuotaBytes: number;

  constructor(private readonly options: TranscriptArtifactStoreOptions) {
    this.root = join(options.dataDir, TRANSCRIPT_ARTIFACT_DIRECTORY);
    this.assetQuotaBytes =
      options.assetBytesPerEnvironment ?? ARTIFACT_TOOL_POLICY.assetStoreBytesPerEnvironment;
  }

  database(): StorageDatabase {
    if (this.closed)
      throw new ArtifactFailure(
        artifactError("storage_unavailable", "The artifact store is closed"),
      );
    if (this.options.database) return this.options.database;
    if (!this.connection || this.connection.isClosed()) {
      this.connection = openBackendDatabase(this.options.dataDir);
    }
    return this.connection;
  }

  fault(stage: ArtifactStoreFaultStage, environmentId: string): void {
    this.options.faults?.(stage, environmentId);
  }

  isDeleted(environmentId: string): boolean {
    return (
      this.deleted.has(environmentId) ||
      deletionMarker(this.database(), TRANSCRIPT_ARTIFACT_DELETION_SCOPE, environmentId) !== 0
    );
  }

  private requireEnvironment(environmentId: string): void {
    if (!isArtifactEnvironmentId(environmentId)) {
      throw new ArtifactFailure(artifactError("not_found", "Artifact not found"));
    }
  }

  /** Read-only view (no transaction). */
  records(environmentId: string): EnvironmentRecords {
    this.requireEnvironment(environmentId);
    return new EnvironmentRecords(
      this.database().rows(transcriptArtifactStoreName(environmentId)),
      environmentId,
    );
  }

  /**
   * One synchronous IMMEDIATE transaction over an environment's store. The
   * deletion fence is checked inside it; a deleted environment answers
   * `not_found`, exactly like a missing record.
   */
  transact<T>(environmentId: string, work: (records: EnvironmentRecords) => T): T {
    this.requireEnvironment(environmentId);
    const database = this.database();
    return database.transaction(() => {
      if (
        this.deleted.has(environmentId) ||
        deletionMarker(database, TRANSCRIPT_ARTIFACT_DELETION_SCOPE, environmentId) !== 0
      ) {
        throw new ArtifactFailure(artifactError("not_found", "Artifact not found"));
      }
      const result = work(this.records(environmentId));
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Transcript artifact transactions must be synchronous");
      }
      return result;
    });
  }

  /** Environments with a store or with files on disk (crash leftovers before any commit). */
  async knownEnvironmentIds(): Promise<string[]> {
    const ids = new Set(this.environmentIds());
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (isArtifactEnvironmentId(name)) ids.add(name);
    }
    return Array.from(ids).sort();
  }

  environmentIds(): string[] {
    return this.database()
      .listStores(TRANSCRIPT_ARTIFACT_STORE_PREFIX)
      .map((store) => store.slice(TRANSCRIPT_ARTIFACT_STORE_PREFIX.length))
      .filter(isArtifactEnvironmentId);
  }

  // ---------------------------------------------------------------------------
  // Asset files

  environmentDirectory(environmentId: string): string {
    this.requireEnvironment(environmentId);
    return join(this.root, environmentId);
  }

  assetPath(environmentId: string, sha256: string): string {
    if (!SHA256.test(sha256))
      throw new ArtifactFailure(artifactError("not_found", "Asset not found"));
    return join(this.environmentDirectory(environmentId), "assets", sha256);
  }

  stagingDirectory(environmentId: string): string {
    return join(this.environmentDirectory(environmentId), "staging");
  }

  isPending(environmentId: string, sha256: string): boolean {
    return (this.pending.get(`${environmentId}/${sha256}`) ?? 0) > 0;
  }

  isActiveStaging(name: string): boolean {
    return this.activeStaging.has(name);
  }

  /**
   * Stage, verify, fsync and promote bytes into content-addressed storage.
   * Returns a release callback: call it after the referencing commit (or its
   * failure); until then the collector treats the file as in use.
   */
  async writeAsset(
    environmentId: string,
    bytes: Uint8Array,
  ): Promise<{ sha256: string; byteLength: number; release: () => void }> {
    const sha256 = sha256Hex(bytes);
    const pendingKey = `${environmentId}/${sha256}`;
    this.pending.set(pendingKey, (this.pending.get(pendingKey) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = (this.pending.get(pendingKey) ?? 1) - 1;
      if (next > 0) this.pending.set(pendingKey, next);
      else this.pending.delete(pendingKey);
    };
    try {
      if (this.isDeleted(environmentId)) {
        throw new ArtifactFailure(artifactError("not_found", "Artifact not found"));
      }
      const assets = join(this.environmentDirectory(environmentId), "assets");
      const staging = this.stagingDirectory(environmentId);
      await mkdir(assets, { recursive: true, mode: 0o700 });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const target = join(assets, sha256);
      if (await this.matches(target, sha256, bytes.byteLength)) {
        const now = new Date();
        await utimes(target, now, now).catch(() => undefined);
        return { sha256, byteLength: bytes.byteLength, release };
      }
      const name = `${randomBytes(12).toString("hex")}.tmp`;
      const temp = join(staging, name);
      this.activeStaging.add(name);
      try {
        await writeExclusivePrivateFile(temp, Buffer.from(bytes), true);
        // Verify what is on disk, not what we meant to write.
        if (!(await this.matches(temp, sha256, bytes.byteLength))) {
          throw new ArtifactFailure(
            artifactError("storage_unavailable", "Staged artifact bytes did not verify"),
          );
        }
        try {
          // link() never replaces an existing name, so different bytes are
          // never overwritten by a racing writer.
          await link(temp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await this.matches(target, sha256, bytes.byteLength))) {
            // The name denotes these bytes; a damaged copy is repaired in place.
            await rename(temp, target);
          }
        }
        if (this.options.syncDirectories !== false) await syncDirectory(assets);
      } finally {
        this.activeStaging.delete(name);
        await rm(temp, { force: true }).catch(() => undefined);
      }
      this.fault("after-promote", environmentId);
      return { sha256, byteLength: bytes.byteLength, release };
    } catch (error) {
      release();
      if (error instanceof ArtifactFailure) throw error;
      throw new ArtifactFailure(
        artifactError("storage_unavailable", "Artifact bytes could not be stored"),
      );
    }
  }

  private async matches(file: string, sha256: string, byteLength: number): Promise<boolean> {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size !== byteLength) return false;
      return sha256Hex(await readFile(file)) === sha256;
    } catch {
      return false;
    }
  }

  /** Synchronous existence check for use inside a commit transaction. */
  assetFileExists(environmentId: string, sha256: string, byteLength: number): boolean {
    try {
      const stat = lstatSync(this.assetPath(environmentId, sha256));
      return stat.isFile() && stat.size === byteLength;
    } catch {
      return false;
    }
  }

  /** Reads and verifies an asset; a missing or mismatched file is `storage_corrupt`. */
  async readAsset(environmentId: string, sha256: string, byteLength: number): Promise<Buffer> {
    let bytes: Buffer;
    try {
      const handle = await open(this.assetPath(environmentId, sha256), "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== byteLength) throw new Error("size");
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof ArtifactFailure) throw error;
      throw storageCorrupt();
    }
    if (bytes.byteLength !== byteLength || sha256Hex(bytes) !== sha256) throw storageCorrupt();
    return bytes;
  }

  /**
   * Inside a commit transaction: require each file on disk and account new
   * bytes against the environment quota. Over quota rejects; nothing is evicted.
   */
  registerAssetsInTransaction(
    records: EnvironmentRecords,
    assets: ReadonlyArray<{ sha256: string; byteLength: number; mimeType: string }>,
    now: string,
  ): void {
    // Check everything before writing anything, so a refusal leaves the
    // transaction clean for the caller to record a failure instead.
    const unique = new Map<string, { sha256: string; byteLength: number; mimeType: string }>();
    for (const asset of assets) unique.set(asset.sha256, asset);
    let added = 0;
    for (const asset of unique.values()) {
      if (!this.assetFileExists(records.environmentId, asset.sha256, asset.byteLength)) {
        throw new ArtifactFailure(
          artifactError("storage_unavailable", "Artifact bytes disappeared before commit"),
        );
      }
      if (!records.get("asset", asset.sha256)) added += asset.byteLength;
    }
    const quota = records.quota();
    if (added > 0 && quota.assetBytes + added > this.assetQuotaBytes) {
      throw new ArtifactFailure(
        artifactError("capacity_exceeded", "The environment's artifact storage quota is full", {
          resource: "asset-bytes",
          retryClass: "never",
          suggestion: "Publish or let unpublished drafts expire before adding new bytes.",
        }),
      );
    }
    for (const asset of unique.values()) {
      const existing = records.get("asset", asset.sha256);
      if (existing) {
        if (existing.unreferencedSince !== null) {
          records.put("asset", asset.sha256, { ...existing, unreferencedSince: null });
        }
        continue;
      }
      const row: StoredAsset = {
        schemaVersion: 1,
        sha256: asset.sha256,
        byteLength: asset.byteLength,
        mimeType: asset.mimeType,
        createdAt: now,
        unreferencedSince: null,
      };
      records.put("asset", asset.sha256, row);
    }
    if (added > 0)
      records.put("quota", "quota", { schemaVersion: 1, assetBytes: quota.assetBytes + added });
  }

  /** Inside a write transaction, after references were re-checked. */
  unlinkAssetInTransaction(records: EnvironmentRecords, sha256: string): boolean {
    const row = records.get("asset", sha256);
    try {
      unlinkSync(this.assetPath(records.environmentId, sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (row) {
      records.delete("asset", sha256);
      const quota = records.quota();
      records.put("quota", "quota", {
        schemaVersion: 1,
        assetBytes: Math.max(0, quota.assetBytes - row.byteLength),
      });
    }
    return true;
  }

  async listAssetFiles(environmentId: string): Promise<string[]> {
    return (
      await readdir(join(this.environmentDirectory(environmentId), "assets")).catch(
        () => [] as string[],
      )
    ).filter((name) => SHA256.test(name));
  }

  async listStagingFiles(environmentId: string): Promise<string[]> {
    return readdir(this.stagingDirectory(environmentId)).catch(() => [] as string[]);
  }

  fileExists(path: string): boolean {
    return existsSync(path);
  }

  /**
   * Environment deletion: fence first (in the same transaction that removes
   * the store), so any in-flight completion fails its own fence check; then
   * scrub and remove files. Idempotent.
   */
  async deleteEnvironment(environmentId: string): Promise<void> {
    if (!isArtifactEnvironmentId(environmentId)) return;
    this.deleted.add(environmentId);
    const database = this.database();
    database.transaction(() => {
      markDeletion(database, TRANSCRIPT_ARTIFACT_DELETION_SCOPE, environmentId);
      database.deleteStoreInTransaction(transcriptArtifactStoreName(environmentId));
    });
    database.scrubDeletedContent();
    await rm(join(this.root, environmentId), { recursive: true, force: true });
  }

  close(): void {
    this.closed = true;
    if (!this.options.database) {
      this.connection?.close();
      this.connection = null;
    }
  }
}

export function storageCorrupt(): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("storage_corrupt", "A stored artifact representation is missing or damaged", {
      suggestion: "Source and metadata are retained; create a new revision to regenerate output.",
    }),
  );
}
