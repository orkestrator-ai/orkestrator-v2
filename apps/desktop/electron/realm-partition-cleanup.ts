import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@orkestrator/protocol/logger";

/**
 * Removes the storage of the retired desktop workspace realms (plan item 6003,
 * decision 13.7 A: their presentation state is abandoned, not migrated).
 *
 * A realm's renderer used the partition `persist:orkestrator-realm-<slot>-<hash>`,
 * where `<hash>` is `connectionPartitionKey(nodeId)` (16 lowercase hex digits).
 * Electron keeps a `persist:` partition in `<userData>/Partitions/<name>`, the
 * name without `persist:`, lowercased and URL-escaped; these names have no
 * character either changes. Only directories whose whole name matches that
 * form are removed, and only under this app's own `userData`: never a file, a
 * symbolic link or any other partition (renderer, previews, artifacts).
 */
export const REALM_PARTITION_DIRECTORY = /^orkestrator-realm-\d{1,3}-[0-9a-f]{16}$/u;

const log = createLogger("desktop");

/** The filesystem calls the cleanup makes; tests pass their own. */
export type RealmPartitionFs = {
  readdir(directory: string): Promise<Dirent[]>;
  rm(target: string): Promise<void>;
};

const nodeFs: RealmPartitionFs = {
  readdir: (directory) => readdir(directory, { withFileTypes: true }),
  rm: (target) => rm(target, { recursive: true, force: true }),
};

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * Delete every retired realm partition directory under `userDataDir`. Run at
 * startup before any window exists, so no session holds one. Idempotent: a
 * second run, or a profile that never had realms, removes nothing. Never
 * throws; the log line carries counts only, never names or paths.
 */
export async function removeRealmPartitions(
  userDataDir: string,
  fs: RealmPartitionFs = nodeFs,
): Promise<{ removed: number; failed: number }> {
  const partitionsDir = path.join(userDataDir, "Partitions");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(partitionsDir);
  } catch (error) {
    if (!isMissing(error)) log.warn("realm-partitions.list-failed");
    return { removed: 0, failed: 0 };
  }
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    // A Dirent describes the entry itself: a link to a directory is not one.
    if (!entry.isDirectory() || !REALM_PARTITION_DIRECTORY.test(entry.name)) continue;
    try {
      await fs.rm(path.join(partitionsDir, entry.name));
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  if (removed > 0) log.info("realm-partitions.removed", { count: removed });
  if (failed > 0) log.warn("realm-partitions.remove-failed", { count: failed });
  return { removed, failed };
}
