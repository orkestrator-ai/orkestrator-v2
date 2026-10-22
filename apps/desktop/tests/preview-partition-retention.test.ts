import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  browserPreviewPartitionForWindow,
  browserPreviewServicePartition,
  connectionPartitionKey,
} from "../electron/desktop-window-lifecycle";
import {
  liveServicePartitionSuffixes,
  PreviewPartitionRetention,
  previewPartitionsInUse,
  type PreviewPartitionFs,
  type PreviewServiceListSource,
} from "../electron/preview-partition-retention";

const BACKEND = "backend-instance-1";
const PARTITIONS = "/profile/Partitions";
const PENDING = "/profile/preview-partitions-pending.json";

function dirName(partition: string): string {
  return partition.replace(/^persist:/, "");
}

function servicePartition(slot: number, connectionId: string, serviceId: string): string {
  return browserPreviewServicePartition(slot, connectionId, {
    backendInstanceId: BACKEND,
    serviceId,
  });
}

function snapshot(serviceIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    backendInstanceId: BACKEND,
    backendEpoch: "epoch-1",
    registryRevision: 7,
    environmentId: null,
    notModified: false,
    services: serviceIds.map((serviceId) => ({ definition: { serviceId }, endpoint: {} })),
    tombstones: [],
    tombstoneFloor: 0,
    ...overrides,
  };
}

class MemoryFs implements PreviewPartitionFs {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();
  readonly removed: string[] = [];
  failRemove = new Set<string>();

  async readdir(directory: string): Promise<string[]> {
    if (directory !== PARTITIONS) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Array.from(this.directories);
  }

  async rm(target: string): Promise<void> {
    const name = path.relative(PARTITIONS, target);
    if (this.failRemove.has(name)) throw new Error("busy");
    this.removed.push(target);
    this.directories.delete(name);
  }

  async readFile(file: string): Promise<string> {
    const contents = this.files.get(file);
    if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return contents;
  }

  async writeFile(file: string, contents: string): Promise<void> {
    this.files.set(file, contents);
  }

  pending(): string[] {
    return JSON.parse(this.files.get(PENDING) ?? "[]") as string[];
  }
}

const retentions: PreviewPartitionRetention[] = [];
afterEach(() => {
  for (const retention of retentions.splice(0)) retention.dispose();
});

function setup(options: { held?: string[] } = {}) {
  const fs = new MemoryFs();
  const cleared: string[] = [];
  const warn = mock(() => undefined);
  const held = new Set(options.held ?? []);
  const retention = new PreviewPartitionRetention({
    retryMs: 5,
    partitionsDir: PARTITIONS,
    pendingFile: PENDING,
    sessionFor: (partition) => ({
      clearStorageData: async () => {
        cleared.push(partition);
      },
      clearCache: async () => undefined,
    }),
    inUse: () => held,
    fs,
    logger: { warn },
  });
  retentions.push(retention);
  return { fs, cleared, held, retention, warn };
}

function source(list: () => Promise<unknown>): PreviewServiceListSource & { closed: boolean } {
  return { closed: false, listServices: list };
}

describe("liveServicePartitionSuffixes", () => {
  test("hashes every service of a full, unfiltered snapshot", () => {
    const suffixes = liveServicePartitionSuffixes(snapshot(["svc-alpha", "svc-bravo"]));
    expect(suffixes).toEqual(
      new Set(
        ["svc-alpha", "svc-bravo"].map((serviceId) =>
          servicePartition(1, "local", serviceId).slice(-16),
        ),
      ),
    );
  });

  test("refuses anything that is not the complete list", () => {
    expect(liveServicePartitionSuffixes(null)).toBeNull();
    expect(liveServicePartitionSuffixes("list")).toBeNull();
    expect(liveServicePartitionSuffixes(snapshot([], { environmentId: "env-1" }))).toBeNull();
    expect(liveServicePartitionSuffixes(snapshot([], { notModified: true }))).toBeNull();
    expect(liveServicePartitionSuffixes(snapshot([], { backendInstanceId: "../x" }))).toBeNull();
    expect(liveServicePartitionSuffixes(snapshot([], { services: "none" }))).toBeNull();
    expect(
      liveServicePartitionSuffixes(snapshot([], { services: [{ definition: {} }] })),
    ).toBeNull();
  });
});

describe("PreviewPartitionRetention", () => {
  test("derives current holdings across windows and transports, including shared sessions", async () => {
    const first = new Set([servicePartition(1, "remote", "svc-a")]);
    const second = new Set([servicePartition(2, "local", "svc-b")]);
    const windows = [
      {
        sharedPartition: browserPreviewPartitionForWindow(1, "remote"),
        transport: { partitionsInUse: () => first },
      },
      {
        sharedPartition: browserPreviewPartitionForWindow(2, "local"),
        transport: { partitionsInUse: () => second },
      },
    ];
    expect(previewPartitionsInUse(windows)).toEqual(
      new Set([...first, ...second, windows[0]!.sharedPartition, windows[1]!.sharedPartition]),
    );
    const { fs, retention, cleared, held } = setup();
    for (const partition of previewPartitionsInUse(windows)) {
      held.add(partition);
      fs.directories.add(dirName(partition));
    }
    const key = connectionPartitionKey("remote");
    expect(await retention.forgetConnection(key, { includeShared: true })).toEqual([]);
    windows.shift(); // The remote window closes while Local keeps working.
    held.clear();
    for (const partition of previewPartitionsInUse(windows)) held.add(partition);
    const deadline = Date.now() + 1_000;
    while (cleared.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(cleared).toHaveLength(2);
    expect(cleared.every((partition) => !held.has(partition))).toBe(true);
  });

  test("clears partitions of removed services on that connection, in every window slot", async () => {
    const { fs, cleared, retention } = setup();
    const kept = servicePartition(1, "local", "svc-live");
    const goneSlot1 = servicePartition(1, "local", "svc-gone");
    const goneSlot2 = servicePartition(2, "local", "svc-gone");
    const otherConnection = servicePartition(1, "remote-1", "svc-gone");
    const shared = browserPreviewPartitionForWindow(1, "local");
    for (const name of [kept, goneSlot1, goneSlot2, otherConnection, shared, "orkestrator-panel-x"])
      fs.directories.add(dirName(name));

    const result = await retention.reconcileServices(
      connectionPartitionKey("local"),
      source(async () => snapshot(["svc-live"])),
    );

    expect(result.sort()).toEqual([dirName(goneSlot1), dirName(goneSlot2)].sort());
    expect(cleared.sort()).toEqual([goneSlot1, goneSlot2].sort());
    expect(fs.pending().sort()).toEqual(result.sort());
    // Nothing is removed from disk while this process may hold the session.
    expect(fs.removed).toEqual([]);
  });

  test("never clears a partition a live transport holds", async () => {
    const gone = servicePartition(1, "local", "svc-gone");
    const { fs, cleared, retention } = setup({ held: [gone] });
    fs.directories.add(dirName(gone));
    expect(
      await retention.reconcileServices(
        connectionPartitionKey("local"),
        source(async () => snapshot([])),
      ),
    ).toEqual([]);
    expect(cleared).toEqual([]);
    expect(fs.files.has(PENDING)).toBe(false);
  });

  test("keeps every partition when the list cannot be trusted or the transport closed", async () => {
    const gone = servicePartition(1, "local", "svc-gone");
    const key = connectionPartitionKey("local");
    for (const list of [
      async () => {
        throw new Error("unsupported");
      },
      async () => snapshot([], { environmentId: "env-1" }),
      async () => snapshot([], { notModified: true }),
      async () => ({ error: "capacity-exceeded" }),
    ]) {
      const { fs, cleared, retention } = setup();
      fs.directories.add(dirName(gone));
      expect(await retention.reconcileServices(key, source(list))).toEqual([]);
      expect(cleared).toEqual([]);
    }

    const { fs, cleared, retention } = setup();
    fs.directories.add(dirName(gone));
    const closing = source(async () => {
      closing.closed = true;
      return snapshot([]);
    });
    expect(await retention.reconcileServices(key, closing)).toEqual([]);
    expect(cleared).toEqual([]);
  });

  test("a partition created while the list is fetched is never a candidate", async () => {
    const { fs, cleared, retention } = setup();
    const old = servicePartition(1, "local", "svc-older");
    const fresh = servicePartition(1, "local", "svc-fresh");
    fs.directories.add(dirName(old));
    await retention.reconcileServices(
      connectionPartitionKey("local"),
      source(async () => {
        // Registered and opened after the directories were listed; a list
        // fetched before that could not include it.
        fs.directories.add(dirName(fresh));
        return snapshot([]);
      }),
    );
    expect(cleared).toEqual([old]);
  });

  test("does not ask the backend when the connection has no service partitions", async () => {
    const { retention } = setup();
    const list = mock(async () => snapshot([]));
    expect(
      await retention.reconcileServices(connectionPartitionKey("local"), source(list)),
    ).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  test("bounds the partitions cleared in one pass", async () => {
    const { fs, cleared, retention } = setup();
    for (let index = 0; index < 70; index += 1)
      fs.directories.add(dirName(servicePartition(1, "local", `svc-item-${index}`)));
    const key = connectionPartitionKey("local");
    expect(
      await retention.reconcileServices(
        key,
        source(async () => snapshot([])),
      ),
    ).toHaveLength(64);
    expect(cleared).toHaveLength(64);
    // Cleared directories stay until the next start; a later pass skips them.
    expect(
      await retention.reconcileServices(
        key,
        source(async () => snapshot([])),
      ),
    ).toHaveLength(6);
    expect(new Set(cleared).size).toBe(70);
    expect(fs.pending()).toHaveLength(70);
  });

  test("a forgotten connection loses its service partitions, and its shared ones once no window uses it", async () => {
    const { fs, cleared, retention } = setup();
    const service1 = servicePartition(1, "remote-1", "svc-alpha");
    const service3 = servicePartition(3, "remote-1", "svc-bravo");
    const shared = browserPreviewPartitionForWindow(2, "remote-1");
    const otherService = servicePartition(1, "remote-2", "svc-alpha");
    const otherShared = browserPreviewPartitionForWindow(1, "local");
    for (const name of [service1, service3, shared, otherService, otherShared])
      fs.directories.add(dirName(name));
    const key = connectionPartitionKey("remote-1");

    expect((await retention.forgetConnection(key, { includeShared: false })).sort()).toEqual(
      [dirName(service1), dirName(service3)].sort(),
    );
    cleared.length = 0;
    expect(await retention.forgetConnection(key, { includeShared: true })).toContain(
      dirName(shared),
    );
    expect(cleared).not.toContain(otherService);
    expect(cleared).not.toContain(otherShared);
  });

  test("the next start removes cleared directories and only names this install creates", async () => {
    const { fs, retention, warn } = setup();
    const gone = dirName(servicePartition(1, "local", "svc-gone"));
    const shared = dirName(browserPreviewPartitionForWindow(1, "remote-1"));
    const busy = dirName(servicePartition(2, "local", "svc-busy"));
    fs.failRemove.add(busy);
    fs.files.set(
      PENDING,
      JSON.stringify([gone, shared, busy, "../../Documents", "orkestrator-renderer-1-abc", 7]),
    );

    expect((await retention.sweepPending()).sort()).toEqual([gone, shared].sort());
    expect(fs.removed.sort()).toEqual(
      [path.join(PARTITIONS, gone), path.join(PARTITIONS, shared)].sort(),
    );
    // A failed removal is retried on the next start; nothing else is kept.
    expect(fs.pending()).toEqual([busy]);
    expect(warn).toHaveBeenCalledWith("[Previews] Failed to remove cleared preview partitions.");
  });

  test("forgotten cleanup drains beyond one pass and retries failures without a transport, then survives restart", async () => {
    const { fs, retention, held } = setup();
    const partitions = Array.from({ length: 140 }, (_, index) =>
      servicePartition(1, "forgotten", `svc-${index}`),
    );
    const shared = browserPreviewPartitionForWindow(1, "forgotten");
    partitions.push(shared);
    const unrelated = servicePartition(1, "kept", "svc-keep");
    for (const partition of [...partitions, unrelated]) fs.directories.add(dirName(partition));
    held.add(partitions[0]!);
    let failures = 2;
    const cleared = new Set<string>();
    const options = {
      partitionsDir: PARTITIONS,
      pendingFile: PENDING,
      fs,
      retryMs: 5,
      inUse: () => held,
      sessionFor: (partition: string) => ({
        clearStorageData: async () => {
          if (partition === partitions[1] && failures-- > 0) throw new Error("busy");
          cleared.add(partition);
        },
      }),
    };
    const active = new PreviewPartitionRetention(options);
    retentions.push(active);
    expect(
      await active.forgetConnection(connectionPartitionKey("forgotten"), { includeShared: true }),
    ).toHaveLength(63);
    held.clear(); // The last window and its transport have gone away.
    const deadline = Date.now() + 2_000;
    while (cleared.size < partitions.length && Date.now() < deadline) await Bun.sleep(5);
    expect(cleared.size).toBe(partitions.length);
    active.dispose();
    retention.dispose();
    // Simulate death after minting intent but before its first successful clear.
    const late = servicePartition(2, "forgotten", "svc-late");
    fs.directories.add(dirName(late));
    const restarted = new PreviewPartitionRetention({
      ...options,
      sessionFor: () => {
        throw new Error("startup must not create a native session");
      },
    });
    retentions.push(restarted);
    expect(await restarted.sweepPending()).toHaveLength(partitions.length + 1);
    expect(Array.from(fs.directories)).toEqual([dirName(unrelated)]);
  });

  test("a failed startup removal of an uncleared forgotten partition still retries the native clear", async () => {
    const { fs, cleared, retention, warn } = setup();
    const gone = servicePartition(1, "forgotten", "svc-failed");
    fs.directories.add(dirName(gone));
    fs.failRemove.add(dirName(gone));
    fs.files.set(
      `${PENDING}.forgotten`,
      JSON.stringify([{ key: connectionPartitionKey("forgotten"), includeShared: true }]),
    );
    expect(await retention.sweepPending()).toEqual([]);
    expect(fs.pending()).toEqual([]);
    const deadline = Date.now() + 1_000;
    while (!cleared.length && Date.now() < deadline) await Bun.sleep(5);
    expect(cleared).toEqual([gone]);
    expect(fs.pending()).toEqual([dirName(gone)]);
    expect(warn).toHaveBeenCalled();
  });

  test("failed clears survive a restart even before any follow-up pass", async () => {
    const { fs } = setup();
    const gone = servicePartition(1, "forgotten", "svc-failed");
    fs.directories.add(dirName(gone));
    const options = {
      partitionsDir: PARTITIONS,
      pendingFile: PENDING,
      fs,
      inUse: () => [],
      logger: { warn: () => undefined },
      sessionFor: () => ({
        clearStorageData: async () => {
          throw new Error("busy");
        },
      }),
    };
    const first = new PreviewPartitionRetention(options);
    await first.forgetConnection(connectionPartitionKey("forgotten"), { includeShared: false });
    first.dispose();
    expect(fs.pending()).toEqual([]);
    const restarted = new PreviewPartitionRetention(options);
    expect(await restarted.sweepPending()).toEqual([dirName(gone)]);
    restarted.dispose();
  });

  test("a missing partitions directory or pending file is not an error", async () => {
    const { retention, warn } = setup();
    expect(await retention.sweepPending()).toEqual([]);
    const missing = new PreviewPartitionRetention({
      partitionsDir: "/nowhere",
      pendingFile: PENDING,
      sessionFor: () => ({ clearStorageData: async () => undefined }),
      inUse: () => [],
      fs: new MemoryFs(),
      logger: { warn },
    });
    expect(await missing.forgetConnection("0123456789abcdef", { includeShared: true })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("window schedules can be cancelled before first run, and shutdown cancels the others", async () => {
    const { fs, retention } = setup();
    fs.directories.add(dirName(servicePartition(1, "local", "svc-gone")));
    const first = mock(async () => snapshot([]));
    const second = mock(async () => snapshot([]));
    const stop = retention.schedule(connectionPartitionKey("local"), source(first), {
      delayMs: 10,
      intervalMs: 5,
    });
    retention.schedule(connectionPartitionKey("local"), source(second), {
      delayMs: 10,
      intervalMs: 5,
    });
    stop();
    retention.dispose();
    await Bun.sleep(40);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  test("a scheduled reconcile stops once its transport closes", async () => {
    const { fs, retention } = setup();
    fs.directories.add(dirName(servicePartition(1, "local", "svc-gone")));
    const list = mock(async () => snapshot([]));
    const scheduled = source(list);
    retention.schedule(connectionPartitionKey("local"), scheduled, {
      delayMs: 5,
      intervalMs: 5,
    });
    await Bun.sleep(40);
    const runs = list.mock.calls.length;
    expect(runs).toBeGreaterThanOrEqual(2);
    scheduled.closed = true;
    await Bun.sleep(30);
    expect(list.mock.calls.length).toBe(runs);
  });
});

describe("PreviewPartitionRetention on disk", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  test("clears, then removes the directory on the next start", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "preview-retention-"));
    const partitionsDir = path.join(root, "Partitions");
    const gone = dirName(servicePartition(1, "local", "svc-gone"));
    const kept = dirName(servicePartition(1, "local", "svc-live"));
    for (const name of [gone, kept]) {
      await mkdir(path.join(partitionsDir, name, "Local Storage"), { recursive: true });
      await writeFile(path.join(partitionsDir, name, "Cookies"), "x");
    }
    const options = {
      partitionsDir,
      pendingFile: path.join(root, "preview-partitions-pending.json"),
      sessionFor: () => ({ clearStorageData: async () => undefined }),
      inUse: () => [],
    };
    await new PreviewPartitionRetention(options).reconcileServices(
      connectionPartitionKey("local"),
      source(async () => snapshot(["svc-live"])),
    );
    expect(existsSync(path.join(partitionsDir, gone))).toBe(true);

    // A new process, before any session exists.
    expect(await new PreviewPartitionRetention(options).sweepPending()).toEqual([gone]);
    expect(await readdir(partitionsDir)).toEqual([kept]);
    expect(await new PreviewPartitionRetention(options).sweepPending()).toEqual([]);
  });
});
