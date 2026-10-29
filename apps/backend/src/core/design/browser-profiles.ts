import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isProcessAlive,
  isRecordedProcessAlive,
  processStartIdentity,
  readLiveCommandLines,
} from "../process-identity.js";

/**
 * Playwright makes each design browser's profile with `mkdtemp` in the
 * backend's temporary directory and removes it from this process only when the
 * browser exits, so a killed backend leaves the profile behind. The name holds
 * no owner, and `playwright-cli` and agent browser sessions use the same
 * prefix, so a later backend cannot tell this backend's profiles from theirs.
 * The renderer therefore records each profile it launches in a ledger under the
 * data directory, and startup recovery removes only recorded profiles.
 */

/** How long a recorded profile is kept after its last change once its backend and browser have exited. */
export const DESIGN_PROFILE_STALE_MS = 60 * 60_000;
/** Exactly what Playwright's `mkdtemp` makes; a record naming anything else is ignored. */
const PROFILE_NAME = /^playwright_chromiumdev_profile-[A-Za-z0-9]{6}$/;
const RECORD_NAME = /^[1-9]\d*-[1-9]\d*-[0-9a-f]{8}\.json$/;
const PARTIAL_RECORD_NAME = /^[1-9]\d*-[1-9]\d*-[0-9a-f]{8}\.json\.[0-9a-f]{8}\.tmp$/;
const USER_DATA_DIR_ARG = "--user-data-dir=";

interface ProcessRecord {
  pid: number;
  start: string | null;
}

interface ProfileRecord {
  profile: string;
  backend: ProcessRecord;
  browser: ProcessRecord;
}

/** The profile a Playwright-launched Chromium uses, from its spawn arguments. */
export function userDataDirFromArgs(args: readonly string[] | undefined): string | undefined {
  const arg = args?.find((candidate) => candidate.startsWith(USER_DATA_DIR_ARG));
  return arg ? arg.slice(USER_DATA_DIR_ARG.length) : undefined;
}

export interface DesignProfileLedgerOptions {
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  processStartIdentity?: (pid: number) => string | null;
  /** Command lines of live processes, or `null` when unreadable (every profile then counts as in use). */
  liveCommandLines?: () => Promise<string | null>;
}

export class DesignProfileLedger {
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly identity: (pid: number) => string | null;
  private readonly commandLines: () => Promise<string | null>;
  private backendStart: string | null | undefined;

  constructor(
    readonly dir: string,
    options: DesignProfileLedgerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.alive = options.isProcessAlive ?? isProcessAlive;
    this.identity = options.processStartIdentity ?? processStartIdentity;
    this.commandLines = options.liveCommandLines ?? readLiveCommandLines;
  }

  /**
   * Records the profile of a browser this backend launched and returns the
   * record's path, or `null` when there is nothing to record. Never throws: a
   * missing record only means a later backend leaves that profile alone.
   */
  async record(
    browserPid: number | undefined,
    profile: string | undefined,
  ): Promise<string | null> {
    if (!browserPid || !profile || !isProfilePath(profile)) return null;
    this.backendStart ??= this.identity(process.pid);
    const record: ProfileRecord = {
      profile,
      backend: { pid: process.pid, start: this.backendStart },
      browser: { pid: browserPid, start: this.identity(browserPid) },
    };
    const target = path.join(
      this.dir,
      `${process.pid}-${browserPid}-${randomUUID().slice(0, 8)}.json`,
    );
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      // Write then rename, so a reader never sees half a record.
      const partial = `${target}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(partial, JSON.stringify(record), { mode: 0o600 });
      await rename(partial, target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * Drops a record once its browser has exited and Playwright has removed the
   * profile. A profile that is still there keeps its record for startup
   * recovery. Never throws.
   */
  async release(recordPath: string | null): Promise<void> {
    if (!recordPath) return;
    try {
      const record = parseRecord(await readFile(recordPath, "utf8"));
      if (record && (await exists(record.profile))) return;
      await rm(recordPath, { force: true });
    } catch {
      // Left for startup recovery.
    }
  }

  /**
   * Startup recovery. Removes recorded profiles whose backend and browser have
   * both exited, that have not changed for `maxAgeMs`, and that no live process
   * names on its command line. Never throws; returns the removed profiles.
   */
  async sweep(maxAgeMs = DESIGN_PROFILE_STALE_MS): Promise<string[]> {
    const removed: string[] = [];
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return removed;
    }
    let commandLines: Promise<string | null> | undefined;
    for (const name of names) {
      if (PARTIAL_RECORD_NAME.test(name)) {
        await this.removeAbandonedPartial(path.join(this.dir, name), maxAgeMs);
        continue;
      }
      if (!RECORD_NAME.test(name)) continue;
      const recordPath = path.join(this.dir, name);
      try {
        const record = parseRecord(await readFile(recordPath, "utf8"));
        // A record that names nothing removable is dropped, never acted on.
        if (!record) {
          await rm(recordPath, { force: true });
          continue;
        }
        if (this.isAlive(record.backend) || this.isAlive(record.browser)) continue;
        const info = await lstat(record.profile).catch(() => null);
        if (!info || !info.isDirectory()) {
          await rm(recordPath, { force: true });
          continue;
        }
        if (this.now() - info.mtimeMs <= maxAgeMs) continue;
        commandLines ??= this.commandLines().catch(() => null);
        const lines = await commandLines;
        if (lines === null || lines.includes(record.profile)) continue;
        await rm(record.profile, { recursive: true, force: true });
        await rm(recordPath, { force: true });
        removed.push(record.profile);
      } catch {
        // Retried at the next start.
      }
    }
    return removed;
  }

  /** A write interrupted before its rename; its profile was never recorded. */
  private async removeAbandonedPartial(partial: string, maxAgeMs: number): Promise<void> {
    const info = await lstat(partial).catch(() => null);
    if (info?.isFile() && this.now() - info.mtimeMs > maxAgeMs)
      await rm(partial, { force: true }).catch(() => undefined);
  }

  private isAlive(record: ProcessRecord): boolean {
    return isRecordedProcessAlive(record.pid, record.start, this.alive, this.identity);
  }
}

function isProfilePath(candidate: string): boolean {
  return path.isAbsolute(candidate) && PROFILE_NAME.test(path.basename(candidate));
}

function isProcessRecord(value: unknown): value is ProcessRecord {
  const record = value as Partial<ProcessRecord> | null;
  return (
    typeof record?.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    (record.start === null || typeof record.start === "string")
  );
}

function parseRecord(text: string): ProfileRecord | null {
  try {
    const value = JSON.parse(text) as Partial<ProfileRecord>;
    if (typeof value.profile !== "string" || !isProfilePath(value.profile)) return null;
    if (!isProcessRecord(value.backend) || !isProcessRecord(value.browser)) return null;
    return { profile: value.profile, backend: value.backend, browser: value.browser };
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => null)) !== null;
}
