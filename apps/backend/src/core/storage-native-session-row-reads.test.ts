import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PersistedNativeAgentSession } from "./models.js";
import { createEnvironment, StorageService } from "./storage.js";
import { seedStore, storageDatabase, storageInternals } from "./storage-test-support.js";
import { backfillNativeAgentSessionOwners } from "./storage-stores.js";

const STORE = "native-agent-sessions";
const FILE = "native-agent-sessions.json";
const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function service(directory?: string): Promise<StorageService> {
  const dataDir = directory ?? (await fs.mkdtemp(path.join(tmpdir(), "ork-native-session-rows-")));
  if (!directory) directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  return storage;
}

async function createSession(
  storage: StorageService,
  environmentId: string,
  tab: string,
): Promise<PersistedNativeAgentSession> {
  return storage.getOrCreateNativeAgentSession(
    {
      key: `key-${tab}`,
      environmentId,
      agent: "claude",
      logicalSessionKey: tab,
    },
    async () => `provider-${tab}`,
  );
}

/** Replaces one row's stored text, as a damaged or newer row would read. */
function writeRawRow(storage: StorageService, key: string, value: string): void {
  storageDatabase(storage)
    .db.query("UPDATE store_rows SET value = ? WHERE store = ? AND key = ?")
    .run(value, STORE, key);
  storageDatabase(storage)
    .db.query("UPDATE stores SET revision = revision + 1 WHERE name = ?")
    .run(STORE);
}

function rawRow(storage: StorageService, key: string): unknown {
  return storageDatabase(storage)
    .db.query("SELECT * FROM store_rows WHERE store = ? AND key = ?")
    .get(STORE, key);
}

describe("native session mutations read one row", () => {
  test("a mutation reads and writes only its own key", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const other = await createSession(storage, environment.id, "b");
    const otherRow = rawRow(storage, other.key);
    const key = session.key;
    const provider = session.providerSessionId;
    const database = storageDatabase(storage);

    database.db.exec("CREATE TEMP TABLE session_row_writes (key TEXT NOT NULL)");
    for (const [event, row] of [
      ["INSERT", "new"],
      ["UPDATE", "new"],
      ["DELETE", "old"],
    ] as const) {
      database.db.exec(`CREATE TEMP TRIGGER session_row_write_${event}
        AFTER ${event} ON main.store_rows WHEN ${row}.store = '${STORE}'
        BEGIN INSERT INTO session_row_writes VALUES (${row}.key); END`);
    }
    const wholeReads = spyOn(database, "readStore");
    const wholeLoads = spyOn(
      storageInternals(storage).repos.nativeAgentSessions,
      "loadNativeAgentSessions",
    );
    try {
      await storage.adoptNativeAgentSession({
        key,
        environmentId: environment.id,
        agent: "claude",
        logicalSessionKey: "a",
        providerSessionId: provider,
        controls: { modelId: "model-1" },
      });
      await storage.updateNativeAgentSessionControls(key, provider, { modelId: "model-2" });
      await storage.initializeNativeAgentSessionInferredComposerIfAbsent(key, provider, {
        modelId: "ignored",
      });
      await storage.recordNativeAgentSessionResumeIdentity(key, provider, "resume-1");
      await storage.recordNativeAgentSessionBackendTitle(key, {
        providerSessionId: provider,
        title: "A title",
        source: "generated",
      });
      await storage.setIncompleteTurnNotice(key, provider, {
        kind: "failed",
        assistantMessageId: "assistant-1",
        updatedAt: new Date().toISOString(),
      });
      await storage.updateNativeAgentGoal(key, () => undefined);
      await storage.dispatchNativeAgentPromptOnce(key, "request-1", async () => undefined);
      const current = (await storage.getNativeAgentSession(key))!;
      await storage.recordNativeAgentActivityTurn(current, "active");
      await storage.recordNativeAgentTurnOutcome(key, provider, {
        requestId: "request-1",
        outcome: "completed",
        observedAt: new Date().toISOString(),
      });
      await storage.recordNativeAgentTurnInterrupt(key, provider, "request-1");
      await storage.recordNativeAgentSignInResend(key, {
        requestId: "request-1",
        providerSessionId: provider,
        prompt: "again",
        recordedAt: new Date().toISOString(),
      });
      await storage.takeNativeAgentSignInResend(key, "request-1");
      for (const [requestId, finish] of [
        ["parked-1", () => storage.confirmNativeAgentDispatch(key, "parked-1")],
        ["parked-2", () => storage.clearPendingNativeAgentDispatch(key, "parked-2")],
        ["parked-3", () => storage.retireNativeAgentDispatch(key, "parked-3")],
      ] as const) {
        await storage.dispatchNativeAgentPromptOnce(
          key,
          requestId,
          async () => ({ dispatched: false, mailRefused: true }),
          { requestId, prompt: "text", createdAt: new Date().toISOString() },
        );
        expect(await finish()).toBe(true);
      }
      const steer = {
        requestId: "steer-1",
        text: "steer",
        inputDigest: "a".repeat(64),
        expectedRunId: "run-1",
        state: "prepared" as const,
        createdAt: new Date().toISOString(),
      };
      await storage.dispatchNativeAgentSteerOnce(key, steer, async () => {
        throw new Error("ambiguous");
      });
      expect(await storage.confirmNativeAgentSteer(key, steer.requestId)).toBe(true);
      await storage.dispatchNativeAgentSteerOnce(key, { ...steer, requestId: "steer-2" }, () => {
        throw new Error("ambiguous");
      });
      expect(await storage.clearPendingNativeAgentSteer(key, "steer-2")).toBe(true);
      expect((await storage.readNativeAgentPublicationState(key, "claude\0a")).session?.key).toBe(
        key,
      );
      expect(await storage.invalidateNativeAgentSession(key, provider)).toBe(true);

      expect(wholeReads.mock.calls.filter(([store]) => store === STORE)).toEqual([]);
      expect(wholeLoads).not.toHaveBeenCalled();
    } finally {
      wholeReads.mockRestore();
      wholeLoads.mockRestore();
    }
    const written = database.db.query("SELECT DISTINCT key FROM session_row_writes").all();
    expect(written).toEqual([{ key }]);
    expect(rawRow(storage, other.key)).toEqual(otherRow);
  });

  test("whole-store loads remain only where the whole store is the question", () => {
    const source = (file: string) => readFileSync(path.join(import.meta.dir, file), "utf8");
    expect(source("storage-native-deliveries.ts")).not.toContain("loadNativeAgentSessions");
    // The owner migration's walk, both document fallbacks, the list and the
    // environment sweep's fallback for a store held whole or buffered by an
    // atomic scope. None holds a key's lease.
    expect(source("storage-native.ts").match(/this\.loadNativeAgentSessions\(\)/g)).toHaveLength(5);
  });
});

describe("the unreadable-record refusal stays with its key", () => {
  test("a record this build cannot read still refuses every mutation of that key", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const future = { ...session, version: 99 };
    seedStore(storage.getDataDir(), FILE, { [session.key]: future });
    const provider = session.providerSessionId;

    for (const mutate of [
      () => storage.recordNativeAgentActivityTurn(session, "active"),
      () => storage.recordNativeAgentTurnInterrupt(session.key, provider, "request-1"),
      () => storage.updateNativeAgentGoal(session.key, () => undefined),
      () => storage.dispatchNativeAgentPromptOnce(session.key, "request-1", async () => undefined),
      () => storage.readNativeAgentPublicationState(session.key, "queue"),
    ]) {
      await expect(mutate()).rejects.toThrow("invalid or uses an unsupported version");
    }
    expect(await storage.listNativeAgentSessions()).toEqual([]);
  });

  test("damaged JSON in its own row refuses, before any provider create", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    writeRawRow(storage, session.key, "{ not json");
    let created = 0;
    await expect(
      storage.getOrCreateNativeAgentSession(
        {
          key: session.key,
          environmentId: environment.id,
          agent: "claude",
          logicalSessionKey: "a",
        },
        async () => {
          created += 1;
          return "second-provider-session";
        },
      ),
    ).rejects.toThrow("invalid or uses an unsupported version");
    expect(created).toBe(0);
    await expect(
      storage.recordNativeAgentTurnInterrupt(session.key, session.providerSessionId, "request-1"),
    ).rejects.toThrow("invalid or uses an unsupported version");
  });

  test("another key's bad rows neither stop this key nor get rewritten", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const newer = await createSession(storage, environment.id, "newer");
    const damaged = await createSession(storage, environment.id, "damaged");
    writeRawRow(storage, newer.key, JSON.stringify({ ...newer, version: 99 }));
    writeRawRow(storage, damaged.key, "{ not json");
    const before = [rawRow(storage, newer.key), rawRow(storage, damaged.key)];

    await storage.dispatchNativeAgentPromptOnce(session.key, "request-1", async () => undefined);
    await storage.recordNativeAgentTurnInterrupt(
      session.key,
      session.providerSessionId,
      "request-1",
    );

    const stored = await storage.getNativeAgentSession(session.key);
    expect(stored?.dispatchedRequestIds).toEqual(["request-1"]);
    expect(stored?.interruptedRequestIds).toEqual(["request-1"]);
    expect([rawRow(storage, newer.key), rawRow(storage, damaged.key)]).toEqual(before);
  });

  test("the environment sweep passes over a record it cannot attribute", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const newer = await createSession(storage, environment.id, "newer");
    writeRawRow(storage, newer.key, JSON.stringify({ ...newer, version: 99 }));

    await storage.deleteNativeAgentSessionsByEnvironment(environment.id);

    expect(await storage.getNativeAgentSession(session.key)).toBeNull();
    expect(rawRow(storage, newer.key)).toBeTruthy();
  });

  test("a store held whole is read whole, and a non-record refuses", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    seedStore(storage.getDataDir(), FILE, [1, 2]);
    await expect(storage.recordNativeAgentActivityTurn(session, "active")).rejects.toThrow(
      "Stored native agent sessions are invalid",
    );
  });
});

describe("what a row read hands a mutation", () => {
  test("changing it never touches the shared frozen snapshot", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const [frozen] = await storage.readNativeAgentSessionsSnapshot();
    expect(Object.isFrozen(frozen)).toBe(true);
    const held = JSON.stringify(frozen);

    await storage.updateNativeAgentGoal(session.key, (_goal, current) => {
      expect(Object.isFrozen(current)).toBe(false);
      return undefined;
    });
    await storage.recordNativeAgentTurnInterrupt(
      session.key,
      session.providerSessionId,
      "unknown-request",
    );
    await storage.dispatchNativeAgentPromptOnce(session.key, "request-1", async () => undefined);

    expect(JSON.stringify(frozen)).toBe(held);
    const [next] = await storage.readNativeAgentSessionsSnapshot();
    expect(next?.dispatchedRequestIds).toEqual(["request-1"]);
  });

  test("a mutation sees another backend's commit to its row", async () => {
    const first = await service();
    const second = await service(first.getDataDir());
    const environment = await first.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(first, environment.id, "a");
    await second.dispatchNativeAgentPromptOnce(session.key, "request-1", async () => undefined);
    expect(
      await first.recordNativeAgentTurnInterrupt(
        session.key,
        session.providerSessionId,
        "request-1",
      ),
    ).toBe(true);
  });
});

describe("concurrent native session writers", () => {
  test("two backends writing one key and other keys lose nothing", async () => {
    const first = await service();
    const second = await service(first.getDataDir());
    const environment = await first.addEnvironment(createEnvironment("project-1"));
    const shared = await createSession(first, environment.id, "shared");
    const mine = await createSession(first, environment.id, "mine");
    const yours = await createSession(first, environment.id, "yours");
    const provider = shared.providerSessionId;
    await first.dispatchNativeAgentPromptOnce(shared.key, "request-0", async () => undefined);
    const requests = Array.from({ length: 12 }, (_, index) => `request-${index + 1}`);

    await Promise.all(
      requests.flatMap((requestId, index) => {
        const writer = index % 2 === 0 ? first : second;
        return [
          writer.dispatchNativeAgentPromptOnce(shared.key, requestId, async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }),
          first.dispatchNativeAgentPromptOnce(mine.key, requestId, async () => undefined),
          second.dispatchNativeAgentPromptOnce(yours.key, requestId, async () => undefined),
        ];
      }),
    );
    await Promise.all(
      requests.map((requestId, index) =>
        (index % 2 === 0 ? second : first).recordNativeAgentTurnInterrupt(
          shared.key,
          provider,
          requestId,
        ),
      ),
    );

    const stored = (await first.getNativeAgentSession(shared.key))!;
    expect(stored.dispatchedRequestIds?.toSorted()).toEqual(["request-0", ...requests].toSorted());
    expect(stored.interruptedRequestIds?.toSorted()).toEqual(requests.toSorted());
    for (const key of [mine.key, yours.key]) {
      expect((await second.getNativeAgentSession(key))?.dispatchedRequestIds?.toSorted()).toEqual(
        requests.toSorted(),
      );
    }
  }, 30_000);
});

/** Clears the indexed owner, as on a row written before the store had one or by an older build. */
function clearOwner(storage: StorageService, key: string): void {
  storageDatabase(storage)
    .db.query("UPDATE store_rows SET owner = NULL WHERE store = ? AND key = ?")
    .run(STORE, key);
}

function ownerOf(storage: StorageService, key: string): string | null | undefined {
  return (rawRow(storage, key) as { owner: string | null } | null)?.owner;
}

describe("the environment sweep reads only its environment's rows (todo 6120 task 6)", () => {
  test("every write records the session's environment as the row's indexed owner", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    expect(ownerOf(storage, session.key)).toBe(environment.id);
    await storage.dispatchNativeAgentPromptOnce(session.key, "request-1", async () => undefined);
    expect(ownerOf(storage, session.key)).toBe(environment.id);
  });

  test("finds its keys by owner without decoding the store", async () => {
    const storage = await service();
    const doomed = await storage.addEnvironment(createEnvironment("project-1"));
    const kept = await storage.addEnvironment(createEnvironment("project-1"));
    const first = await createSession(storage, doomed.id, "a");
    const second = await createSession(storage, doomed.id, "b");
    const other = await createSession(storage, kept.id, "c");
    const otherRow = rawRow(storage, other.key);
    const database = storageDatabase(storage);
    const wholeReads = spyOn(database, "readStore");
    const wholeLoads = spyOn(
      storageInternals(storage).repos.nativeAgentSessions,
      "loadNativeAgentSessions",
    );
    try {
      await storage.deleteNativeAgentSessionsByEnvironment(doomed.id);
      expect(wholeReads.mock.calls.filter(([store]) => store === STORE)).toEqual([]);
      expect(wholeLoads).not.toHaveBeenCalled();
    } finally {
      wholeReads.mockRestore();
      wholeLoads.mockRestore();
    }
    expect(await storage.getNativeAgentSession(first.key)).toBeNull();
    expect(await storage.getNativeAgentSession(second.key)).toBeNull();
    expect(rawRow(storage, other.key)).toEqual(otherRow);
  });

  test("still finds a row that has no owner, and leaves another environment's", async () => {
    const storage = await service();
    const doomed = await storage.addEnvironment(createEnvironment("project-1"));
    const kept = await storage.addEnvironment(createEnvironment("project-1"));
    const unowned = await createSession(storage, doomed.id, "a");
    const otherUnowned = await createSession(storage, kept.id, "b");
    const damaged = await createSession(storage, doomed.id, "damaged");
    clearOwner(storage, unowned.key);
    clearOwner(storage, otherUnowned.key);
    writeRawRow(storage, damaged.key, "{ not json");
    clearOwner(storage, damaged.key);

    await storage.deleteNativeAgentSessionsByEnvironment(doomed.id);

    expect(await storage.getNativeAgentSession(unowned.key)).toBeNull();
    expect((await storage.getNativeAgentSession(otherUnowned.key))?.environmentId).toBe(kept.id);
    // Nothing can prove which environment an unreadable row belongs to.
    expect(rawRow(storage, damaged.key)).toBeTruthy();
  });

  test("inside an atomic scope that buffers the store, reads the buffered value", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const { context, repos } = storageInternals(storage);
    const buffered = { ...session, key: "key-buffered", logicalSessionKey: "buffered" };
    await context.atomically(async () => {
      await repos.nativeAgentSessions.saveNativeAgentSession(buffered.key, buffered);
      expect(
        context.listStoreRowKeysByOwner(path.join(storage.getDataDir(), FILE), environment.id),
      ).toBeUndefined();
    });
    expect((await storage.getNativeAgentSession(buffered.key))?.key).toBe(buffered.key);
    await storage.deleteNativeAgentSessionsByEnvironment(environment.id);
    expect(await storage.listNativeAgentSessions()).toEqual([]);
  });

  test("open gives unowned rows their environment, once, without changing a value", async () => {
    const storage = await service();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const session = await createSession(storage, environment.id, "a");
    const damaged = await createSession(storage, environment.id, "damaged");
    writeRawRow(storage, damaged.key, "{ not json");
    clearOwner(storage, session.key);
    clearOwner(storage, damaged.key);
    const value = (rawRow(storage, session.key) as { value: string }).value;

    const database = storageDatabase(storage);
    expect(backfillNativeAgentSessionOwners(database)).toBe(1);
    expect(ownerOf(storage, session.key)).toBe(environment.id);
    expect((rawRow(storage, session.key) as { value: string }).value).toBe(value);
    expect(ownerOf(storage, damaged.key)).toBeNull();
    expect(backfillNativeAgentSessionOwners(database)).toBe(0);

    // A backend opening the directory does the same.
    clearOwner(storage, session.key);
    const reopened = await service(storage.getDataDir());
    expect(ownerOf(reopened, session.key)).toBe(environment.id);
  });
});
