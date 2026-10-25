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
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
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
import { deflateSync, inflateSync } from "node:zlib";

export type ObjectType = "blob" | "manifest";

const OBJECT_ID = /^[0-9a-f]{40}$/;

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
}

export class ObjectStore {
  readonly root: string;
  private readonly objects: string;
  private readonly durable: boolean;
  private readonly hardBudgetBytes: () => number;
  private mutation: Promise<unknown> = Promise.resolve();
  private usedBytes: number | null = null;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work);
    this.mutation = result.catch(() => undefined);
    return result;
  }

  private initialized: Promise<void> | null = null;

  constructor(options: ObjectStoreOptions) {
    this.hardBudgetBytes = options.hardBudgetBytes ?? (() => Infinity);
    this.root = options.root;
    this.objects = join(options.root, "objects");
    this.durable = options.durable ?? true;
  }

  /** Lay out a minimal bare repository so `git fsck` can read the store. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      await mkdir(join(this.objects, "info"), { recursive: true, mode: 0o700 });
      await mkdir(join(this.root, "refs"), { recursive: true, mode: 0o700 });
      await writeIfMissing(join(this.root, "HEAD"), "ref: refs/heads/main\n");
      await writeIfMissing(
        join(this.root, "config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
      );
      await mkdir(join(this.root, "tmp"), { recursive: true, mode: 0o700 });
    })();
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

  /** Renew the orphan fence before adopting a metadata-reused object. */
  reuse(id: string): Promise<boolean> {
    if (!isObjectId(id)) return Promise.resolve(false);
    return this.exclusive(async () => {
      const now = new Date();
      return utimes(this.path(id), now, now).then(
        () => true,
        () => false,
      );
    });
  }

  /**
   * Write one immutable object. Returns its id and whether it was new. The
   * write is atomic; concurrent writers of the same content converge.
   */
  async put(type: ObjectType, bytes: Uint8Array): Promise<{ id: string; created: boolean }> {
    return this.exclusive(async () => {
      await this.init();
      const id = objectId(type, bytes);
      const target = this.path(id);
      this.usedBytes ??= await this.storedBytes();
      if (this.usedBytes >= this.hardBudgetBytes()) throw new Error("capture-storage-quota");
      if (await this.has(id)) {
        const now = new Date();
        await utimes(target, now, now);
        return { id, created: false };
      }
      await mkdir(join(this.objects, id.slice(0, 2)), { recursive: true, mode: 0o700 });
      const header = Buffer.from(`${gitType(type)} ${bytes.length}\0`);
      const compressed = deflateSync(Buffer.concat([header, bytes]));
      if (this.usedBytes + compressed.length > this.hardBudgetBytes())
        throw new Error("capture-storage-quota");
      const temp = join(this.root, "tmp", `${id}.${randomUUID()}`);
      await writeFile(temp, compressed, { mode: 0o400 });
      if (this.durable) fsyncPath(temp);
      await rename(temp, target);
      this.usedBytes += compressed.length;
      return { id, created: true };
    });
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
      raw = inflateSync(compressed);
    } catch {
      return null;
    }
    const nul = raw.indexOf(0);
    if (nul < 0) return null;
    const payload = raw.subarray(nul + 1);
    if (createHash("sha1").update(raw).digest("hex") !== id) return null;
    return new Uint8Array(payload);
  }

  /** Make published objects durable: fsync each new object's directory entry. */
  syncDirectories(ids: Iterable<string>): void {
    if (!this.durable) return;
    const directories = new Set<string>();
    for (const id of ids) directories.add(join(this.objects, id.slice(0, 2)));
    for (const directory of directories) fsyncPath(directory);
  }

  /**
   * Remove objects not in `reachable` whose files are older than `graceMs`.
   * The grace fence keeps a concurrent publication (objects written, ledger
   * commit pending) from losing its objects.
   */
  async sweep(
    reachable: ReadonlySet<string>,
    graceMs: number,
    nowMs = Date.now(),
  ): Promise<{
    removed: number;
    bytes: number;
  }> {
    return this.exclusive(async () => {
      await this.init();
      let removed = 0;
      let bytes = 0;
      let fanout: string[];
      try {
        fanout = await readdir(this.objects);
      } catch {
        return { removed, bytes };
      }
      for (const prefix of fanout) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
        const directory = join(this.objects, prefix);
        for (const name of await readdir(directory).catch(() => [] as string[])) {
          const id = `${prefix}${name}`;
          if (!isObjectId(id) || reachable.has(id)) continue;
          const info = await lstat(join(directory, name)).catch(() => null);
          if (!info || nowMs - info.mtimeMs <= graceMs) continue;
          await rm(join(directory, name), { force: true });
          removed++;
          bytes += info.size;
        }
      }
      // Abandoned temporaries from crashed writers.
      for (const name of await readdir(join(this.root, "tmp")).catch(() => [] as string[])) {
        const file = join(this.root, "tmp", name);
        const info = await lstat(file).catch(() => null);
        if (info && nowMs - info.mtimeMs >= graceMs) await rm(file, { force: true });
      }
      this.usedBytes = null;
      return { removed, bytes };
    });
  }

  /** Total stored bytes (compressed), for quota accounting. */
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

function fsyncPath(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms; object writes are
    // still atomic.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
