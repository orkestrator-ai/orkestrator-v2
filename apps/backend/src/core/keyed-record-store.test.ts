import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ByteCountSemaphore, KeyedSerialQueue } from "./keyed-record-concurrency.js";
import { recordFileStem } from "./keyed-record-format.js";
import {
  KeyedRecordStore,
  type KeyedRecordIoKind,
  type KeyedRecordStoreOptions,
} from "./keyed-record-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-keyed-record-"));
  directories.push(directory);
  return directory;
}

type Events = Array<{ kind: KeyedRecordIoKind; key?: string }>;

async function createStore(
  overrides: Partial<KeyedRecordStoreOptions> = {},
): Promise<{ store: KeyedRecordStore; directory: string; events: Events }> {
  const root = await tempDirectory();
  const directory = overrides.directory ?? path.join(root, "records");
  const events: Events = [];
  const store = new KeyedRecordStore({
    directory,
    namespace: "test/v1",
    schema: "test-record-v1",
    retentionClass: "cache",
    maxPayloadBytes: 1_024,
    maxRecords: 8,
    maxTotalPayloadBytes: 8 * 1_024,
    observer: (event) => events.push(event),
    ...overrides,
  });
  return { store, directory, events };
}

function recordPath(directory: string, key: string, namespace = "test/v1"): string {
  return path.join(directory, `${recordFileStem(namespace, key)}.rec`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("KeyedRecordStore", () => {
  test("round-trips a record into a private hashed file", async () => {
    const { store, directory } = await createStore();
    const written = await store.put("session-a", "hello", { owner: { environmentId: "env-1" } });
    expect(written).toMatchObject({ status: "written", revision: 1 });
    const read = await store.get("session-a");
    expect(read.status).toBe("found");
    if (read.status !== "found") throw new Error("expected record");
    expect(read.payload.toString()).toBe("hello");
    expect(read.header).toMatchObject({
      key: "session-a",
      revision: 1,
      byteLength: 5,
      owner: { environmentId: "env-1" },
      retentionClass: "cache",
    });
    const file = recordPath(directory, "session-a");
    expect(path.basename(file)).toMatch(/^[0-9a-f]{64}\.rec$/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("distinguishes missing from corrupt and never returns a tampered payload", async () => {
    const { store, directory } = await createStore();
    expect(await store.get("absent")).toEqual({ status: "missing" });
    await store.put("session-a", "payload-bytes");
    const file = recordPath(directory, "session-a");
    const original = await fs.readFile(file);

    await fs.writeFile(file, Buffer.concat([original.subarray(0, -1), Buffer.from("X")]));
    expect(await store.get("session-a")).toEqual({
      status: "corrupt",
      reason: "checksum-mismatch",
    });

    await fs.writeFile(file, original.subarray(0, original.length - 3));
    expect(await store.get("session-a")).toEqual({ status: "corrupt", reason: "length-mismatch" });

    await fs.writeFile(file, "not a header");
    expect(await store.get("session-a")).toEqual({ status: "corrupt", reason: "malformed-header" });
  });

  test("refuses a record whose decoded header names a different key", async () => {
    const { store, directory } = await createStore();
    await store.put("session-a", "secret-a");
    await store.put("session-b", "secret-b");
    // Hashing the filename is not authorization: a file copied under another
    // key's name must not be served for that key.
    await fs.copyFile(recordPath(directory, "session-a"), recordPath(directory, "session-b"));
    expect(await store.get("session-b")).toEqual({
      status: "corrupt",
      reason: "identity-mismatch",
    });
  });

  test("rejects symlink substitutions and a symlinked namespace", async () => {
    const { store, directory } = await createStore();
    await store.put("session-a", "a");
    const outside = path.join(path.dirname(directory), "outside.rec");
    await fs.copyFile(recordPath(directory, "session-a"), outside);
    await fs.rm(recordPath(directory, "session-a"));
    await fs.symlink(outside, recordPath(directory, "session-a"));
    expect(await store.get("session-a")).toEqual({ status: "corrupt", reason: "not-regular-file" });

    const root = await tempDirectory();
    const real = path.join(root, "real");
    await fs.mkdir(real);
    const linked = path.join(root, "linked");
    await fs.symlink(real, linked);
    const { store: redirected } = await createStore({ directory: linked });
    await expect(redirected.put("session-a", "a")).rejects.toThrow(/private directory/);
  });

  test("bounds reads before and during buffering", async () => {
    const { store, directory } = await createStore({ maxPayloadBytes: 16 });
    expect(await store.put("big", "x".repeat(17))).toEqual({
      status: "rejected",
      reason: "too-large",
    });
    await store.put("session-a", "small");
    // A file grown past the cap is refused at admission, before buffering.
    await fs.appendFile(recordPath(directory, "session-a"), "y".repeat(8_192));
    expect(await store.get("session-a")).toEqual({ status: "corrupt", reason: "oversized" });
  });

  test("applies compare-and-swap revisions and serializes one key", async () => {
    const { store } = await createStore();
    expect(await store.put("key", "one", { expectedRevision: null })).toMatchObject({
      status: "written",
      revision: 1,
    });
    expect(await store.put("key", "stale", { expectedRevision: null })).toEqual({
      status: "conflict",
      currentRevision: 1,
    });
    expect(await store.put("key", "two", { expectedRevision: 1 })).toMatchObject({
      status: "written",
      revision: 2,
    });
    // A concurrent writer that read revision 1 cannot overwrite revision 2.
    expect(await store.put("key", "late", { expectedRevision: 1 })).toEqual({
      status: "conflict",
      currentRevision: 2,
    });
    const results = await Promise.all(["a", "b", "c"].map((payload) => store.put("key", payload)));
    expect(results.map((result) => (result.status === "written" ? result.revision : 0))).toEqual([
      3, 4, 5,
    ]);
    const read = await store.get("key");
    expect(read.status === "found" && read.payload.toString()).toBe("c");
  });

  test("lets a second key progress while the first is stalled mid-write", async () => {
    const gate = deferred();
    let stalled = false;
    const { store } = await createStore({
      faults: {
        at: async (stage, { key }) => {
          if (stage === "after-stage" && key === "slow") {
            stalled = true;
            await gate.promise;
          }
        },
      },
    });
    const slow = store.put("slow", "slow-payload");
    while (!stalled) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await store.put("fast", "fast-payload")).toMatchObject({ status: "written" });
    expect((await store.get("fast")).status).toBe("found");
    expect((await store.get("slow")).status).toBe("missing");
    gate.resolve();
    expect(await slow).toMatchObject({ status: "written" });
  });

  test("touches only the requested record's payload with 1, 32, and 128 neighbours", async () => {
    for (const neighbours of [1, 32, 128]) {
      const { store, events } = await createStore({
        maxRecords: 256,
        maxTotalPayloadBytes: 1024 * 1024,
      });
      for (let index = 0; index < neighbours; index += 1) {
        await store.put(`neighbour-${index}`, `payload-${index}`);
      }
      await store.put("target", "initial");
      events.length = 0;
      await store.put("target", "updated");
      const read = await store.get("target");
      expect(read.status === "found" && read.payload.toString()).toBe("updated");
      const touched = events.filter(
        (event) =>
          event.kind === "payload-read" ||
          event.kind === "payload-write" ||
          event.kind === "checksum" ||
          event.kind === "header-read",
      );
      expect(touched.every((event) => event.key === "target")).toBe(true);
      expect(events.filter((event) => event.kind === "payload-write")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "evict")).toHaveLength(0);
    }
  });

  test("evicts least recently written cache records by count and bytes", async () => {
    let clock = 1_000;
    const { store } = await createStore({
      maxRecords: 3,
      maxTotalPayloadBytes: 40,
      now: () => (clock += 1),
    });
    for (const key of ["a", "b", "c"]) await store.put(key, "1234567890");
    const fourth = await store.put("d", "1234567890");
    expect(fourth).toMatchObject({ status: "written", evicted: 1 });
    expect((await store.get("a")).status).toBe("missing");
    const bigger = await store.put("e", "1".repeat(30));
    expect(bigger).toMatchObject({ status: "written" });
    const remaining = (await store.list()).map((entry) => entry.key).sort();
    expect(remaining).toEqual(["d", "e"]);
    expect((await store.list()).reduce((sum, entry) => sum + entry.payloadBytes, 0)).toBe(40);
  });

  test("durable quota rejects admission and always releases reservations", async () => {
    let failNext = true;
    const { store } = await createStore({
      retentionClass: "durable",
      maxRecords: 4,
      maxTotalPayloadBytes: 100,
      faults: {
        at: (stage) => {
          if (stage === "after-stage" && failNext) {
            failNext = false;
            throw new Error("disk full");
          }
        },
      },
    });
    await expect(store.put("a", "x".repeat(60))).rejects.toThrow("disk full");
    // The failed write's reservation is gone, so the full budget is usable.
    expect(await store.put("a", "x".repeat(60))).toMatchObject({ status: "written" });
    // Durable data is never evicted: the committed 60 bytes (and its future
    // retained generation) count against the ceiling.
    expect(await store.put("b", "y".repeat(50))).toEqual({ status: "rejected", reason: "quota" });
    expect((await store.get("a")).status).toBe("found");
  });

  test("rejects operations beyond the admission bound instead of queueing them", async () => {
    const gate = deferred();
    const { store } = await createStore({
      maxQueuedOperations: 2,
      faults: {
        at: async (stage) => {
          if (stage === "after-stage") await gate.promise;
        },
      },
    });
    const first = store.put("a", "1");
    const second = store.put("b", "2");
    expect(await store.put("c", "3")).toEqual({ status: "rejected", reason: "busy" });
    gate.resolve();
    await Promise.all([first, second]);
  });

  test("fences a write inside the key's critical section", async () => {
    const { store } = await createStore();
    let allowed = true;
    const gate = deferred();
    const blocker = store.put("key", "first");
    const queued = store.put("key", "second", { fence: () => allowed });
    allowed = false;
    gate.resolve();
    await blocker;
    expect(await queued).toEqual({ status: "rejected", reason: "fenced" });
    const read = await store.get("key");
    expect(read.status === "found" && read.payload.toString()).toBe("first");
  });

  test("deletes every generation and filters deletes by owner metadata", async () => {
    const { store, directory, events } = await createStore({ retentionClass: "durable" });
    await store.put("a", "one", { owner: { environmentId: "env-1" } });
    await store.put("a", "two", { owner: { environmentId: "env-1" } });
    await store.put("b", "one", { owner: { environmentId: "env-2" } });
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".prev")).length).toBe(1);
    events.length = 0;
    expect(await store.deleteWhere((metadata) => metadata.owner.environmentId === "env-1")).toBe(1);
    expect(events.some((event) => event.kind === "payload-read")).toBe(false);
    expect((await store.get("a")).status).toBe("missing");
    expect((await store.get("b")).status).toBe("found");
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".prev"))).toEqual([]);
    expect(await store.delete("a")).toBe(false);
  });

  test("rebuilds a lost index from headers without reading payloads", async () => {
    const { store, directory } = await createStore({ maxRecords: 64 });
    for (let index = 0; index < 5; index += 1) await store.put(`key-${index}`, `value-${index}`);
    await fs.rm(path.join(directory, "_meta", "index.json"));
    const events: Events = [];
    const restarted = new KeyedRecordStore({
      directory,
      namespace: "test/v1",
      schema: "test-record-v1",
      retentionClass: "cache",
      maxPayloadBytes: 1_024,
      maxRecords: 64,
      maxTotalPayloadBytes: 8 * 1_024,
      observer: (event) => events.push(event),
    });
    const listed = await restarted.list();
    expect(listed.map((entry) => entry.key).sort()).toEqual([
      "key-0",
      "key-1",
      "key-2",
      "key-3",
      "key-4",
    ]);
    expect(listed.reduce((sum, entry) => sum + entry.payloadBytes, 0)).toBe(35);
    expect(events.filter((event) => event.kind === "header-read")).toHaveLength(5);
    expect(events.filter((event) => event.kind === "payload-read")).toHaveLength(0);
    // A second repair trusts unchanged stat fingerprints: no header reads.
    events.length = 0;
    await restarted.repair();
    expect(events.filter((event) => event.kind === "header-read")).toHaveLength(0);
  });
});

describe("keyed record concurrency primitives", () => {
  test("the staging semaphore bounds count and bytes and rejects excess waiters", async () => {
    const semaphore = new ByteCountSemaphore(2, 100, 1);
    const first = await semaphore.acquire(60);
    const second = semaphore.acquire(60);
    let secondGranted = false;
    void second.then(() => {
      secondGranted = true;
    });
    await expect(semaphore.acquire(1)).rejects.toThrow(/admission/);
    await Promise.resolve();
    expect(secondGranted).toBe(false);
    first();
    (await second)();
    expect(semaphore.inFlightBytes).toBe(0);
    // A request larger than the byte budget is admitted alone.
    const oversized = await semaphore.acquire(500);
    expect(semaphore.inFlightCount).toBe(1);
    oversized();
  });

  test("the key queue serializes one key and drops idle keys", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    const gate = deferred();
    const first = queue.run("a", async () => {
      await gate.promise;
      order.push("a1");
    });
    const second = queue.run("a", async () => {
      order.push("a2");
    });
    await queue.run("b", async () => {
      order.push("b1");
    });
    expect(queue.isBusy("a")).toBe(true);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["b1", "a1", "a2"]);
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });
});
