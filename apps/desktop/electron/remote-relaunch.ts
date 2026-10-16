import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A relaunch nobody may be watching.
 *
 * A remote client asked this computer to install an update, so the app that
 * starts next may have no one in front of it. While the marker is fresh, the
 * startup paths that would otherwise park on a modal dialog (toolchain setup
 * failure, an early Local backend exit) retry on their own instead, so the
 * remote client gets its backend back rather than a dialog it cannot see.
 */

export const REMOTE_RELAUNCH_FILE = "remote-update-relaunch.json";
/** How long after the install the next launch counts as unattended. */
export const REMOTE_RELAUNCH_WINDOW_MS = 15 * 60 * 1000;
/** Relaunches allowed for a Local backend that keeps exiting. */
export const REMOTE_RELAUNCH_MAX_ATTEMPTS = 2;

export interface RemoteRelaunchMarker {
  jobId: string;
  version: string;
  writtenAt: string;
  attempts: number;
}

function markerPath(dataDir: string): string {
  return path.join(dataDir, REMOTE_RELAUNCH_FILE);
}

export async function writeRemoteRelaunchMarker(
  dataDir: string,
  input: { jobId: string; version: string },
  now: () => number = Date.now,
): Promise<void> {
  const marker: RemoteRelaunchMarker = {
    ...input,
    writtenAt: new Date(now()).toISOString(),
    attempts: 0,
  };
  await writeFile(markerPath(dataDir), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

/** The marker while it is fresh; an expired or unreadable one is removed. */
export function readRemoteRelaunchMarker(
  dataDir: string,
  now: () => number = Date.now,
): RemoteRelaunchMarker | null {
  let parsed: Partial<RemoteRelaunchMarker>;
  try {
    parsed = JSON.parse(readFileSync(markerPath(dataDir), "utf8")) as Partial<RemoteRelaunchMarker>;
  } catch {
    return null;
  }
  const writtenAt = typeof parsed.writtenAt === "string" ? Date.parse(parsed.writtenAt) : NaN;
  if (
    typeof parsed.jobId !== "string" ||
    typeof parsed.version !== "string" ||
    !Number.isFinite(writtenAt) ||
    now() - writtenAt > REMOTE_RELAUNCH_WINDOW_MS
  ) {
    clearRemoteRelaunchMarker(dataDir);
    return null;
  }
  return {
    jobId: parsed.jobId,
    version: parsed.version,
    writtenAt: parsed.writtenAt!,
    attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
  };
}

/** Counts one more automatic relaunch; false once the budget is spent. */
export function claimRemoteRelaunchAttempt(dataDir: string, marker: RemoteRelaunchMarker): boolean {
  if (marker.attempts >= REMOTE_RELAUNCH_MAX_ATTEMPTS) return false;
  try {
    writeFileSync(
      markerPath(dataDir),
      `${JSON.stringify({ ...marker, attempts: marker.attempts + 1 })}\n`,
      { mode: 0o600 },
    );
  } catch {
    return false;
  }
  return true;
}

export function clearRemoteRelaunchMarker(dataDir: string): void {
  rmSync(markerPath(dataDir), { force: true });
}
