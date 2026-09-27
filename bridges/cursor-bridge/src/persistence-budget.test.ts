/**
 * INC-03: the state file holds every session, so its budget is aggregate.
 *
 * The pure serializer is exercised at small budgets for exact byte behaviour;
 * the real 32 MiB ceiling is exercised once end to end through the production
 * write queue, so the bound the shipped bridge enforces is the one tested.
 * Nothing here raises a production limit to make a case easy.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { readFile, stat, writeFile as realWriteFile } from "node:fs/promises";
import { newSessionState } from "./agent-session.js";
import { MAX_STATE_FILE_BYTES } from "./config.js";
import { emptyComposer } from "./models.js";
import {
  PersistenceError,
  serializeWithinBudget,
  type BudgetedSession,
  type EssentialRecord,
} from "./persistence-budget.js";
import {
  loadPersistedState,
  persistBarrier,
  schedulePersist,
  usePersistenceFsForTests,
} from "./persistence.js";
import { clientSessionKeys, sessions, type BridgeMessage, type SessionState } from "./state.js";
import { deferred, startRouterHarness, type RouterHarness } from "./testing/router-harness.js";

const MiB = 1024 * 1024;
const ENVELOPE = { version: 1, provider: "cursor" } as const;

function textMessage(id: string, text: string): BridgeMessage {
  return {
    id,
    role: "assistant",
    content: text,
    parts: [{ type: "text", content: text, sourcePartId: `${id}:0`, sourceMessageId: id }],
    createdAt: new Date(0).toISOString(),
  };
}

function essential(id: string, extra: Partial<EssentialRecord> = {}): EssentialRecord {
  return {
    id,
    agentId: `agent-${id}`,
    status: "idle",
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    revision: 1,
    structured: [],
    promptJournal: [],
    steerJournal: [],
    composer: emptyComposer(),
    ...extra,
  };
}

function budgeted(
  id: string,
  lastAccessed: number,
  messages: BridgeMessage[],
  extra: Partial<EssentialRecord> = {},
): BudgetedSession {
  return { id, lastAccessed, essential: essential(id, extra), messages };
}

function shedIds(sessionsIn: readonly BudgetedSession[], budget: number): string[] {
  return serializeWithinBudget(ENVELOPE, sessionsIn, budget).shed.slice().sort();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("serializeWithinBudget (pure)", () => {
  test("fits exactly at the boundary and sheds one byte under it", () => {
    const session = budgeted("s1", 1, [textMessage("m0", "x".repeat(100))]);
    const full = serializeWithinBudget(ENVELOPE, [session], Number.MAX_SAFE_INTEGER);
    expect(full.shed).toEqual([]);
    expect(full.bytes).toBe(Buffer.byteLength(full.serialized));
    // The splice produces exactly what a plain serialization would.
    expect(JSON.parse(full.serialized)).toEqual({
      ...ENVELOPE,
      sessions: [{ ...session.essential, messages: session.messages }],
    });

    const exact = serializeWithinBudget(ENVELOPE, [session], full.bytes);
    expect(exact.shed).toEqual([]);
    expect(exact.serialized).toBe(full.serialized);
    expect(exact.bytes).toBe(full.bytes);

    const under = serializeWithinBudget(ENVELOPE, [session], full.bytes - 1);
    expect(under.shed).toEqual(["s1"]);
    expect(under.bytes).toBeLessThanOrEqual(full.bytes - 1);
    expect(Buffer.byteLength(under.serialized)).toBe(under.bytes);
    const record = (JSON.parse(under.serialized) as { sessions: Array<Record<string, unknown>> })
      .sessions[0]!;
    expect(record).toMatchObject({ id: "s1", agentId: "agent-s1", messages: [] });
    expect(record.transcriptTruncated).toBe(true);

    // One byte more of transcript at the same budget is the same decision.
    const grown = budgeted("s1", 1, [textMessage("m0", "x".repeat(101))]);
    expect(serializeWithinBudget(ENVELOPE, [grown], full.bytes).shed).toEqual(["s1"]);
  });

  test("the minimal essential snapshot is the admission boundary", () => {
    const session = budgeted("s1", 1, [textMessage("m0", "x".repeat(100))]);
    const full = serializeWithinBudget(ENVELOPE, [session], Number.MAX_SAFE_INTEGER);
    const minimal = serializeWithinBudget(ENVELOPE, [session], full.bytes - 1);
    expect(serializeWithinBudget(ENVELOPE, [session], minimal.bytes).shed).toEqual(["s1"]);

    let thrown: unknown;
    try {
      serializeWithinBudget(ENVELOPE, [session], minimal.bytes - 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersistenceError);
    expect((thrown as PersistenceError).code).toBe("persistence-budget-exceeded");
  });

  test("measures escaped and multibyte output in UTF-8 bytes, not characters", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const awkward = `"\\\n\t\u0001${lineSeparator}\u{1F600}漢字é`.repeat(200);
    const session = budgeted("s1", 1, [textMessage("m0", awkward)], {
      clientSessionKey: "ключ-\u{1F511}",
      error: 'bad "quote"\n',
    });
    const full = serializeWithinBudget(ENVELOPE, [session], Number.MAX_SAFE_INTEGER);
    expect(full.shed).toEqual([]);
    expect(full.bytes).toBe(Buffer.byteLength(full.serialized));
    // Multibyte text makes the byte size exceed the UTF-16 length.
    expect(full.bytes).toBeGreaterThan(full.serialized.length);
    const parsed = JSON.parse(full.serialized) as {
      sessions: Array<{ messages: BridgeMessage[]; clientSessionKey: string }>;
    };
    expect(parsed.sessions[0]!.messages[0]!.content).toBe(awkward);
    expect(parsed.sessions[0]!.clientSessionKey).toBe("ключ-\u{1F511}");

    // A budget equal to the character count would admit this file if the
    // accounting counted characters; in bytes it must shed.
    const byChars = serializeWithinBudget(ENVELOPE, [session], full.serialized.length);
    expect(byChars.shed).toEqual(["s1"]);
    expect(Buffer.byteLength(byChars.serialized)).toBe(byChars.bytes);
    expect(byChars.bytes).toBeLessThanOrEqual(full.serialized.length);

    for (const budget of [full.bytes, full.bytes - 1, full.bytes - 3]) {
      const result = serializeWithinBudget(ENVELOPE, [session], budget);
      expect(Buffer.byteLength(result.serialized)).toBe(result.bytes);
      expect(result.bytes).toBeLessThanOrEqual(budget);
      expect(() => JSON.parse(result.serialized)).not.toThrow();
    }
  });

  test("equal access times retain by id, independent of input order", () => {
    const text = "y".repeat(500);
    const make = (id: string) => budgeted(id, 5, [textMessage(`${id}-m`, text)]);
    const all = ["c", "a", "b"].map(make);
    const full = serializeWithinBudget(ENVELOPE, all, Number.MAX_SAFE_INTEGER);
    const single = serializeWithinBudget(ENVELOPE, [make("a")], Number.MAX_SAFE_INTEGER);
    const singleShed = serializeWithinBudget(ENVELOPE, [make("a")], single.bytes - 1);
    const perTranscript = single.bytes - singleShed.bytes;

    const orders = [
      ["a", "b", "c"],
      ["a", "c", "b"],
      ["b", "a", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
    ];
    for (const order of orders) {
      const input = order.map(make);
      expect(shedIds(input, full.bytes)).toEqual([]);
      expect(shedIds(input, full.bytes - perTranscript)).toEqual(["c"]);
      expect(shedIds(input, full.bytes - 2 * perTranscript)).toEqual(["b", "c"]);
    }

    // Recency still wins over the tie-breaker.
    const newest = budgeted("z", 9, [textMessage("z-m", text)]);
    expect(shedIds([make("a"), make("b"), newest], full.bytes - perTranscript)).toEqual(["b"]);
  });

  test("never mutates the records it is handed", () => {
    const live = [
      budgeted("a", 1, [textMessage("a-m", "a".repeat(300))], { droppedMessages: 4 }),
      budgeted("b", 2, [textMessage("b-m", "b".repeat(300))]),
    ];
    const before = JSON.stringify(live);
    deepFreeze(live);
    const full = serializeWithinBudget(ENVELOPE, live, Number.MAX_SAFE_INTEGER);
    const shed = serializeWithinBudget(ENVELOPE, live, full.bytes - 1);
    expect(shed.shed).toEqual(["a"]);
    expect(JSON.stringify(live)).toBe(before);
    expect(live[0]!.messages).toHaveLength(1);
    expect(live[0]!.essential.droppedMessages).toBe(4);
  });
});

describe("the real state file at its default ceiling", () => {
  let harness: RouterHarness;
  let warn: Mock<typeof console.warn>;

  beforeEach(async () => {
    harness = await startRouterHarness();
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    try {
      await harness.close();
    } finally {
      warn.mockRestore();
    }
  });

  /** Two messages whose text is `chunk`, each held in content and in its part. */
  function bigTranscript(prefix: string, chunk: string): BridgeMessage[] {
    return [textMessage(`${prefix}-0`, chunk), textMessage(`${prefix}-1`, chunk)];
  }

  function register(state: SessionState): SessionState {
    sessions.set(state.id, state);
    if (state.clientSessionKey) clientSessionKeys.set(state.clientSessionKey, state.id);
    return state;
  }

  interface Fixture {
    oldest: SessionState;
    middle: SessionState;
    newest: SessionState;
    small: SessionState;
  }

  /** Three ~12 MiB transcripts plus a small session: ~36 MiB against 32 MiB. */
  function largeFixture(): Fixture {
    const chunk = "a".repeat(3 * MiB);
    const make = (name: string, lastAccessed: number, messages: BridgeMessage[]) => {
      const state = newSessionState(`client-${name}`);
      state.agentId = `agent-${name}`;
      state.composer = {
        ...state.composer,
        selectedModelId: `model-${name}`,
        selectedModeId: "plan",
      };
      state.messages = messages;
      state.lastAccessed = lastAccessed;
      return register(state);
    };
    const oldest = make("oldest", 1_000, bigTranscript("oldest", chunk));
    oldest.droppedMessages = 40;
    oldest.droppedParts = 7;
    oldest.revision = 9;
    const middle = make("middle", 2_000, bigTranscript("middle", chunk));
    const newest = make("newest", 3_000, bigTranscript("newest", chunk));
    const small = make("small", 4_000, [textMessage("small-0", "hi")]);
    return { oldest, middle, newest, small };
  }

  async function publishedSessions(): Promise<Array<Record<string, unknown>>> {
    // Read as a fresh process would: straight from disk, nothing drained.
    const published = await harness.readPublished();
    return (published?.sessions ?? []) as Array<Record<string, unknown>>;
  }

  test("three 12 MiB transcripts and a small session publish every identity; shed copies stay live", async () => {
    const fixture = largeFixture();
    const liveOldestMessages = fixture.oldest.messages;

    await persistBarrier();

    expect((await stat(harness.stateFile)).size).toBeLessThanOrEqual(MAX_STATE_FILE_BYTES);
    const records = await publishedSessions();
    expect(records.map((record) => record.id).sort()).toEqual(
      Object.values(fixture)
        .map((state) => state.id)
        .sort(),
    );
    const byId = new Map(records.map((record) => [record.id as string, record]));
    // Oldest-touched transcript is the one shed; the rest are kept whole.
    expect(byId.get(fixture.oldest.id)!.messages).toEqual([]);
    expect(byId.get(fixture.oldest.id)!.transcriptTruncated).toBe(true);
    for (const kept of [fixture.middle, fixture.newest, fixture.small]) {
      expect((byId.get(kept.id)!.messages as unknown[]).length).toBe(kept.messages.length);
    }

    // The live transcript feeding a tab is untouched by the shed copy.
    expect(fixture.oldest.messages).toBe(liveOldestMessages);
    expect(fixture.oldest.messages).toHaveLength(2);
    expect(fixture.oldest.messages[0]!.content.length).toBe(3 * MiB);
    expect(fixture.oldest.droppedMessages).toBe(40);
    expect(fixture.oldest.transcriptTruncated).toBe(false);
    // The shed is surfaced once, as a bounded notice on that session.
    expect(
      fixture.oldest.health
        .listNotices()
        .filter((notice) => notice.method === "persistence" && notice.severity === "info"),
    ).toHaveLength(1);
    expect(fixture.middle.health.listNotices()).toHaveLength(0);

    const expected = Object.values(fixture).map((state) => ({
      id: state.id,
      clientSessionKey: state.clientSessionKey,
      agentId: state.agentId,
      selectedModelId: state.composer.selectedModelId,
    }));
    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();

    for (const identity of expected) {
      const restored = sessions.get(identity.id);
      expect(restored).toBeDefined();
      expect(restored!.agentId).toBe(identity.agentId);
      expect(restored!.clientSessionKey).toBe(identity.clientSessionKey);
      expect(clientSessionKeys.get(identity.clientSessionKey!)).toBe(identity.id);
      expect(restored!.composer.selectedModelId).toBe(identity.selectedModelId);
      expect(restored!.composer.selectedModeId).toBe("plan");
    }

    // A fresh process sees the shed transcript as explicitly truncated, with
    // the absolute base carried forward rather than reset, and a new revision.
    const shed = sessions.get(fixture.oldest.id)!;
    expect(shed.messages).toEqual([]);
    expect(shed.transcriptTruncated).toBe(true);
    expect(shed.droppedMessages).toBe(42);
    expect(shed.droppedParts).toBe(9);
    expect(shed.revision).toBe(10);
    expect(shed.agentId).toBe("agent-oldest");
    expect(sessions.get(fixture.newest.id)!.messages).toHaveLength(2);
    expect(sessions.get(fixture.newest.id)!.transcriptTruncated).toBe(false);
  });

  test("a prepared prompt record added at the exact limit is published", async () => {
    const fixture = largeFixture();
    await persistBarrier();
    const firstSize = (await stat(harness.stateFile)).size;
    expect(firstSize).toBeLessThan(MAX_STATE_FILE_BYTES);

    // Pad the most recently touched transcript so the file is exactly at the
    // real ceiling: ASCII in `content` only, so every added char is one byte.
    const padding = MAX_STATE_FILE_BYTES - firstSize;
    fixture.small.messages = [
      { ...fixture.small.messages[0]!, content: `hi${"b".repeat(padding)}` },
    ];
    await persistBarrier();
    expect((await stat(harness.stateFile)).size).toBe(MAX_STATE_FILE_BYTES);
    let records = await publishedSessions();
    expect(
      records.filter((record) => (record.messages as unknown[]).length === 0).map((r) => r.id),
    ).toEqual([fixture.oldest.id]);

    fixture.small.promptJournal.set("prepared-at-limit", {
      requestId: "prepared-at-limit",
      state: "prepared",
      acceptedAt: 1,
    });
    await persistBarrier();

    expect((await stat(harness.stateFile)).size).toBeLessThanOrEqual(MAX_STATE_FILE_BYTES);
    records = await publishedSessions();
    const small = records.find((record) => record.id === fixture.small.id)!;
    // Published before any provider could be invoked, as the restart must read it.
    expect(small.promptJournal).toEqual([
      { requestId: "prepared-at-limit", state: "ambiguous", acceptedAt: 1 },
    ]);
    // Room was made by shedding the next-oldest transcript, not the record.
    const emptied = records
      .filter((record) => (record.messages as unknown[]).length === 0)
      .map((record) => record.id)
      .sort();
    expect(emptied).toEqual([fixture.oldest.id, fixture.middle.id].sort());
    expect(fixture.middle.messages).toHaveLength(2);
  });

  test("essential state alone over budget rejects the barrier and keeps the old file; closing reclaims it", async () => {
    const keeper = register(newSessionState("client-keeper"));
    keeper.agentId = "agent-keeper";
    await persistBarrier();
    const before = await readFile(harness.stateFile);

    // Structured results are recovery state and are never shed.
    const oversized = register(newSessionState("client-oversized"));
    const result = "s".repeat(MiB);
    for (let index = 0; index < 34; index += 1) oversized.structured.set(`r-${index}`, result);

    let thrown: unknown;
    try {
      await persistBarrier();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersistenceError);
    expect((thrown as PersistenceError).code).toBe("persistence-budget-exceeded");
    expect((thrown as PersistenceError).message).not.toContain(harness.stateRoot);
    expect(Buffer.compare(await readFile(harness.stateFile), before)).toBe(0);
    expect(
      keeper.health.listNotices().find((notice) => notice.method === "persistence")?.severity,
    ).toBe("error");

    // Closing through the router removes the session even though the file is
    // refusing growth: a close never needs a larger write first.
    const response = await harness.call(`/session/${oversized.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(sessions.has(oversized.id)).toBe(false);

    keeper.composer = { ...keeper.composer, selectedModelId: "after-recovery" };
    await persistBarrier();
    const records = await publishedSessions();
    expect(records.map((record) => record.id)).toEqual([keeper.id]);
    expect(records[0]!.composer).toMatchObject({ selectedModelId: "after-recovery" });
  });

  test("removing an oversized session from the registry lets the next barrier succeed", async () => {
    const keeper = register(newSessionState("client-keeper"));
    const oversized = register(newSessionState("client-oversized"));
    oversized.structured.set("huge", "s".repeat(MAX_STATE_FILE_BYTES));
    await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-budget-exceeded" });
    expect(await harness.readPublished()).toBeUndefined();

    sessions.delete(oversized.id);
    clientSessionKeys.delete(oversized.clientSessionKey!);
    oversized.structured.clear();
    await persistBarrier();
    expect((await publishedSessions()).map((record) => record.id)).toEqual([keeper.id]);
  });
});

describe("saturated streaming", () => {
  let harness: RouterHarness;
  let warn: Mock<typeof console.warn>;

  beforeEach(async () => {
    harness = await startRouterHarness();
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    try {
      await harness.close();
    } finally {
      warn.mockRestore();
    }
  });

  test("a burst behind a held write coalesces into one queued write", async () => {
    const state = newSessionState();
    sessions.set(state.id, state);
    const entered = deferred();
    const gate = deferred();
    let writes = 0;
    const restoreFs = usePersistenceFsForTests({
      writeFile: (async (...args: Parameters<typeof realWriteFile>) => {
        writes += 1;
        if (writes === 1) {
          entered.resolve();
          await gate.promise;
        }
        return realWriteFile(...args);
      }) as typeof realWriteFile,
    });
    try {
      schedulePersist();
      await entered.promise;
      for (let index = 0; index < 500; index += 1) {
        state.revision += 1;
        schedulePersist();
      }
      // A barrier arriving now joins the one queued write.
      const joined = persistBarrier();
      expect(writes).toBe(1);
      gate.resolve();
      await joined;
      expect(writes).toBe(2);
      const published = (await harness.readPublished()) as {
        sessions: Array<{ revision: number }>;
      };
      expect(published.sessions[0]!.revision).toBe(state.revision);
    } finally {
      gate.resolve();
      restoreFs();
    }
  });

  test("a failing write warns and records a notice once per failure transition", async () => {
    const state = newSessionState();
    sessions.set(state.id, state);
    let failing = true;
    const restoreFs = usePersistenceFsForTests({
      writeFile: (async (...args: Parameters<typeof realWriteFile>) => {
        if (failing) {
          throw Object.assign(new Error(`EIO writing ${harness.stateRoot}`), { code: "EIO" });
        }
        return realWriteFile(...args);
      }) as typeof realWriteFile,
    });
    const failingWarnings = () =>
      warn.mock.calls.filter((call) => String(call[0]).includes("state publication failing"));
    const recoveredWarnings = () =>
      warn.mock.calls.filter((call) => String(call[0]).includes("state publication recovered"));
    const persistenceNotice = () =>
      state.health.listNotices().find((notice) => notice.method === "persistence");
    try {
      for (let round = 0; round < 5; round += 1) {
        for (let index = 0; index < 50; index += 1) schedulePersist();
        await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      }
      expect(failingWarnings()).toHaveLength(1);
      expect(persistenceNotice()?.count).toBe(1);
      // Content-free: the filesystem error's path never reaches the log.
      for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(harness.stateRoot);
      expect(String(failingWarnings()[0]![0])).toContain("EIO");

      failing = false;
      await persistBarrier();
      expect(recoveredWarnings()).toHaveLength(1);

      failing = true;
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      expect(failingWarnings()).toHaveLength(2);
      expect(persistenceNotice()?.count).toBe(2);
    } finally {
      restoreFs();
    }
  });
});
