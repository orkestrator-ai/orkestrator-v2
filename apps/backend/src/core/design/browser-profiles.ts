import type { Stats } from "node:fs";
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
 *
 * Each launch also needs an artifacts directory (downloads, traces, video).
 * Left to itself Playwright makes `playwright-artifacts-*` beside the profile,
 * which is off Chromium's command line and so cannot be recorded (0830). The
 * ledger makes one inside its own directory instead, named for this backend,
 * and removes it with the record.
 */

/** How long a recorded profile is kept after its last change once its backend and browser have exited. */
export const DESIGN_PROFILE_STALE_MS = 60 * 60_000;
/** Exactly what Playwright's `mkdtemp` makes; a record naming anything else is ignored. */
const PROFILE_NAME = /^playwright_chromiumdev_profile-[A-Za-z0-9]{6}$/;
const RECORD_NAME = /^[1-9]\d*-[1-9]\d*-[0-9a-f]{8}\.json$/;
const PARTIAL_RECORD_NAME = /^[1-9]\d*-[1-9]\d*-[0-9a-f]{8}\.json\.[0-9a-f]{8}\.tmp$/;
/** `artifacts-<backend pid>-<random>`, directly inside the ledger directory. */
const ARTIFACTS_NAME = /^artifacts-([1-9]\d*)-[0-9a-f]{8}$/;
const USER_DATA_DIR_ARG = "--user-data-dir=";

interface ProcessRecord {
  pid: number;
  start: string | null;
}

interface ProfileRecord {
  profile: string;
  /** The launch's artifacts directory, when the ledger made one (absent in older records). */
  artifacts?: string;
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
  inspectProfile?: (profile: string) => Promise<Stats>;
  isProcessAlive?: (pid: number) => boolean;
  processStartIdentity?: (pid: number) => string | null;
  /** Command lines of live processes, or `null` when unreadable (every profile then counts as in use). */
  liveCommandLines?: () => Promise<string | null>;
}

export class DesignProfileLedger {
  private readonly now: () => number;
  private readonly inspectProfile: (profile: string) => Promise<Stats>;
  private readonly alive: (pid: number) => boolean;
  private readonly identity: (pid: number) => string | null;
  private readonly commandLines: () => Promise<string | null>;
  private backendStart: string | null | undefined;

  constructor(
    readonly dir: string,
    options: DesignProfileLedgerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.inspectProfile = options.inspectProfile ?? lstat;
    this.alive = options.isProcessAlive ?? isProcessAlive;
    this.identity = options.processStartIdentity ?? processStartIdentity;
    this.commandLines = options.liveCommandLines ?? readLiveCommandLines;
  }

  /**
   * Makes the artifacts directory for one browser launch, to pass to Playwright
   * as `artifactsDir`. Returns `undefined` when it cannot, and Playwright then
   * makes its own in the temporary directory as before. Never throws.
   */
  async createArtifactsDir(): Promise<string | undefined> {
    const target = path.join(
      path.resolve(this.dir),
      `artifacts-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await mkdir(target, { mode: 0o700 });
      return target;
    } catch {
      return undefined;
    }
  }

  /**
   * Removes an artifacts directory no record holds: its launch failed, or its
   * record could not be written. Never throws.
   */
  async discardArtifactsDir(artifacts: string | undefined): Promise<void> {
    if (!artifacts || !this.isArtifactsPath(artifacts)) return;
    await rm(artifacts, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Records the profile of a browser this backend launched, with the artifacts
   * directory it was given, and returns the record's path, or `null` when there
   * is nothing to record. Never throws: a missing record only means a later
   * backend leaves that profile alone.
   */
  async record(
    browserPid: number | undefined,
    profile: string | undefined,
    artifacts?: string,
  ): Promise<string | null> {
    if (!browserPid || !profile || !isProfilePath(profile)) return null;
    this.backendStart ??= this.identity(process.pid);
    const record: ProfileRecord = {
      profile,
      ...(artifacts && this.isArtifactsPath(artifacts) ? { artifacts } : {}),
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
   * Drops a record, and its artifacts directory, once its browser has exited
   * and Playwright has removed the profile. A profile that is still there keeps
   * both for startup recovery. Never throws.
   */
  async release(recordPath: string | null): Promise<void> {
    if (!recordPath) return;
    try {
      const record = this.parseRecord(await readFile(recordPath, "utf8"));
      if (record && (await this.profileInfo(record.profile))?.isDirectory()) return;
      await this.removeArtifacts(record);
      await rm(recordPath, { force: true });
    } catch {
      // Left for startup recovery.
    }
  }

  /**
   * Startup recovery. Removes recorded profiles whose backend and browser have
   * both exited, that have not changed for `maxAgeMs`, and that no live process
   * names on its command line, each with its artifacts directory. Then removes
   * artifacts directories no record holds, once their backend has exited and
   * they have not changed for `maxAgeMs`. Never throws; returns the removed
   * profiles.
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
    const heldArtifacts = new Set<string>();
    // A record that could not be read may hold any artifacts directory.
    let unreadRecord = false;
    for (const name of names) {
      if (PARTIAL_RECORD_NAME.test(name)) {
        await this.removeAbandonedPartial(path.join(this.dir, name), maxAgeMs);
        continue;
      }
      if (!RECORD_NAME.test(name)) continue;
      const recordPath = path.join(this.dir, name);
      let record: ProfileRecord | null = null;
      try {
        record = this.parseRecord(await readFile(recordPath, "utf8"));
        // A record that names nothing removable is dropped, never acted on.
        if (!record) {
          await rm(recordPath, { force: true });
          continue;
        }
        if (this.isAlive(record.backend) || this.isAlive(record.browser)) {
          if (record.artifacts) heldArtifacts.add(record.artifacts);
          continue;
        }
        const info = await this.profileInfo(record.profile);
        if (!info || !info.isDirectory()) {
          await this.removeArtifacts(record);
          await rm(recordPath, { force: true });
          continue;
        }
        if (this.now() - info.mtimeMs <= maxAgeMs) {
          if (record.artifacts) heldArtifacts.add(record.artifacts);
          continue;
        }
        commandLines ??= this.commandLines().catch(() => null);
        const lines = await commandLines;
        if (lines === null || lines.includes(record.profile)) {
          if (record.artifacts) heldArtifacts.add(record.artifacts);
          continue;
        }
        await rm(record.profile, { recursive: true, force: true });
        await this.removeArtifacts(record);
        await rm(recordPath, { force: true });
        removed.push(record.profile);
      } catch {
        // Retried at the next start; until then its artifacts stay held.
        if (record?.artifacts) heldArtifacts.add(record.artifacts);
        else unreadRecord = true;
      }
    }
    if (!unreadRecord) await this.removeUnheldArtifacts(names, heldArtifacts, maxAgeMs);
    return removed;
  }

  /**
   * An artifacts directory whose launch never wrote a record: the backend was
   * killed during launch, or the record write failed. Only its own backend
   * could still be using it, so it goes once that backend has exited.
   */
  private async removeUnheldArtifacts(
    names: readonly string[],
    held: ReadonlySet<string>,
    maxAgeMs: number,
  ): Promise<void> {
    for (const name of names) {
      const owner = ARTIFACTS_NAME.exec(name)?.[1];
      const artifacts = path.join(path.resolve(this.dir), name);
      if (!owner || held.has(artifacts) || this.alive(Number(owner))) continue;
      const info = await lstat(artifacts).catch(() => null);
      if (!info?.isDirectory() || this.now() - info.mtimeMs <= maxAgeMs) continue;
      await rm(artifacts, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async removeArtifacts(record: ProfileRecord | null): Promise<void> {
    if (record?.artifacts) await rm(record.artifacts, { recursive: true, force: true });
  }

  private isArtifactsPath(candidate: string): boolean {
    return (
      path.dirname(candidate) === path.resolve(this.dir) &&
      ARTIFACTS_NAME.test(path.basename(candidate))
    );
  }

  private parseRecord(text: string): ProfileRecord | null {
    const record = parseRecord(text);
    // An artifacts path outside this ledger is never acted on.
    if (record?.artifacts !== undefined && !this.isArtifactsPath(record.artifacts)) return null;
    return record;
  }

  /** Only confirmed absence permits dropping ownership; other errors retry later. */
  private async profileInfo(profile: string): Promise<Stats | null> {
    try {
      return await this.inspectProfile(profile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
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
    if (value.artifacts !== undefined && typeof value.artifacts !== "string") return null;
    return {
      profile: value.profile,
      ...(value.artifacts !== undefined ? { artifacts: value.artifacts } : {}),
      backend: value.backend,
      browser: value.browser,
    };
  } catch {
    return null;
  }
}
