import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMigrationProgress } from "./keyed-record-migration.js";
import type { KeyedRecordIoKind } from "./keyed-record-store.js";
import {
  NATIVE_DISPLAY_TAIL_LEGACY_MIGRATION_ID,
  NativeAgentDisplayTailStore,
  type NativeAgentDisplayTailStoreOptions,
} from "./native-agent-display-tail-store.js";
import {
  NATIVE_DISPLAY_TAIL_LEGACY_SCHEMA,
  NATIVE_DISPLAY_TAIL_LEGACY_VERSION,
  NATIVE_DISPLAY_TAIL_MAX_BYTES,
  createNativeAgentDisplayTail,
  displayTailChecksum,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-display-tail-store-"));
  directories.push(directory);
  return directory;
}

type Events = Array<{ kind: KeyedRecordIoKind; key?: string }>;

function storeIn(
  dataDir: string,
  overrides: Partial<NativeAgentDisplayTailStoreOptions> = {},
  events?: Events,
): NativeAgentDisplayTailStore {
  return new NativeAgentDisplayTailStore({
    directory: path.join(dataDir, "native-agent-display-tail-records"),
    legacyFile: path.join(dataDir, "native-agent-display-tails.json"),
    ...(events ? { observer: (event) => events.push(event) } : {}),
    ...overrides,
  });
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

function legacyV1(index: number): NativeAgentDisplayTail {
  const record: Omit<NativeAgentDisplayTail, "checksum"> = {
    version: NATIVE_DISPLAY_TAIL_LEGACY_VERSION,
    schema: NATIVE_DISPLAY_TAIL_LEGACY_SCHEMA,
    environmentId: "env-even",
    agent: "claude",
    logicalSessionKey: `legacy-tab-${index}`,
    providerSessionId: `legacy-provider-${index}`,
    historyEpoch: "epoch-legacy",
    messages: [{ id: "legacy", role: "assistant", content: "legacy preview" }],
    updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
  };
  return { ...record, checksum: displayTailChecksum(record) };
}

async function writeLegacy(dataDir: string, store: Record<string, unknown>): Promise<string> {
  const file = path.join(dataDir, "native-agent-display-tails.json");
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function allFileContents(directory: string): Promise<string> {
  const contents: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(await allFileContents(fullPath));
    else if (entry.isFile()) contents.push(await fs.readFile(fullPath, "utf8"));
  }
  return contents.join("\n");
}

describe("NativeAgentDisplayTailStore", () => {
  test("round-trips a tail and serves unchanged reads from the bounded decoded cache", async () => {
    const dataDir = await dataDirectory();
    const events: Events = [];
    const store = storeIn(dataDir, {}, events);
    const value = tail(1);
    expect(await store.put("key-1", value)).toBe(true);
    events.length = 0;
    expect(await store.get("key-1")).toEqual(value);
    expect(await store.get("key-1")).toEqual(value);
    expect(events.filter((event) => event.kind === "payload-read")).toHaveLength(0);
    expect(store.stats().decodedCacheHits).toBe(2);
    // A cold store (restart) reads and validates exactly that one record.
    const coldEvents: Events = [];
    const cold = storeIn(dataDir, {}, coldEvents);
    expect(await cold.get("key-1")).toEqual(value);
    expect(coldEvents.filter((event) => event.kind === "payload-read")).toHaveLength(1);
    expect(cold.stats().decodes).toBe(1);
  });

  test("updates and reads one key without touching neighbour payloads at 1, 32, and 128 records", async () => {
    for (const count of [1, 32, 128]) {
      const dataDir = await dataDirectory();
      const events: Events = [];
      const store = storeIn(dataDir, {}, events);
      for (let index = 0; index < count; index += 1) {
        expect(await store.put(`key-${index}`, tail(index))).toBe(true);
      }
      events.length = 0;
      const updated = tail(0, { messages: [{ id: "m0", role: "assistant", content: "newer" }] });
      expect(await store.put("key-0", updated)).toBe(true);
      const cold = storeIn(dataDir, {}, events);
      expect((await cold.get("key-0"))?.messages).toEqual(updated.messages);
      const payloadWork = events.filter((event) =>
        ["payload-read", "payload-write", "checksum", "header-read", "evict"].includes(event.kind),
      );
      expect(payloadWork.length).toBeGreaterThan(0);
      expect(payloadWork.every((event) => event.key === "key-0")).toBe(true);
      expect(cold.stats().decodes).toBe(1);
    }
  });

  test("keeps 128 records and evicts the least recently written without reading payloads", async () => {
    const dataDir = await dataDirectory();
    let clock = 1_000_000;
    const events: Events = [];
    const store = storeIn(dataDir, { now: () => (clock += 1) }, events);
    for (let index = 0; index < 129; index += 1) {
      expect(await store.put(`key-${index}`, tail(index))).toBe(true);
    }
    expect(await store.get("key-0")).toBeNull();
    expect(await store.get("key-1")).not.toBeNull();
    expect(await store.get("key-128")).not.toBeNull();
    expect(events.filter((event) => event.kind === "evict")).toEqual([
      { kind: "evict", key: "key-0" },
    ]);
    expect((await store.records.list()).length).toBe(128);
  });

  test("enforces the per-record size limit on write and read", async () => {
    const dataDir = await dataDirectory();
    const store = storeIn(dataDir);
    const oversized = {
      ...tail(1),
      messages: [{ id: "big", content: "x".repeat(NATIVE_DISPLAY_TAIL_MAX_BYTES) }],
    };
    oversized.checksum = displayTailChecksum(oversized);
    expect(await store.put("key-1", oversized)).toBe(false);
    expect(await store.put("key-2", tail(2))).toBe(true);
    const file = (await fs.readdir(store.records.directory)).find((name) => name.endsWith(".rec"))!;
    await fs.appendFile(
      path.join(store.records.directory, file),
      "x".repeat(NATIVE_DISPLAY_TAIL_MAX_BYTES + 8_192),
    );
    expect(await storeIn(dataDir).get("key-2")).toBeNull();
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
    await store.put("key-1", tail(1, { messages: [{ id: "m2", content: "second" }] }));
    const persisted = await allFileContents(dataDir);
    expect(persisted).toContain("second");
    for (const secret of [
      "SECRET-TOOL-OUTPUT",
      "SECRET-TOOL-ERROR",
      "SECRET-APPROVAL",
      "SECRET-TOKEN",
      "SECRET-CREDENTIAL",
      "SECRET-ATTACHMENT",
      "SECRET-DIFF",
    ]) {
      expect(persisted).not.toContain(secret);
    }
    // Cache records keep no backups or previous generations.
    expect(
      (await fs.readdir(store.records.directory)).filter((name) => /\.(prev|bak|tmp)/.test(name)),
    ).toEqual([]);
  });
});

describe("legacy display-tail migration", () => {
  test("imports valid v1/v2 tails once, skips bad entries, and retires the legacy file", async () => {
    const dataDir = await dataDirectory();
    const oversized = { ...tail(9), messages: [{ id: "x", content: "x".repeat(600 * 1024) }] };
    oversized.checksum = displayTailChecksum(oversized);
    const legacyFile = await writeLegacy(dataDir, {
      "key-v2": tail(2),
      "key-v1": legacyV1(1),
      "key-tampered": { ...tail(3), checksum: "tampered" },
      "key-oversized": oversized,
    });
    await fs.writeFile(`${legacyFile}.bak.1`, "{}", { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, ".native-agent-display-tails.json.abc.tmp"), "{}");
    const store = storeIn(dataDir);
    expect(await store.get("key-v2")).toEqual(tail(2));
    expect(await store.get("key-v1")).toEqual(legacyV1(1));
    expect(await store.get("key-tampered")).toBeNull();
    expect(await store.get("key-oversized")).toBeNull();
    expect(store.stats()).toMatchObject({ importedLegacy: 2, skippedLegacy: 2 });
    const remaining = await fs.readdir(dataDir);
    expect(remaining.filter((name) => name.includes("native-agent-display-tails"))).toEqual([]);
    const progress = await readMigrationProgress(
      store.records,
      NATIVE_DISPLAY_TAIL_LEGACY_MIGRATION_ID,
    );
    expect(progress?.completedAt).toBeNumber();

    // An older binary recreating the legacy file after migration is never
    // read again; the next store retires it instead of importing it.
    await writeLegacy(dataDir, { "key-resurrected": tail(4) });
    const next = storeIn(dataDir);
    expect(await next.get("key-resurrected")).toBeNull();
    await next.ensureMigration();
    await expect(fs.stat(legacyFile)).rejects.toThrow();
  });

  test("a crash halfway through import resumes twice without resurrecting deletions", async () => {
    const dataDir = await dataDirectory();
    const legacy: Record<string, NativeAgentDisplayTail> = {};
    for (let index = 0; index < 8; index += 1) legacy[`key-${index}`] = tail(index);
    await writeLegacy(dataDir, legacy);
    const crashAfter = (position: number) => {
      let crashed = false;
      return {
        crashed: () => crashed,
        options: {
          importWaitMs: 0,
          migrationFaults: {
            at: (stage: string, detail: { processed: number }) => {
              if (stage !== "after-record" || detail.processed !== position) return;
              crashed = true;
              return new Promise<never>(() => undefined);
            },
          },
        },
      };
    };
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(condition()).toBe(true);
    };

    const first = crashAfter(3);
    void storeIn(dataDir, first.options).ensureMigration();
    await waitFor(first.crashed);
    // Newest first: key-7, key-6, key-5 are imported. Delete one imported
    // key, one not yet imported, and a whole environment meanwhile.
    const between = storeIn(dataDir, { importWaitMs: 0 });
    await between.delete("key-7");
    await between.delete("key-2");
    await between.deleteByEnvironment("env-odd");

    const second = crashAfter(6);
    void storeIn(dataDir, second.options).ensureMigration();
    await waitFor(second.crashed);

    const final = storeIn(dataDir);
    await final.ensureMigration();
    const present: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      if (await final.get(`key-${index}`)) present.push(`key-${index}`);
    }
    expect(present).toEqual(["key-0", "key-4", "key-6"]);
    await expect(fs.stat(path.join(dataDir, "native-agent-display-tails.json"))).rejects.toThrow();
    // With the legacy source gone the tombstones are retired.
    const tombstones = await final.records.tombstones.read();
    expect(Object.keys(tombstones.keys)).toEqual([]);
    expect(Object.keys(tombstones.owners)).toEqual([]);
  });

  test("a live write during the import wins over the legacy copy", async () => {
    const dataDir = await dataDirectory();
    await writeLegacy(dataDir, { "key-1": tail(1) });
    const store = storeIn(dataDir);
    const live = tail(1, { messages: [{ id: "live", content: "live checkpoint" }] });
    expect(await store.put("key-1", live)).toBe(true);
    await store.ensureMigration();
    expect((await store.get("key-1"))?.messages).toEqual(live.messages);
  });
});
