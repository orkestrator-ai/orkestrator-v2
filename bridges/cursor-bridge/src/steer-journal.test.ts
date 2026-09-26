/**
 * INC-07: the steer journal is bounded without letting a retry be delivered
 * twice.
 *
 * The helper is exercised at small limits for its retention rules; the route
 * is exercised at the shipped limits through the real router, the real write
 * queue and a fake run that only counts deliveries.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { createHash } from "node:crypto";
import { writeFile as realWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { newSessionState, useCursorAgentForTests } from "./agent-session.js";
import { MAX_STEER_ID_BYTES, MAX_STEER_JOURNAL, MAX_STEER_JOURNAL_BYTES } from "./config.js";
import { loadPersistedState, usePersistenceFsForTests } from "./persistence.js";
import {
  admitSteer,
  persistedSteerJournal,
  removeSteer,
  restoreSteerJournal,
  setSteerEntry,
  steerEntryBytes,
  steerHistoryFenced,
  steerJournalSummary,
  type SteerJournalLimits,
} from "./steer-journal.js";
import { sessions, type SessionState, type SteerJournalEntry } from "./state.js";
import { fakeAgent } from "./testing/fake-agent.js";
import {
  defaultPolicy,
  deferred,
  holdPublication,
  startRouterHarness,
  stubAttach,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function entry(
  requestId: string,
  expectedRunId: string,
  state: SteerJournalEntry["state"] = "delivered",
  text = `text-${requestId}`,
): SteerJournalEntry {
  return { requestId, inputDigest: digest(text), expectedRunId, state, createdAt: 1 };
}

/** What the byte counter must equal after every mutation. */
function heldBytes(state: SessionState): number {
  let total = 0;
  for (const value of state.steerJournal.values()) total += steerEntryBytes(value);
  return total;
}

function withActiveRun(state: SessionState, runId: string | undefined): SessionState {
  state.activeRun = runId ? ({ id: runId } as SessionState["activeRun"]) : undefined;
  return state;
}

const small: SteerJournalLimits = { entries: 3, bytes: 64 * 1024, fenceRuns: 2 };

describe("journal helper", () => {
  test("an update replaces its charge instead of adding to it", () => {
    const state = newSessionState();
    const prepared = entry("r1", "run-1", "prepared");
    expect(admitSteer(state, prepared, small)).toEqual({ admitted: true });
    expect(state.steerJournalBytes).toBe(steerEntryBytes(prepared));

    const delivered = entry("r1", "run-1", "delivered");
    setSteerEntry(state, delivered);
    setSteerEntry(state, delivered);
    expect(state.steerJournal.size).toBe(1);
    expect(state.steerJournalBytes).toBe(steerEntryBytes(delivered));
    expect(state.steerJournalBytes).toBe(heldBytes(state));

    setSteerEntry(state, entry("r2", "run-1", "ambiguous"));
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    removeSteer(state, "r1");
    removeSteer(state, "r1");
    removeSteer(state, "never-held");
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    removeSteer(state, "r2");
    expect(state.steerJournalBytes).toBe(0);
  });

  test("protected records fill the count bound and refuse without evicting anything", () => {
    const state = withActiveRun(newSessionState(), "run-1");
    for (const id of ["a", "b", "c"]) {
      expect(admitSteer(state, entry(id, "run-1"), small)).toEqual({ admitted: true });
    }
    const bytes = state.steerJournalBytes;
    expect(admitSteer(state, entry("d", "run-1"), small)).toEqual({
      admitted: false,
      reason: "steer-capacity-exceeded",
    });
    expect(Array.from(state.steerJournal.keys())).toEqual(["a", "b", "c"]);
    expect(state.steerJournalBytes).toBe(bytes);
    expect(state.steerFence).toBeUndefined();

    // A prepared record is protected even when its run is not the active one.
    const other = withActiveRun(newSessionState(), "run-2");
    for (const id of ["a", "b", "c"]) admitSteer(other, entry(id, "run-1", "prepared"), small);
    expect(admitSteer(other, entry("d", "run-2"), small)).toMatchObject({ admitted: false });
    expect(other.steerJournal.size).toBe(3);
  });

  test("only unprotected records are evicted, oldest first and only as many as needed", () => {
    const state = withActiveRun(newSessionState(), "run-1");
    setSteerEntry(state, entry("old-1", "run-0"));
    setSteerEntry(state, entry("old-2", "run-0"));
    setSteerEntry(state, entry("live-1", "run-1"));
    expect(admitSteer(state, entry("live-2", "run-1"), small)).toEqual({ admitted: true });
    expect(Array.from(state.steerJournal.keys())).toEqual(["old-2", "live-1", "live-2"]);
    expect(state.steerFence).toEqual({ runs: ["run-0"] });
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    expect(steerHistoryFenced(state, "run-0")).toBe(true);
    expect(steerHistoryFenced(state, "run-1")).toBe(false);
  });

  test("a refusal that eviction could not cure leaves evictable history in place", () => {
    const state = withActiveRun(newSessionState(), "run-1");
    const limits: SteerJournalLimits = { entries: 10, bytes: 1_000, fenceRuns: 2 };
    setSteerEntry(state, entry("old", "run-0"));
    setSteerEntry(state, entry("live", "run-1"));
    const before = state.steerJournalBytes;
    const wide = entry(`wide-${"w".repeat(780)}`, "run-1");
    // Admissible on its own, so the refusal is the eviction check's decision.
    expect(steerEntryBytes(wide)).toBeLessThanOrEqual(limits.bytes);
    expect(before + steerEntryBytes(wide)).toBeGreaterThan(limits.bytes);
    expect(steerEntryBytes(entry("live", "run-1")) + steerEntryBytes(wide)).toBeGreaterThan(
      limits.bytes,
    );
    expect(admitSteer(state, wide, limits)).toMatchObject({ admitted: false });
    expect(Array.from(state.steerJournal.keys())).toEqual(["old", "live"]);
    expect(state.steerJournalBytes).toBe(before);
    expect(state.steerFence).toBeUndefined();

    // One record larger than the whole budget is refused outright.
    const huge = entry("h".repeat(2_000), "run-1");
    expect(admitSteer(newSessionState(), huge, limits)).toEqual({
      admitted: false,
      reason: "steer-capacity-exceeded",
    });
  });

  test("an overflowed fence covers only recovered runs created before the drop, and names refuse", () => {
    const state = withActiveRun(newSessionState(), "run-live");
    const limits: SteerJournalLimits = { entries: 1, bytes: 64 * 1024, fenceRuns: 2 };
    const beforeDrop = Date.now();
    for (const run of ["r0", "r1", "r2"]) {
      setSteerEntry(state, entry(`from-${run}`, run));
      // Each admission evicts the previous run's only record.
      state.activeRun = { id: `${run}-next` } as SessionState["activeRun"];
      expect(admitSteer(state, entry(`next-${run}`, `${run}-next`), limits)).toEqual({
        admitted: true,
      });
      removeSteer(state, `next-${run}`);
    }
    expect(state.steerFence).toEqual({ runs: ["r1", "r2"], overflowBefore: expect.any(Number) });
    const overflowBefore = state.steerFence!.overflowBefore!;
    expect(overflowBefore).toBeGreaterThanOrEqual(beforeDrop);
    expect(steerHistoryFenced(state, "r2")).toBe(true);
    expect(admitSteer(state, entry("fresh", "r2"), limits)).toEqual({
      admitted: false,
      reason: "steer-history-unavailable",
    });

    // A run the bounded fence no longer names is judged only as the recovered
    // active run, by when it was created.
    expect(steerHistoryFenced(state, "r0")).toBe(false);
    state.activeRun = { id: "r0" } as SessionState["activeRun"];
    expect(steerHistoryFenced(state, "r0")).toBe(false);
    state.activeRunRecovered = true;
    state.activeRunCreatedAt = overflowBefore;
    expect(steerHistoryFenced(state, "r0")).toBe(true);
    // Created after the last drop: provably not a dropped run. Not sticky.
    state.activeRunCreatedAt = overflowBefore + 1;
    expect(steerHistoryFenced(state, "r0")).toBe(false);
    expect(admitSteer(state, entry("fresh-late", "r0"), limits)).toEqual({ admitted: true });
    // No creation time reported: conservatively fenced.
    state.activeRunCreatedAt = undefined;
    expect(steerHistoryFenced(state, "r0")).toBe(true);
  });

  test("the persisted fence keeps its bound, and a legacy boolean restores conservatively", () => {
    const state = newSessionState();
    state.steerFence = { runs: ["r1"], overflowBefore: 1_000 };
    const persisted = persistedSteerJournal(state);
    // The legacy boolean is written beside the bound for an older reader.
    expect(persisted.steerFence).toEqual({ runs: ["r1"], overflowBefore: 1_000, overflow: true });

    const restored = newSessionState();
    restoreSteerJournal(restored, persisted.steerJournal, persisted.steerFence);
    expect(restored.steerFence).toEqual({ runs: ["r1"], overflowBefore: 1_000 });

    // A file that only says "overflowed" is bounded by this process's start:
    // every run it could have dropped was created before the load.
    const before = Date.now();
    const legacy = newSessionState();
    restoreSteerJournal(legacy, [], { runs: [], overflow: true });
    expect(legacy.steerFence!.overflowBefore!).toBeGreaterThanOrEqual(before);
    expect(legacy.steerFence!.overflowBefore!).toBeLessThanOrEqual(Date.now());
    legacy.activeRun = { id: "recovered" } as SessionState["activeRun"];
    legacy.activeRunRecovered = true;
    legacy.activeRunCreatedAt = before - 1;
    expect(steerHistoryFenced(legacy, "recovered")).toBe(true);
    legacy.activeRunCreatedAt = Date.now() + 60_000;
    expect(steerHistoryFenced(legacy, "recovered")).toBe(false);
  });

  test("a prepared record is charged as the ambiguous record the file stores", () => {
    const state = withActiveRun(newSessionState(), "run-1");
    expect(admitSteer(state, entry("p1", "run-1", "prepared"), small)).toEqual({ admitted: true });
    expect(admitSteer(state, entry("p2", "run-1", "prepared"), small)).toEqual({ admitted: true });
    const persisted = persistedSteerJournal(state);
    expect(persisted.steerJournal.map((value) => value.state)).toEqual(["ambiguous", "ambiguous"]);
    const restored = newSessionState();
    restoreSteerJournal(restored, persisted.steerJournal, persisted.steerFence, small);
    // Live and restored accounting agree byte for byte.
    expect(restored.steerJournalBytes).toBe(state.steerJournalBytes);
    expect(state.steerJournalBytes).toBe(
      persisted.steerJournal.reduce((total, value) => total + steerEntryBytes(value), 0),
    );
  });

  test("the summary reports saturation only while protected records leave no room", () => {
    const state = withActiveRun(newSessionState(), "run-1");
    for (const id of ["a", "b", "c"]) admitSteer(state, entry(id, "run-1"), small);
    expect(steerJournalSummary(state, small)).toEqual({
      entries: 3,
      limitEntries: 3,
      bytes: state.steerJournalBytes,
      limitBytes: small.bytes,
      fencedRuns: 0,
      saturated: true,
    });
    // The run settled: its records are evictable again.
    state.activeRun = undefined;
    expect(steerJournalSummary(state, small).saturated).toBe(false);
  });

  test("restoring an oversized legacy journal keeps the newest within bounds and fences the rest", () => {
    const state = newSessionState();
    const raw = Array.from({ length: 400 }, (_, index) =>
      entry(`s-${index}`, index < 200 ? "run-a" : "run-b"),
    );
    restoreSteerJournal(state, raw, undefined, { entries: 10, bytes: 64 * 1024, fenceRuns: 4 });
    expect(Array.from(state.steerJournal.keys())).toEqual(
      Array.from({ length: 10 }, (_, index) => `s-${390 + index}`),
    );
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    expect(state.steerFence?.runs).toEqual(["run-b", "run-a"]);

    const byBytes = newSessionState();
    const oneBytes = steerEntryBytes(entry("s-399", "run-b"));
    restoreSteerJournal(byBytes, raw, undefined, {
      entries: 256,
      bytes: oneBytes * 5,
      fenceRuns: 4,
    });
    expect(byBytes.steerJournal.size).toBeLessThanOrEqual(5);
    expect(byBytes.steerJournalBytes).toBeLessThanOrEqual(oneBytes * 5);
    expect(byBytes.steerFence?.runs).toContain("run-a");
    expect(byBytes.steerFence?.runs).toContain("run-b");
  });

  test("corrupt and oversized legacy records load bounded, fence readable runs and never throw", () => {
    const state = newSessionState();
    const tenKb = "a".repeat(10 * 1024);
    const raw: unknown[] = [
      42,
      null,
      "not-a-record",
      [],
      { expectedRunId: "run-missing-id" },
      { requestId: "   ", expectedRunId: "run-blank-id" },
      { requestId: tenKb, expectedRunId: "run-long-id" },
      { requestId: "long-run", expectedRunId: "r".repeat(10 * 1024) },
      { requestId: "was-prepared", expectedRunId: "run-ok", state: "prepared", inputDigest: "zz" },
      entry("ok", "run-ok"),
      entry("ok", "run-ok", "absent"),
    ];
    expect(() =>
      restoreSteerJournal(state, raw, {
        runs: [5, "fenced", "f".repeat(10 * 1024)],
        overflow: "yes",
        overflowBefore: "soon",
      }),
    ).not.toThrow();
    expect(Array.from(state.steerJournal.keys()).sort()).toEqual(["ok", "was-prepared"]);
    // The newest duplicate wins; a restart never revives `prepared`.
    expect(state.steerJournal.get("ok")!.state).toBe("absent");
    expect(state.steerJournal.get("was-prepared")).toMatchObject({
      state: "ambiguous",
      inputDigest: "",
    });
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    expect(state.steerFence?.runs.slice().sort()).toEqual([
      "fenced",
      "run-blank-id",
      "run-long-id",
      "run-missing-id",
    ]);
    expect(state.steerFence?.overflowBefore).toBeUndefined();
    for (const id of state.steerJournal.keys()) {
      expect(Buffer.byteLength(id)).toBeLessThanOrEqual(MAX_STEER_ID_BYTES);
    }

    const garbage = newSessionState();
    expect(() => restoreSteerJournal(garbage, "garbage", "garbage")).not.toThrow();
    expect(garbage.steerJournal.size).toBe(0);
    expect(garbage.steerFence).toBeUndefined();
  });
});

describe("steer route", () => {
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

  function runningSession(runId = "run-1"): { state: SessionState; delivered: string[] } {
    const state = newSessionState();
    sessions.set(state.id, state);
    const delivered: string[] = [];
    state.status = "running";
    setRun(state, runId, delivered);
    return { state, delivered };
  }

  function setRun(state: SessionState, runId: string, delivered: string[]): void {
    state.activeRun = {
      id: runId,
      supports: (feature: string) => feature === "stream",
      steer: async (text: string) => {
        delivered.push(text);
        return "complete_delivered";
      },
    } as unknown as SessionState["activeRun"];
  }

  function steer(
    state: SessionState,
    requestId: string,
    input = `text-${requestId}`,
    expectedRunId = "run-1",
  ): Promise<Response> {
    return harness.call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ input, requestId, expectedRunId }),
    });
  }

  async function dispatchOf(state: SessionState, requestId: string): Promise<unknown> {
    const response = await harness.call(
      `/session/${state.id}/steer/dispatch?requestId=${encodeURIComponent(requestId)}`,
    );
    return ((await response.json()) as { dispatch: unknown }).dispatch;
  }

  test("300 steers against one run stay bounded; the overflow is refused before delivery", async () => {
    const { state, delivered } = runningSession();
    for (let index = 0; index < 300; index += 1) {
      const response = await steer(state, `steer-${index}`);
      if (index < MAX_STEER_JOURNAL) {
        expect(response.status).toBe(202);
        await response.body?.cancel();
        continue;
      }
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        outcome: "rejected",
        reason: "steer-capacity-exceeded",
        requestId: `steer-${index}`,
        message: expect.any(String),
      });
      // Refused before the SDK was called.
      expect(delivered).toHaveLength(MAX_STEER_JOURNAL);
      expect(state.steerJournal.has(`steer-${index}`)).toBe(false);
    }
    expect(state.steerJournal.size).toBe(MAX_STEER_JOURNAL);
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    expect(state.steerJournalBytes).toBeLessThanOrEqual(MAX_STEER_JOURNAL_BYTES);
    const published = (await harness.readPublished()) as {
      sessions: Array<{ steerJournal: unknown[] }>;
    };
    expect(published.sessions[0]!.steerJournal).toHaveLength(MAX_STEER_JOURNAL);

    // The earliest request, retried at capacity, gets its original answer.
    const retry = await steer(state, "steer-0");
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({
      outcome: "applied",
      requestId: "steer-0",
      duplicate: true,
    });
    expect(delivered).toHaveLength(MAX_STEER_JOURNAL);
    expect(delivered.filter((text) => text === "text-steer-0")).toHaveLength(1);
    // A refused id was never recorded and stays unknown, not dispatched.
    expect(await dispatchOf(state, "steer-299")).toBe("unknown");
    expect(state.status).toBe("running");
  });

  test("the same id with different text or run is a conflict, never a delivery", async () => {
    const { state, delivered } = runningSession();
    expect((await steer(state, "dup", "original")).status).toBe(202);
    const changedText = await steer(state, "dup", "something else");
    expect(changedText.status).toBe(409);
    expect(await changedText.json()).toEqual({ outcome: "unknown", requestId: "dup" });
    const changedRun = await steer(state, "dup", "original", "run-other");
    expect(changedRun.status).toBe(409);
    expect(await changedRun.json()).toEqual({ outcome: "unknown", requestId: "dup" });
    expect(delivered).toEqual(["original"]);
  });

  test("after the run changes and its history is evicted, an old retry cannot steer the new run", async () => {
    const { state, delivered } = runningSession();
    expect((await steer(state, "old-steer", "old text")).status).toBe(202);

    const newRun: string[] = [];
    setRun(state, "run-2", newRun);
    for (let index = 0; index < MAX_STEER_JOURNAL - 1; index += 1) {
      setSteerEntry(state, entry(`fill-${index}`, "run-2"));
    }
    expect(state.steerJournal.size).toBe(MAX_STEER_JOURNAL);
    const fresh = await steer(state, "new-steer", "new text", "run-2");
    expect(fresh.status).toBe(202);
    expect(state.steerJournal.has("old-steer")).toBe(false);
    expect(state.steerFence?.runs).toContain("run-1");
    expect(await dispatchOf(state, "old-steer")).toBe("unknown");

    // Its record is gone and its run is fenced, so the retry is unknown —
    // never a mismatch the caller could read as "not delivered".
    const retry = await steer(state, "old-steer", "old text", "run-1");
    expect(retry.status).toBe(503);
    expect(await retry.json()).toEqual({ outcome: "unknown", requestId: "old-steer" });
    expect(newRun).toEqual(["new text"]);
    expect(delivered).toEqual(["old text"]);
  });

  test("a restart with a legacy oversized journal fences the recovered run instead of replaying", async () => {
    const legacy = Array.from({ length: 400 }, (_, index) => entry(`s-${index}`, "run-a"));
    await realWriteFile(
      harness.stateFile,
      JSON.stringify({
        version: 1,
        provider: "cursor",
        sessions: [
          {
            id: "legacy-session",
            status: "idle",
            revision: 3,
            messages: [],
            structured: [],
            promptJournal: [],
            steerJournal: legacy,
          },
        ],
      }),
    );
    await loadPersistedState();
    const state = sessions.get("legacy-session")!;
    expect(state.steerJournal.size).toBe(MAX_STEER_JOURNAL);
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    expect(state.steerJournalBytes).toBeLessThanOrEqual(MAX_STEER_JOURNAL_BYTES);
    expect(state.steerJournal.has("s-399")).toBe(true);
    expect(state.steerJournal.has("s-0")).toBe(false);
    expect(state.steerFence?.runs).toEqual(["run-a"]);

    // The same run is recovered as active after the restart.
    const delivered: string[] = [];
    state.status = "running";
    setRun(state, "run-a", delivered);
    state.activeRunRecovered = true;

    // A request with no record against a fenced run cannot be told apart from
    // a forgotten retry, so both are unknown — never a definitive refusal the
    // caller would clear as "not sent".
    const fresh = await steer(state, "brand-new", "new text", "run-a");
    expect(fresh.status).toBe(503);
    expect(await fresh.json()).toEqual({ outcome: "unknown", requestId: "brand-new" });
    const forgotten = await steer(state, "s-0", "text-s-0", "run-a");
    expect(forgotten.status).toBe(503);
    expect(await forgotten.json()).toEqual({ outcome: "unknown", requestId: "s-0" });
    // A retained id still gets its original answer.
    const kept = await steer(state, "s-399", "text-s-399", "run-a");
    expect(kept.status).toBe(202);
    expect(await kept.json()).toMatchObject({ outcome: "applied", duplicate: true });
    expect(delivered).toEqual([]);
  });

  test("escape-heavy ids at the allowed length hit the byte cap before the count cap", async () => {
    const runId = `run-${"\u0001".repeat(MAX_STEER_ID_BYTES - 4)}`;
    expect(Buffer.byteLength(runId)).toBe(MAX_STEER_ID_BYTES);
    const { state, delivered } = runningSession(runId);
    const idFor = (index: number) => {
      const prefix = `${index}-`;
      return `${prefix}${"\u0001".repeat(MAX_STEER_ID_BYTES - prefix.length)}`;
    };
    let refusedAt = -1;
    for (let index = 0; index < MAX_STEER_JOURNAL; index += 1) {
      const response = await steer(state, idFor(index), "same text", runId);
      if (response.status === 429) {
        expect(await response.json()).toMatchObject({ reason: "steer-capacity-exceeded" });
        refusedAt = index;
        break;
      }
      expect(response.status).toBe(202);
      await response.body?.cancel();
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThan(MAX_STEER_JOURNAL);
    expect(state.steerJournal.size).toBe(refusedAt);
    expect(delivered).toHaveLength(refusedAt);
    expect(state.steerJournalBytes).toBe(heldBytes(state));
    expect(state.steerJournalBytes).toBeLessThanOrEqual(MAX_STEER_JOURNAL_BYTES);
    // Refused precisely because one more record would cross the byte budget.
    const next = entry(idFor(refusedAt), runId, "prepared", "same text");
    expect(state.steerJournalBytes + steerEntryBytes(next)).toBeGreaterThan(
      MAX_STEER_JOURNAL_BYTES,
    );
  });

  test("two concurrent requests for the last slot: at most one reserves it", async () => {
    const { state, delivered } = runningSession();
    for (let index = 0; index < MAX_STEER_JOURNAL - 1; index += 1) {
      setSteerEntry(state, entry(`fill-${index}`, "run-1"));
    }
    const hold = holdPublication();
    try {
      const first = steer(state, "last-a");
      const second = steer(state, "last-b");
      // The winner's publication is held, so the loser must have been refused
      // while the winner was still in flight.
      await hold.held;
      const refused = await Promise.race([first, second]);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ reason: "steer-capacity-exceeded" });
      expect(delivered).toEqual([]);
      hold.release();
      const statuses = [(await first).status, (await second).status].sort();
      expect(statuses).toEqual([202, 429]);
      expect(delivered).toHaveLength(1);
      expect(state.steerJournal.size).toBe(MAX_STEER_JOURNAL);
      expect(state.steerJournalBytes).toBe(heldBytes(state));
    } finally {
      hold.restore();
    }
  });

  test("a failed journal publication refuses the steer and restores accounting", async () => {
    const { state, delivered } = runningSession();
    for (const id of ["a", "b", "c"]) setSteerEntry(state, entry(id, "run-1"));
    const size = state.steerJournal.size;
    const bytes = state.steerJournalBytes;

    // The state directory is a regular file.
    const blocker = join(harness.stateRoot, "not-a-directory");
    await realWriteFile(blocker, "x");
    process.env.CURSOR_BRIDGE_STATE_DIR = blocker;
    const response = await steer(state, "unpublished");
    // Provably not sent, so the refusal is definitive.
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      outcome: "rejected",
      reason: "steer-not-recorded",
      requestId: "unpublished",
      message: expect.any(String),
    });
    expect(delivered).toEqual([]);
    expect(state.steerJournal.has("unpublished")).toBe(false);
    expect(state.steerJournal.size).toBe(size);
    expect(state.steerJournalBytes).toBe(bytes);

    // Through the filesystem seam as well.
    process.env.CURSOR_BRIDGE_STATE_DIR = harness.stateRoot;
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const failed = await steer(state, "unpublished");
      expect(failed.status).toBe(429);
      expect(await failed.json()).toMatchObject({ reason: "steer-not-recorded" });
      expect(delivered).toEqual([]);
      expect(state.steerJournal.size).toBe(size);
      expect(state.steerJournalBytes).toBe(bytes);
    } finally {
      hold.restore();
    }

    // Provably never sent, so the same id may be sent once publication works.
    const retried = await steer(state, "unpublished");
    expect(retried.status).toBe(202);
    expect(delivered).toEqual(["text-unpublished"]);
  });

  test("a delivered steer whose outcome write fails answers applied and replays from memory", async () => {
    const { state, delivered } = runningSession();
    let writes = 0;
    const restoreFs = usePersistenceFsForTests({
      writeFile: (async (...args: Parameters<typeof realWriteFile>) => {
        writes += 1;
        if (writes >= 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return realWriteFile(...args);
      }) as typeof realWriteFile,
    });
    try {
      const first = await steer(state, "late-fail");
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ outcome: "applied", requestId: "late-fail" });
      expect(delivered).toEqual(["text-late-fail"]);
      expect(writes).toBe(2);
      // The file keeps the conservative reading of the delivered request.
      const published = (await harness.readPublished()) as {
        sessions: Array<{ steerJournal: Array<{ requestId: string; state: string }> }>;
      };
      expect(published.sessions[0]!.steerJournal).toEqual([
        expect.objectContaining({ requestId: "late-fail", state: "ambiguous" }),
      ]);

      const retry = await steer(state, "late-fail");
      expect(retry.status).toBe(202);
      expect(await retry.json()).toEqual({
        outcome: "applied",
        requestId: "late-fail",
        duplicate: true,
      });
      expect(delivered).toEqual(["text-late-fail"]);
    } finally {
      restoreFs();
    }
  });
  test("a record-less request against a fenced run is unknown, whatever the run's state now", async () => {
    const { state, delivered } = runningSession();
    state.steerFence = { runs: ["run-old"] };

    // Another run is active: not a mismatch.
    const whileOther = await steer(state, "gone-1", "old text", "run-old");
    expect(whileOther.status).toBe(503);
    expect(await whileOther.json()).toEqual({ outcome: "unknown", requestId: "gone-1" });

    // Nothing is running any more: not idle either.
    state.status = "idle";
    state.activeRun = undefined;
    const whileIdle = await steer(state, "gone-1", "old text", "run-old");
    expect(whileIdle.status).toBe(503);
    expect(await whileIdle.json()).toEqual({ outcome: "unknown", requestId: "gone-1" });

    // An exact retry with a record is answered from it even with no run.
    setSteerEntry(state, entry("kept", "run-1", "delivered", "kept text"));
    const kept = await steer(state, "kept", "kept text", "run-1");
    expect(kept.status).toBe(202);
    expect(await kept.json()).toEqual({ outcome: "applied", requestId: "kept", duplicate: true });

    // A run this journal never fenced still answers idle.
    const unfenced = await steer(state, "new-1", "new text", "run-unknown");
    expect(unfenced.status).toBe(200);
    expect(await unfenced.json()).toEqual({ outcome: "idle" });
    expect(delivered).toEqual([]);
  });

  test("saturation and fencing each raise one content-free notice, and health reports occupancy", async () => {
    const { state, delivered } = runningSession();
    for (let index = 0; index < MAX_STEER_JOURNAL; index += 1) {
      setSteerEntry(state, entry(`fill-${index}`, "run-1"));
    }
    for (const id of ["over-1", "over-2", "over-3"]) {
      const refused = await steer(state, id, "secret instruction");
      expect(refused.status).toBe(429);
      await refused.body?.cancel();
    }
    state.steerFence = { runs: ["run-old"] };
    for (const id of ["fenced-1", "fenced-2"]) {
      const unknown = await steer(state, id, "secret instruction", "run-old");
      expect(unknown.status).toBe(503);
      await unknown.body?.cancel();
    }
    expect(delivered).toEqual([]);

    const health = (await (await harness.call(`/session/${state.id}/runtime-health`)).json()) as {
      summary: { steer: unknown };
      notices: Array<{ method?: string; count: number }>;
    };
    expect(health.summary.steer).toEqual({
      entries: MAX_STEER_JOURNAL,
      limitEntries: MAX_STEER_JOURNAL,
      bytes: state.steerJournalBytes,
      limitBytes: MAX_STEER_JOURNAL_BYTES,
      fencedRuns: 1,
      saturated: true,
    });
    const notices = health.notices.filter((notice) => notice.method === "steer-journal");
    // One per transition, not one per refused request.
    expect(notices.map((notice) => notice.count)).toEqual([1, 1]);
    const raw = JSON.stringify(health);
    for (const secret of ["secret instruction", "over-1", "fenced-1", "run-old", "run-1"]) {
      expect(raw).not.toContain(secret);
    }
  });

  test("a run recovered through resume is fenced by creation time, not forever", async () => {
    const createdAt = Date.now() - 10_000;
    const gate = deferred();
    const delivered: string[] = [];
    let status = "running";
    const run = {
      id: "run-recovered",
      agentId: "vendor-agent",
      createdAt,
      get status() {
        return status;
      },
      supports: (feature: string) => feature === "stream",
      unsupportedReason: () => undefined,
      // Streams nothing until the run ends; recovery drains a generator.
      // oxlint-disable-next-line require-yield
      async *stream() {
        await gate.promise;
      },
      wait: async () => {
        await gate.promise;
        status = "finished";
        return { id: "run-recovered", status: "finished" };
      },
      cancel: async () => {
        status = "cancelled";
        gate.resolve();
      },
      onDidChangeStatus: () => () => undefined,
      conversation: async () => [],
      steer: async (text: string) => {
        delivered.push(text);
        return "complete_delivered";
      },
    };
    const restoreAttach = stubAttach({ resume: async () => fakeAgent() });
    const restoreRuns = useCursorAgentForTests({
      resume: async () => fakeAgent(),
      listRuns: async () => ({ items: status === "running" ? [run] : [] }),
    } as unknown as Parameters<typeof useCursorAgentForTests>[0]);
    try {
      const resumed = await harness.call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: "vendor-agent", policy: defaultPolicy }),
      });
      expect(resumed.status).toBe(201);
      const { sessionId } = (await resumed.json()) as { sessionId: string };
      const state = sessions.get(sessionId)!;
      // Adopted by the real recovery path, with the provider's creation time.
      expect(state.activeRun?.id).toBe("run-recovered");
      expect(state.activeRunRecovered).toBe(true);
      expect(state.activeRunCreatedAt).toBe(createdAt);

      // The fence last dropped a name at the moment this run was created.
      restoreSteerJournal(state, [], { runs: [], overflowBefore: createdAt });
      const fenced = await steer(state, "fresh-1", "first", "run-recovered");
      expect(fenced.status).toBe(503);
      expect(await fenced.json()).toEqual({ outcome: "unknown", requestId: "fresh-1" });
      expect(delivered).toEqual([]);

      // It dropped one only before this run existed: steerable again.
      restoreSteerJournal(state, [], { runs: [], overflowBefore: createdAt - 1 });
      const applied = await steer(state, "fresh-2", "second", "run-recovered");
      expect(applied.status).toBe(202);
      expect(await applied.json()).toEqual({ outcome: "applied", requestId: "fresh-2" });
      expect(delivered).toEqual(["second"]);

      gate.resolve();
      await waitFor(() => state.recoveringRun === undefined);
      expect(state.activeRunCreatedAt).toBeUndefined();
    } finally {
      gate.resolve();
      restoreRuns();
      restoreAttach();
    }
  });
});
