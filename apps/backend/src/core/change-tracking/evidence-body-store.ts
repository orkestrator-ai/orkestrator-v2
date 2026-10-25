/**
 * Server-only store for retained provider evidence bodies (patches,
 * replacement sides, raw payload slices).
 *
 * Bodies are content-addressed by SHA-256 — the same id the bridge spool
 * assigns — and verified on write and read, so an opaque body id can never
 * name an arbitrary filesystem path. Bodies inherit session authorization:
 * they are read only through `changes_get_diff` for a measurement the caller
 * may already see, never logged and never put in metrics. Bytes are written
 * (and fsynced) before the ledger row that references them commits.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BODY_ID = /^sha256:([0-9a-f]{64})$/;

export function bodyIdFor(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class EvidenceBodyStore {
  constructor(
    private readonly root: string,
    private readonly durable = true,
  ) {}

  private path(id: string): string | null {
    const match = BODY_ID.exec(id);
    if (!match) return null;
    const hex = match[1]!;
    return join(this.root, hex.slice(0, 2), hex.slice(2));
  }

  /** Store bytes under their id; rejects bytes that do not hash to `id`. */
  async put(id: string, bytes: Uint8Array): Promise<boolean> {
    const target = this.path(id);
    if (!target || bodyIdFor(bytes) !== id) return false;
    if (
      await lstat(target).then(
        () => true,
        () => false,
      )
    )
      return true;
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600 });
    if (this.durable) {
      const fd = openSync(temp, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    await rename(temp, target);
    return true;
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

  async remove(id: string): Promise<void> {
    const target = this.path(id);
    if (target) await rm(target, { force: true });
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
