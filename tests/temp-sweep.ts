import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test temporary directories are removed by the test that made them, but a
// worker that is killed or times out never runs that cleanup. Directories made
// through `ownedTempDirPrefix` are named `<prefix><pid>-<random>`, so a later
// process can tell which leftovers belong to a process that has exited. Every
// prefix opts in explicitly: a sweep only ever looks at the prefixes its caller
// names.

/** Six characters `mkdtemp` appends to the template. */
const OWNED_SUFFIX = /^([1-9]\d*)-[A-Za-z0-9]{6}$/;
const LEGACY_SUFFIX = /^[A-Za-z0-9]{6}$/;

export interface SweepStaleTempDirsOptions {
  /** One or more `mkdtemp` prefixes, each including its trailing separator. */
  prefix: string | readonly string[];
  /**
   * How long a directory whose owner has exited is kept. The age check also
   * covers an owner in another PID namespace (a container or sandbox sharing
   * the temporary directory), which looks dead from here.
   */
  maxAgeMs: number;
  /**
   * How long a `<prefix><random>` directory, made before its creator embedded
   * a PID, is kept. It has no owner to ask, so only age decides. Omit to leave
   * such directories alone.
   */
  legacyMaxAgeMs?: number;
  root?: string;
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
}

/** Path prefix for `mkdtemp`/`mkdtempSync` that records this process as owner. */
export function ownedTempDirPrefix(prefix: string, root = tmpdir()): string {
  return join(root, `${prefix}${process.pid}-`);
}

export function createOwnedTempDir(prefix: string, root = tmpdir()): string {
  return mkdtempSync(ownedTempDirPrefix(prefix, root));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes stale directories directly under `root` whose names match one of the
 * prefixes, and returns their paths. A directory owned by a live process is
 * never removed. The sweep never throws: concurrent sweeps race each other and
 * the owners, and a failure only leaves a directory for the next sweep.
 */
export function sweepStaleTempDirs(options: SweepStaleTempDirsOptions): string[] {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  const alive = options.isProcessAlive ?? isProcessAlive;
  const prefixes = typeof options.prefix === "string" ? [options.prefix] : options.prefix;
  const removed: string[] = [];

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }

  for (const name of names) {
    for (const prefix of prefixes) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      const owner = OWNED_SUFFIX.exec(suffix);
      const maxAgeMs = owner
        ? options.maxAgeMs
        : LEGACY_SUFFIX.test(suffix)
          ? options.legacyMaxAgeMs
          : undefined;
      if (maxAgeMs === undefined) continue;
      if (owner) {
        const pid = Number(owner[1]);
        if (pid === process.pid || alive(pid)) break;
      }

      const target = join(root, name);
      try {
        const info = lstatSync(target);
        if (!info.isDirectory() || now - info.mtimeMs <= maxAgeMs) break;
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {
        // Already removed by another sweep, or not ours to remove.
      }
      break;
    }
  }
  return removed;
}
