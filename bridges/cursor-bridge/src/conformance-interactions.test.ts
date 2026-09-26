/**
 * The inconsistency fixes working together (plan step 11, section B).
 *
 * Each fix has its own focused suite. These cases cross them: a cancel and a
 * close racing a held publication, dispatch at the aggregate limit, steering
 * at capacity across a restart, and incremental reads of a shed transcript.
 * Recovery is always proved from the published file, never from a drain.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadPersistedState } from "./persistence.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import { attachFake } from "./testing/fake-agent.js";
import {
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

async function restartFromDisk(): Promise<void> {
  sessions.clear();
  clientSessionKeys.clear();
  await loadPersistedState();
}

function prompt(state: SessionState, requestId: string): Promise<Response> {
  return harness.call(`/session/${state.id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt: "synthetic prompt", requestId }),
  });
}

function bigMessage(id: string, bytes: number): SessionState["messages"][number] {
  return {
    id,
    role: "assistant",
    content: "y".repeat(bytes),
    parts: [],
    createdAt: new Date(0).toISOString(),
  };
}

describe("cancel and close racing a held publication", () => {
  test("nothing is sent, cleanup is safe, and the final file cannot revive the session", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const agent = attachFake(state);
    const hold = holdPublication();
    try {
      const turn = prompt(state, "race-1");
      await hold.held;
      const cancel = await harness.call(`/session/${state.id}/cancel`, { method: "POST" });
      // Claimed but not yet sent: parked, never reported as stopped.
      expect(cancel.status).toBe(202);
      const closing = harness.call(`/session/${state.id}`, { method: "DELETE" });
      await waitFor(() => state.closed === true);
      hold.release();

      expect((await turn).status).toBe(409);
      expect((await closing).status).toBe(200);
      expect(agent.sends).toHaveLength(0);
      expect(agent.cancels).toBe(0);

      await restartFromDisk();
      expect(sessions.has(state.id)).toBe(false);
      expect(clientSessionKeys.has("tab-1")).toBe(false);
    } finally {
      hold.restore();
    }
  });
});

describe("dispatch at the aggregate limit", () => {
  test("a new session's identity and prepared intent are published before acceptance", async () => {
    const chunk = 15 * 1024 * 1024;
    for (const [index, key] of ["old-a", "old-b", "old-c"].entries()) {
      const old = await harness.createSession({ clientSessionKey: key });
      old.lastAccessed = index + 1;
      old.messages.push(bigMessage(`${key}-m`, chunk));
    }
    const fresh = await harness.createSession({ clientSessionKey: "fresh" });
    const holdSend = Promise.withResolvers<void>();
    const agent = attachFake(fresh, { holdSend: holdSend.promise });
    try {
      const turn = prompt(fresh, "at-limit-1");
      await waitFor(() => agent.sends.length === 1);
      // `send` has been called: the file a successor would read must already
      // carry the fresh session and its request, whatever was shed to fit.
      const file = (await harness.readPublished()) as {
        sessions: Array<{ id: string; promptJournal: Array<{ requestId: string; state: string }> }>;
      };
      const published = file.sessions.find((entry) => entry.id === fresh.id);
      expect(published?.promptJournal).toContainEqual(
        expect.objectContaining({ requestId: "at-limit-1", state: "ambiguous" }),
      );
      expect(file.sessions).toHaveLength(4);
      holdSend.resolve();
      expect((await turn).status).toBe(202);
    } finally {
      holdSend.resolve();
    }
  });
});

describe("steering at capacity across a restart", () => {
  test("a lost refusal and a recovered run never produce a duplicate or a fabricated absent", async () => {
    const state = await harness.createSession();
    const delivered: string[] = [];
    state.status = "running";
    state.activeRun = {
      id: "run-1",
      supports: (feature: string) => feature === "stream",
      steer: async (text: string) => {
        delivered.push(text);
        return "complete_delivered";
      },
    } as SessionState["activeRun"];
    const steer = (requestId: string, target: SessionState = state) =>
      harness.call(`/session/${target.id}/steer`, {
        method: "POST",
        body: JSON.stringify({ input: `steer ${requestId}`, requestId, expectedRunId: "run-1" }),
      });

    for (let index = 0; index < 256; index += 1) {
      expect((await steer(`s-${index}`)).status).toBe(202);
    }
    const refused = await steer("parked");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "parked",
    });
    // The backend lost that answer and retries the same attempt.
    expect((await steer("parked")).status).toBe(429);
    expect(delivered).toHaveLength(256);

    await restartFromDisk();
    const restored = sessions.get(state.id)!;
    // Stand in for the same run being re-adopted after the restart.
    restored.status = "running";
    restored.activeRun = state.activeRun;
    restored.activeRunRecovered = true;
    expect((await steer("parked", restored)).status).toBe(429);
    // A delivered, retained record still answers as delivered — once.
    expect(await (await steer("s-0", restored)).json()).toMatchObject({
      outcome: "applied",
      duplicate: true,
    });
    expect(delivered).toHaveLength(256);
    // The refused id was never recorded, so it probes as unknown, not absent.
    expect(
      await (await harness.call(`/session/${state.id}/steer/dispatch?requestId=parked`)).json(),
    ).toEqual({ dispatch: "unknown" });
  });
});

describe("incremental reads of a shed transcript", () => {
  test("stale and malformed cursors land on the honest, truncated retained window", async () => {
    const chunk = 15 * 1024 * 1024;
    const shed = await harness.createSession({ clientSessionKey: "shed" });
    shed.lastAccessed = 1;
    shed.messages.push(bigMessage("a", 1024), bigMessage("b", chunk));
    for (const [index, key] of ["keep-a", "keep-b"].entries()) {
      const kept = await harness.createSession({ clientSessionKey: key });
      kept.lastAccessed = index + 10;
      kept.messages.push(bigMessage(`${key}-m`, chunk));
    }
    await harness.createSession({ clientSessionKey: "trigger" });
    await restartFromDisk();

    const restored = sessions.get(shed.id)!;
    expect(restored.messages).toEqual([]);
    expect(restored.droppedMessages).toBe(2);
    expect(restored.transcriptTruncated).toBe(true);
    for (const cursor of ["0", "1", "not-a-number", "1.5", "-1", ""]) {
      const window = (await (
        await harness.call(`/session/${shed.id}/messages?fromIndex=${cursor}`)
      ).json()) as Record<string, unknown>;
      expect(window).toMatchObject({
        messages: [],
        baseIndex: 2,
        totalMessages: 2,
        messageWindow: { truncated: true, omittedMessages: 2 },
      });
    }
    // A valid cursor at the end is the existing bounded empty result.
    expect(
      await (await harness.call(`/session/${shed.id}/messages?fromIndex=2`)).json(),
    ).toMatchObject({ messages: [], baseIndex: 2, totalMessages: 2 });
  });
});
