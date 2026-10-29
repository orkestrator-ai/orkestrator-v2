import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test temporary directories are removed by the test that made them, but a
// worker that is killed or times out never runs that cleanup. Directories made
// through `ownedTempDirPrefix` are named `<prefix><pid>-<random>`, so a later
// process can tell which leftovers belong to a process that has exited. Every
// prefix opts in explicitly: a sweep only ever looks at the prefixes its caller
// names.

/**
 * The temporary directory a test process had before `tests/private-tmpdir.ts`
 * gave it a private one. Sweeps without an explicit root look there as well,
 * so leftovers from before a process went private are still found.
 */
export const PARENT_TMPDIR_ENV = "ORKESTRATOR_TEST_PARENT_TMPDIR";

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
  /** Directory to sweep (default: the temporary directory and its parent, see `PARENT_TMPDIR_ENV`). */
  root?: string;
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Whether a live process still uses a directory that is otherwise stale (a
   * browser outlives the process that launched it). `true` keeps it. Omit to
   * decide on owner and age alone.
   */
  isInUse?: (directory: string) => boolean;
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
  if (options.root === undefined) {
    const roots = new Set([tmpdir(), process.env[PARENT_TMPDIR_ENV] || tmpdir()]);
    return [...roots].flatMap((root) => sweepStaleTempDirs({ ...options, root }));
  }
  const root = options.root;
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
        if (options.isInUse?.(target)) break;
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

/**
 * A check for whether any visible live process names a directory, or a path
 * inside it, on its command line (a browser's `--user-data-dir`). The process
 * list is read once, on the first call; a list that cannot be read counts
 * every directory as in use.
 */
export function namedByLiveProcess(): (directory: string) => boolean {
  let commandLines: string | null | undefined;
  return (directory) => {
    commandLines ??= readLiveCommandLines();
    return commandLines === null || commandLines.includes(directory);
  };
}

function readLiveCommandLines(): string | null {
  if (process.platform === "linux") {
    try {
      const lines: string[] = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          lines.push(readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " "));
        } catch {
          // Exited during the scan, or not readable.
        }
      }
      return lines.join("\n");
    } catch {
      return null;
    }
  }
  const result = spawnSync("ps", ["-axww", "-o", "args="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return result.status === 0 ? result.stdout : null;
}
