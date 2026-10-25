import { readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { isBackendId } from "@orkestrator/protocol/federation";
import { isOpaquePreviewId } from "@orkestrator/protocol/preview-services";

import { connectionPartitionKey } from "./desktop-window-lifecycle.js";
import { previewServicePartitionSuffix } from "./preview-transport-manager.js";

const SERVICE_PARTITION = /^orkestrator-preview-svc-\d{1,3}-([0-9a-f]{16})-([0-9a-f]{16})$/;
const SHARED_PARTITION = /^orkestrator-browser-previews-\d{1,3}-([0-9a-f]{16})$/;
/** Partitions cleared per pass; the rest wait for the next pass. */
const MAX_CLEARED_PER_PASS = 64;
/** Directory removals remembered for the next start. */
const MAX_PENDING = 1024;
/** Command connections remembered per node. */
const MAX_COMMANDS_PER_NODE = 8;

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
  retryMs?: number;
}

/** A source of the authoritative service list for one window's connection. */
export interface PreviewServiceListSource {
  listServices(): Promise<unknown>;
  /** The connection's node registry (`list_nodes`), when it may be a command node. */
  listNodes?(): Promise<unknown>;
  readonly closed: boolean;
}

/** A node reached through command nodes, and the command connections that list it. */
interface NodeEntry {
  key: string;
  commands: string[];
}

const PARTITION_KEY = /^[0-9a-f]{16}$/;

/** Partition key of a node's previews (`node:<id>`, as `createWindowBrowserPreviews` names them). */
export function nodePartitionKey(nodeId: string): string {
  return connectionPartitionKey(`node:${nodeId}`);
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

/** The connection or node key a preview partition directory belongs to. */
function partitionKeyOf(name: string): string | undefined {
  return SERVICE_PARTITION.exec(name)?.[1] ?? SHARED_PARTITION.exec(name)?.[1];
}

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
 * The node partition keys a command node's full `list_nodes` reply keeps
 * alive, or null when the reply cannot be trusted as its complete registry
 * (a bad shape, or a leaf whose registry is suspended).
 */
export function liveNodePartitionKeys(list: unknown): Set<string> | null {
  if (!list || typeof list !== "object") return null;
  const value = list as Record<string, unknown>;
  if (typeof value.revision !== "number" || value.suspended !== false) return null;
  if (!Array.isArray(value.nodes)) return null;
  const keys = new Set<string>();
  for (const node of value.nodes) {
    const nodeId = (node as { nodeId?: unknown } | null)?.nodeId;
    if (!isBackendId(nodeId)) return null;
    keys.add(nodePartitionKey(nodeId));
  }
  return keys;
}

/** Authoritative holdings across every window, including its shared legacy session. */
export function previewPartitionsInUse(
  windows: Iterable<{
    sharedPartition: string;
    transport: { partitionsInUse(): Iterable<string> };
  }>,
): Set<string> {
  const held = new Set<string>();
  for (const window of windows) {
    held.add(window.sharedPartition);
    for (const partition of window.transport.partitionsInUse()) held.add(partition);
  }
  return held;
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
  private retry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private retryOffset = 0;
  private readonly schedules = new Set<() => void>();

  constructor(private readonly options: PreviewPartitionRetentionOptions) {
    this.fs = options.fs ?? nodeFs;
  }

  /** Remove directories cleared in an earlier run. Call before any preview session exists. */
  sweepPending(): Promise<string[]> {
    return this.serialize(async () => {
      const forgotten = await this.readForgotten();
      const names = await this.listPartitions();
      const clearedBefore = new Set(await this.readPending());
      const pending = Array.from(
        new Set([...clearedBefore, ...names.filter((name) => this.isForgotten(name, forgotten))]),
      );
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
      // A failed directory removal does not prove its site data was cleared.
      // Only keep prior positive clears here; forgotten intent retries the rest.
      await this.writePending(failed.filter((name) => clearedBefore.has(name)));
      // Retain whole-connection intent even when more directories failed than
      // fit in the bounded per-directory journal.
      const remaining = names.filter((name) => !removed.includes(name));
      await this.writeForgotten(
        forgotten.filter((entry) => remaining.some((name) => this.isForgotten(name, [entry]))),
      );
      if (failed.length) this.scheduleForgotten();
      return removed;
    });
  }

  /** Every preview partition of a connection this device forgot (all window slots). */
  forgetConnection(connectionKey: string, options: { includeShared: boolean }): Promise<string[]> {
    return this.serialize(async () => {
      if (!PARTITION_KEY.test(connectionKey)) throw new Error("Invalid connection key");
      const forget = [{ key: connectionKey, includeShared: options.includeShared }];
      // Nodes this device reached only through the forgotten command node go too.
      const nodes = await this.readNodes();
      const orphaned: string[] = [];
      for (const entry of nodes) {
        if (!entry.commands.includes(connectionKey)) continue;
        entry.commands = entry.commands.filter((command) => command !== connectionKey);
        if (!entry.commands.length) orphaned.push(entry.key);
      }
      for (const key of orphaned) forget.push({ key, includeShared: true });
      const cleared = await this.forgetKeys(forget);
      await this.writeNodes(nodes.filter((entry) => entry.commands.length));
      return cleared;
    });
  }

  /**
   * Record that a window reached a node through a command connection. A node
   * seen again after it was forgotten keeps its new site data: its key leaves
   * the forgotten and pending journals, so no later start removes it.
   */
  rememberNode(nodeKey: string, commandKey: string): Promise<void> {
    return this.serialize(async () => {
      if (!PARTITION_KEY.test(nodeKey) || !PARTITION_KEY.test(commandKey))
        throw new Error("Invalid partition key");
      const nodes = await this.readNodes();
      const entry = nodes.find((candidate) => candidate.key === nodeKey);
      if (entry) {
        if (entry.commands.includes(commandKey)) return;
        if (entry.commands.length >= MAX_COMMANDS_PER_NODE) entry.commands.shift();
        entry.commands.push(commandKey);
      } else {
        if (nodes.length >= MAX_PENDING) nodes.shift();
        nodes.push({ key: nodeKey, commands: [commandKey] });
      }
      await this.writeNodes(nodes);
      const forgotten = await this.readForgotten();
      if (forgotten.some((candidate) => candidate.key === nodeKey))
        await this.writeForgotten(forgotten.filter((candidate) => candidate.key !== nodeKey));
      const pending = await this.readPending();
      const kept = pending.filter((name) => partitionKeyOf(name) !== nodeKey);
      if (kept.length !== pending.length) await this.writePending(kept);
    });
  }

  /**
   * A command handover moved nodes from one command node to another: the
   * target now vouches for every node the source did, so the source dropping
   * them from its registry is not a removal.
   */
  transferNodes(fromCommandKey: string, toCommandKey: string): Promise<void> {
    return this.serialize(async () => {
      if (!PARTITION_KEY.test(fromCommandKey) || !PARTITION_KEY.test(toCommandKey))
        throw new Error("Invalid partition key");
      const nodes = await this.readNodes();
      let changed = false;
      for (const entry of nodes) {
        if (!entry.commands.includes(fromCommandKey) || entry.commands.includes(toCommandKey))
          continue;
        if (entry.commands.length >= MAX_COMMANDS_PER_NODE) entry.commands.shift();
        entry.commands.push(toCommandKey);
        changed = true;
      }
      if (changed) await this.writeNodes(nodes);
    });
  }

  /**
   * Serialize admission and remote handover with reconciliation/forgetting.
   * A pending list must finish before the remote registry can change. Target
   * vouchers are durable before sending; retain them on an unknown RPC outcome
   * until an authoritative target registry can establish removal.
   */
  handoverNodes<T>(
    fromCommandKey: string,
    toCommandKey: string,
    nodeKeys: string[] | undefined,
    handover: () => Promise<T>,
  ): Promise<T> {
    return this.serialize(async () => {
      if (
        ![fromCommandKey, toCommandKey, ...(nodeKeys ?? [])].every((key) => PARTITION_KEY.test(key))
      )
        throw new Error("Invalid partition key");
      const nodes = await this.readNodes();
      for (const entry of nodes) {
        if (
          (nodeKeys && !nodeKeys.includes(entry.key)) ||
          !entry.commands.includes(fromCommandKey) ||
          entry.commands.includes(toCommandKey)
        )
          continue;
        if (entry.commands.length >= MAX_COMMANDS_PER_NODE) entry.commands.shift();
        entry.commands.push(toCommandKey);
      }
      // Unlike best-effort bookkeeping, admission must succeed before the RPC.
      await this.fs.writeFile(`${this.options.pendingFile}.nodes`, `${JSON.stringify(nodes)}\n`);
      return handover();
    });
  }

  /**
   * Node partitions whose node every command connection that listed it has
   * since removed from its registry. A command node that is unreachable,
   * suspended or answers with anything but its full registry vouches as
   * before. Nodes seen through no other command node are then forgotten like
   * a connection: service and shared partitions in every window slot.
   */
  reconcileNodes(
    commandKey: string,
    source: { listNodes(): Promise<unknown>; readonly closed: boolean },
  ): Promise<string[]> {
    return this.serialize(async () => {
      const vouched = (await this.readNodes()).filter((entry) =>
        entry.commands.includes(commandKey),
      );
      if (!vouched.length || source.closed) return [];
      let live: Set<string> | null;
      try {
        live = liveNodePartitionKeys(await source.listNodes());
      } catch {
        // Not a command node, older, or unreachable: no evidence of removal.
        return [];
      }
      if (!live || source.closed || this.disposed) return [];
      // Re-read: a node remembered while the list was fetched keeps its voucher.
      const nodes = await this.readNodes();
      const removed: string[] = [];
      for (const entry of nodes) {
        if (!entry.commands.includes(commandKey) || live.has(entry.key)) continue;
        if (!vouched.some((candidate) => candidate.key === entry.key)) continue;
        entry.commands = entry.commands.filter((command) => command !== commandKey);
        if (!entry.commands.length) removed.push(entry.key);
      }
      const cleared = removed.length
        ? await this.forgetKeys(removed.map((key) => ({ key, includeShared: true })))
        : [];
      await this.writeNodes(nodes.filter((entry) => entry.commands.length));
      return cleared;
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
      if (!live || source.closed || this.disposed) return [];
      return this.clear(candidates.filter((name) => !live.has(SERVICE_PARTITION.exec(name)![2]!)));
    });
  }

  /**
   * Reconcile a window transport's connection shortly after it starts and
   * then periodically, until the transport closes (a switch or window close):
   * its services, and the nodes reached through it when it is a command node.
   */
  schedule(
    connectionKey: string,
    source: PreviewServiceListSource,
    timing: { delayMs: number; intervalMs: number },
  ): () => void {
    if (this.disposed) return () => undefined;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
      this.schedules.delete(stop);
    };
    const run = () => {
      if (source.closed || this.disposed) {
        stop();
        return;
      }
      void this.reconcileServices(connectionKey, source).catch(() => undefined);
      const listNodes = source.listNodes?.bind(source);
      if (listNodes)
        void this.reconcileNodes(connectionKey, {
          listNodes,
          get closed() {
            return source.closed;
          },
        }).catch(() => undefined);
    };
    const first = setTimeout(() => {
      run();
      if (source.closed || this.disposed) return;
      interval = setInterval(run, timing.intervalMs);
      interval.unref?.();
    }, timing.delayMs);
    this.schedules.add(stop);
    first.unref?.();
    return stop;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const stop of Array.from(this.schedules)) stop();
  }

  /** Durable forget intent for each key, then a clear pass. Call only inside `serialize`. */
  private async forgetKeys(entries: Array<{ key: string; includeShared: boolean }>) {
    const forgotten = await this.readForgotten();
    for (const { key, includeShared } of entries) {
      const existing = forgotten.find((entry) => entry.key === key);
      if (existing) existing.includeShared ||= includeShared;
      else {
        if (forgotten.length >= MAX_PENDING) throw new Error("Preview cleanup capacity exceeded");
        forgotten.push({ key, includeShared });
      }
    }
    // Admission is durable before clearing anything. A restart can finish
    // even if no transport for this connection will ever exist again.
    await this.writeForgotten(forgotten);
    try {
      return await this.clear(
        (await this.listPartitions()).filter((name) => this.isForgotten(name, forgotten)),
      );
    } finally {
      this.scheduleForgotten();
    }
  }

  private async readNodes(): Promise<NodeEntry[]> {
    try {
      const value: unknown = JSON.parse(
        await this.fs.readFile(`${this.options.pendingFile}.nodes`),
      );
      if (!Array.isArray(value)) return [];
      return value
        .filter(
          (entry): entry is NodeEntry =>
            !!entry &&
            typeof entry.key === "string" &&
            PARTITION_KEY.test(entry.key) &&
            Array.isArray(entry.commands),
        )
        .map((entry) => ({
          key: entry.key,
          commands: entry.commands
            .filter((command): command is string => typeof command === "string")
            .filter((command) => PARTITION_KEY.test(command))
            .slice(-MAX_COMMANDS_PER_NODE),
        }))
        .filter((entry) => entry.commands.length)
        .slice(-MAX_PENDING);
    } catch {
      // A missing or unreadable journal only means no node is remembered yet.
      return [];
    }
  }

  private async writeNodes(nodes: NodeEntry[]): Promise<void> {
    try {
      await this.fs.writeFile(`${this.options.pendingFile}.nodes`, `${JSON.stringify(nodes)}\n`);
    } catch {
      this.warn("[Previews] Failed to record preview nodes.");
    }
  }

  private isForgotten(
    name: string,
    entries: Array<{ key: string; includeShared: boolean }>,
  ): boolean {
    const service = SERVICE_PARTITION.exec(name);
    const shared = SHARED_PARTITION.exec(name);
    return entries.some(
      (entry) => service?.[1] === entry.key || (entry.includeShared && shared?.[1] === entry.key),
    );
  }

  private async readForgotten(): Promise<Array<{ key: string; includeShared: boolean }>> {
    try {
      const value: unknown = JSON.parse(
        await this.fs.readFile(`${this.options.pendingFile}.forgotten`),
      );
      if (!Array.isArray(value) || value.length > MAX_PENDING)
        throw new Error("Invalid cleanup journal");
      return value.filter(
        (entry) =>
          entry && /^[0-9a-f]{16}$/.test(entry.key) && typeof entry.includeShared === "boolean",
      );
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private writeForgotten(entries: Array<{ key: string; includeShared: boolean }>): Promise<void> {
    return this.fs.writeFile(
      `${this.options.pendingFile}.forgotten`,
      `${JSON.stringify(entries)}\n`,
    );
  }

  private scheduleForgotten(): void {
    if (this.disposed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.serialize(async () => {
        const forgotten = await this.readForgotten();
        const pending = new Set(await this.readPending());
        const names = (await this.listPartitions()).filter(
          (name) => this.isForgotten(name, forgotten) && !pending.has(name),
        );
        if (!names.length) return;
        const offset = this.retryOffset % names.length;
        await this.clear([...names.slice(offset), ...names.slice(0, offset)]);
        this.retryOffset += MAX_CLEARED_PER_PASS;
        this.scheduleForgotten();
      }).catch(() => {
        this.warn("[Previews] Failed to retry forgotten preview cleanup.");
        this.scheduleForgotten();
      });
    }, this.options.retryMs ?? 1_000);
    this.retry.unref?.();
  }

  private async clear(names: string[]): Promise<string[]> {
    const held = new Set(this.options.inUse());
    // Already cleared this run or before; their directories go on the next start.
    const pending = new Set(await this.readPending());
    const cleared: string[] = [];
    let attempted = 0;
    for (const name of names) {
      if (attempted >= MAX_CLEARED_PER_PASS || pending.size + cleared.length >= MAX_PENDING) break;
      const partition = `persist:${name}`;
      if (held.has(partition) || pending.has(name)) continue;
      attempted += 1;
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
      if (!isMissing(error)) throw error;
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
