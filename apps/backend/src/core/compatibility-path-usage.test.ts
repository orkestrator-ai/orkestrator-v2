import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COMPATIBILITY_PATH_USAGE_STORE,
  CompatibilityPathUsage,
  normalizeCompatibilityPathUsage,
  mergeCompatibilityPathUsage,
  type CompatibilityPathUsageSink,
} from "./compatibility-path-usage.js";
import { compatibilityPathUsageDatabaseSink } from "./compatibility-path-usage-store.js";
import { openBackendDatabase } from "./storage-stores.js";

const dirs: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-compat-usage-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function clock(start = Date.parse("2026-10-24T10:00:00.000Z")) {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CompatibilityPathUsage", () => {
  test("peek answers from memory after one first read, so a poll writes nothing", () => {
    let merges = 0;
    let writes = 0;
    const stored = {
      count: 5,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    };
    const usage = new CompatibilityPathUsage();
    usage.attach({
      merge(pending) {
        merges += 1;
        if (pending.size > 0) writes += 1;
        return { version: 1, paths: { "agent-handoff.renderer-saved": stored } };
      },
    });
    expect(usage.peek().paths["agent-handoff.renderer-saved"]?.count).toBe(5);
    expect(merges).toBe(1);

    usage.record("agent-handoff.renderer-saved");
    usage.record("bridge-credential.token-file");
    for (let index = 0; index < 3; index += 1) {
      const { paths } = usage.peek();
      expect(paths["agent-handoff.renderer-saved"]?.count).toBe(6);
      expect(paths["bridge-credential.token-file"]?.count).toBe(1);
    }
    expect(merges).toBe(1);
    expect(writes).toBe(0);

    // The durable read still goes through the sink.
    usage.snapshot();
    expect(writes).toBe(1);
    usage.detach(usage["sink"]!);
  });

  test("peek without a sink is the pending counts", () => {
    const usage = new CompatibilityPathUsage();
    usage.record("usage-limit.text-classified");
    expect(usage.peek().paths["usage-limit.text-classified"]?.count).toBe(1);
  });

  test("counts each path with its first and last use, without a sink", () => {
    const time = clock();
    const usage = new CompatibilityPathUsage(time.now);
    usage.record("bridge-credential.token-file");
    time.advance(1_000);
    usage.record("bridge-credential.token-file");
    usage.record("agent-handoff.renderer-saved");

    expect(usage.snapshot()).toEqual({
      version: 1,
      paths: {
        "bridge-credential.token-file": {
          count: 2,
          firstSeenAt: "2026-10-24T10:00:00.000Z",
          lastSeenAt: "2026-10-24T10:00:01.000Z",
        },
        "agent-handoff.renderer-saved": {
          count: 1,
          firstSeenAt: "2026-10-24T10:00:01.000Z",
          lastSeenAt: "2026-10-24T10:00:01.000Z",
        },
      },
    });
    // Without a sink nothing is lost by reading.
    expect(usage.snapshot().paths["bridge-credential.token-file"]?.count).toBe(2);
  });

  test("persists totals across backends sharing a data directory", async () => {
    const dir = await dataDir();
    const time = clock();
    const first = new CompatibilityPathUsage(time.now);
    const firstSink = compatibilityPathUsageDatabaseSink(dir);
    first.record("usage-limit.text-classified");
    first.attach(firstSink);
    first.record("usage-limit.text-classified");
    first.detach(firstSink);

    time.advance(60_000);
    const second = new CompatibilityPathUsage(time.now);
    const secondSink = compatibilityPathUsageDatabaseSink(dir);
    second.attach(secondSink);
    second.record("usage-limit.text-classified");
    expect(second.snapshot().paths["usage-limit.text-classified"]).toEqual({
      count: 3,
      firstSeenAt: "2026-10-24T10:00:00.000Z",
      lastSeenAt: "2026-10-24T10:01:00.000Z",
    });
    second.detach(secondSink);

    // The stored document holds only ids, counts and times.
    const database = openBackendDatabase(dir);
    try {
      expect(database.readStore(COMPATIBILITY_PATH_USAGE_STORE)?.value).toEqual({
        version: 1,
        paths: {
          "usage-limit.text-classified": {
            count: 3,
            firstSeenAt: "2026-10-24T10:00:00.000Z",
            lastSeenAt: "2026-10-24T10:01:00.000Z",
          },
        },
      });
    } finally {
      database.close();
    }
  });

  test("flushes on its timer once a sink is attached", async () => {
    const merged: number[] = [];
    const sink: CompatibilityPathUsageSink = {
      merge: (pending) => {
        merged.push(pending.get("usage-limit.text-classified")?.count ?? 0);
        return { version: 1, paths: {} };
      },
    };
    const usage = new CompatibilityPathUsage(undefined, 5);
    usage.attach(sink);
    usage.record("usage-limit.text-classified");
    usage.record("usage-limit.text-classified");
    const deadline = Date.now() + 1_000;
    while (merged.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(merged).toEqual([2]);
    usage.detach(sink);
  });

  test("preserves newer backend counters through a database merge", async () => {
    const dir = await dataDir();
    const database = openBackendDatabase(dir);
    const future = {
      count: 9,
      firstSeenAt: clock().now().toISOString(),
      lastSeenAt: clock().now().toISOString(),
    };
    const sink = compatibilityPathUsageDatabaseSink(dir);
    const usage = new CompatibilityPathUsage(clock().now);
    try {
      database.transaction(() =>
        database.writeStoreInTransaction(COMPATIBILITY_PATH_USAGE_STORE, {
          version: 1,
          paths: { "future.path": future, broken: { count: -1 } },
        }),
      );
      usage.attach(sink);
      usage.record("agent-handoff.renderer-saved");
      expect(usage.snapshot().paths).not.toHaveProperty("future.path");
      usage.detach(sink);
      expect(database.readStore(COMPATIBILITY_PATH_USAGE_STORE)?.value).toEqual({
        version: 1,
        paths: {
          "future.path": future,
          "agent-handoff.renderer-saved": { ...future, count: 1 },
        },
      });
    } finally {
      usage.detach(sink);
      database.close();
    }
  });

  test("retries a failed timed flush without further traffic", async () => {
    let attempts = 0;
    let stored = { version: 1 as const, paths: {} };
    const sink: CompatibilityPathUsageSink = {
      merge(pending) {
        attempts++;
        if (attempts === 1) throw new Error("busy");
        stored = mergeCompatibilityPathUsage(stored, pending);
        return stored;
      },
    };
    const usage = new CompatibilityPathUsage(clock().now, 5);
    usage.attach(sink);
    try {
      usage.record("agent-handoff.renderer-saved");
      const deadline = Date.now() + 1_000;
      while (attempts < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(attempts).toBe(2);
      expect(
        normalizeCompatibilityPathUsage(stored).paths["agent-handoff.renderer-saved"]?.count,
      ).toBe(1);
    } finally {
      usage.detach(sink);
    }
  });

  test("detach cancels a pending retry and preserves counts for a replacement sink", async () => {
    let attempts = 0;
    const sink: CompatibilityPathUsageSink = {
      merge() {
        attempts++;
        throw new Error("busy");
      },
    };
    const usage = new CompatibilityPathUsage(clock().now, 5);
    usage.attach(sink);
    usage.record("agent-handoff.renderer-saved");
    usage.snapshot();
    usage.detach(sink);
    const detachedAttempts = attempts;
    await Bun.sleep(25);
    expect(attempts).toBe(detachedAttempts);
    expect(usage.snapshot().paths["agent-handoff.renderer-saved"]?.count).toBe(1);
  });

  test("failed snapshots include historical totals plus pending counts without double counting", () => {
    let fail = false;
    const stored = { version: 1 as const, paths: {} };
    const sink: CompatibilityPathUsageSink = {
      merge(pending) {
        if (fail) throw new Error("busy");
        return mergeCompatibilityPathUsage(stored, pending);
      },
    };
    const time = clock();
    const usage = new CompatibilityPathUsage(time.now);
    usage.attach(sink);
    try {
      usage.record("agent-handoff.renderer-saved");
      usage.record("bridge-credential.token-file");
      const original = usage.snapshot();
      time.advance(1_000);
      usage.record("agent-handoff.renderer-saved");
      fail = true;
      for (let i = 0; i < 2; i++) {
        expect(usage.snapshot().paths).toEqual({
          "bridge-credential.token-file": original.paths["bridge-credential.token-file"],
          "agent-handoff.renderer-saved": {
            count: 2,
            firstSeenAt: "2026-10-24T10:00:00.000Z",
            lastSeenAt: "2026-10-24T10:00:01.000Z",
          },
        });
      }
      fail = false;
      expect(usage.snapshot().paths["agent-handoff.renderer-saved"]?.count).toBe(2);
      fail = true;
      expect(usage.snapshot().paths["agent-handoff.renderer-saved"]?.count).toBe(2);
    } finally {
      usage.detach(sink);
    }
  });

  test("keeps pending counts when the sink fails", () => {
    let fail = true;
    const sink: CompatibilityPathUsageSink = {
      merge: (pending) => {
        if (fail) throw new Error("database is busy");
        return {
          version: 1,
          paths: {
            "usage-limit.text-classified": {
              ...pending.get("usage-limit.text-classified")!,
            },
          },
        };
      },
    };
    const usage = new CompatibilityPathUsage(clock().now);
    usage.attach(sink);
    usage.record("usage-limit.text-classified");
    expect(usage.snapshot().paths["usage-limit.text-classified"]?.count).toBe(1);
    fail = false;
    usage.record("usage-limit.text-classified");
    expect(usage.snapshot().paths["usage-limit.text-classified"]?.count).toBe(2);
    usage.detach(sink);
  });

  test("never recreates a data directory that was removed", async () => {
    const dir = path.join(await dataDir(), "gone");
    const usage = new CompatibilityPathUsage(clock().now);
    const sink = compatibilityPathUsageDatabaseSink(dir);
    usage.attach(sink);
    usage.record("workspace-grant.config-echo");
    expect(usage.snapshot().paths["workspace-grant.config-echo"]?.count).toBe(1);
    usage.detach(sink);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  test("detaching a sink that was replaced leaves the current one attached", () => {
    const merges: string[] = [];
    const sinkFor = (name: string): CompatibilityPathUsageSink => ({
      merge: () => {
        merges.push(name);
        return { version: 1, paths: {} };
      },
    });
    const first = sinkFor("first");
    const second = sinkFor("second");
    const usage = new CompatibilityPathUsage(clock().now);
    usage.attach(first);
    usage.attach(second);
    usage.detach(first);
    usage.snapshot();
    expect(merges).toEqual(["first", "second"]);
    usage.detach(second);
  });
});

describe("normalizeCompatibilityPathUsage", () => {
  test("keeps only known ids with valid counts and times", () => {
    expect(
      normalizeCompatibilityPathUsage({
        version: 1,
        paths: {
          "bridge-credential.token-file": {
            count: 4,
            firstSeenAt: "2026-10-20T00:00:00.000Z",
            lastSeenAt: "2026-10-21T00:00:00.000Z",
          },
          "a-path-a-newer-backend-counts": {
            count: 1,
            firstSeenAt: "2026-10-20T00:00:00.000Z",
            lastSeenAt: "2026-10-20T00:00:00.000Z",
          },
          "agent-handoff.renderer-saved": { count: -1, firstSeenAt: "x", lastSeenAt: "y" },
        },
      }),
    ).toEqual({
      version: 1,
      paths: {
        "bridge-credential.token-file": {
          count: 4,
          firstSeenAt: "2026-10-20T00:00:00.000Z",
          lastSeenAt: "2026-10-21T00:00:00.000Z",
        },
      },
    });
    expect(normalizeCompatibilityPathUsage(null)).toEqual({ version: 1, paths: {} });
  });
});

test("an idle reader refreshes another backend's totals on each bounded timer tick", () => {
  const callbacks: Array<() => void> = [];
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    callbacks.push(callback);
    return original(callback, ms);
  }) as typeof setTimeout);
  const stored = { version: 1 as const, paths: {} };
  let reads = 0;
  let writes = 0;
  const sink: CompatibilityPathUsageSink = {
    merge(pending) {
      reads++;
      if (pending.size) writes++;
      return mergeCompatibilityPathUsage(stored, pending);
    },
  };
  const time = clock();
  const reader = new CompatibilityPathUsage(time.now);
  const writer = new CompatibilityPathUsage(time.now);
  try {
    reader.attach(sink);
    writer.attach(sink);
    expect(reader.peek().paths).toEqual({});
    writer.record("usage-limit.text-classified");
    writer.snapshot();
    const before = reads;
    expect(reader.peek().paths).toEqual({});
    expect(reads).toBe(before);
    time.advance(60_000);
    // peek replaced the initial attach timer; tick the reader's current timer.
    callbacks[2]!();
    expect(reader.peek().paths["usage-limit.text-classified"]?.count).toBe(1);
    expect(writes).toBe(1);
    expect(callbacks.length).toBeGreaterThan(2);
  } finally {
    reader.detach(sink);
    writer.detach(sink);
    timer.mockRestore();
  }
});
