import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NATIVE_AGENT_DISPLAY_TAIL_STORE } from "./native-agent-display-tail-layout.js";
import {
  NATIVE_DISPLAY_TAIL_LEGACY_FILE,
  NATIVE_DISPLAY_TAIL_LEGACY_RECORD_DIRECTORY,
  NativeAgentDisplayTailStore,
  type NativeAgentDisplayTailStoreOptions,
} from "./native-agent-display-tail-store.js";
import {
  NATIVE_DISPLAY_TAIL_MAX_BYTES,
  createNativeAgentDisplayTail,
  displayTailChecksum,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { storageFilesContain } from "./storage-test-support.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-display-tail-store-"));
  directories.push(directory);
  return directory;
}

/** A new connection: behaves like another backend process sharing `dataDir`. */
function connect(dataDir: string): StorageDatabase {
  const database = openBackendDatabase(dataDir);
  databases.push(database);
  return database;
}

function storeIn(
  dataDir: string,
  overrides: Partial<NativeAgentDisplayTailStoreOptions> = {},
  database = connect(dataDir),
): NativeAgentDisplayTailStore {
  return new NativeAgentDisplayTailStore({
    database: () => database,
    legacyRoot: dataDir,
    ...overrides,
  });
}

function storedKeys(dataDir: string): string[] {
  const snapshot = connect(dataDir).readStore(NATIVE_AGENT_DISPLAY_TAIL_STORE);
  return Object.keys((snapshot?.value ?? {}) as Record<string, unknown>).sort();
}

function tail(
  index: number,
  overrides: Partial<Parameters<typeof createNativeAgentDisplayTail>[0]> = {},
): NativeAgentDisplayTail {
  const created = createNativeAgentDisplayTail({
    environmentId: index % 2 === 0 ? "env-even" : "env-odd",
    agent: "codex",
    logicalSessionKey: `tab-${index}`,
    providerSessionId: `provider-${index}`,
    historyEpoch: "epoch-1",
    messages: [{ id: `m${index}`, role: "assistant", content: `preview ${index}`, parts: [] }],
    historyComplete: true,
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    ...overrides,
  });
  if (!created) throw new Error("tail too large");
  return created;
}

/** Overwrites one row with raw text (bit rot or another writer; never produced by the store). */
function writeRawRow(database: StorageDatabase, key: string, value: string, owner?: string): void {
  database.transaction(() =>
    database.rows(NATIVE_AGENT_DISPLAY_TAIL_STORE).put(key, value, owner ? { owner } : {}),
  );
}

describe("NativeAgentDisplayTailStore", () => {
  test("round-trips a tail and serves unchanged reads from the bounded decoded cache", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir);
    const value = tail(1);
    expect(await store.put("key-1", value)).toBe(true);
    expect(await store.get("key-1")).toEqual(value);
    expect(await store.get("key-1")).toEqual(value);
    expect(store.stats()).toMatchObject({ rowReads: 0, decodes: 0, decodedCacheHits: 2 });
    // Callers own what they receive.
    (await store.get("key-1"))!.messages.length = 0;
    expect(await store.get("key-1")).toEqual(value);
    // A cold store (restart) reads and validates exactly that one row.
    const cold = storeIn(dataDir);
    expect(await cold.get("key-1")).toEqual(value);
    expect(await cold.get("key-missing")).toBeNull();
    expect(cold.stats()).toMatchObject({ rowReads: 1, decodes: 1 });
  });

  test("updates and cold-reads one key by reading one row at 1, 32, and 128 records", async () => {
    for (const count of [1, 32, 128]) {
      const dataDir = await dataDirectory();
      const store = storeIn(dataDir);
      for (let index = 0; index < count; index += 1) {
        expect(await store.put(`key-${index}`, tail(index))).toBe(true);
      }
      const updated = tail(0, { messages: [{ id: "m0", role: "assistant", content: "newer" }] });
      expect(await store.put("key-0", updated)).toBe(true);
      const cold = storeIn(dataDir);
      expect((await cold.get("key-0"))?.messages).toEqual(updated.messages);
      expect(cold.stats()).toMatchObject({ rowReads: 1, decodes: 1 });
      expect(store.stats().evictions).toBe(0);
    }
  });

  test("keeps 128 sessions and evicts the least recently written", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir);
    for (let index = 0; index < 128; index += 1) {
      expect(await store.put(`key-${index}`, tail(index))).toBe(true);
    }
    // Rewriting key-0 makes it the most recent: key-1 is now the oldest.
    expect(await store.put("key-0", tail(0, { title: "rewritten" }))).toBe(true);
    expect(await store.put("key-128", tail(128))).toBe(true);
    expect(store.stats().evictions).toBe(1);
    expect(await store.get("key-1")).toBeNull();
    expect((await store.get("key-0"))?.title).toBe("rewritten");
    expect(await store.get("key-128")).not.toBeNull();
    const keys = storedKeys(dataDir);
    expect(keys).toHaveLength(128);
    expect(keys).not.toContain("key-1");
  });

  test("evicts the least recently written while the byte total exceeds its bound", async () => {
    const dataDir = await dataDirectory();
    const size = Buffer.byteLength(JSON.stringify(tail(1)));
    const store = storeIn(dataDir, { limits: { maxTotalBytes: size * 3 + size / 2 } });
    for (let index = 1; index <= 3; index += 1) {
      expect(await store.put(`key-${index}`, tail(index))).toBe(true);
    }
    expect(storedKeys(dataDir)).toEqual(["key-1", "key-2", "key-3"]);
    expect(await store.put("key-4", tail(4))).toBe(true);
    expect(storedKeys(dataDir)).toEqual(["key-2", "key-3", "key-4"]);
    // One large tail displaces as many old ones as it needs.
    const large = tail(5, { messages: [{ id: "big", content: "y".repeat(size * 2) }] });
    expect(await store.put("key-5", large)).toBe(true);
    expect(storedKeys(dataDir)).toEqual(["key-5"]);
    expect(store.stats().evictions).toBe(4);
    expect((await store.get("key-5"))?.messages).toEqual(large.messages);
  });

  test("enforces the per-record size limit and validation on write and read", async () => {
    const dataDir = await dataDirectory();
    const database = connect(dataDir);
    const store = storeIn(dataDir, {}, database);
    const oversized = {
      ...tail(1),
      messages: [{ id: "big", content: "x".repeat(NATIVE_DISPLAY_TAIL_MAX_BYTES) }],
    };
    oversized.checksum = displayTailChecksum(oversized);
    expect(await store.put("key-1", oversized)).toBe(false);
    expect(await store.put("key-2", tail(2))).toBe(true);
    expect(await store.put("key-3", tail(3))).toBe(true);
    expect(await store.put("key-4", tail(4))).toBe(true);
    const other = connect(dataDir);
    writeRawRow(other, "key-2", JSON.stringify(oversized));
    writeRawRow(other, "key-3", JSON.stringify({ ...tail(3), checksum: "tampered" }));
    writeRawRow(other, "key-4", "{not json", "env-even");
    for (const reader of [store, storeIn(dataDir)]) {
      expect(await reader.get("key-2")).toBeNull();
      expect(await reader.get("key-3")).toBeNull();
      expect(await reader.get("key-4")).toBeNull();
    }
  });

  test("another connection's writes and deletes are observed through the store revision", async () => {
    const dataDir = await dataDirectory();
    const first = storeIn(dataDir);
    const second = storeIn(dataDir);
    expect(await first.put("key-1", tail(1))).toBe(true);
    expect(await second.get("key-1")).toEqual(tail(1));
    expect(await second.get("key-1")).toEqual(tail(1));
    expect(second.stats()).toMatchObject({ rowReads: 1, decodedCacheHits: 1 });
    // Any commit moves the revision: the next read revalidates by re-reading.
    expect(await first.put("key-2", tail(2))).toBe(true);
    expect(await second.get("key-1")).toEqual(tail(1));
    expect(second.stats()).toMatchObject({ rowReads: 2, decodedCacheHits: 1 });
    const updated = tail(1, { title: "from the first backend" });
    expect(await first.put("key-1", updated)).toBe(true);
    expect((await second.get("key-1"))?.title).toBe("from the first backend");
    await first.delete("key-1");
    expect(await second.get("key-1")).toBeNull();
    await second.deleteByEnvironment("env-even");
    expect(await first.get("key-2")).toBeNull();
  });

  test("two backends writing interleaved keys lose no update and share one bound", async () => {
    const dataDir = await dataDirectory();
    const first = storeIn(dataDir, { limits: { maxSessions: 6 } });
    const second = storeIn(dataDir, { limits: { maxSessions: 6 } });
    const writes: Array<Promise<boolean>> = [];
    for (let index = 0; index < 8; index += 1) {
      writes.push((index % 2 === 0 ? first : second).put(`key-${index}`, tail(index)));
    }
    expect(await Promise.all(writes)).toEqual(Array.from({ length: 8 }, () => true));
    expect(storedKeys(dataDir)).toEqual(["key-2", "key-3", "key-4", "key-5", "key-6", "key-7"]);
    for (let index = 2; index < 8; index += 1) {
      expect(await first.get(`key-${index}`)).toEqual(tail(index));
    }
  });

  test("refuses a write whose fence predates a deletion of its key or environment", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir);
    const deletions: unknown[] = [];
    store.onDeleted((event) => deletions.push(event));
    const stale = store.captureFence();
    await store.delete("key-1");
    expect(await store.put("key-1", tail(1), { fence: stale })).toBe(false);
    expect(await store.get("key-1")).toBeNull();
    expect(await store.put("key-1", tail(1), { fence: store.captureFence() })).toBe(true);

    const beforeEnvironmentDelete = store.captureFence();
    await store.deleteByEnvironment("env-odd");
    expect(await store.get("key-1")).toBeNull();
    expect(await store.put("key-3", tail(3), { fence: beforeEnvironmentDelete })).toBe(false);
    expect(await store.put("key-2", tail(2), { fence: beforeEnvironmentDelete })).toBe(true);
    expect(deletions).toEqual([
      { kind: "key", key: "key-1" },
      { kind: "environment", environmentId: "env-odd" },
    ]);
  });

  test("a failed write rolls back entirely and leaves the previous value", async () => {
    const dataDir = await dataDirectory();
    const database = connect(dataDir);
    const store = storeIn(dataDir, { limits: { maxSessions: 2 } }, database);
    expect(await store.put("key-1", tail(1))).toBe(true);
    expect(await store.put("key-2", tail(2))).toBe(true);
    const rows = database.rows.bind(database);
    // Fail the last step of the put: after the eviction and the row upsert.
    const spy = spyOn(database, "rows").mockImplementation((name: string) => {
      const real = rows(name);
      return {
        ...real,
        put(key, value, options) {
          real.put(key, value, options);
          throw new Error("injected commit failure");
        },
      };
    });
    try {
      expect(await store.put("key-1", tail(1, { title: "lost" }))).toBe(false);
      expect(await store.put("key-3", tail(3))).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await store.get("key-1")).toEqual(tail(1));
    const cold = storeIn(dataDir);
    expect(await cold.get("key-1")).toEqual(tail(1));
    expect(await cold.get("key-2")).toEqual(tail(2));
    expect(await cold.get("key-3")).toBeNull();
    expect(store.stats()).toMatchObject({ rowWrites: 2, evictions: 0 });
  });

  test("a store held whole as a document is replaced, continuing its revision", async () => {
    const dataDir = await dataDirectory();
    const database = connect(dataDir);
    // Not a record value: stored as one document, which row writes refuse.
    database.writeStore(NATIVE_AGENT_DISPLAY_TAIL_STORE, ["not", "a", "record"]);
    const before = database.storeRevision(NATIVE_AGENT_DISPLAY_TAIL_STORE)!;
    const store = storeIn(dataDir, {}, database);
    expect(await store.get("key-1")).toBeNull();
    expect(await store.put("key-1", tail(1))).toBe(true);
    expect(database.storeRevision(NATIVE_AGENT_DISPLAY_TAIL_STORE)!).toBeGreaterThan(before);
    expect(storedKeys(dataDir)).toEqual(["key-1"]);
    expect(await storeIn(dataDir).get("key-1")).toEqual(tail(1));
  });

  test("deleted tails are unrecoverable from the database files", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir);
    const marker = (name: string) =>
      tail(name === "KEY" ? 1 : 2, {
        messages: [{ id: "m", role: "assistant", content: `PRIVATE-${name}-PREVIEW` }],
      });
    expect(await store.put("key-1", marker("KEY"))).toBe(true);
    expect(await store.put("key-2", marker("ENVIRONMENT"))).toBe(true);
    expect(await store.put("key-3", tail(3))).toBe(true);
    expect(storageFilesContain(dataDir, "PRIVATE-KEY-PREVIEW")).toBe(true);
    await store.delete("key-1");
    expect(storageFilesContain(dataDir, "PRIVATE-KEY-PREVIEW")).toBe(false);
    await store.deleteByEnvironment("env-even");
    expect(storageFilesContain(dataDir, "PRIVATE-ENVIRONMENT-PREVIEW")).toBe(false);
    expect(storedKeys(dataDir)).toEqual(["key-3"]);
  });

  test("never persists approvals, credentials, inline tool output, or data URLs", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir);
    const value = tail(1, {
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "visible answer",
          toolOutput: "SECRET-TOOL-OUTPUT",
          toolError: "SECRET-TOOL-ERROR",
          interactions: [{ id: "SECRET-APPROVAL" }],
          approvals: [{ id: "SECRET-APPROVAL-2" }],
          token: "SECRET-TOKEN",
          credentials: { apiKey: "SECRET-CREDENTIAL" },
          fileUrl: "data:image/png;base64,SECRET-ATTACHMENT",
          toolDiff: { filePath: "a.ts", additions: 1, deletions: 0, diff: "SECRET-DIFF" },
        },
      ],
    });
    expect(await store.put("key-1", value)).toBe(true);
    expect(storageFilesContain(dataDir, "visible answer")).toBe(true);
    for (const secret of [
      "SECRET-TOOL-OUTPUT",
      "SECRET-TOOL-ERROR",
      "SECRET-APPROVAL",
      "SECRET-TOKEN",
      "SECRET-CREDENTIAL",
      "SECRET-ATTACHMENT",
      "SECRET-DIFF",
    ]) {
      expect(storageFilesContain(dataDir, secret)).toBe(false);
    }
  });
});

describe("legacy display-tail files", () => {
  test("are removed once, best effort, and never imported", async () => {
    const dataDir = await dataDirectory();
    const legacyFile = path.join(dataDir, NATIVE_DISPLAY_TAIL_LEGACY_FILE);
    await fs.writeFile(legacyFile, JSON.stringify({ "key-legacy": tail(7) }), { mode: 0o600 });
    await fs.writeFile(`${legacyFile}.bak.1`, "{}", { mode: 0o600 });
    await fs.writeFile(`${legacyFile}.bak.5`, "{}", { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, `.${NATIVE_DISPLAY_TAIL_LEGACY_FILE}.abc.tmp`), "{}");
    const records = path.join(dataDir, NATIVE_DISPLAY_TAIL_LEGACY_RECORD_DIRECTORY);
    await fs.mkdir(path.join(records, "_meta"), { recursive: true });
    await fs.writeFile(path.join(records, "abc.rec"), "legacy record");
    await fs.writeFile(path.join(records, "_meta", "index.json"), "{}");
    await fs.writeFile(path.join(dataDir, "unrelated.json"), "{}");

    const store = storeIn(dataDir);
    expect(await store.get("key-legacy")).toBeNull();
    await store.cleanupLegacy();
    const remaining = await fs.readdir(dataDir);
    expect(remaining).toContain("unrelated.json");
    expect(remaining.some((name) => name.includes("native-agent-display-tail"))).toBe(false);

    // Once per store: a file an older backend writes later is removed on the
    // next start, and the store keeps working meanwhile.
    await fs.writeFile(legacyFile, "{}");
    await store.cleanupLegacy();
    await expect(fs.stat(legacyFile)).resolves.toBeDefined();
    expect(await store.put("key-1", tail(1))).toBe(true);
    await storeIn(dataDir).cleanupLegacy();
    await expect(fs.stat(legacyFile)).rejects.toThrow();
  });

  test("a missing data directory does not fail the cleanup", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir, { legacyRoot: path.join(dataDir, "absent") });
    await store.cleanupLegacy();
    expect(await store.put("key-1", tail(1))).toBe(true);
  });
});
