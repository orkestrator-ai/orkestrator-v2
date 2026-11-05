import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { LEGACY_JSON_DIRECTORY } from "./storage-stores.js";
import { StorageService } from "./storage.js";
import {
  readStoredValue,
  seedStore,
  seedUnreadableStore,
  storageDatabase,
  storageInternals,
} from "./storage-test-support.js";

const QUEUES = "prompt-queues.json";
const LOGICAL = "env-e1:tab-1";
const KEY = `claude\0${LOGICAL}`;
const SIBLING = "claude\0env-e2:tab-1";
const SESSION = nativeAgentSessionStorageKey("e1", "claude", LOGICAL);
const STAMP = "2026-11-01T00:00:00.000Z";
/** Appears only in the sibling queue, so a decode of it is visible. */
const SIBLING_TEXT = "sibling-queue-text";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function emptyDataDir(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-queue-rows-"));
  directories.push(dataDir);
  return dataDir;
}

async function open(dataDir: string): Promise<StorageService> {
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  return storage;
}

async function addEnvironments(storage: StorageService): Promise<void> {
  for (const id of ["e1", "e2"]) {
    await storage.addEnvironment({
      id,
      projectId: "proj-1",
      name: id,
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
    });
  }
}

function record(queueKey: string, environmentId: string, messages: unknown[], extra = {}) {
  return { queueKey, environmentId, messages, updatedAt: STAMP, revision: 1, ...extra };
}

function sibling() {
  return record(SIBLING, "e2", [{ id: "s1", text: SIBLING_TEXT }]);
}

/** A service over a seeded store, with the session a steer needs. */
async function seeded(queues: Record<string, unknown>) {
  const dataDir = await emptyDataDir();
  const storage = await open(dataDir);
  await addEnvironments(storage);
  seedStore(dataDir, QUEUES, queues);
  await storage.getOrCreateNativeAgentSession(
    { key: SESSION, environmentId: "e1", agent: "claude", logicalSessionKey: LOGICAL },
    async () => "provider-1",
  );
  return { dataDir, storage };
}

/** Records the keys of every prompt-queue row this connection writes. */
function countRowWrites(storage: StorageService): { keys: () => string[]; reset: () => void } {
  const { db } = storageDatabase(storage);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS queue_row_writes (key TEXT NOT NULL)");
  for (const [event, row] of [
    ["INSERT", "new"],
    ["UPDATE", "new"],
    ["DELETE", "old"],
  ] as const) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS queue_row_write_${event}
      AFTER ${event} ON main.store_rows WHEN ${row}.store = 'prompt-queues'
      BEGIN INSERT INTO queue_row_writes VALUES (${row}.key); END`);
  }
  return {
    keys: () =>
      (db.query("SELECT key FROM queue_row_writes").all() as Array<{ key: string }>).map(
        (row) => row.key,
      ),
    reset: () => db.exec("DELETE FROM queue_row_writes"),
  };
}

/**
 * Runs `run` and proves it decoded and wrote only `KEY`'s row: nothing parsed
 * the sibling's text, nothing read or wrote the store whole, and only that row
 * was written.
 */
async function expectOnlyTargetRow<T>(storage: StorageService, run: () => Promise<T>): Promise<T> {
  const database = storageDatabase(storage);
  const writes = countRowWrites(storage);
  writes.reset();
  const parse = spyOn(JSON, "parse");
  const wholeReads = spyOn(database, "readStore");
  const serialized = spyOn(database, "readStoreSerialized");
  const wholeWrites = spyOn(database, "writeStoreInTransaction");
  try {
    const result = await run();
    expect(parse.mock.calls.filter(([text]) => String(text).includes(SIBLING_TEXT))).toEqual([]);
    for (const spy of [wholeReads, serialized, wholeWrites]) {
      expect(spy.mock.calls.filter(([store]) => store === "prompt-queues")).toEqual([]);
    }
    expect(new Set(writes.keys())).toEqual(new Set([KEY]));
    return result;
  } finally {
    parse.mockRestore();
    wholeReads.mockRestore();
    serialized.mockRestore();
    wholeWrites.mockRestore();
  }
}

function setRow(storage: StorageService, key: string, raw: string): void {
  const { db } = storageDatabase(storage);
  db.query(
    "UPDATE store_rows SET value = ? WHERE store = 'prompt-queues' AND collection = '' AND key = ?",
  ).run(raw, key);
  db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'prompt-queues'").run();
}

describe("a prompt queue mutation touches one row", () => {
  test("a steer's reservation and settlement decode and write only their own queue", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [
        { id: "m1", text: "first" },
        { id: "m2", text: "second" },
      ]),
      [SIBLING]: sibling(),
    });
    const pending = await expectOnlyTargetRow(storage, () =>
      storage.reservePromptQueueSteer(SESSION, "m2", "run-1"),
    );
    expect(pending?.requestId).toBe("m2");
    const reserved = await storage.getPromptQueue(KEY);
    expect(reserved?.inFlight).toMatchObject({
      requestId: "m2",
      steer: true,
      restoreAfterId: "m1",
    });
    expect(reserved?.messages).toEqual([{ id: "m1", text: "first" }]);
    expect((await storage.getNativeAgentSession(SESSION))?.pendingSteer?.requestId).toBe("m2");

    await expectOnlyTargetRow(storage, () => storage.clearPendingNativeAgentSteer(SESSION, "m2"));
    const settled = await storage.getPromptQueue(KEY);
    expect(settled?.inFlight).toBeUndefined();
    expect(settled?.messages).toEqual([
      { id: "m1", text: "first" },
      { id: "m2", text: "second" },
    ]);
    expect(await storage.getPromptQueue(SIBLING)).toEqual(sibling());
  });

  test("a steer refused by its row writes nothing", async () => {
    const message = { id: "m1", text: "first", attachments: [{ name: "a.png" }] };
    const { storage } = await seeded({ [KEY]: record(KEY, "e1", [message]) });
    await expect(storage.reservePromptQueueSteer(SESSION, "m1", "run-1")).rejects.toThrow(
      "cannot be steered",
    );
    expect(await storage.getPromptQueue(KEY)).toEqual(record(KEY, "e1", [message]));
    expect((await storage.getNativeAgentSession(SESSION))?.pendingSteer).toBeUndefined();
  });

  test.each<[string, (storage: StorageService) => Promise<unknown>]>([
    ["a whole-list save", (s) => s.savePromptQueue(KEY, "e1", [{ id: "m9" }], 1)],
    ["an append", (s) => s.enqueuePromptQueueMessage(KEY, "e1", { id: "m9" })],
    ["an idempotent append", (s) => s.enqueuePromptQueueMessageIfAbsent(KEY, "e1", { id: "m9" })],
    ["a removal", (s) => s.removePromptQueueMessage(KEY, "e1", "m1")],
    ["a move", (s) => s.movePromptQueueMessage(KEY, "e1", "m2", "up")],
    ["a head reservation", (s) => s.reservePromptQueueHeadForDispatch(KEY)],
  ])("%s decodes and writes only its queue", async (_name, mutate) => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }, { id: "m2" }]),
      [SIBLING]: sibling(),
    });
    await expectOnlyTargetRow(storage, () => mutate(storage));
    expect((await storage.getPromptQueue(KEY))?.revision).toBe(2);
    expect(await storage.getPromptQueue(SIBLING)).toEqual(sibling());
  });

  test("a dispatch's later steps, a failure and a retry each write only their queue", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }, { id: "m2" }]),
      [SIBLING]: sibling(),
    });
    await storage.reservePromptQueueHeadForDispatch(KEY);
    await expectOnlyTargetRow(storage, () => storage.markPromptQueueDispatchSubmitting(KEY, "m1"));
    await expectOnlyTargetRow(storage, () => storage.markPromptQueueDispatchSubmitted(KEY, "m1"));
    await expectOnlyTargetRow(storage, () => storage.failPromptQueueDispatch(KEY, "m1"));
    expect((await storage.getPromptQueue(KEY))?.dispatchError?.messageId).toBe("m1");
    await expectOnlyTargetRow(storage, () => storage.retryPromptQueueDispatch(KEY));
    await storage.reservePromptQueueHeadForDispatch(KEY);
    await expectOnlyTargetRow(storage, () => storage.acknowledgePromptQueueDispatch(KEY, "m1"));
    expect(await storage.getPromptQueue(KEY)).toMatchObject({
      messages: [{ id: "m2" }],
      revision: 8,
    });
  });

  test("a job's reservation and settlement write only their queue", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }]),
      [SIBLING]: sibling(),
    });
    const receipt = { requestId: "job-1", fingerprint: "a".repeat(64), status: "unknown" as const };
    await expectOnlyTargetRow(storage, () =>
      storage.reserveNativeAgentJobRequest(KEY, "e1", receipt),
    );
    await expectOnlyTargetRow(storage, () =>
      storage.settleNativeAgentJobRequest(KEY, "job-1", "accepted"),
    );
    expect((await storage.getPromptQueue(KEY))?.jobReceipts).toEqual([
      { ...receipt, status: "accepted" },
    ]);
  });

  test("mail's empty-queue check reads only its queue", async () => {
    const { storage } = await seeded({ [SIBLING]: sibling() });
    const parse = spyOn(JSON, "parse");
    try {
      expect(await storage.withEmptyPromptQueueForMail(KEY, "e1", async () => "sent")).toEqual({
        empty: true,
        value: "sent",
      });
      expect(parse.mock.calls.filter(([text]) => String(text).includes(SIBLING_TEXT))).toEqual([]);
    } finally {
      parse.mockRestore();
    }
    await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
    expect(await storage.withEmptyPromptQueueForMail(KEY, "e1", async () => "sent")).toEqual({
      empty: false,
    });
  });

  test("a mutation that changes nothing writes nothing", async () => {
    const { storage } = await seeded({ [KEY]: record(KEY, "e1", [{ id: "m1" }]) });
    const writes = countRowWrites(storage);
    writes.reset();
    const events: unknown[] = [];
    storage.setResourceChangeListener((change) => events.push(change));
    expect((await storage.removePromptQueueMessage(KEY, "e1", "absent")).removed).toBeNull();
    expect(await storage.movePromptQueueMessage(KEY, "e1", "m1", "up")).toMatchObject({
      revision: 1,
    });
    expect(await storage.retryPromptQueueDispatch(KEY)).toMatchObject({ revision: 1 });
    expect(await storage.acknowledgePromptQueueDispatch(KEY, "absent")).toMatchObject({
      revision: 1,
    });
    expect(writes.keys()).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("a queue row's claim recovery and validation", () => {
  const live = {
    token: "t-live",
    message: { id: "claimed", text: "claimed" },
    claimedAt: STAMP,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
  const expired = { ...live, token: "t-old", expiresAt: "2020-01-01T00:00:00.000Z" };

  test.each<[string, unknown]>([
    ["a clean queue", record(KEY, "e1", [{ id: "m1" }])],
    ["a live claim", record(KEY, "e1", [{ id: "m1" }], { outstandingClaim: live })],
    ["an expired claim", record(KEY, "e1", [{ id: "m1" }], { outstandingClaim: expired })],
    [
      "an expired claim replacing its queued copy",
      record(KEY, "e1", [{ id: "claimed", text: "stale" }], { outstandingClaim: expired }),
    ],
    [
      "a claim with malformed lease fields",
      record(KEY, "e1", [], { outstandingClaim: { ...live, expiresAt: "soon" } }),
    ],
    ["a claim with no message", record(KEY, "e1", [], { outstandingClaim: { token: "t" } })],
    [
      "a claimed message with no id",
      record(KEY, "e1", [], { outstandingClaim: { ...expired, message: { text: "x" } } }),
    ],
    ["a row naming another key", record(SIBLING, "e1", [])],
    ["a row with no messages", { queueKey: KEY, environmentId: "e1", revision: 1 }],
    ["a row with a bad revision", record(KEY, "e1", [], { revision: 0 })],
    ["a row that is not a record", "garbage"],
  ])("%s reads the same as a whole load", async (_name, stored) => {
    const { storage } = await seeded({ [KEY]: stored });
    const whole = (await storage.listAllPromptQueues()).find((queue) => queue.queueKey === KEY);
    expect(await storage.getPromptQueue(KEY)).toEqual(whole ?? null);
  });

  test("a row recovers an expired claim and validates as its mutation sees it", async () => {
    const { storage, dataDir } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }], { outstandingClaim: expired }),
      [SIBLING]: record(SIBLING, "e2", [{ id: "s1" }], { outstandingClaim: expired }),
    });
    await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
    expect(await storage.getPromptQueue(KEY)).toMatchObject({
      messages: [{ id: "claimed" }, { id: "m1" }, { id: "m2" }],
      revision: 2,
    });

    // Only the mutated row persists the recovery. The other stays as stored,
    // and every read of it still recovers.
    const stored = readStoredValue<Record<string, { outstandingClaim?: unknown }>>(
      dataDir,
      QUEUES,
    )!;
    expect(stored[KEY]?.outstandingClaim).toBeUndefined();
    expect(stored[SIBLING]?.outstandingClaim).toEqual(expired);
    expect((await storage.getPromptQueue(SIBLING))?.messages).toEqual([
      { id: "claimed", text: "claimed" },
      { id: "s1" },
    ]);
  });

  test("a live claim survives row writes and excludes its message", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }], { outstandingClaim: live }),
    });
    await storage.savePromptQueue(KEY, "e1", [{ id: "claimed" }, { id: "m1" }]);
    expect(await storage.getPromptQueue(KEY)).toMatchObject({
      messages: [{ id: "m1" }],
      outstandingClaim: { token: "t-live" },
    });
    expect(await storage.reservePromptQueueHeadForDispatch(KEY)).toBeNull();
    await expect(storage.reservePromptQueueSteer(SESSION, "m1", "run-1")).rejects.toThrow(
      "already being delivered",
    );
  });

  test("a mutation replaces an invalid row and leaves another's alone", async () => {
    const future = { queueKey: SIBLING, environmentId: "e2", shape: "from a newer build" };
    const { storage, dataDir } = await seeded({
      [KEY]: { queueKey: KEY, environmentId: "e1", revision: 1 },
      [SIBLING]: future,
    });
    expect(await storage.getPromptQueue(KEY)).toBeNull();
    expect(await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" })).toMatchObject({
      messages: [{ id: "m1" }],
      revision: 1,
    });
    expect(readStoredValue<Record<string, unknown>>(dataDir, QUEUES)?.[SIBLING]).toEqual(future);
  });

  test("an unparsable row costs that row, and its queue's next write replaces it", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }]),
      [SIBLING]: sibling(),
    });
    setRow(storage, KEY, "{ not json");

    expect(await storage.getPromptQueue(KEY)).toBeNull();
    expect((await storage.listAllPromptQueues()).map((queue) => queue.queueKey)).toEqual([SIBLING]);
    expect(await storage.listPromptQueues("e2")).toEqual([sibling()]);
    expect(await storage.enqueuePromptQueueMessage(SIBLING, "e2", { id: "s2" })).toMatchObject({
      revision: 2,
    });

    expect(await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" })).toMatchObject({
      messages: [{ id: "m2" }],
      revision: 1,
    });
    expect((await storage.listAllPromptQueues()).length).toBe(2);
  });

  test("an unreadable store still reads as empty and the next write replaces it", async () => {
    const { storage, dataDir } = await seeded({});
    seedUnreadableStore(dataDir, QUEUES);
    expect(await storage.listAllPromptQueues()).toEqual([]);
    expect(await storage.getPromptQueue(KEY)).toBeNull();
    expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([]);
    expect(await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" })).toMatchObject({
      revision: 1,
    });
    expect(storageDatabase(storage).readStoreHeader("prompt-queues")?.mode).toBe("rows");
    expect(await storage.listAllPromptQueues()).toHaveLength(1);
  });
});

describe("deleting an environment's prompt queues", () => {
  const SECOND = "claude\0env-e1:tab-2";

  test("removes that environment's rows only and reports their keys", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }]),
      [SECOND]: record(SECOND, "e1", []),
      [SIBLING]: sibling(),
    });
    const writes = countRowWrites(storage);
    writes.reset();
    expect((await storage.deletePromptQueuesByEnvironment("e1")).sort()).toEqual([KEY, SECOND]);
    expect(writes.keys().sort()).toEqual([KEY, SECOND]);
    expect(await storage.getPromptQueue(KEY)).toBeNull();
    expect(await storage.getPromptQueue(SIBLING)).toEqual(sibling());
  });

  test("announces once, and not at all when nothing readable went", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", []),
      [SECOND]: record(SECOND, "e1", []),
    });
    const events: Array<{ resource: string }> = [];
    storage.setResourceChangeListener((change) => events.push(change));
    await storage.deletePromptQueuesByEnvironment("e1");
    await storage.deletePromptQueuesByEnvironment("e1");
    expect(events.filter((event) => event.resource === "prompt-queue")).toHaveLength(1);
  });

  test("takes what cannot be attributed and keeps what names another environment", async () => {
    const future = { queueKey: SIBLING, environmentId: "e2", shape: "from a newer build" };
    const { storage, dataDir } = await seeded({
      [KEY]: { queueKey: KEY, environmentId: "e1", text: "invalid but ours" },
      "claude\0env-x:junk": { text: "names nobody" },
      "claude\0env-x:torn": record("claude\0env-x:torn", "e2", []),
      [SIBLING]: future,
    });
    setRow(storage, "claude\0env-x:torn", "{ not json");
    // None of those was a readable queue of this environment.
    expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([]);
    expect(readStoredValue(dataDir, QUEUES)).toEqual({ [SIBLING]: future });
  });

  test("keeps damaged tmux rows whose keys name another environment", async () => {
    const ours = "claude-tmux\0env:e1:tab:tab-1";
    const theirs = "claude-tmux\0env:e2:tab:tab-1";
    const invalid = "claude-tmux\0env:e2:tab:tab-2";
    const { storage } = await seeded({
      [ours]: record(ours, "e1", []),
      [theirs]: record(theirs, "e2", []),
      [invalid]: { shape: "unknown" },
    });
    setRow(storage, ours, "{ not json");
    setRow(storage, theirs, "{ not json");
    await storage.deletePromptQueuesByEnvironment("e1");
    const rows = storageDatabase(storage).readStoreSerialized("prompt-queues");
    expect(rows?.mode).toBe("rows");
    if (rows?.mode !== "rows") throw new Error("expected rows");
    const retained = Array.from(rows.rows);
    expect(retained.map((row) => row.key).sort()).toEqual([theirs, invalid].sort());
    expect(retained.find((row) => row.key === theirs)?.value).toBe("{ not json");
  });

  test("an unparsable row elsewhere does not hide the environment's queues", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }]),
      [SIBLING]: sibling(),
    });
    setRow(storage, SIBLING, "{ not json");
    expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([KEY]);
    expect(await storage.getPromptQueue(KEY)).toBeNull();
  });

  test("a failure part-way leaves the rest for a retry to finish", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1" }]),
      [SECOND]: record(SECOND, "e1", [{ id: "m2" }]),
      [SIBLING]: sibling(),
    });
    const { context } = storageInternals(storage);
    const real = context.updateSensitiveStoreRow.bind(context);
    const events: Array<{ resource: string }> = [];
    storage.setResourceChangeListener((change) => events.push(change));
    let calls = 0;
    const update = spyOn(context, "updateSensitiveStoreRow").mockImplementation(((
      ...args: Parameters<typeof real>
    ) => {
      if (++calls === 2) throw new Error("disk full");
      return real(...args);
    }) as never);
    await expect(storage.deletePromptQueuesByEnvironment("e1")).rejects.toThrow("disk full");
    update.mockRestore();
    expect(events.filter((event) => event.resource === "prompt-queue")).toHaveLength(1);
    expect(await storage.listPromptQueues("e1")).toHaveLength(1);
    expect(await storage.deletePromptQueuesByEnvironment("e1")).toHaveLength(1);
    expect(events.filter((event) => event.resource === "prompt-queue")).toHaveLength(2);
    expect(await storage.listPromptQueues("e1")).toEqual([]);
    expect(await storage.getPromptQueue(SIBLING)).toEqual(sibling());
  });
});

describe("the retired JSON archive of prompt queues", () => {
  /** Opens a directory upgraded from JSON files, with one backup, and its archive files. */
  async function migrated(queues: Record<string, unknown>) {
    const dataDir = await emptyDataDir();
    const raw = `${JSON.stringify(queues, null, 2)}\n`;
    await fs.writeFile(path.join(dataDir, QUEUES), raw);
    await fs.writeFile(path.join(dataDir, `${QUEUES}.bak.1`), raw);
    const storage = await open(dataDir);
    await addEnvironments(storage);
    const [stamp] = await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY));
    const archive = path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp!);
    const copies = async () => {
      const names = (await fs.readdir(archive)).sort();
      expect(names.length).toBeGreaterThan(0);
      return Promise.all(names.map((name) => fs.readFile(path.join(archive, name), "utf8")));
    };
    return { storage, copies };
  }

  test("a mutation that removes nothing leaves the archive byte-identical", async () => {
    const { storage, copies } = await migrated({
      [KEY]: record(KEY, "e1", [{ id: "m1", text: "archived-text" }]),
    });
    const before = await copies();
    await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2", text: "new" });
    expect(await copies()).toEqual(before);
  });

  test("a removal prunes that queue's archived copies and no other queue's", async () => {
    const { storage, copies } = await migrated({
      [KEY]: record(KEY, "e1", [
        { id: "m1", text: "removed-text" },
        { id: "m2", text: "kept-text" },
      ]),
      [SIBLING]: sibling(),
    });
    await storage.removePromptQueueMessage(KEY, "e1", "m1");
    for (const copy of await copies()) {
      expect(copy).not.toContain("removed-text");
      expect(copy).toContain("kept-text");
      expect(copy).toContain(SIBLING_TEXT);
    }
  });

  for (const operation of ["replace", "delete"] as const) {
    test(`an unreadable row journals archive cleanup on ${operation}`, async () => {
      const { storage, copies } = await migrated({
        [KEY]: record(KEY, "e1", [{ id: "m1", text: "torn-archived-text" }]),
        [SIBLING]: sibling(),
      });
      setRow(storage, KEY, "{ not json");
      const journal = spyOn(storageDatabase(storage), "writeStoreInTransaction");
      try {
        if (operation === "replace") {
          await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
        } else {
          await storage.deletePromptQueuesByEnvironment("e1");
        }
        const cleanups = journal.mock.calls.filter(([store]) => store !== "prompt-queues");
        expect(JSON.stringify(cleanups)).toContain(
          operation === "replace" ? "prune-row" : "delete-row",
        );
        expect(JSON.stringify(cleanups)).not.toContain(SIBLING_TEXT);
        for (const copy of await copies()) {
          expect(copy).not.toContain("torn-archived-text");
          expect(copy).toContain(SIBLING_TEXT);
        }
        expect(await storage.getPromptQueue(SIBLING)).toEqual(sibling());
      } finally {
        journal.mockRestore();
      }
    });
  }

  test("deleting an environment scrubs its archived queues and keeps others'", async () => {
    const { storage, copies } = await migrated({
      [KEY]: record(KEY, "e1", [{ id: "m1", text: "deleted-text" }]),
      [SIBLING]: sibling(),
    });
    expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([KEY]);
    for (const copy of await copies()) {
      expect(copy).not.toContain("deleted-text");
      expect(copy).toContain(SIBLING_TEXT);
    }
    expect(await storage.getPromptQueue(SIBLING)).toEqual(sibling());
  });

  test("a queue's write journals only its own row", async () => {
    const { storage } = await migrated({
      [KEY]: record(KEY, "e1", [{ id: "m1", text: "removed-text" }]),
      [SIBLING]: sibling(),
    });
    const journal = spyOn(storageDatabase(storage), "writeStoreInTransaction");
    await storage.removePromptQueueMessage(KEY, "e1", "m1");
    const cleanups = journal.mock.calls.filter(([store]) => store !== "prompt-queues");
    journal.mockRestore();
    expect(JSON.stringify(cleanups)).toContain("prune-row");
    expect(JSON.stringify(cleanups)).not.toContain(SIBLING_TEXT);
  });
});

describe("prompt queue lease order and races", () => {
  /** Records each lease the service takes and which were held when it asked. */
  function traceLeases(storage: StorageService) {
    const { context } = storageInternals(storage);
    const real = context.serialize.bind(context);
    const held: string[] = [];
    const taken: Array<{ lease: string; holding: string[] }> = [];
    const kind = (target: string) =>
      target.includes("native-agent-session-leases")
        ? "session"
        : target.endsWith(QUEUES)
          ? "queue"
          : "other";
    const spy = spyOn(context, "serialize").mockImplementation(((
      target: string,
      description: string,
      operation: () => Promise<unknown>,
      options?: never,
    ) => {
      const lease = kind(target);
      taken.push({ lease, holding: [...held] });
      return real(
        target,
        description,
        async () => {
          held.push(lease);
          try {
            return await operation();
          } finally {
            held.pop();
          }
        },
        options,
      );
    }) as never);
    return { taken, restore: () => spy.mockRestore() };
  }

  test("a steer takes the session lease first and never one under the queue lease", async () => {
    const { storage } = await seeded({
      [KEY]: record(KEY, "e1", [{ id: "m1", text: "first" }]),
    });
    const trace = traceLeases(storage);
    await storage.reservePromptQueueSteer(SESSION, "m1", "run-1");
    await storage.reconcileNativeAgentSteer(SESSION, "m1", async () => "absent");
    await storage.reservePromptQueueSteer(SESSION, "m1", "run-2");
    await storage.clearPendingNativeAgentSteer(SESSION, "m1");
    await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
    await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", { id: "m3" });
    trace.restore();

    const relevant = trace.taken.filter(({ lease }) => lease !== "other");
    expect(relevant.map(({ lease }) => lease).slice(0, 2)).toEqual(["session", "queue"]);
    // The queue lease under the session lease, on both steer paths.
    expect(relevant.some((t) => t.lease === "queue" && t.holding.includes("session"))).toBe(true);
    expect(relevant.filter((t) => t.lease === "session" && t.holding.includes("queue"))).toEqual(
      [],
    );
  });

  test("a steer racing queue mutations loses no update, across two backends", async () => {
    const dataDir = await emptyDataDir();
    const first = await open(dataDir);
    await addEnvironments(first);
    const second = await open(dataDir);
    await first.getOrCreateNativeAgentSession(
      { key: SESSION, environmentId: "e1", agent: "claude", logicalSessionKey: LOGICAL },
      async () => "provider-1",
    );

    for (let round = 0; round < 8; round += 1) {
      const head = `steer-${round}`;
      await first.enqueuePromptQueueMessage(KEY, "e1", { id: head, text: "steer this" });
      const before = (await first.getPromptQueue(KEY))!;
      const added = [0, 1, 2, 3].map((i) => `r${round}-${i}`);
      const [pending] = await Promise.all([
        first.reservePromptQueueSteer(SESSION, head, `run-${round}`),
        second.enqueuePromptQueueMessage(KEY, "e1", { id: added[0], text: "a" }),
        first.enqueuePromptQueueMessage(KEY, "e1", { id: added[1], text: "b" }),
        second.enqueuePromptQueueMessageIfAbsent(KEY, "e1", { id: added[2], text: "c" }),
        second.enqueuePromptQueueMessage(SIBLING, "e2", { id: added[3], text: "d" }),
      ]);
      expect(pending?.requestId).toBe(head);

      const reserved = (await second.getPromptQueue(KEY))!;
      expect(reserved.inFlight?.requestId).toBe(head);
      expect(reserved.revision).toBe(before.revision + 4);
      const reservedIds = reserved.messages.map((message) => (message as { id: string }).id);
      expect(reservedIds).toEqual(expect.arrayContaining(added.slice(0, 3)));
      expect(reservedIds).not.toContain(head);

      // Settlement racing another append keeps that append too.
      await Promise.all([
        first.confirmNativeAgentSteer(SESSION, head),
        second.enqueuePromptQueueMessage(KEY, "e1", { id: `late-${round}`, text: "e" }),
      ]);
      const settled = (await first.getPromptQueue(KEY))!;
      expect(settled.inFlight).toBeUndefined();
      expect(settled.revision).toBe(before.revision + 6);
      const settledIds = settled.messages.map((message) => (message as { id: string }).id);
      expect(settledIds).toEqual(expect.arrayContaining([...added.slice(0, 3), `late-${round}`]));
      expect(settledIds).not.toContain(head);
      expect((await first.getNativeAgentSession(SESSION))?.dispatchedRequestIds).toContain(head);
    }
    const others = (await second.getPromptQueue(SIBLING))!;
    expect(others.messages).toHaveLength(8);
  });
});

describe("prompt queue stores across versions", () => {
  test("a store written by the previous version's whole-value save loads and mutates", async () => {
    const claim = {
      token: "t-old",
      message: { id: "claimed", text: "claimed" },
      claimedAt: STAMP,
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    const written = {
      [KEY]: record(KEY, "e1", [{ id: "m1", text: "first" }], {
        outstandingClaim: claim,
        removedOrigins: [{ requestId: "gone", removedAt: STAMP }],
      }),
      [SIBLING]: sibling(),
    };
    const { storage, dataDir } = await seeded({});
    const old = storageDatabase(storage);
    old.writeStore("prompt-queues", written);
    expect(old.readStoreHeader("prompt-queues")?.mode).toBe("rows");

    expect((await storage.listAllPromptQueues()).map((queue) => queue.queueKey)).toEqual([
      KEY,
      SIBLING,
    ]);
    await expectOnlyTargetRow(storage, () =>
      storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" }),
    );
    expect(await storage.getPromptQueue(KEY)).toMatchObject({
      messages: [{ id: "claimed" }, { id: "m1" }, { id: "m2" }],
      removedOrigins: [{ requestId: "gone" }],
      revision: 2,
    });
    // Both rows remain what the previous version's reader assembles.
    const stored = readStoredValue<typeof written>(dataDir, QUEUES)!;
    expect(stored[SIBLING]).toEqual(sibling());
    expect(Object.keys(stored)).toEqual([KEY, SIBLING]);
  });

  test("a store this version wrote is what the previous version reads and rewrites", async () => {
    const { storage, dataDir } = await seeded({});
    await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1", text: "first" });
    await storage.enqueuePromptQueueMessage(SIBLING, "e2", { id: "s1", text: SIBLING_TEXT });
    await storage.removePromptQueueMessage(KEY, "e1", "absent");

    const { db } = storageDatabase(storage);
    expect(
      db
        .query(
          "SELECT collection, key, owner FROM store_rows WHERE store = 'prompt-queues' ORDER BY position",
        )
        .all(),
    ).toEqual([
      { collection: "", key: KEY, owner: null },
      { collection: "", key: SIBLING, owner: null },
    ]);
    expect(storageDatabase(storage).readStoreHeader("prompt-queues")).toMatchObject({
      mode: "rows",
    });

    // The previous version reads the assembled value and diffs a whole-value
    // save against the rows, on another connection under the same lease.
    const whole = readStoredValue<Record<string, { revision: number; messages: unknown[] }>>(
      dataDir,
      QUEUES,
    )!;
    expect(whole[KEY]).toMatchObject({ messages: [{ id: "m1", text: "first" }], revision: 1 });
    seedStore(dataDir, QUEUES, {
      ...whole,
      [KEY]: { ...whole[KEY], messages: [{ id: "m1", text: "edited" }], revision: 2 },
    });

    // A running backend of this version sees the older writer's commit.
    expect(await storage.getPromptQueue(KEY)).toMatchObject({
      messages: [{ id: "m1", text: "edited" }],
      revision: 2,
    });
    expect(await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" })).toMatchObject({
      revision: 3,
    });
    expect(await storage.getPromptQueue(SIBLING)).toMatchObject({ revision: 1 });
  });

  test("a claim an older backend writes while this one runs is held and recovered", async () => {
    const { storage, dataDir } = await seeded({ [KEY]: record(KEY, "e1", [{ id: "m1" }]) });
    await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
    const whole = readStoredValue<Record<string, { messages: unknown[]; revision: number }>>(
      dataDir,
      QUEUES,
    )!;
    seedStore(dataDir, QUEUES, {
      ...whole,
      [KEY]: {
        ...whole[KEY],
        messages: [{ id: "m2" }],
        outstandingClaim: {
          token: "t-old",
          message: { id: "m1" },
          claimedAt: STAMP,
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        revision: 3,
      },
    });
    expect(await storage.reservePromptQueueHeadForDispatch(KEY)).toBeNull();
    expect(await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" })).toMatchObject({
      revision: 3,
    });
  });
});
