// Whether the process that wrote its pid into a file is still that process.
//
// A pid alone is not identity. A container restart starts a fresh pid
// namespace that hands out small pids again (possibly to the new bridge
// itself), a reboot resets them, and macOS wraps at 99999. Three bridge files
// name an owner that must not be overruled while it lives: the session
// preference lock and its recovery marker (`session-preferences.ts`), the
// turn-in-flight mark (`session-manager-turn-interruption.ts`) and the
// change-evidence spool claim (`change-evidence.ts`). Each records
// {@link currentProcessIdentity} and asks {@link recordedOwnerState} before
// treating a live pid as its owner.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** What a bridge records about itself beside its pid. */
export interface ProcessIdentity {
  pid: number;
  /** Random per bridge process; never reused. */
  instance: string;
  /** Linux: field 22 of `/proc/<pid>/stat` (start time in clock ticks after boot). */
  procStart?: string;
  /** Linux: `/proc/sys/kernel/random/boot_id`. */
  bootId?: string;
  /**
   * Epoch milliseconds when the process started. Compared with `ps -o lstart`
   * only where `/proc` cannot answer, and only on a slow path.
   */
  processStartedAt?: number;
}

/** An owner read back from a file. An older bridge wrote only the pid. */
export type RecordedOwner = Pick<ProcessIdentity, "pid"> & Partial<Omit<ProcessIdentity, "pid">>;

/**
 * - `current`: this bridge process wrote it.
 * - `dead`: the writer is gone (its pid is free, is this process under another
 *   instance, or now belongs to a process with another start or boot).
 * - `alive`: the pid is live and its recorded identity matches.
 * - `unverified`: the pid is live and nothing recorded can tell whether it is
 *   still the writer. Callers treat it as alive.
 */
export type RecordedOwnerState = "current" | "dead" | "alive" | "unverified";

/** Changes when this bridge process restarts. */
export const BRIDGE_INSTANCE_ID = randomUUID();

/**
 * `ps -o lstart` prints whole seconds and the process started a moment before
 * its runtime's time origin. A wider window only makes a reused pid that
 * started within it look like the owner, which keeps the owner's file.
 */
const PS_START_TOLERANCE_MS = 2_000;
const PS_TIMEOUT_MS = 1_000;
const PS_CACHE_LIMIT = 256;
const PS_UNVERIFIED_RETRY_MS = 60_000;
const PROC_START_PATTERN = /^\d{1,20}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let ownIdentity: ProcessIdentity | undefined;

function readProcStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 follows the parenthesised command, which may contain spaces.
    const value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return value && PROC_START_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readBootId(): string | undefined {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value.length > 0 && value.length <= 64 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** This process's identity, read once. Costs nothing on hosts without `/proc`. */
export function currentProcessIdentity(): ProcessIdentity {
  if (!ownIdentity) {
    const procStart = readProcStart(process.pid);
    const bootId = procStart ? readBootId() : undefined;
    ownIdentity = {
      pid: process.pid,
      instance: BRIDGE_INSTANCE_ID,
      ...(procStart ? { procStart } : {}),
      ...(bootId ? { bootId } : {}),
      processStartedAt: Math.round(performance.timeOrigin),
    };
  }
  return ownIdentity;
}

/** The identity fields beside `pid`, for files that store the instance under their own key. */
export function currentIdentityFields(): Omit<ProcessIdentity, "pid" | "instance"> {
  const { procStart, bootId, processStartedAt } = currentProcessIdentity();
  return {
    ...(procStart ? { procStart } : {}),
    ...(bootId ? { bootId } : {}),
    ...(processStartedAt !== undefined ? { processStartedAt } : {}),
  };
}

/**
 * The optional identity fields of a parsed record. A malformed field drops
 * only itself, which leaves the owner less verifiable, never more.
 */
export function parseIdentityFields(
  record: Record<string, unknown>,
): Omit<ProcessIdentity, "pid" | "instance"> {
  return {
    ...(typeof record.procStart === "string" && PROC_START_PATTERN.test(record.procStart)
      ? { procStart: record.procStart }
      : {}),
    ...(typeof record.bootId === "string" && record.bootId.length > 0 && record.bootId.length <= 64
      ? { bootId: record.bootId }
      : {}),
    ...(typeof record.processStartedAt === "number" && Number.isFinite(record.processStartedAt)
      ? { processStartedAt: record.processStartedAt }
      : {}),
  };
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps -o lstart=` under `TZ=UTC LC_ALL=C`: `Wed Oct 28 02:27:14 2026`. */
export function parsePsStartTime(text: string): number | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    text.trim(),
  );
  if (!match) return undefined;
  const [, month, day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month!);
  if (monthIndex < 0) return undefined;
  return Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
}

const psVerdicts = new Map<string, { state: "dead" | "unverified"; at: number }>();

/**
 * Compare a live pid's start with the recorded one through `ps`. Spawns at
 * each slow-path check for a matching owner: a live pid can have been reused
 * since the last check. Only dead verdicts are permanent; an unanswered `ps`
 * is retried after a minute.
 */
function psOwnerState(pid: number, processStartedAt: number): "alive" | "dead" | "unverified" {
  const key = `${pid}:${processStartedAt}`;
  const cached = psVerdicts.get(key);
  if (
    cached &&
    (cached.state !== "unverified" || Date.now() - cached.at < PS_UNVERIFIED_RETRY_MS)
  ) {
    return cached.state;
  }
  let state: "alive" | "dead" | "unverified" = "unverified";
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const started = result.status === 0 ? parsePsStartTime(result.stdout) : undefined;
    if (started !== undefined) {
      state = Math.abs(started - processStartedAt) < PS_START_TOLERANCE_MS ? "alive" : "dead";
    }
  } catch {
    // No `ps`: the owner stays unverified.
  }
  psVerdicts.delete(key);
  if (state !== "alive") psVerdicts.set(key, { state, at: Date.now() });
  while (psVerdicts.size > PS_CACHE_LIMIT) {
    const oldest = psVerdicts.keys().next().value;
    if (oldest === undefined) break;
    psVerdicts.delete(oldest);
  }
  return state;
}

/**
 * Whether a recorded owner is still the process that wrote it.
 *
 * `/proc` answers at once. Where it cannot (macOS), `ps` answers only when
 * `slowPath` is set, because it spawns a process: callers set it once a file
 * has outlived its owner's heartbeat, or on a path that runs once.
 */
export function recordedOwnerState(
  owner: RecordedOwner,
  options: { slowPath: boolean },
): RecordedOwnerState {
  if (owner.instance === BRIDGE_INSTANCE_ID) return "current";
  // This process never records its pid under another instance (or none), so
  // the writer was an earlier process that had this pid.
  if (owner.pid === process.pid) return "dead";
  if (!processIsAlive(owner.pid)) return "dead";
  const self = currentProcessIdentity();
  if (owner.bootId && self.bootId && owner.bootId !== self.bootId) return "dead";
  if (owner.procStart) {
    const current = readProcStart(owner.pid);
    if (current !== undefined) return current === owner.procStart ? "alive" : "dead";
  }
  if (options.slowPath && owner.processStartedAt !== undefined) {
    return psOwnerState(owner.pid, owner.processStartedAt);
  }
  return "unverified";
}

/** Test-only: forget cached identity and `ps` answers. */
export function resetProcessIdentityCacheForTesting(): void {
  psVerdicts.clear();
  ownIdentity = undefined;
}
