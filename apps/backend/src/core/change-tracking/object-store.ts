/**
 * Backend-owned content-addressed object store for change snapshots.
 *
 * Objects use Git's loose-object format (zlib of `<type> <size>\0<bytes>`,
 * SHA-1 addressed) under `<root>/objects/`, so an operator can verify the
 * store with `git --git-dir=<root> fsck` — but nothing here runs Git. Blobs are
 * written from the literal bytes the capture read: no clean/smudge filter,
 * attribute, hook or user configuration can touch them. The store is separate
 * from every user repository, so pruning or deleting a source repository can
 * never remove a retained historical body.
 *
 * Writes are atomic (temporary sibling + rename) and objects are immutable,
 * so a stale owner that finishes late can only add unreferenced objects; the
 * ledger decides what is referenced.
 *
 * ## Write path
 *
 * A name under `objects/` always means complete, synced content: a crash can
 * lose a name but never leave one naming a partial file, which `has` and
 * `reuse` would adopt for good. So {@link ObjectBatch} stages each object as a
 * temporary file outside the store lock, and a flush fsyncs the temporaries in
 * parallel (the filesystem coalesces concurrent commits), renames them under
 * the lock, and then fsyncs the directories that gained names. Only a resolved
 * flush makes an object safe for a ledger row to name.
 *
 * Directory syncs are store-wide. A flush drains every directory with an
 * unsynced name and waits for syncs already running, so a capture that adopts
 * an object another writer has just renamed still waits for that name.
 *
 * Compression and fsync run off the event loop. Hashing and the small
 * synchronous deflates below {@link OFF_LOOP_ZLIB_BYTES} stay on it.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflate, deflateSync, inflate, inflateSync } from "node:zlib";
import { CaptureError } from "./capture-error.js";
import { fsyncPath, type SyncPath } from "./durable-sync.js";
import { ManifestCache, type ManifestCacheLimits } from "./manifest-cache.js";

export type ObjectType = "blob" | "manifest";

const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Inputs from this size go through the thread pool. Smaller ones stay on the
 * loop: 16 KiB costs a few hundred microseconds, and at source-file sizes the
 * thread hop costs about three times the call.
 */
export const OFF_LOOP_ZLIB_BYTES = 16 * 1024;
/** Off-loop zlib calls per store; each holds at most one object's buffers. */
const MAX_OFF_LOOP_ZLIB_CALLS = 4;
/** A batch flushes itself at either bound, so its temporaries stay bounded. */
export const BATCH_MAX_OBJECTS = 512;
export const BATCH_MAX_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_SYNCS = 16;
/** Renames per hold of the store lock, so a sweep or a renewal can interleave. */
const RENAMES_PER_LOCK_HOLD = 256;
/** Removals per hold of the store lock during a sweep, for the same reason. */
const REMOVALS_PER_LOCK_HOLD = 64;
/** Bound drift from external changes without rewalking on every hourly pass. */
const BYTE_RECONCILIATION_MS = 24 * 60 * 60 * 1000;

const deflateOffLoop = promisify(deflate);
const inflateOffLoop = promisify(inflate);

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

/** Git-compatible object id of `bytes` stored as `type`. */
export function objectId(type: ObjectType, bytes: Uint8Array): string {
  const header = Buffer.from(`${gitType(type)} ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

// Manifests are stored as Git blobs too: fsck sees ordinary blob objects.
function gitType(_type: ObjectType): string {
  return "blob";
}

export interface ObjectStoreOptions {
  root: string;
  /** fsync objects when publishing; disabled only in tests. */
  durable?: boolean;
  hardBudgetBytes?: () => number;
  /**
   * The grace {@link ObjectStore.sweep} is given. Unset, the store does not
   * know its fence is safe to keep, so every reuse renews it.
   */
  orphanGraceMs?: () => number;
  /** Bounds of the parsed-manifest cache; the defaults suit production. */
  manifestCache?: Partial<ManifestCacheLimits>;
  /** Replaces the fsync itself, for tests that observe order or inject failure. */
  fsync?: SyncPath;
  /**
   * The compressed bytes at which a batch flushes itself; defaults to
   * {@link BATCH_MAX_BYTES}. Tests lower it so reaching the bound does not
   * take 64 MiB of incompressible input.
   */
  batchMaxBytes?: number;
}

export type { SyncPath };

/**
 * A group of writes that become durable together. Nothing put here is readable
 * or safe to name until {@link ObjectBatch.flush} resolves. Puts run one at a
 * time per batch; every batch ends with {@link ObjectBatch.close}.
 */
export interface ObjectBatch {
  /** Stage one object. `created` is false when it is already stored or staged. */
  put(type: ObjectType, bytes: Uint8Array): Promise<{ id: string; created: boolean }>;
  /**
   * Publish what is staged and sync every unsynced name in the store. Rejects
   * when anything could not be made durable; nothing may then name these objects.
   */
  flush(): Promise<void>;
  /**
   * Publish what is left, so an abandoned capture's retry need not write it
   * again, and remove what cannot be published. Never rejects.
   */
  close(): Promise<void>;
}

interface StagedObject {
  temp: string;
  name: string;
  size: number;
}

interface StagedBatch {
  objects: Map<string, StagedObject>;
  bytes: number;
}

export class ObjectStore {
  readonly root: string;
  private readonly objects: string;
  private readonly durable: boolean;
  private readonly hardBudgetBytes: () => number;
  private readonly orphanGraceMs: () => number;
  private mutation: Promise<unknown> = Promise.resolve();
  private usedBytes: number | null = null;
  private bytesReconciledAt = 0;
  private removedCount = 0;
  /** Bytes reserved by staged temporaries, charged against the hard budget. */
  private stagedBytes = 0;
  /** Temporaries a live batch owns; a sweep must not take them as abandoned. */
  private readonly stagedTemps = new Set<string>();
  /** Directories with a name not yet synced: at most the fan-out and its two parents. */
  private readonly unsyncedDirectories = new Set<string>();
  private directorySync: Promise<unknown> = Promise.resolve();
  private readonly sync: SyncPath;
  private readonly batchMaxBytes: number;
  private readonly zlibSlots = new CallSlots(MAX_OFF_LOOP_ZLIB_CALLS);
  /** Parsed manifests by id; {@link readManifest} in capture.ts reads through it. */
  readonly manifests: ManifestCache;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work);
    this.mutation = result.catch(() => undefined);
    return result;
  }

  private initialized: Promise<void> | null = null;

  constructor(options: ObjectStoreOptions) {
    this.hardBudgetBytes = options.hardBudgetBytes ?? (() => Infinity);
    this.orphanGraceMs = options.orphanGraceMs ?? (() => 0);
    this.root = options.root;
    this.objects = join(options.root, "objects");
    this.durable = options.durable ?? true;
    this.sync = options.fsync ?? fsyncPath;
    this.batchMaxBytes = options.batchMaxBytes ?? BATCH_MAX_BYTES;
    this.manifests = new ManifestCache(options.manifestCache);
  }

  /** Lay out a minimal bare repository so `git fsck` can read the store. */
  init(): Promise<void> {
    // A failed attempt is forgotten, so the next call retries rather than
    // replaying one transient failure until the backend restarts.
    this.initialized ??= (async () => {
      await mkdir(join(this.objects, "info"), { recursive: true, mode: 0o700 });
      await mkdir(join(this.root, "refs"), { recursive: true, mode: 0o700 });
      await writeIfMissing(join(this.root, "HEAD"), "ref: refs/heads/main\n");
      await writeIfMissing(
        join(this.root, "config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
      );
      await mkdir(join(this.root, "tmp"), { recursive: true, mode: 0o700 });
      if (!this.durable) return;
      // An earlier process may have stopped before syncing these. The first
      // flush covers them, so nothing here relies on a name it cannot vouch for.
      this.unsyncedDirectories.add(this.root);
      this.unsyncedDirectories.add(this.objects);
      for (const prefix of await readdir(this.objects).catch(() => [] as string[]))
        if (/^[0-9a-f]{2}$/.test(prefix)) this.unsyncedDirectories.add(join(this.objects, prefix));
    })().catch((error: unknown) => {
      this.initialized = null;
      throw error;
    });
    return this.initialized;
  }

  private path(id: string): string {
    return join(this.objects, id.slice(0, 2), id.slice(2));
  }

  async has(id: string): Promise<boolean> {
    if (!isObjectId(id)) return false;
    return stat(this.path(id)).then(
      () => true,
      () => false,
    );
  }

  /**
   * Prove an object present and fenced before adopting a metadata-reused copy.
   * True means it exists now and {@link sweep} leaves it alone for at least
   * half of the orphan grace, however stale the sweep's reachable set is.
   *
   * A fence younger than half the grace is left as it is, with no lock and no
   * `utimes`: a sweep deletes only past the full grace, measured from the same
   * mtime this reads, so at least the other half remains. That margin has to
   * outlast the capture's deadline (seconds) and the sweep's walk of the
   * ledger, which is the same assumption the renewal itself makes.
   *
   * An older fence is renewed under the lock, never beside it: a sweep that has
   * already read the old mtime would delete the object straight after a
   * renewal that reported success. Behind the lock the renewal either fences
   * the object or fails on the missing file, and the capture rewrites it.
   */
  reuse(id: string): Promise<boolean> {
    if (!isObjectId(id)) return Promise.resolve(false);
    const fenced = this.fencedAt(id);
    if (fenced === null) return Promise.resolve(false);
    if (Date.now() - fenced < this.orphanGraceMs() / 2) return Promise.resolve(true);
    return this.exclusive(async () => {
      const now = new Date();
      return utimes(this.path(id), now, now).then(
        () => true,
        () => false,
      );
    });
  }

  /**
   * The object's fence, or null when it is absent. Synchronous on purpose: this
   * runs once per unchanged file in a capture, and on Linux an `lstatSync` costs
   * about 1 µs where an awaited `lstat` costs about 8 µs on the thread pool.
   */
  private fencedAt(id: string): number | null {
    try {
      return lstatSync(this.path(id)).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Objects {@link sweep} has removed from this store. A capture compares it
   * across its pass: nothing else deletes objects, so an unchanged count means
   * what the pass proved present is still present.
   */
  get removedObjects(): number {
    return this.removedCount;
  }

  /**
   * Write one immutable object, durable on return. Returns its id and whether
   * it was new; concurrent writers of the same content converge. Code writing
   * several objects uses {@link batch}, which syncs them together.
   */
  async put(type: ObjectType, bytes: Uint8Array): Promise<{ id: string; created: boolean }> {
    const batch = this.batch();
    try {
      const written = await batch.put(type, bytes);
      await batch.flush();
      return written;
    } finally {
      await batch.close();
    }
  }

  batch(): ObjectBatch {
    const staged: StagedBatch = { objects: new Map(), bytes: 0 };
    return {
      put: (type, bytes) => this.stage(staged, type, bytes),
      flush: () => this.publish(staged),
      close: () => this.publish(staged).catch(() => this.discard(staged)),
    };
  }

  private async stage(
    batch: StagedBatch,
    type: ObjectType,
    bytes: Uint8Array,
  ): Promise<{ id: string; created: boolean }> {
    const id = objectId(type, bytes);
    // The lock is queued before the first await, so a renewal stays ordered
    // against a sweep called after this put.
    const known = await this.exclusive(async () => {
      await this.init();
      const usedBytes = await this.reconcileBytesUnderLock();
      if (usedBytes + this.stagedBytes >= this.hardBudgetBytes())
        throw new CaptureError("capture-storage-quota");
      if (batch.objects.has(id)) return true;
      if (!(await this.has(id))) return false;
      const now = new Date();
      await utimes(this.path(id), now, now);
      return true;
    });
    if (known) return { id, created: false };

    const header = Buffer.from(`${gitType(type)} ${bytes.length}\0`);
    const raw = Buffer.concat([header, bytes]);
    const compressed =
      raw.length < OFF_LOOP_ZLIB_BYTES
        ? deflateSync(raw)
        : await this.zlibSlots.run(() => deflateOffLoop(raw));

    await this.exclusive(async () => {
      const usedBytes = await this.reconcileBytesUnderLock();
      if (usedBytes + this.stagedBytes + compressed.length > this.hardBudgetBytes())
        throw new CaptureError("capture-storage-quota");
      this.stagedBytes += compressed.length;
    });
    const name = `${id}.${randomUUID()}`;
    const temp = join(this.root, "tmp", name);
    const object: StagedObject = { temp, name, size: compressed.length };
    this.stagedTemps.add(name);
    try {
      await writeFile(temp, compressed, { mode: 0o400 });
    } catch (error) {
      await this.removeStaged(object);
      throw error;
    }
    batch.objects.set(id, object);
    batch.bytes += object.size;
    if (batch.objects.size >= BATCH_MAX_OBJECTS || batch.bytes >= this.batchMaxBytes)
      await this.publish(batch);
    return { id, created: true };
  }

  private async publish(batch: StagedBatch): Promise<void> {
    const objects = Array.from(batch.objects);
    if (this.durable) {
      const failures: unknown[] = [];
      await forEachBounded(objects, MAX_CONCURRENT_SYNCS, async ([id, object]) => {
        try {
          await this.sync(object.temp, "file");
        } catch (error) {
          // A later fsync can succeed after a writeback error without proving
          // these bytes durable. Never let close publish this temporary again.
          batch.objects.delete(id);
          batch.bytes -= object.size;
          await this.removeStaged(object);
          failures.push(error);
        }
      });
      // All syncs must settle before close can retry the healthy objects.
      if (failures.length) throw failures[0];
    }
    for (let index = 0; index < objects.length; index += RENAMES_PER_LOCK_HOLD) {
      const chunk = objects.slice(index, index + RENAMES_PER_LOCK_HOLD);
      await this.exclusive(async () => {
        for (const [id, object] of chunk) {
          await this.place(id, object);
          batch.objects.delete(id);
          batch.bytes -= object.size;
        }
      });
    }
    await this.syncDirectories();
  }

  /** Move one synced temporary to its final name. Runs under the store lock. */
  private async place(id: string, object: StagedObject): Promise<void> {
    const target = this.path(id);
    const directory = join(this.objects, id.slice(0, 2));
    if (await this.has(id)) {
      const now = new Date();
      await utimes(target, now, now);
      await this.removeStaged(object);
    } else {
      try {
        await rename(object.temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (this.durable) this.unsyncedDirectories.add(this.objects);
        await rename(object.temp, target);
      }
      this.stagedBytes -= object.size;
      this.stagedTemps.delete(object.name);
      if (this.usedBytes !== null) this.usedBytes += object.size;
    }
    // Also when another writer placed it: that writer's sync may not have run.
    if (this.durable) this.unsyncedDirectories.add(directory);
  }

  private async removeStaged(object: StagedObject): Promise<void> {
    await rm(object.temp, { force: true }).catch(() => undefined);
    this.stagedBytes -= object.size;
    this.stagedTemps.delete(object.name);
  }

  private async discard(batch: StagedBatch): Promise<void> {
    const objects = Array.from(batch.objects.values());
    batch.objects.clear();
    batch.bytes = 0;
    for (const object of objects) await this.removeStaged(object);
  }

  /**
   * Sync every directory with an unsynced name. Runs after any sync already
   * under way, so on success each name placed before this call is durable. A
   * failed directory stays listed: the next flush tries it again.
   */
  private syncDirectories(): Promise<void> {
    if (!this.durable) return Promise.resolve();
    const run = this.directorySync.then(async () => {
      const directories = Array.from(this.unsyncedDirectories);
      this.unsyncedDirectories.clear();
      try {
        await forEachBounded(directories, MAX_CONCURRENT_SYNCS, (directory) =>
          this.sync(directory, "directory"),
        );
      } catch (error) {
        for (const directory of directories) this.unsyncedDirectories.add(directory);
        throw error;
      }
    });
    this.directorySync = run.catch(() => undefined);
    return run;
  }

  /** Read an object's payload, verifying its id. Null when absent or corrupt. */
  async get(id: string): Promise<Uint8Array | null> {
    if (!isObjectId(id)) return null;
    let compressed: Buffer;
    try {
      compressed = await readFile(this.path(id));
    } catch {
      return null;
    }
    let raw: Buffer;
    try {
      raw =
        compressed.length < OFF_LOOP_ZLIB_BYTES
          ? inflateSync(compressed)
          : await this.zlibSlots.run(() => inflateOffLoop(compressed));
    } catch {
      return null;
    }
    const nul = raw.indexOf(0);
    if (nul < 0) return null;
    const payload = raw.subarray(nul + 1);
    if (createHash("sha1").update(raw).digest("hex") !== id) return null;
    return new Uint8Array(payload);
  }

  /**
   * Remove objects not in `reachable` whose files are older than `graceMs`.
   * The grace fence keeps a concurrent publication (objects written, ledger
   * commit pending) from losing its objects.
   *
   * The walk runs without the store lock, so captures interleave with it. It
   * only collects candidates; each one is read again and removed under the
   * lock, a bounded number per hold. The mtime read under the lock is the one
   * that decides, so a renewal that lands after the walk saw an old fence keeps
   * the object. Candidates are held one fan-out directory at a time.
   */
  async sweep(
    reachable: ReadonlySet<string>,
    graceMs: number,
    nowMs = Date.now(),
  ): Promise<{
    removed: number;
    bytes: number;
  }> {
    await this.init();
    const totals = { removed: 0, bytes: 0 };
    let fanout: string[];
    try {
      fanout = await readdir(this.objects);
    } catch {
      return totals;
    }
    const expired = (info: { mtimeMs: number } | null) =>
      info !== null && nowMs - info.mtimeMs > graceMs;
    for (const prefix of fanout) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      const directory = join(this.objects, prefix);
      const candidates: string[] = [];
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        const id = `${prefix}${name}`;
        if (!isObjectId(id) || reachable.has(id)) continue;
        if (expired(await lstat(join(directory, name)).catch(() => null)))
          candidates.push(join(directory, name));
      }
      await this.removeUnderLock(candidates, async (file) => {
        const info = await lstat(file).catch(() => null);
        if (info === null) {
          // Only a sweep removes objects, and it holds the lock: something
          // outside this store deleted it, so the running figure is wrong.
          this.usedBytes = null;
          return;
        }
        if (!expired(info)) return;
        await rm(file, { force: true });
        this.removedCount++;
        totals.removed++;
        totals.bytes += info.size;
        if (this.usedBytes !== null) this.usedBytes -= info.size;
      });
    }
    // Abandoned temporaries from crashed writers. A live batch's names are in
    // `stagedTemps` from before their file exists until after it is gone.
    const tmp = join(this.root, "tmp");
    const abandoned: string[] = [];
    for (const name of await readdir(tmp).catch(() => [] as string[])) {
      if (this.stagedTemps.has(name)) continue;
      const info = await lstat(join(tmp, name)).catch(() => null);
      if (info && nowMs - info.mtimeMs >= graceMs) abandoned.push(name);
    }
    await this.removeUnderLock(abandoned, async (name) => {
      if (this.stagedTemps.has(name)) return;
      const info = await lstat(join(tmp, name)).catch(() => null);
      if (info && nowMs - info.mtimeMs >= graceMs) await rm(join(tmp, name), { force: true });
    });
    return totals;
  }

  private async removeUnderLock<T>(
    items: readonly T[],
    remove: (item: T) => Promise<void>,
  ): Promise<void> {
    for (let index = 0; index < items.length; index += REMOVALS_PER_LOCK_HOLD) {
      const chunk = items.slice(index, index + REMOVALS_PER_LOCK_HOLD);
      await this.exclusive(async () => {
        for (const item of chunk) await remove(item);
      });
    }
  }

  /** Invalidate accounting when a reader detects an externally missing object. */
  async invalidateBytes(): Promise<void> {
    await this.exclusive(async () => {
      this.usedBytes = null;
    });
  }

  /**
   * Compressed bytes maintained by puts and sweeps. Recount under the lock on
   * invalidation and at least daily when accessed, so external changes cannot
   * leave quota decisions stale indefinitely. Ordinary hourly passes do no walk.
   */
  async currentBytes(): Promise<number> {
    if (this.usedBytes !== null && Date.now() - this.bytesReconciledAt < BYTE_RECONCILIATION_MS)
      return this.usedBytes;
    return this.exclusive(async () => {
      await this.init();
      return this.reconcileBytesUnderLock();
    });
  }

  /** Caller holds the mutation lock, including across the walk and publication. */
  private async reconcileBytesUnderLock(): Promise<number> {
    const now = Date.now();
    if (this.usedBytes === null || now - this.bytesReconciledAt >= BYTE_RECONCILIATION_MS) {
      this.usedBytes = await this.storedBytes();
      this.bytesReconciledAt = now;
    }
    return this.usedBytes;
  }

  /** Total stored bytes (compressed), walking every object. */
  async storedBytes(): Promise<number> {
    let total = 0;
    for (const prefix of await readdir(this.objects).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const name of await readdir(join(this.objects, prefix)).catch(() => [] as string[])) {
        const info = await lstat(join(this.objects, prefix, name)).catch(() => null);
        if (info) total += info.size;
      }
    }
    return total;
  }
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

/** First-come slots for calls that hold a thread-pool thread and a large buffer. */
class CallSlots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(count: number) {
    this.free = count;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}
