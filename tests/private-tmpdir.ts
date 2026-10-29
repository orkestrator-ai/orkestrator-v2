import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PARENT_TMPDIR_ENV,
  createOwnedTempDir,
  namedByLiveProcess,
  sweepStaleTempDirs,
} from "./temp-sweep";

// Anything a test process leaves in the shared temporary directory has no
// owner a later run can identify. Playwright's browser profiles are the main
// case: `playwright_chromiumdev_profile-*` names hold no PID and other tools use
// the same prefix (0248). So each test process gets a private `TMPDIR` named
// for its PID; everything it and its children make lands inside it, and a later
// run removes the whole directory once its owner has exited.

/** Kept short: Unix socket paths made inside it are limited to 104 bytes on macOS. */
export const PRIVATE_TMPDIR_PREFIX = "ork-test-tmp-";
/** Set to `1` to keep each private directory for inspection (a leak hunt, as in 0247). */
export const KEEP_PRIVATE_TMPDIR_ENV = "ORKESTRATOR_TEST_KEEP_PRIVATE_TMPDIR";
/** The private directory a test process handed to its children, so they reuse it. */
export const PRIVATE_TMPDIR_ENV = "ORKESTRATOR_TEST_PRIVATE_TMPDIR";
/** A test process never runs this long, so an older directory is not being created. */
const STALE_AFTER_MS = 60 * 60 * 1_000;

/**
 * Where private directories go for a process whose temporary directory is
 * `parent`. macOS's per-user temporary directory is already 49 characters, and
 * a private directory inside it pushed test sockets past 104 bytes (the SSH
 * askpass broker and a sub-agent control socket failed). There they go under
 * `/private/tmp` instead, which is canonical and shorter than the per-user
 * directory, so paths only get shorter. Elsewhere the parent is honoured.
 */
export function privateTmpdirRoot(parent = tmpdir(), platform = process.platform): string {
  const short = "/private/tmp";
  return platform === "darwin" && parent.length > short.length && existsSync(short)
    ? short
    : parent;
}

/**
 * Points `TMPDIR` at a new private directory for this process and returns the
 * function that restores it and removes the directory. A process that
 * inherited its parent's private directory keeps using it and owns nothing.
 * Removal keeps a directory that a live process (a browser that outlived its
 * test) still names; the next run's sweep retries it.
 */
export function enterPrivateTestTmpdir(): () => void {
  const inherited = process.env[PRIVATE_TMPDIR_ENV];
  if (inherited && process.env.TMPDIR === inherited && existsSync(inherited)) return () => {};

  const parent = tmpdir();
  const root = privateTmpdirRoot(parent);
  sweepStaleTempDirs({
    prefix: PRIVATE_TMPDIR_PREFIX,
    root,
    maxAgeMs: STALE_AFTER_MS,
    isInUse: namedByLiveProcess(),
  });
  const directory = createOwnedTempDir(PRIVATE_TMPDIR_PREFIX, root);
  const previous = {
    TMPDIR: process.env.TMPDIR,
    [PRIVATE_TMPDIR_ENV]: process.env[PRIVATE_TMPDIR_ENV],
    [PARENT_TMPDIR_ENV]: process.env[PARENT_TMPDIR_ENV],
  };
  process.env.TMPDIR = directory;
  process.env[PRIVATE_TMPDIR_ENV] = directory;
  process.env[PARENT_TMPDIR_ENV] = parent;

  let left = false;
  return () => {
    if (left) return;
    left = true;
    // Only undo what is still ours: a test may have pointed TMPDIR elsewhere.
    if (process.env.TMPDIR === directory) {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    removePrivateTmpdir(directory);
  };
}

function removePrivateTmpdir(directory: string): void {
  if (process.env[KEEP_PRIVATE_TMPDIR_ENV] === "1") return;
  try {
    if (readdirSync(directory).length > 0 && namedByLiveProcess()(directory)) return;
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Already gone, or left for the next run's sweep.
  }
}
