import { readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { isOpaquePreviewId } from "@orkestrator/protocol/preview-services";

import { previewServicePartitionSuffix } from "./preview-transport-manager.js";

const SERVICE_PARTITION = /^orkestrator-preview-svc-\d{1,3}-([0-9a-f]{16})-([0-9a-f]{16})$/;
const SHARED_PARTITION = /^orkestrator-browser-previews-\d{1,3}-([0-9a-f]{16})$/;
/** Partitions cleared per pass; the rest wait for the next pass. */
const MAX_CLEARED_PER_PASS = 64;
/** Directory removals remembered for the next start. */
const MAX_PENDING = 1024;

/** The part of an Electron session retention needs (injectable in tests). */
export interface RetainedPartitionSession {
  clearStorageData(): Promise<void>;
  clearCache?(): Promise<void>;
}

export interface PreviewPartitionFs {
  readdir(directory: string): Promise<string[]>;
  rm(target: string): Promise<void>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, contents: string): Promise<void>;
}

export interface PreviewPartitionRetentionOptions {
  /** `<userData>/Partitions`, where Electron keeps `persist:` partitions. */
  partitionsDir: string;
  /** Directory removals deferred to the next start, before any session exists. */
  pendingFile: string;
  sessionFor(partition: string): RetainedPartitionSession;
  /** `persist:` partition names a live window or transport still holds. */
  inUse(): Iterable<string>;
  fs?: PreviewPartitionFs;
  logger?: Pick<Console, "warn">;
}

/** A source of the authoritative service list for one window's connection. */
export interface PreviewServiceListSource {
  listServices(): Promise<unknown>;
  readonly closed: boolean;
}

const nodeFs: PreviewPartitionFs = {
  readdir: (directory) => readdir(directory),
  rm: (target) => rm(target, { recursive: true, force: true }),
  readFile: (file) => readFile(file, "utf8"),
  async writeFile(file, contents) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, file);
  },
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The service partition suffixes a full, unfiltered `get_preview_services`
 * snapshot keeps alive, or null when the snapshot cannot be trusted as the
 * complete list (an environment filter, a not-modified reply, a bad shape).
 */
export function liveServicePartitionSuffixes(snapshot: unknown): Set<string> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  if (value.notModified !== false || value.environmentId !== null) return null;
  if (typeof value.backendInstanceId !== "string" || !isOpaquePreviewId(value.backendInstanceId))
    return null;
  if (!Array.isArray(value.services)) return null;
  const suffixes = new Set<string>();
  for (const service of value.services) {
    const serviceId = (service as { definition?: { serviceId?: unknown } } | null)?.definition
      ?.serviceId;
    if (typeof serviceId !== "string" || !isOpaquePreviewId(serviceId)) return null;
    suffixes.add(
      previewServicePartitionSuffix({ backendInstanceId: value.backendInstanceId, serviceId }),
    );
  }
  return suffixes;
}

/**
 * Ends preview partitions nothing can use again: a removed service's
 * partition, and every preview partition of a forgotten connection. The
 * backend knows nothing about client partitions, so Electron owns this.
 *
 * A partition is cleared through its Electron session at once (cookies,
 * storage, service workers, caches), then its directory is removed on the
 * next start, before any session for it can exist. A partition a live
 * transport or window holds is never touched; a later pass gets it.
 */
export class PreviewPartitionRetention {
  private readonly fs: PreviewPartitionFs;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PreviewPartitionRetentionOptions) {
    this.fs = options.fs ?? nodeFs;
  }

  /** Remove directories cleared in an earlier run. Call before any preview session exists. */
  sweepPending(): Promise<string[]> {
    return this.serialize(async () => {
      const pending = await this.readPending();
      if (!pending.length) return [];
      const removed: string[] = [];
      const failed: string[] = [];
      for (const name of pending) {
        // Only ever names this install created; never a path from the file.
        if (!SERVICE_PARTITION.test(name) && !SHARED_PARTITION.test(name)) continue;
        try {
          await this.fs.rm(path.join(this.options.partitionsDir, name));
          removed.push(name);
        } catch {
          failed.push(name);
        }
      }
      if (failed.length) this.warn("[Previews] Failed to remove cleared preview partitions.");
      await this.writePending(failed);
      return removed;
    });
  }

  /** Every preview partition of a connection this device forgot (all window slots). */
  forgetConnection(connectionKey: string, options: { includeShared: boolean }): Promise<string[]> {
    return this.serialize(async () => {
      const names = (await this.listPartitions()).filter((name) => {
        const service = SERVICE_PARTITION.exec(name);
        if (service) return service[1] === connectionKey;
        const shared = SHARED_PARTITION.exec(name);
        return options.includeShared && shared?.[1] === connectionKey;
      });
      return this.clear(names);
    });
  }

  /**
   * Service partitions of one connection (all window slots) whose service is
   * gone from the backend's full list. Directories are listed before the list
   * is fetched, so a partition created meanwhile is never a candidate, and
   * service ids are never reused.
   */
  reconcileServices(connectionKey: string, source: PreviewServiceListSource): Promise<string[]> {
    return this.serialize(async () => {
      const candidates = (await this.listPartitions()).filter(
        (name) => SERVICE_PARTITION.exec(name)?.[1] === connectionKey,
      );
      if (!candidates.length || source.closed) return [];
      let live: Set<string> | null;
      try {
        live = liveServicePartitionSuffixes(await source.listServices());
      } catch {
        // Older, unreachable or over-bound backends keep their partitions.
        return [];
      }
      if (!live || source.closed) return [];
      return this.clear(candidates.filter((name) => !live.has(SERVICE_PARTITION.exec(name)![2]!)));
    });
  }

  /**
   * Reconcile a window transport's connection shortly after it starts and
   * then periodically, until the transport closes (a switch or window close).
   */
  schedule(
    connectionKey: string,
    source: PreviewServiceListSource,
    timing: { delayMs: number; intervalMs: number },
  ): void {
    let interval: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (source.closed) {
        if (interval) clearInterval(interval);
        return;
      }
      void this.reconcileServices(connectionKey, source).catch(() => undefined);
    };
    const first = setTimeout(() => {
      run();
      if (source.closed) return;
      interval = setInterval(run, timing.intervalMs);
      interval.unref?.();
    }, timing.delayMs);
    first.unref?.();
  }

  private async clear(names: string[]): Promise<string[]> {
    const held = new Set(this.options.inUse());
    // Already cleared this run or before; their directories go on the next start.
    const pending = new Set(await this.readPending());
    const cleared: string[] = [];
    for (const name of names) {
      if (cleared.length >= MAX_CLEARED_PER_PASS) break;
      const partition = `persist:${name}`;
      if (held.has(partition) || pending.has(name)) continue;
      try {
        const session = this.options.sessionFor(partition);
        await session.clearStorageData();
        await session.clearCache?.();
        cleared.push(name);
      } catch {
        this.warn("[Previews] Failed to clear a preview partition.");
      }
    }
    if (cleared.length) {
      for (const name of cleared) pending.add(name);
      await this.writePending(Array.from(pending).slice(-MAX_PENDING));
    }
    return cleared;
  }

  private async listPartitions(): Promise<string[]> {
    try {
      return await this.fs.readdir(this.options.partitionsDir);
    } catch (error) {
      if (!isMissing(error)) this.warn("[Previews] Failed to list preview partitions.");
      return [];
    }
  }

  private async readPending(): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse(await this.fs.readFile(this.options.pendingFile));
      return Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === "string").slice(-MAX_PENDING)
        : [];
    } catch {
      return [];
    }
  }

  private async writePending(names: string[]): Promise<void> {
    try {
      await this.fs.writeFile(this.options.pendingFile, `${JSON.stringify(names)}\n`);
    } catch {
      // The partitions are already cleared; only their empty directories stay.
      this.warn("[Previews] Failed to record cleared preview partitions.");
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private warn(message: string): void {
    (this.options.logger ?? console).warn(message);
  }
}
