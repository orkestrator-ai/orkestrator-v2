import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBackendDatabase } from "../src/core/storage-stores";

/** Shared by the `tests/storage*.test.ts` files split out of `storage.test.ts`. */

const tempDirs: string[] = [];

export async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function withFixedDate<T>(iso: string, fn: () => T): T {
  const RealDate = Date;
  const fixedTime = new RealDate(iso).getTime();

  globalThis.Date = class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedTime);
      } else if (args.length === 1) {
        super(args[0]);
      } else {
        super(
          args[0],
          args[1],
          args[2] ?? 1,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
          args[6] ?? 0,
        );
      }
    }

    static now() {
      return fixedTime;
    }
  } as DateConstructor;

  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Leaves lease `name` held by a backend that crashed: no release, no heartbeat. */
export async function abandonLease(dataDir: string, name: string): Promise<void> {
  const crashed = openBackendDatabase(dataDir);
  await crashed.acquireLease(name, "crashed backend");
  crashed.db.query("UPDATE leases SET heartbeat_at = 0 WHERE name = ?").run(name);
  crashed.close();
}

export function heldLeases(dataDir: string): string[] {
  const database = openBackendDatabase(dataDir);
  try {
    return (database.db.query("SELECT name FROM leases").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    database.close();
  }
}

export function leaseHeld(dataDir: string, name: string): boolean {
  return heldLeases(dataDir).includes(name);
}

/** Removes every directory `createTempDir` made; each file runs it `afterEach`. */
export async function removeTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
