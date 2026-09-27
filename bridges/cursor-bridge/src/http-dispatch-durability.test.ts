/**
 * INC-01: a prompt or steer reaches the SDK only after its prepared record —
 * and the identity of the agent it goes to — has been published.
 *
 * Each case holds or fails one real state-file write through the persistence
 * module's filesystem seam. Serialization, the write queue, the journals and
 * the routes are all production code; the fake agent only counts sends.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadPersistedState,
  persistBarrier,
  reopenPersistenceForTests,
  schedulePersist,
} from "./persistence.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import { attachFake } from "./testing/fake-agent.js";
import {
  deferred,
  holdPublication,
  startRouterHarness,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";

let harness: RouterHarness;

beforeEach(async () => {
  harness = await startRouterHarness();
});

afterEach(async () => {
  await harness.close();
});

function prompt(state: SessionState, requestId: string): Promise<Response> {
  return harness.call(`/session/${state.id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt: "synthetic prompt", requestId }),
  });
}

function steerableRun(state: SessionState, delivered: string[]): void {
  state.status = "running";
  state.activeRun = {
    id: "run-1",
    supports: (feature: string) => feature === "stream",
    steer: async (text: string) => {
      delivered.push(text);
      return "complete_delivered";
    },
  } as SessionState["activeRun"];
}

function steer(state: SessionState, requestId: string): Promise<Response> {
  return harness.call(`/session/${state.id}/steer`, {
    method: "POST",
    body: JSON.stringify({ input: "narrow it", requestId, expectedRunId: "run-1" }),
  });
}

describe("mandatory publication barrier", () => {
  test("an unwritable state directory rejects the barrier instead of resolving", async () => {
    const blocker = join(harness.stateRoot, "not-a-directory");
    await writeFile(blocker, "x");
    process.env.CURSOR_BRIDGE_STATE_DIR = blocker;
    await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
  });

  test("a failed earlier write does not poison the next barrier", async () => {
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      hold.failWith(undefined);
      await persistBarrier();
      expect(await harness.readPublished()).toMatchObject({ provider: "cursor" });
    } finally {
      hold.restore();
    }
  });

  test("an earlier successful write cannot satisfy a later mutation's barrier", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-a" });
    const hold = holdPublication();
    try {
      // A best-effort write is in flight with the old composer...
      schedulePersist();
      await hold.held;
      state.composer = { ...state.composer, selectedModelId: "after-the-snapshot" };
      // ...so the barrier for the new one must be a write of its own.
      const barrier = persistBarrier();
      hold.release();
      await barrier;
      const published = (await harness.readPublished()) as {
        sessions: Array<{ composer: { selectedModelId?: string } }>;
      };
      expect(published.sessions[0]!.composer.selectedModelId).toBe("after-the-snapshot");
    } finally {
      hold.restore();
    }
  });

  test("concurrent barriers share writes and never overlap a writer", async () => {
    await harness.createSession();
    const hold = holdPublication();
    try {
      schedulePersist();
      await hold.held;
      const barriers = Array.from({ length: 20 }, () => persistBarrier());
      for (let index = 0; index < 50; index += 1) schedulePersist();
      hold.release();
      await Promise.all(barriers);
      // One held write plus one coalesced write for everything queued behind it.
      expect(hold.writes()).toBe(2);
      expect(hold.maxConcurrentWrites()).toBe(1);
    } finally {
      hold.restore();
    }
  });

  test("a rename failure leaves the previous complete file authoritative", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-a" });
    const before = await harness.readPublished();
    const hold = holdPublication();
    try {
      state.composer = { ...state.composer, selectedModelId: "never-published" };
      // The temporary file is written in full; only the rename fails.
      hold.failRenameWith(new Error("rename refused"));
      hold.release();
      await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-failed" });
      expect(hold.writes()).toBe(1);
      expect(hold.renameAttempts()).toBe(1);
      expect(hold.renames()).toBe(0);
      const temporary = JSON.parse(await readFile(`${harness.stateFile}.tmp`, "utf8")) as {
        sessions: Array<{ composer: { selectedModelId?: string } }>;
      };
      expect(temporary.sessions[0]!.composer.selectedModelId).toBe("never-published");
      expect(await harness.readPublished()).toEqual(before!);
    } finally {
      hold.restore();
    }
  });

  test("a barrier after shutdown began is refused, and the final file is valid", async () => {
    await harness.createSession({ clientSessionKey: "tab-a" });
    const { drainPersistence } = await import("./persistence.js");
    await drainPersistence();
    await expect(persistBarrier()).rejects.toMatchObject({ code: "persistence-closed" });
    expect(await harness.readPublished()).toMatchObject({ provider: "cursor" });
    reopenPersistenceForTests();
  });
});

describe("prompt dispatch", () => {
  test("nothing is sent while the prepared record's write is held", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    const hold = holdPublication();
    try {
      const response = prompt(state, "held-1");
      await hold.held;
      // The prepared record exists in memory but has not reached disk.
      expect(state.promptJournal.get("held-1")?.state).toBe("prepared");
      expect(agent.sends).toHaveLength(0);
      hold.release();
      expect((await response).status).toBe(202);
      expect(agent.sends).toHaveLength(1);
    } finally {
      hold.restore();
    }
  });

  test("a failed publication refuses the prompt before the SDK sees it", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const response = await prompt(state, "fail-1");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        kind: "persistence-unavailable",
        code: "persistence-failed",
      });
      expect(agent.sends).toHaveLength(0);
      // Provably not dispatched: the claim is released and the id is reusable.
      expect(state.dispatching).toBe(false);
      expect(state.promptJournal.has("fail-1")).toBe(false);

      hold.failWith(undefined);
      expect((await prompt(state, "fail-1")).status).toBe(202);
      expect(agent.sends).toHaveLength(1);
    } finally {
      hold.restore();
    }
  });

  test("a crash right before dispatch restarts into an ambiguous record, never a re-send", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-a" });
    const holdSend = deferred();
    const agent = attachFake(state, { holdSend: holdSend.promise });
    try {
      const response = prompt(state, "crash-1");
      // `send` has been called, so the barrier before it has completed.
      await waitFor(() => agent.sends.length === 1);
      // Read the file as a successor would, without a graceful flush.
      const published = (await harness.readPublished()) as {
        sessions: Array<{ id: string; promptJournal: Array<{ requestId: string; state: string }> }>;
      };
      expect(published.sessions[0]!.promptJournal).toContainEqual(
        expect.objectContaining({ requestId: "crash-1", state: "ambiguous" }),
      );

      // Simulate the successor: load only what was published.
      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();
      const successor = sessions.get(state.id)!;
      const successorAgent = attachFake(successor);
      const retry = await prompt(successor, "crash-1");
      expect(retry.status).toBe(410);
      expect(successorAgent.sends).toHaveLength(0);

      holdSend.resolve();
      await response;
    } finally {
      holdSend.resolve();
    }
  });
});

describe("steer dispatch", () => {
  test("nothing is steered while the prepared record's write is held", async () => {
    const state = await harness.createSession();
    const delivered: string[] = [];
    steerableRun(state, delivered);
    const hold = holdPublication();
    try {
      const response = steer(state, "steer-held");
      await hold.held;
      expect(delivered).toEqual([]);
      hold.release();
      expect((await response).status).toBe(202);
      expect(delivered).toEqual(["narrow it"]);
    } finally {
      hold.restore();
    }
  });

  test("a failed publication refuses the steer before delivery", async () => {
    const state = await harness.createSession();
    const delivered: string[] = [];
    steerableRun(state, delivered);
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const response = await steer(state, "steer-fail");
      // Provably not sent, so the refusal is definitive (INC-07).
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        outcome: "rejected",
        reason: "steer-not-recorded",
        requestId: "steer-fail",
      });
      expect(delivered).toEqual([]);
      expect(state.steerJournal.has("steer-fail")).toBe(false);
      expect(state.steerJournalBytes).toBe(0);
    } finally {
      hold.restore();
    }
  });

  test("a delivered steer whose outcome write fails is still one delivery", async () => {
    const state = await harness.createSession();
    const delivered: string[] = [];
    state.status = "running";
    const hold = holdPublication();
    state.activeRun = {
      id: "run-1",
      supports: (feature: string) => feature === "stream",
      steer: async (text: string) => {
        delivered.push(text);
        // The prepared write already succeeded; the outcome's write fails.
        hold.failWith(new Error("disk full after delivery"));
        return "complete_delivered";
      },
    } as SessionState["activeRun"];
    try {
      hold.release();
      const first = await steer(state, "steer-late-fail");
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ outcome: "applied", requestId: "steer-late-fail" });
      // The file still holds the request as prepared, which a restart reads
      // as ambiguous — never as "absent".
      const published = (await harness.readPublished()) as {
        sessions: Array<{ steerJournal: Array<{ requestId: string; state: string }> }>;
      };
      expect(published.sessions[0]!.steerJournal).toContainEqual(
        expect.objectContaining({ requestId: "steer-late-fail", state: "ambiguous" }),
      );
      const retry = await steer(state, "steer-late-fail");
      expect(await retry.json()).toMatchObject({ outcome: "applied", duplicate: true });
      expect(delivered).toEqual(["narrow it"]);
    } finally {
      hold.restore();
    }
  });
});

describe("stateless mode", () => {
  test("with no state directory configured, prompts dispatch without publication", async () => {
    await harness.close();
    harness = await startRouterHarness({ stateless: true });
    const state = await harness.createSession();
    const agent = attachFake(state);
    expect((await prompt(state, "stateless-1")).status).toBe(202);
    expect(agent.sends).toHaveLength(1);
    expect(await harness.readPublished()).toBeUndefined();
  });
});
