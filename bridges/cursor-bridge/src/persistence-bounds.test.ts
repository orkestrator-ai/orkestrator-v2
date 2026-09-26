/**
 * Bounds on what one publication attempt holds and what one session retains.
 *
 * - Structured results are recovery state that is never shed, so each session
 *   bounds them by bytes as well as count, live and on restore.
 * - A budget refusal names the sessions whose records are largest.
 * - A refused serialization stops at the first record that overflows instead
 *   of encoding every session first.
 * - Shutdown drain racing an in-flight write leaves a valid final file and
 *   refuses later mandatory admission.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { writeFile } from "node:fs/promises";
import { newSessionState } from "./agent-session.js";
import { MAX_STRUCTURED_RESULTS, MAX_STRUCTURED_RESULTS_BYTES } from "./config.js";
import { emptyComposer } from "./models.js";
import {
  PersistenceError,
  serializeWithinBudget,
  type BudgetedSession,
  type EssentialRecord,
} from "./persistence-budget.js";
import {
  drainPersistence,
  loadPersistedState,
  persistBarrier,
  reopenPersistenceForTests,
  schedulePersist,
} from "./persistence.js";
import { setStructuredResult } from "./structured-results.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import {
  holdPublication,
  startRouterHarness,
  type RouterHarness,
} from "./testing/router-harness.js";

const MiB = 1024 * 1024;

function structuredBytes(state: SessionState): number {
  let total = 0;
  for (const [id, value] of state.structured) {
    total += Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(value));
  }
  return total;
}

function result(requestId: string, fill: number): unknown {
  return { ok: true, provider: "cursor", requestId, value: "v".repeat(fill) };
}

describe("per-session structured result bound", () => {
  test("live results evict the oldest by bytes and keep the newest", () => {
    const state = newSessionState();
    for (let index = 0; index < 10; index += 1) {
      setStructuredResult(state, `r-${index}`, result(`r-${index}`, MiB - 256));
    }
    expect(structuredBytes(state)).toBeLessThanOrEqual(MAX_STRUCTURED_RESULTS_BYTES);
    expect(state.structured.has("r-9")).toBe(true);
    expect(state.structured.has("r-0")).toBe(false);
    expect(Array.from(state.structured.keys())).toEqual(["r-6", "r-7", "r-8", "r-9"]);
  });

  test("the count bound still applies to small results", () => {
    const state = newSessionState();
    for (let index = 0; index < MAX_STRUCTURED_RESULTS + 10; index += 1) {
      setStructuredResult(state, `r-${index}`, result(`r-${index}`, 8));
    }
    expect(state.structured.size).toBe(MAX_STRUCTURED_RESULTS);
    expect(state.structured.has(`r-${MAX_STRUCTURED_RESULTS + 9}`)).toBe(true);
    expect(state.structured.has("r-9")).toBe(false);
  });

  test("a single result over the per-session bound becomes an explicit failure", () => {
    const state = newSessionState();
    setStructuredResult(state, "huge", result("huge", MAX_STRUCTURED_RESULTS_BYTES + 1));
    expect(state.structured.get("huge")).toMatchObject({
      ok: false,
      requestId: "huge",
      error: { code: "output_too_large" },
    });
  });

  describe("on restore", () => {
    let harness: RouterHarness;

    beforeEach(async () => {
      harness = await startRouterHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    test("a file from before the byte bound restores a bounded session", async () => {
      const structured: Array<[string, unknown]> = [];
      for (let index = 0; index < 10; index += 1) {
        structured.push([`r-${index}`, result(`r-${index}`, MiB - 256)]);
      }
      await writeFile(
        harness.stateFile,
        JSON.stringify({
          version: 1,
          provider: "cursor",
          sessions: [
            {
              id: "restored-1",
              status: "idle",
              messages: [],
              revision: 1,
              structured,
              promptJournal: [],
            },
          ],
        }),
      );
      await loadPersistedState();
      const restored = sessions.get("restored-1")!;
      expect(structuredBytes(restored)).toBeLessThanOrEqual(MAX_STRUCTURED_RESULTS_BYTES);
      expect(Array.from(restored.structured.keys())).toEqual(["r-6", "r-7", "r-8", "r-9"]);
    });
  });
});

describe("budget refusal names the largest sessions", () => {
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

  test("the notice marks the offending sessions and not the others", async () => {
    const register = (state: SessionState) => {
      sessions.set(state.id, state);
      if (state.clientSessionKey) clientSessionKeys.set(state.clientSessionKey, state.id);
      return state;
    };
    const keeper = register(newSessionState("client-keeper"));
    // Each session is within its own bound; together they are not.
    const heavy: SessionState[] = [];
    for (let session = 0; session < 9; session += 1) {
      const state = register(newSessionState(`client-heavy-${session}`));
      for (let index = 0; index < 4; index += 1) {
        setStructuredResult(state, `r-${index}`, result(`r-${index}`, MiB - 64 * 1024));
      }
      heavy.push(state);
    }
    expect(heavy.every((state) => structuredBytes(state) <= MAX_STRUCTURED_RESULTS_BYTES)).toBe(
      true,
    );

    let thrown: unknown;
    try {
      await persistBarrier();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersistenceError);
    const refusal = thrown as PersistenceError;
    expect(refusal.code).toBe("persistence-budget-exceeded");
    expect(refusal.sessionIds.length).toBeGreaterThan(0);
    expect(refusal.sessionIds).not.toContain(keeper.id);
    for (const id of refusal.sessionIds) {
      expect(heavy.map((state) => state.id)).toContain(id);
    }

    const marked = (state: SessionState) =>
      state.health
        .listNotices()
        .some(
          (notice) =>
            notice.method === "persistence" && notice.message.includes("among the largest"),
        );
    for (const state of heavy) {
      expect(marked(state)).toBe(refusal.sessionIds.includes(state.id));
    }
    expect(marked(keeper)).toBe(false);
    expect(
      keeper.health.listNotices().find((notice) => notice.method === "persistence")?.severity,
    ).toBe("error");
    // Content-free: ids and counts only.
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain("vvvv");
      expect(String(call[0])).not.toContain(harness.stateRoot);
    }
  });
});

describe("refused serialization stops at the overflow", () => {
  function essential(id: string, structured: Array<[string, unknown]> = []): EssentialRecord {
    return {
      id,
      status: "idle",
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      revision: 1,
      structured,
      promptJournal: [],
      composer: emptyComposer(),
    };
  }

  test("sessions after the overflowing record are never read or encoded", () => {
    const budget = 64 * 1024;
    const reads: number[] = [];
    const input: BudgetedSession[] = [];
    for (let index = 0; index < 50; index += 1) {
      const record =
        index < 3
          ? essential(`s-${index}`, [["r", "x".repeat(30 * 1024)]])
          : essential(`s-${index}`, [
              [
                "r",
                {
                  toJSON() {
                    throw new Error("a record past the overflow was encoded");
                  },
                },
              ],
            ]);
      input.push({
        id: `s-${index}`,
        lastAccessed: index,
        messages: [],
        get essential() {
          reads.push(index);
          return record;
        },
      });
    }

    let thrown: unknown;
    try {
      serializeWithinBudget({ version: 1, provider: "cursor" }, input, budget);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersistenceError);
    expect((thrown as PersistenceError).code).toBe("persistence-budget-exceeded");
    // Two 30 KiB records fit a 64 KiB budget; the third overflows it.
    expect(reads).toEqual([0, 1, 2]);
    expect((thrown as PersistenceError).sessionIds).toEqual(["s-0"]);
  });
});

describe("shutdown drain racing a write", () => {
  let harness: RouterHarness;

  beforeEach(async () => {
    harness = await startRouterHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("the final file is valid and includes the last mutation; later barriers are refused", async () => {
    const state = newSessionState("client-drain");
    sessions.set(state.id, state);
    clientSessionKeys.set("client-drain", state.id);
    const hold = holdPublication();
    try {
      schedulePersist();
      await hold.held;
      // A mutation made while the write is in flight belongs to the final one.
      state.composer = { ...state.composer, selectedModelId: "during-drain" };
      const drained = drainPersistence();
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-closed" });
      hold.release();
      await drained;
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-closed" });
      expect(hold.writes()).toBe(2);
      expect(hold.maxConcurrentWrites()).toBe(1);
      const published = (await harness.readPublished()) as {
        sessions: Array<{ id: string; composer: { selectedModelId?: string } }>;
      };
      expect(published.sessions.map((entry) => entry.id)).toEqual([state.id]);
      expect(published.sessions[0]!.composer.selectedModelId).toBe("during-drain");
    } finally {
      hold.restore();
      reopenPersistenceForTests();
    }
  });
});
