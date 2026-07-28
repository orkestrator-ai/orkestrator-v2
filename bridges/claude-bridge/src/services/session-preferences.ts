// Durable per-session user preferences.
//
// Bridge session state is in-memory and the bridge process dies with the
// backend, so a preference held only on `SessionState` silently resets on the
// next app launch. That matters for plan mode: a user who had it ON would send
// their next prompt with bypassPermissions without having changed anything.
//
// Each session gets its own small JSON file, keyed by the SDK session id (the
// same id the rollout is stored under). Per-session files rather than one
// shared document because several environments' bridges share one Claude home:
// a whole-file rewrite from one bridge could drop an entry another bridge had
// just written, while per-session files never contend.

import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { claudeSessionPreferencesDir } from "./claude-home.js";

/** Preferences that must survive a bridge restart. Extend here, not ad hoc. */
export interface SessionPreferences {
  /** Whether the UI plan-mode toggle is on. Absent = never set (defaults off). */
  planMode?: boolean;
  /**
   * Recently accepted renderer request ids.
   *
   * Initial prompts are one-shot launch work, but a renderer can disappear
   * after the bridge accepts one and before it clears its local launch marker.
   * Keeping the acceptance journal beside the rollout makes the retry
   * idempotent across bridge and application restarts.
   */
  dispatchedRequestIds?: string[];
}

export const MAX_DISPATCHED_REQUEST_IDS = 64;

/**
 * Only a canonical UUID may become a filename. The id normally comes from the
 * SDK, but it also arrives via HTTP session ids; this keeps a hostile or
 * mangled id from ever being joined into a path.
 */
const SDK_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedSessionId(sdkSessionId: string): string | null {
  if (!SDK_SESSION_ID_PATTERN.test(sdkSessionId)) return null;
  return sdkSessionId.toLowerCase();
}

function preferencesPath(sdkSessionId: string): string | null {
  const normalized = normalizedSessionId(sdkSessionId);
  return normalized
    ? join(claudeSessionPreferencesDir(), `${normalized}.json`)
    : null;
}

/**
 * Writes in flight per session id. Chained so a rapid toggle cannot interleave
 * two temp-file writes into a corrupt rename, and so the last call wins.
 */
const pendingWrites = new Map<string, Promise<void>>();
const PREFERENCE_LOCK_TIMEOUT_MS = 5_000;
const PREFERENCE_LOCK_STALE_MS = 30_000;
const PREFERENCE_LOCK_HEARTBEAT_MS = 5_000;
const UNAVAILABLE_PREFERENCES = Symbol("unavailable-session-preferences");

type LockMetadata = {
  token: string;
  pid: number;
};

type LockSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  metadata?: LockMetadata;
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function parseLockMetadata(raw: string): LockMetadata | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    return typeof parsed.token === "string"
        && parsed.token.length > 0
        && typeof parsed.pid === "number"
        && Number.isSafeInteger(parsed.pid)
        && parsed.pid > 0
      ? { token: parsed.token, pid: parsed.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  try {
    const [lockStat, raw] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, "utf-8").catch(() => ""),
    ]);
    return {
      dev: lockStat.dev,
      ino: lockStat.ino,
      mtimeMs: lockStat.mtimeMs,
      metadata: parseLockMetadata(raw),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function snapshotIsRecoverable(snapshot: LockSnapshot): boolean {
  return Date.now() - snapshot.mtimeMs > PREFERENCE_LOCK_STALE_MS
    && (
      snapshot.metadata === undefined
      || !processIsAlive(snapshot.metadata.pid)
    );
}

/**
 * Serialize stale recovery for one exact lock inode.
 *
 * The recovery marker closes the two-reaper race: after both processes observe
 * one stale lock, only one may unlink that inode. The loser re-reads the main
 * lock instead of deleting a replacement the winner has already acquired.
 */
async function recoverStaleLock(
  lockPath: string,
  candidate: LockSnapshot,
): Promise<boolean> {
  if (!snapshotIsRecoverable(candidate)) return false;
  const recoveryPath =
    `${lockPath}.recover-${candidate.dev}-${candidate.ino}`;
  let recoveryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    recoveryHandle = await open(recoveryPath, "wx", 0o600);
    try {
      await recoveryHandle.writeFile(JSON.stringify({
        token: crypto.randomUUID(),
        pid: process.pid,
      } satisfies LockMetadata));
    } catch (error) {
      await recoveryHandle.close().catch(() => {});
      recoveryHandle = undefined;
      await rm(recoveryPath, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      // Recovery itself can be interrupted. A marker owned by a live process
      // is never stolen, even when that process is suspended beyond the stale
      // interval. A dead owner's marker is removed so future attempts are not
      // permanently wedged.
      const abandoned = await readLockSnapshot(recoveryPath);
      if (abandoned && snapshotIsRecoverable(abandoned)) {
        const current = await readLockSnapshot(recoveryPath);
        if (
          current
          && current.dev === abandoned.dev
          && current.ino === abandoned.ino
          && snapshotIsRecoverable(current)
        ) {
          await rm(recoveryPath, { force: true });
        }
      }
      return false;
    }
    throw error;
  }

  const acquiredRecovery = await recoveryHandle.stat();
  try {
    const current = await readLockSnapshot(lockPath);
    if (
      current
      && current.dev === candidate.dev
      && current.ino === candidate.ino
      && snapshotIsRecoverable(current)
    ) {
      await rm(lockPath, { force: true });
      return true;
    }
    return false;
  } finally {
    await recoveryHandle.close().catch(() => {});
    try {
      const currentRecovery = await stat(recoveryPath);
      if (
        currentRecovery.dev === acquiredRecovery.dev
        && currentRecovery.ino === acquiredRecovery.ino
      ) {
        await rm(recoveryPath, { force: true });
      }
    } catch {
      // Already removed or replaced; never unlink another recovery owner.
    }
  }
}

async function withPreferenceFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(claudeSessionPreferencesDir(), { recursive: true });
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          token: crypto.randomUUID(),
          pid: process.pid,
        } satisfies LockMetadata));
      } catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const lockSnapshot = await readLockSnapshot(lockPath);
      if (!lockSnapshot || await recoverStaleLock(lockPath, lockSnapshot)) continue;
      if (Date.now() - startedAt >= PREFERENCE_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for session preference lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const acquiredLock = await handle.stat();
  const heartbeat = setInterval(() => {
    void handle?.utimes(new Date(), new Date()).catch(() => {});
  }, PREFERENCE_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => {});
    // A stale-lock recovery may have replaced this path while an old owner was
    // suspended. Never let that old owner unlink the replacement's live lock.
    try {
      const currentLock = await stat(lockPath);
      if (
        currentLock.dev === acquiredLock.dev
        && currentLock.ino === acquiredLock.ino
      ) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // The lock already disappeared or cannot be inspected; there is no safe
      // cleanup action left to take.
    }
  }
}

function parsePreferences(raw: string): SessionPreferences | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.hasOwn(record, "planMode")
    && typeof record.planMode !== "boolean"
  ) {
    return undefined;
  }
  if (
    Object.hasOwn(record, "dispatchedRequestIds")
    && !Array.isArray(record.dispatchedRequestIds)
  ) {
    return undefined;
  }
  const preferences: SessionPreferences = {};
  if (typeof record.planMode === "boolean") preferences.planMode = record.planMode;
  if (Array.isArray(record.dispatchedRequestIds)) {
    const unique = new Set<string>();
    for (const value of record.dispatchedRequestIds) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (
        typeof value === "string"
        && normalized.length > 0
        && normalized.length <= 200
      ) {
        unique.add(normalized);
      }
    }
    if (unique.size > 0) {
      preferences.dispatchedRequestIds = [...unique].slice(-MAX_DISPATCHED_REQUEST_IDS);
    }
  }
  return preferences;
}

/**
 * A preferences file that exists but cannot be trusted must not silently
 * disable plan mode. Plan mode is the restrictive permission state, so it is
 * the safe fallback for corruption, unreadable metadata, and version-skewed
 * non-object payloads.
 */
const FAIL_CLOSED_PREFERENCES: Readonly<SessionPreferences> = {
  planMode: true,
};

function unavailablePreferences(): SessionPreferences {
  const preferences: SessionPreferences = { ...FAIL_CLOSED_PREFERENCES };
  Object.defineProperty(preferences, UNAVAILABLE_PREFERENCES, {
    value: true,
  });
  return preferences;
}

/** Whether the file existed but its permission/journal contents were unknown. */
export function sessionPreferencesUnavailable(
  preferences: SessionPreferences | undefined,
): boolean {
  return preferences !== undefined
    && (preferences as SessionPreferences & {
      [UNAVAILABLE_PREFERENCES]?: boolean;
    })[UNAVAILABLE_PREFERENCES] === true;
}

/**
 * Read a session's stored preferences. A genuinely missing file means the user
 * has never stored a preference. Any other read or parse failure fails closed
 * to plan mode so damaged metadata cannot widen tool permissions.
 */
export async function readSessionPreferences(
  sdkSessionId: string,
): Promise<SessionPreferences | undefined> {
  const path = preferencesPath(sdkSessionId);
  if (!path) return undefined;
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return undefined;
    }
    return unavailablePreferences();
  }
  return parsePreferences(raw) ?? unavailablePreferences();
}

async function writePreferencesFile(
  path: string,
  preferences: SessionPreferences,
): Promise<void> {
  await mkdir(claudeSessionPreferencesDir(), { recursive: true });
  // Written via rename so a crash mid-write leaves either the old file or the
  // new one, never a truncated document the reader would treat as "never set".
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(preferences)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Merge `update` into the stored preferences for a session.
 *
 * A merge rather than a replace so a future second preference cannot be erased
 * by a caller that only knows about plan mode. Rejections propagate; callers
 * that treat durability as best-effort catch and log.
 */
export async function updateSessionPreferences(
  sdkSessionId: string,
  update: SessionPreferences,
): Promise<void> {
  const writeKey = normalizedSessionId(sdkSessionId);
  const path = preferencesPath(sdkSessionId);
  if (!writeKey || !path) return;
  const previous = pendingWrites.get(writeKey) ?? Promise.resolve();
  // Chained regardless of the previous write's outcome; one failed write must
  // not wedge every later one.
  const write = previous
    .catch(() => {})
    .then(async () => {
      await withPreferenceFileLock(path, async () => {
        const existing = (await readSessionPreferences(sdkSessionId)) ?? {};
        if (sessionPreferencesUnavailable(existing)) {
          throw new Error(
            "Session preferences are unreadable; refusing to overwrite the durable prompt journal",
          );
        }
        await writePreferencesFile(path, { ...existing, ...update });
      });
    });
  pendingWrites.set(writeKey, write);
  void write
    .finally(() => {
      if (pendingWrites.get(writeKey) === write) {
        pendingWrites.delete(writeKey);
      }
    })
    .catch(() => {
      // The caller observes the original rejection; this branch only settles
      // the promise returned by `finally`.
    });
  return write;
}

/** Remove a session's preference file. Absent files are a no-op. */
export async function deleteSessionPreferences(sdkSessionId: string): Promise<void> {
  const writeKey = normalizedSessionId(sdkSessionId);
  const path = preferencesPath(sdkSessionId);
  if (!writeKey || !path) return;
  const previous = pendingWrites.get(writeKey) ?? Promise.resolve();
  const deletion = previous
    .catch(() => {})
    .then(() => withPreferenceFileLock(
      path,
      () => rm(path, { force: true }),
    ));
  pendingWrites.set(writeKey, deletion);
  void deletion
    .finally(() => {
      if (pendingWrites.get(writeKey) === deletion) {
        pendingWrites.delete(writeKey);
      }
    })
    .catch(() => {
      // The caller observes the original rejection; this branch only settles
      // the promise returned by `finally`.
    });
  return deletion;
}
