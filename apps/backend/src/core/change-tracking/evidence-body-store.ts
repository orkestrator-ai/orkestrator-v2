/**
 * Server-only store for retained provider evidence bodies (patches,
 * replacement sides, raw payload slices).
 *
 * Bodies are content-addressed by SHA-256 — the same id the bridge spool
 * assigns — and verified on write and read, so an opaque body id can never
 * name an arbitrary filesystem path. Bodies inherit session authorization:
 * they are read only through `changes_get_diff` for a measurement the caller
 * may already see, never logged and never put in metrics.
 *
 * A resolved {@link EvidenceBodyStore.put} means the body survives a power
 * loss: the bytes are synced before the rename and the directory entry after
 * it, because the ledger row naming the body commits next and the
 * acknowledgement lets the bridge release its own copy. Both syncs are awaited
 * on the thread pool, never on the event loop. Directory syncs are store-wide,
 * as in the object store: concurrent puts share one, and adopting a body whose
 * entry is not yet synced waits for it.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fsyncPath, type SyncPath } from "./durable-sync.js";

const BODY_ID = /^sha256:([0-9a-f]{64})$/;
/** Removals per hold of the store lock, so a write never waits on a whole sweep. */
const REMOVALS_PER_LOCK_HOLD = 64;

export function bodyIdFor(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class EvidenceBodyStore {
  private lock: Promise<unknown> = Promise.resolve();
  /** Directories holding a name not yet synced. */
  private readonly unsyncedDirectories = new Set<string>();
  /** Directories the sync under way covers. */
  private readonly syncingDirectories = new Set<string>();
  private directorySync: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly durable = true,
    /** Replaces the fsync itself, for tests that observe order or inject failure. */
    private readonly sync: SyncPath = fsyncPath,
  ) {}

  /** Serializes a placement or renewal against a sweep's check-and-remove. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private path(id: string): string | null {
    const match = BODY_ID.exec(id);
    if (!match) return null;
    const hex = match[1]!;
    return join(this.root, hex.slice(0, 2), hex.slice(2));
  }

  /**
   * Store bytes under their id; rejects bytes that do not hash to `id`.
   * Resolves only once the body and its directory entry are synced, so the
   * caller may then commit a row naming it and acknowledge the bridge.
   */
  async put(id: string, bytes: Uint8Array): Promise<boolean> {
    const target = this.path(id);
    if (!target || bodyIdFor(bytes) !== id) return false;
    if (await this.reuse(id)) return true;
    const directory = dirname(target);
    await this.exclusive(async () => {
      const created = await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!this.durable || created === undefined) return;
      // Register creation debt before staging can fail or another writer can
      // observe the new directories. Keep it until a directory sync succeeds.
      this.unsyncedDirectories.add(directory);
      for (let parent = dirname(directory); ; parent = dirname(parent)) {
        this.unsyncedDirectories.add(parent);
        if (parent === dirname(created) || parent === dirname(parent)) break;
      }
    });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      if (this.durable) await this.sync(temp, "file");
    } catch (error) {
      // A later fsync can succeed after a writeback error without proving these bytes.
      await rm(temp, { force: true });
      throw error;
    }
    await this.exclusive(async () => {
      await rename(temp, target);
      if (!this.durable) return;
      this.unsyncedDirectories.add(directory);
    });
    await this.syncDirectories();
    return true;
  }

  /**
   * Adopts a body that is already stored, renewing its orphan fence: the ledger
   * row naming it commits after this, and a sweep decides on the file's mtime.
   * False when the body is gone, or its entry could not be synced, so the
   * caller fetches it again.
   */
  async reuse(id: string): Promise<boolean> {
    const target = this.path(id);
    if (!target) return false;
    const directory = dirname(target);
    const adopted = await this.exclusive(async () => {
      const at = new Date();
      const present = await utimes(target, at, at).then(
        () => true,
        () => false,
      );
      // Placed by a writer whose directory sync has not finished.
      const unsynced =
        this.unsyncedDirectories.has(directory) || this.syncingDirectories.has(directory);
      return { present, unsynced };
    });
    if (!adopted.present) return false;
    if (!adopted.unsynced) return true;
    return this.syncDirectories().then(
      () => true,
      () => false,
    );
  }

  /**
   * Sync every directory with an unsynced name. Runs after any sync already
   * under way, so on success each name placed before this call is durable. A
   * failed directory stays listed: the next put or reuse tries it again.
   */
  private syncDirectories(): Promise<void> {
    if (!this.durable) return Promise.resolve();
    const run = this.directorySync.then(async () => {
      const directories = Array.from(this.unsyncedDirectories);
      this.unsyncedDirectories.clear();
      for (const directory of directories) this.syncingDirectories.add(directory);
      const results = await Promise.allSettled(
        directories.map((directory) => this.sync(directory, "directory")),
      );
      this.syncingDirectories.clear();
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        for (const directory of directories) this.unsyncedDirectories.add(directory);
        throw failed.reason;
      }
    });
    this.directorySync = run.catch(() => undefined);
    return run;
  }

  async get(id: string): Promise<Uint8Array | null> {
    const target = this.path(id);
    if (!target) return null;
    try {
      const bytes = new Uint8Array(await readFile(target));
      return bodyIdFor(bytes) === id ? bytes : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes bodies not in `reachable` whose files are older than `graceMs`, the
   * way {@link ObjectStore.sweep} does: the walk holds no lock, and the mtime
   * read under the lock decides, so a body adopted after the walk stays.
   * `forget` runs under the same hold, so a writer that waits for the lock sees
   * the file and the record gone together.
   */
  async sweep(
    reachable: ReadonlySet<string>,
    graceMs: number,
    nowMs: number,
    forget: (id: string) => void,
  ): Promise<{ removed: number; bytes: number }> {
    const totals = { removed: 0, bytes: 0 };
    const expired = (info: { mtimeMs: number } | null) =>
      info !== null && nowMs - info.mtimeMs > graceMs;
    for (const prefix of await readdir(this.root).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      const directory = join(this.root, prefix);
      const candidates: Array<{ id: string | null; file: string }> = [];
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        const id = `sha256:${prefix}${name}`;
        const body = BODY_ID.test(id);
        // Anything else here is a temporary left by a crashed write.
        if ((body && reachable.has(id)) || (!body && !name.endsWith(".tmp"))) continue;
        if (expired(await lstat(join(directory, name)).catch(() => null)))
          candidates.push({ id: body ? id : null, file: join(directory, name) });
      }
      for (let index = 0; index < candidates.length; index += REMOVALS_PER_LOCK_HOLD) {
        const chunk = candidates.slice(index, index + REMOVALS_PER_LOCK_HOLD);
        await this.exclusive(async () => {
          for (const { id, file } of chunk) {
            const info = await lstat(file).catch(() => null);
            if (!info || !expired(info)) continue;
            await rm(file, { force: true });
            if (!id) continue;
            forget(id);
            totals.removed++;
            totals.bytes += info.size;
          }
        });
      }
    }
    return totals;
  }

  async storedBytes(): Promise<number> {
    let total = 0;
    for (const prefix of await readdir(this.root).catch(() => [] as string[])) {
      for (const name of await readdir(join(this.root, prefix)).catch(() => [] as string[])) {
        const info = await lstat(join(this.root, prefix, name)).catch(() => null);
        if (info) total += info.size;
      }
    }
    return total;
  }
}
