/**
 * Who owns a host fake Cursor bridge entry, and whom it serves.
 *
 * An agent-test profile's backend launches a local environment's Cursor bridge
 * from the checkout's `bridges/cursor-bridge/dist/index.js`, which every
 * profile started from that checkout shares. The inactive-path steer spec
 * (`e2e/agent-testing/steer-inactive-live.spec.ts`) swaps that entry for a
 * bundle of `host-fake-engine-server.ts` for the length of its Cursor case.
 * Two rules keep the swap from leaking into other runs:
 *
 * - One owner at a time. The swap records its owner in {@link LOCK_FILE_NAME}
 *   beside the entry, created exclusively; a second run is refused while the
 *   owner's process is alive. A lock whose process is gone is stale (a run
 *   killed before its restore) and is taken over.
 * - The fake serves only its owner. The bundle reads the lock at startup and
 *   runs the fake SDK only for a bridge whose `CURSOR_BRIDGE_STATE_DIR` is
 *   inside the owner's profile data directory. Any other launch (another
 *   profile, a lock already released) runs the real entry kept beside it as
 *   {@link REAL_ENTRY_NAME}.
 *
 * Only `node:` built-ins, so the bundle can make the decision before it loads
 * anything else.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The real entry, kept beside the bundle that replaced it. A `.js` name so it can be imported. */
export const REAL_ENTRY_NAME = "index.qa-real.js";
/** The swap's owner record, beside the entry. */
export const LOCK_FILE_NAME = "index.qa-lock.json";

export interface HostFakeEntryLock {
  /** The process that installed the fake and will restore the real entry. */
  pid: number;
  /** The profile data directory whose bridges the fake serves. */
  dataDir: string;
  /** Distinguishes this swap from a later one by the same process. */
  token: string;
}

/** The lock in `distDirectory`, or null when there is none or it cannot be read. */
export function readHostFakeEntryLock(distDirectory: string): HostFakeEntryLock | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(distDirectory, LOCK_FILE_NAME), "utf8"),
    ) as Partial<HostFakeEntryLock>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.dataDir !== "string" ||
      !parsed.dataDir ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return { pid: parsed.pid, dataDir: parsed.dataDir, token: parsed.token };
  } catch {
    return null;
  }
}

/** Whether a bridge with this state directory gets the fake SDK under `lock`. */
export function hostFakeEntryServes(
  lock: HostFakeEntryLock | null,
  stateDir: string | undefined,
): boolean {
  if (!lock || !stateDir) return false;
  const relative = path.relative(path.resolve(lock.dataDir), path.resolve(stateDir));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
