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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function preferencesPath(sdkSessionId: string): string | null {
  if (!SDK_SESSION_ID_PATTERN.test(sdkSessionId)) return null;
  return join(claudeSessionPreferencesDir(), `${sdkSessionId.toLowerCase()}.json`);
}

/**
 * Writes in flight per session id. Chained so a rapid toggle cannot interleave
 * two temp-file writes into a corrupt rename, and so the last call wins.
 */
const pendingWrites = new Map<string, Promise<void>>();

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
  const preferences: SessionPreferences = {};
  if (typeof record.planMode === "boolean") preferences.planMode = record.planMode;
  if (Array.isArray(record.dispatchedRequestIds)) {
    const unique = new Set<string>();
    for (const value of record.dispatchedRequestIds) {
      if (
        typeof value === "string"
        && value.trim().length > 0
        && value.length <= 200
      ) {
        unique.add(value);
      }
    }
    if (unique.size > 0) {
      preferences.dispatchedRequestIds = [...unique].slice(-MAX_DISPATCHED_REQUEST_IDS);
    }
  }
  return preferences;
}

/**
 * Read a session's stored preferences. Missing, unreadable and malformed files
 * all resolve to undefined: a preference that cannot be recovered defaults, it
 * never fails a request.
 */
export async function readSessionPreferences(
  sdkSessionId: string,
): Promise<SessionPreferences | undefined> {
  const path = preferencesPath(sdkSessionId);
  if (!path) return undefined;
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  return parsePreferences(raw);
}

async function writePreferencesFile(
  path: string,
  preferences: SessionPreferences,
): Promise<void> {
  await mkdir(claudeSessionPreferencesDir(), { recursive: true });
  // Written via rename so a crash mid-write leaves either the old file or the
  // new one, never a truncated document the reader would treat as "never set".
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(preferences)}\n`, "utf-8");
  await rename(tempPath, path);
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
  const path = preferencesPath(sdkSessionId);
  if (!path) return;
  const previous = pendingWrites.get(sdkSessionId) ?? Promise.resolve();
  // Chained regardless of the previous write's outcome; one failed write must
  // not wedge every later one.
  const write = previous
    .catch(() => {})
    .then(async () => {
      const existing = (await readSessionPreferences(sdkSessionId)) ?? {};
      await writePreferencesFile(path, { ...existing, ...update });
    });
  pendingWrites.set(sdkSessionId, write);
  void write
    .finally(() => {
      if (pendingWrites.get(sdkSessionId) === write) {
        pendingWrites.delete(sdkSessionId);
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
  const path = preferencesPath(sdkSessionId);
  if (!path) return;
  await rm(path, { force: true });
}
