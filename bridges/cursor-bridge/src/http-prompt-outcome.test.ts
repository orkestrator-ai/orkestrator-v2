/**
 * What the prompt route records and answers at each point a turn can stop.
 *
 * - `send` called and rejected: the outcome is unknown, so the record stays as
 *   ambiguous evidence and the answer is the distinct 502 the backend parks.
 * - An unreadable attachment: rejected before any prepared record exists.
 * - A cancel parked while the prepared record is being published: settled
 *   locally, never sent.
 * - A journal full of records that must not be evicted: refused up front.
 * - A rewind whose publication fails after the SDK store already changed:
 *   reported as applied but unsaved, never as refused.
 * - A cold attach during the prompt: the new provider identity is on disk
 *   before `send` is called.
 *
 * The router, the write queue, the journals and serialization are production
 * code; only the SDK agent, its local store and the filesystem calls of a
 * publication are replaced.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { readFileSync } from "node:fs";
import type { LocalAgentStore } from "@cursor/sdk";
import { MAX_PROMPT_JOURNAL } from "./config.js";
import { loadPersistedState, persistBarrier } from "./persistence.js";
import { useCursorLocalAgentStoreForTests, useCursorSdkRuntimeForTests } from "./sdk-runtime.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import { attachFake, fakeAgent } from "./testing/fake-agent.js";
import {
  deferred,
  holdPublication,
  startRouterHarness,
  stubAttach,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";

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

function prompt(
  state: SessionState,
  requestId: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return harness.call(`/session/${state.id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt: "synthetic prompt", requestId, ...extra }),
  });
}

type PublishedSession = {
  id: string;
  agentId?: string;
  promptJournal: Array<{ requestId: string; state: string; sendFailed?: unknown }>;
};

async function publishedSession(id: string): Promise<PublishedSession | undefined> {
  const file = (await harness.readPublished()) as { sessions: PublishedSession[] } | undefined;
  return file?.sessions.find((entry) => entry.id === id);
}

describe("a send that rejects after it was called", () => {
  test("keeps ambiguous evidence, answers 502, and a restart refuses the id", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const refused = attachFake(state, { failToStart: new Error("transport reset") });

    const response = await prompt(state, "unknown-1");
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; kind: string };
    expect(body.kind).toBe("dispatch-outcome-unknown");
    // Fixed text: the SDK's own error message never reaches the caller.
    expect(body.error).not.toContain("transport reset");
    expect(refused.sends).toHaveLength(1);
    // The failed SDK object is released, as before.
    expect(state.agent).toBeNull();
    expect(state.dispatching).toBe(false);
    expect(state.promptJournal.get("unknown-1")).toMatchObject({
      state: "ambiguous",
      sendFailed: true,
    });
    expect(
      await (await harness.call(`/session/${state.id}/dispatch?requestId=unknown-1`)).json(),
    ).toEqual({ dispatch: "unknown" });

    // Published as plain ambiguous: the same-process retry licence is not.
    await persistBarrier();
    const record = (await publishedSession(state.id))!.promptJournal.find(
      (entry) => entry.requestId === "unknown-1",
    );
    expect(record).toEqual({
      requestId: "unknown-1",
      state: "ambiguous",
      acceptedAt: expect.any(Number),
    });

    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();
    const successor = sessions.get(state.id)!;
    const successorAgent = attachFake(successor);
    expect((await prompt(successor, "unknown-1")).status).toBe(410);
    expect(successorAgent.sends).toHaveLength(0);
  });

  test("a same-process retry that fails before sending keeps the ambiguous record", async () => {
    const state = await harness.createSession();
    attachFake(state, { failToStart: new Error("transport reset") });
    expect((await prompt(state, "unknown-2")).status).toBe(502);

    // The retry is refused at publication, before the SDK. What the first
    // attempt left must survive: its send may have run.
    const replacement = attachFake(state);
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      expect((await prompt(state, "unknown-2")).status).toBe(503);
      expect(replacement.sends).toHaveLength(0);
      expect(state.promptJournal.get("unknown-2")).toMatchObject({
        state: "ambiguous",
        sendFailed: true,
      });
    } finally {
      hold.restore();
    }
  });
});

describe("attachments", () => {
  test("an unreadable image never creates a prepared record", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    await persistBarrier();
    const hold = holdPublication();
    try {
      hold.release();
      const response = await prompt(state, "image-1", {
        attachments: [{ type: "image", path: "no-such-dir/definitely-missing-image.png" }],
      });
      expect(response.status).toBe(400);
      expect(agent.sends).toHaveLength(0);
      expect(state.dispatching).toBe(false);
      expect(state.promptJournal.has("image-1")).toBe(false);
      // A prepared record would have scheduled a write of its own.
      expect(hold.writes()).toBe(0);
    } finally {
      hold.restore();
    }
  });
});

describe("a cancel parked during the prepared-record barrier", () => {
  test("settles the turn locally and never calls the SDK", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    await persistBarrier();
    const hold = holdPublication();
    try {
      const response = prompt(state, "cancel-1");
      await hold.held;
      expect(state.dispatching).toBe(true);
      const cancel = await harness.call(`/session/${state.id}/cancel`, { method: "POST" });
      expect(cancel.status).toBe(202);
      expect(await cancel.json()).toEqual({ cancelled: false, pending: true });

      hold.release();
      const answered = await response;
      expect(answered.status).toBe(202);
      expect(await answered.json()).toEqual({ accepted: true, cancelled: true });
      expect(agent.sends).toHaveLength(0);
      expect(state.status).toBe("idle");
      expect(state.dispatching).toBe(false);
      expect(state.pendingCancelPromptSequence).toBeUndefined();
      // The user's message is kept; nothing claims an assistant reply.
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toMatchObject({ role: "user", content: "synthetic prompt" });
      expect(state.promptJournal.get("cancel-1")).toMatchObject({
        state: "completed",
        local: true,
      });

      // A duplicate is answered as handled, never run.
      const duplicate = await prompt(state, "cancel-1");
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ duplicate: true });
      expect(agent.sends).toHaveLength(0);
      // And the next turn is not cancelled by the one that was.
      expect((await prompt(state, "after-cancel")).status).toBe(202);
      expect(agent.sends).toHaveLength(1);
    } finally {
      hold.restore();
    }
  });
});

describe("prompt journal retention", () => {
  function fillWithProtected(state: SessionState): void {
    for (let index = 0; index < MAX_PROMPT_JOURNAL; index += 1) {
      state.promptJournal.set(`old-${index}`, {
        requestId: `old-${index}`,
        state: index % 2 === 0 ? "ambiguous" : "accepted",
        acceptedAt: index,
      });
    }
  }

  test("a journal full of protected records refuses a new id before journaling it", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    fillWithProtected(state);

    const response = await prompt(state, "new-1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ kind: "prompt-journal-saturated" });
    expect(agent.sends).toHaveLength(0);
    expect(state.dispatching).toBe(false);
    expect(state.promptJournal.size).toBe(MAX_PROMPT_JOURNAL);
    expect(state.promptJournal.has("new-1")).toBe(false);
    expect(state.promptJournal.has("old-0")).toBe(true);
  });

  test("discarding an ambiguous id frees capacity and survives restart", async () => {
    const state = await harness.createSession();
    fillWithProtected(state);
    await persistBarrier();
    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();
    const restored = sessions.get(state.id)!;
    const agent = attachFake(restored);
    expect(restored.promptJournal.size).toBe(MAX_PROMPT_JOURNAL);
    const discard = await harness.call(`/session/${state.id}/dispatch/discard`, {
      method: "POST",
      body: JSON.stringify({ requestId: "old-0" }),
    });
    expect(discard.status).toBe(200);
    expect(restored.promptJournal.get("old-0")?.state).toBe("discarded");
    expect((await prompt(restored, "old-0")).status).toBe(410);
    expect((await prompt(restored, "new-1")).status).toBe(202);
    expect(agent.sends).toHaveLength(1);
    sessions.clear();
    clientSessionKeys.clear();
    await loadPersistedState();
    expect(sessions.get(state.id)?.promptJournal.has("new-1")).toBe(true);
  });

  test("settled records are evicted first; unresolved evidence is kept", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    fillWithProtected(state);
    // One settled record, and not the oldest: eviction skips protected ones.
    state.promptJournal.set("old-7", { requestId: "old-7", state: "completed", acceptedAt: 7 });

    expect((await prompt(state, "new-2")).status).toBe(202);
    expect(agent.sends).toHaveLength(1);
    expect(state.promptJournal.size).toBe(MAX_PROMPT_JOURNAL);
    expect(state.promptJournal.has("old-7")).toBe(false);
    expect(state.promptJournal.has("old-0")).toBe(true);
    expect(state.promptJournal.has("old-1")).toBe(true);
    expect(state.promptJournal.has("new-2")).toBe(true);
  });
});

describe("rewind after the SDK store changed", () => {
  test("an unsaved rewind is reported as applied, not refused", async () => {
    const state = await harness.createSession();
    state.agentId = "agent-rewind";
    state.messages = [
      { id: "u1", role: "user", content: "first", parts: [], createdAt: "t", runId: "run-1" },
      { id: "a1", role: "assistant", content: "one", parts: [], createdAt: "t" },
      { id: "u2", role: "user", content: "second", parts: [], createdAt: "t", runId: "run-2" },
      { id: "a2", role: "assistant", content: "two", parts: [], createdAt: "t" },
    ];
    await persistBarrier();
    const storeWrites: string[] = [];
    const store = {
      agents: {
        get: async () => ({ agentId: "agent-rewind", latestCheckpoint: "latest" }),
        update: async () => {
          storeWrites.push("agent");
        },
      },
      runs: {
        list: async () => ({
          items: [
            { runId: "run-1", turnNumber: 1, startCheckpointRef: "cp-1" },
            { runId: "run-2", turnNumber: 2, startCheckpointRef: "cp-2" },
          ],
          nextCursor: undefined,
        }),
        delete: async () => {
          storeWrites.push("runs");
        },
      },
      runEvents: {
        delete: async () => {
          storeWrites.push("events");
        },
      },
    } as unknown as LocalAgentStore;
    const restoreRuntime = useCursorSdkRuntimeForTests({
      configureStore: () => undefined,
      createPlatform: (async () => ({})) as never,
    });
    const previousStore = useCursorLocalAgentStoreForTests(store);
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const response = await harness.call(`/session/${state.id}/rewind-messages`, {
        method: "POST",
        body: JSON.stringify({ messageId: "u2" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ rewound: true, persisted: false });
      // The SDK store had already been rewound when publication failed.
      expect(storeWrites).toEqual(["agent", "events", "runs"]);
      expect(state.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
      const notice = state.health
        .listNotices()
        .find((entry) => entry.method === "persistence" && entry.severity === "warning");
      expect(notice?.message).toContain("rewind was applied");
      expect(notice?.message).not.toContain(harness.stateRoot);
      // The file still holds the pre-rewind transcript, as the notice says.
      const file = (await harness.readPublished()) as {
        sessions: Array<{ messages: Array<{ id: string }> }>;
      };
      expect(file.sessions[0]!.messages.map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "u2",
        "a2",
      ]);
    } finally {
      hold.restore();
      useCursorLocalAgentStoreForTests(previousStore);
      restoreRuntime();
    }
  });
});

describe("cold attach during a prompt", () => {
  test("the newly created provider identity is on disk before send is called", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-cold" });
    expect(state.agentId).toBeUndefined();
    const agent = fakeAgent();
    (agent as unknown as { agentId: string }).agentId = "cold-agent-1";
    const seenAtSend: Array<PublishedSession | undefined> = [];
    const send = agent.send.bind(agent);
    (agent as unknown as { send: typeof agent.send }).send = ((
      ...args: Parameters<typeof send>
    ) => {
      // Read synchronously at the moment of the call, as a successor would.
      const file = JSON.parse(readFileSync(harness.stateFile, "utf8")) as {
        sessions: PublishedSession[];
      };
      seenAtSend.push(file.sessions.find((entry) => entry.id === state.id));
      return send(...args);
    }) as typeof agent.send;
    const restore = stubAttach({ create: async () => agent });
    try {
      expect((await prompt(state, "cold-1")).status).toBe(202);
      expect(seenAtSend).toHaveLength(1);
      expect(seenAtSend[0]?.agentId).toBe("cold-agent-1");
      expect(seenAtSend[0]?.promptJournal).toContainEqual(
        expect.objectContaining({ requestId: "cold-1", state: "ambiguous" }),
      );
    } finally {
      restore();
    }
  });
});

describe("a rewind in flight", () => {
  test("refuses a prompt that would resume a half-rewritten conversation", async () => {
    const state = await harness.createSession();
    state.agentId = "agent-rewinding";
    state.messages = [
      { id: "u1", role: "user", content: "first", parts: [], createdAt: "t", runId: "run-1" },
      { id: "a1", role: "assistant", content: "one", parts: [], createdAt: "t" },
    ];
    const agent = attachFake(state);
    const listing = deferred();
    const store = {
      agents: {
        get: async () => ({ agentId: "agent-rewinding", latestCheckpoint: "latest" }),
        update: async () => undefined,
      },
      runs: {
        list: async () => {
          await listing.promise;
          return {
            items: [{ runId: "run-1", turnNumber: 1, startCheckpointRef: "cp-1" }],
            nextCursor: undefined,
          };
        },
        delete: async () => undefined,
      },
      runEvents: { delete: async () => undefined },
    } as unknown as LocalAgentStore;
    const restoreRuntime = useCursorSdkRuntimeForTests({
      configureStore: () => undefined,
      createPlatform: (async () => ({})) as never,
    });
    const previousStore = useCursorLocalAgentStoreForTests(store);
    try {
      const rewind = harness.call(`/session/${state.id}/rewind-messages`, {
        method: "POST",
        body: JSON.stringify({ messageId: "u1" }),
      });
      await waitFor(() => state.rewinding !== undefined);
      const refused = await prompt(state, "during-rewind");
      expect(refused.status).toBe(409);
      expect(agent.sends).toHaveLength(0);
      expect(state.promptJournal.has("during-rewind")).toBe(false);
      listing.resolve();
      expect((await rewind).status).toBe(200);
      expect(state.rewinding).toBeUndefined();
    } finally {
      listing.resolve();
      useCursorLocalAgentStoreForTests(previousStore);
      restoreRuntime();
    }
  });
});
