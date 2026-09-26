/**
 * INC-02: once a permanent close has begun, nothing the session owned may start
 * work, and nothing already in flight may keep running unobserved.
 *
 * Every interleaving is pinned with a deferred attach, send, dispose or
 * state-file write. A 200 on its own proves nothing here, so each case also
 * asserts the provider call counts, the live handles, the registry and what a
 * successor would load from disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { SDKAgent } from "@cursor/sdk";
import type { LocalAgentStore } from "@cursor/sdk";
import { detachAgent } from "./agent-session.js";
import { loadPersistedState } from "./persistence.js";
import { followRun } from "./prompt.js";
import { useCursorLocalAgentStoreForTests } from "./sdk-runtime.js";
import { closeSessionPermanently } from "./session-close.js";
import { clientSessionKeys, closingTombstones, sessions, type SessionState } from "./state.js";
import { attachFake, fakeAgent, type FakeAgent } from "./testing/fake-agent.js";
import {
  defaultPolicy,
  deferred,
  holdPublication,
  startRouterHarness,
  stubAttach,
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

function close(state: SessionState): Promise<Response> {
  return harness.call(`/session/${state.id}`, { method: "DELETE" });
}

function countingDispose(agent: FakeAgent): () => number {
  let disposed = 0;
  (agent as unknown as Record<symbol, () => Promise<void>>)[Symbol.asyncDispose] = async () => {
    disposed += 1;
  };
  return () => disposed;
}

/** A published file that a successor would load: no session, no tombstone. */
async function expectGoneOnDisk(state: SessionState): Promise<void> {
  const file = (await harness.readPublished()) as {
    sessions: Array<{ id: string }>;
    closing?: Array<{ id: string }>;
  };
  expect(file.sessions.map((entry) => entry.id)).not.toContain(state.id);
  expect((file.closing ?? []).map((entry) => entry.id)).not.toContain(state.id);
}

describe("close racing startup", () => {
  test("a prompt waiting on attach sends nothing, and the late agent is disposed", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const created = deferred<SDKAgent>();
    const late = fakeAgent();
    const disposed = countingDispose(late);
    const restore = stubAttach({ create: () => created.promise });
    try {
      const turn = prompt(state, "startup-1");
      await waitFor(() => state.attaching !== undefined);
      const closing = close(state);
      await waitFor(() => state.closed === true);
      created.resolve(late);

      expect((await turn).status).toBe(409);
      expect((await closing).status).toBe(200);
      expect(late.sends).toHaveLength(0);
      expect(disposed()).toBe(1);
      expect(state.agent).toBeNull();
      expect(sessions.has(state.id)).toBe(false);
      expect(clientSessionKeys.has("tab-1")).toBe(false);
      await expectGoneOnDisk(state);
    } finally {
      created.resolve(fakeAgent());
      restore();
    }
  });

  test("an explicit attach that completes after close never becomes a live agent", async () => {
    const state = await harness.createSession();
    const created = deferred<SDKAgent>();
    const late = fakeAgent();
    const disposed = countingDispose(late);
    const restore = stubAttach({ create: () => created.promise });
    try {
      const attach = harness.call(`/session/${state.id}/attach`, { method: "POST", body: "{}" });
      await waitFor(() => state.attaching !== undefined);
      const closing = close(state);
      await waitFor(() => state.closed === true);
      created.resolve(late);
      expect((await attach).status).toBe(409);
      expect((await closing).status).toBe(200);
      expect(disposed()).toBe(1);
      expect(state.agent).toBeNull();
    } finally {
      created.resolve(fakeAgent());
      restore();
    }
  });

  test("a close that arrives while the prepared record is being written wins", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    const hold = holdPublication();
    try {
      const turn = prompt(state, "barrier-1");
      await hold.held;
      const closing = close(state);
      await waitFor(() => state.closed === true);
      hold.release();
      expect((await turn).status).toBe(409);
      expect((await closing).status).toBe(200);
      expect(agent.sends).toHaveLength(0);
    } finally {
      hold.restore();
    }
  });

  test("a send already in flight is cancelled the moment its run exists, and followed", async () => {
    const state = await harness.createSession();
    const sendGate = deferred();
    const agent = attachFake(state, { holdSend: sendGate.promise });
    try {
      const turn = prompt(state, "send-1");
      await waitFor(() => agent.sends.length === 1);
      const closing = close(state);
      await waitFor(() => state.closed === true);
      sendGate.resolve();
      expect((await turn).status).toBe(202);
      expect((await closing).status).toBe(200);
      expect(agent.sends).toHaveLength(1);
      expect(agent.cancels).toBeGreaterThanOrEqual(1);
      expect(state.activeRun).toBeUndefined();
      expect(state.cancelTurn).toBeUndefined();
      await expectGoneOnDisk(state);
    } finally {
      sendGate.resolve();
    }
  });
});

describe("close of a running turn", () => {
  test("stops the run and stays busy until the run has actually stopped", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      const closing = close(state);
      await waitFor(() => agent.cancels === 1);
      // Still registered, still working: the run has been asked, not stopped.
      expect(sessions.has(state.id)).toBe(true);
      expect(await (await harness.call(`/session/${state.id}/activity`)).json()).toMatchObject({
        activity: "working",
      });
      // No new work is admitted in the meantime.
      expect((await prompt(state, "run-2")).status).toBe(409);
      runGate.resolve();
      expect((await closing).status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      runGate.resolve();
    }
  });

  test("a close whose run does not stop in time answers pending, then completes", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    attachFake(state, { hold: runGate.promise });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(sessions.has(state.id)).toBe(true);
      // A retry joins the same operation rather than starting a second one.
      const first = state.closing;
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(state.closing).toBe(first);
      runGate.resolve();
      expect(await closeSessionPermanently(state, 2_000)).toBe("closed");
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      runGate.resolve();
    }
  });

  test("late callbacks from the closed turn publish nothing", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      const onDelta = (agent.sends[0]!.options as { onDelta: (args: { update: unknown }) => void })
        .onDelta;
      const closing = close(state);
      await waitFor(() => state.closed === true);
      const messages = JSON.stringify(state.messages);
      onDelta({ update: { type: "text-delta", text: "late output" } });
      expect(JSON.stringify(state.messages)).toBe(messages);
      runGate.resolve();
      await closing;
      onDelta({ update: { type: "text-delta", text: "later output" } });
      expect(JSON.stringify(state.messages)).toBe(messages);
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      runGate.resolve();
    }
  });
});

describe("close cleanup and publication", () => {
  test("concurrent closes share one cleanup and one disposal", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    const disposed = countingDispose(agent);
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      const first = close(state);
      const second = close(state);
      const third = harness.call(`/session/${state.id}/close`, { method: "POST" });
      await waitFor(() => agent.cancels > 0);
      runGate.resolve();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(await (await third).json()).toEqual({ closed: true, retained: true });
      expect(disposed()).toBe(1);
    } finally {
      runGate.resolve();
    }
  });

  test("a hanging dispose keeps the close pending instead of reporting it done", async () => {
    const state = await harness.createSession();
    const disposeGate = deferred();
    attachFake(state, { holdDispose: disposeGate.promise });
    try {
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(sessions.has(state.id)).toBe(true);
      disposeGate.resolve();
      expect(await closeSessionPermanently(state, 2_000)).toBe("closed");
    } finally {
      disposeGate.resolve();
    }
  });

  test("a rejected dispose is observed and does not wedge the close", async () => {
    const state = await harness.createSession();
    attachFake(state, { failDispose: new Error("dispose exploded") });
    expect((await close(state)).status).toBe(200);
    expect(sessions.has(state.id)).toBe(false);
  });

  test("a failed removal publication is retryable and never reads as already gone", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    attachFake(state);
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const failed = await close(state);
      expect(failed.status).toBe(503);
      // The record stays registered, so a retry cannot be told "not found"
      // while the file still describes a live session.
      expect(sessions.has(state.id)).toBe(true);
      expect((await harness.call(`/session/${state.id}`)).status).toBe(200);
      // Nothing may be started on it in the meantime.
      expect((await prompt(state, "after-close")).status).toBe(409);

      hold.failWith(undefined);
      expect((await close(state)).status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);
      await expectGoneOnDisk(state);
    } finally {
      hold.restore();
    }
  });

  test("a closing session refuses every new operation but still answers reads", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const runGate = deferred();
    attachFake(state, { hold: runGate.promise });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      const closing = close(state);
      await waitFor(() => state.closed === true);
      const refused = await harness.call("/session/create", {
        method: "POST",
        body: JSON.stringify({
          clientSessionKey: "tab-1",
          policy: {
            id: "interactive-host",
            sandbox: "none",
            approvals: "auto-approve",
            projectResources: false,
            networkAccess: "full",
          },
        }),
      });
      expect(refused.status).toBe(409);
      expect(
        (
          await harness.call(`/session/${state.id}/config`, {
            method: "POST",
            body: JSON.stringify({ modelId: "other" }),
          })
        ).status,
      ).toBe(409);
      expect((await harness.call(`/session/${state.id}/messages`)).status).toBe(200);
      runGate.resolve();
      expect((await closing).status).toBe(200);

      // Once the close has settled, a deliberate create gets a new session.
      const fresh = await harness.createSession({ clientSessionKey: "tab-1" });
      expect(fresh.id).not.toBe(state.id);
    } finally {
      runGate.resolve();
    }
  });
});

describe("close route and restart", () => {
  test("POST close answers retained, and an unknown session in band", async () => {
    const state = await harness.createSession();
    const closed = await harness.call(`/session/${state.id}/close`, { method: "POST" });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ closed: true, retained: true });
    const unknown = await harness.call(`/session/${state.id}/close`, { method: "POST" });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ closed: true, missing: true });
  });

  test("a close recorded by a dead process is never reopened, and a retry finishes it", async () => {
    await writeFile(
      harness.stateFile,
      JSON.stringify({
        version: 1,
        provider: "cursor",
        closing: [{ id: "closing-1", since: 1 }],
        sessions: [
          {
            id: "closing-1",
            clientSessionKey: "tab-1",
            status: "idle",
            messages: [],
            revision: 1,
            structured: [],
            promptJournal: [],
          },
        ],
      }),
    );
    await loadPersistedState();
    expect(sessions.has("closing-1")).toBe(false);
    expect(clientSessionKeys.has("tab-1")).toBe(false);
    expect(closingTombstones.has("closing-1")).toBe(true);
    expect(await (await harness.call("/session/closing-1/activity")).json()).toEqual({
      activity: "missing",
    });

    expect((await harness.call("/session/closing-1", { method: "DELETE" })).status).toBe(200);
    expect(closingTombstones.has("closing-1")).toBe(false);
    const file = (await harness.readPublished()) as { closing?: unknown[] };
    expect(file.closing ?? []).toEqual([]);
  });

  test("idle detach is not a close: the same conversation is resumed on the next prompt", async () => {
    const state = await harness.createSession();
    state.agentId = "kept-conversation";
    const resumed: string[] = [];
    const restore = stubAttach({
      resume: async (agentId) => {
        resumed.push(agentId);
        return fakeAgent();
      },
    });
    try {
      await detachAgent(state);
      expect(state.closed).toBeUndefined();
      expect((await prompt(state, "after-detach")).status).toBe(202);
      expect(resumed).toEqual(["kept-conversation"]);
      expect(state.agentId).toBe("kept-conversation");
    } finally {
      restore();
    }
  });
});

describe("close racing an acknowledgement", () => {
  test("a resume whose publication a close overtook is not acknowledged", async () => {
    const restore = stubAttach({ resume: async () => fakeAgent() });
    const hold = holdPublication();
    try {
      const resume = harness.call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: "vendor-agent-close", policy: defaultPolicy }),
      });
      await hold.held;
      const state = Array.from(sessions.values()).find(
        (candidate) => candidate.agentId === "vendor-agent-close",
      )!;
      const closing = close(state);
      await waitFor(() => state.closed === true);
      hold.release();
      const answered = await resume;
      expect(answered.status).toBe(409);
      expect(await answered.json()).toMatchObject({ kind: "session-closing" });
      expect((await closing).status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);
      await expectGoneOnDisk(state);
    } finally {
      hold.restore();
      restore();
    }
  });

  test("a config change whose publication a close overtook is not acknowledged", async () => {
    const state = await harness.createSession();
    const hold = holdPublication();
    try {
      const config = harness.call(`/session/${state.id}/config`, {
        method: "POST",
        body: JSON.stringify({ modelId: "other-model" }),
      });
      await hold.held;
      const closing = close(state);
      await waitFor(() => state.closed === true);
      hold.release();
      const answered = await config;
      expect(answered.status).toBe(409);
      expect(await answered.json()).toMatchObject({ kind: "session-closing" });
      expect((await closing).status).toBe(200);
      await expectGoneOnDisk(state);
    } finally {
      hold.restore();
    }
  });

  test("an attach whose identity publication a close overtook is not acknowledged", async () => {
    const state = await harness.createSession();
    const agent = fakeAgent();
    (agent as unknown as { agentId: string }).agentId = "provider-agent-close";
    const disposed = countingDispose(agent);
    const restore = stubAttach({ create: async () => agent });
    const hold = holdPublication();
    try {
      const attach = harness.call(`/session/${state.id}/attach`, { method: "POST", body: "{}" });
      await hold.held;
      const closing = close(state);
      await waitFor(() => state.closed === true);
      hold.release();
      expect((await attach).status).toBe(409);
      expect((await closing).status).toBe(200);
      // The close owned the attached agent and released it exactly once.
      expect(disposed()).toBe(1);
      expect(state.agent).toBeNull();
      await expectGoneOnDisk(state);
    } finally {
      hold.restore();
      restore();
    }
  });
});

describe("close of work that will not stop on request", () => {
  function runWithCancel(agent: FakeAgent, cancel: () => Promise<void>): void {
    const send = agent.send.bind(agent);
    (agent as unknown as { send: typeof agent.send }).send = (async (
      ...args: Parameters<typeof agent.send>
    ) => {
      const run = await send(...args);
      return Object.assign(run, { cancel });
    }) as typeof agent.send;
  }

  test("hard abort invokes provider cancellation again after a settled abort", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    let cancels = 0;
    runWithCancel(agent, async () => {
      cancels += 1;
    });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      expect((await harness.call(`/session/${state.id}/abort`, { method: "POST" })).status).toBe(
        200,
      );
      expect(cancels).toBe(1);
      expect(
        (await harness.call(`/session/${state.id}/hard-abort`, { method: "POST" })).status,
      ).toBe(200);
      expect(cancels).toBe(2);
    } finally {
      runGate.resolve();
      await state.turnCompletion;
    }
  });

  test("a rejected cancel is observed and the close waits for the run's own end", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    let cancels = 0;
    runWithCancel(agent, async () => {
      cancels += 1;
      throw new Error("cancel exploded");
    });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(cancels).toBeGreaterThan(0);
      expect(sessions.has(state.id)).toBe(true);
      runGate.resolve();
      expect(await closeSessionPermanently(state, 2_000)).toBe("closed");
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      runGate.resolve();
    }
  });

  test("a cancel that never answers keeps the close pending until the run ends", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    let cancels = 0;
    runWithCancel(agent, () => {
      cancels += 1;
      return new Promise<void>(() => undefined);
    });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(cancels).toBe(1);
      runGate.resolve();
      expect(await closeSessionPermanently(state, 2_000)).toBe("closed");
    } finally {
      runGate.resolve();
    }
  });

  test("a closed turn past its budget settles only on the SDK's terminal result", async () => {
    const state = await harness.createSession();
    const terminal = deferred<{ status: string }>();
    let cancels = 0;
    const run = {
      // A run that streams nothing until it ends; the generator must still
      // be one, because that is the shape `followRun` drains.
      // oxlint-disable-next-line require-yield
      async *stream() {
        await terminal.promise;
      },
      // Ignores cancellation, as a wedged run does.
      cancel: async () => {
        cancels += 1;
      },
      wait: () => terminal.promise,
    };
    state.status = "running";
    state.promptSequence = 1;
    state.cancelTurn = () => run.cancel();
    const completion = followRun(state, run, 1, { prompt: "synthetic", images: [] }, 30, 10);
    state.turnCompletion = completion;
    try {
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      // Well past the turn budget and the cancellation grace period.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(cancels).toBeGreaterThanOrEqual(2);
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(sessions.has(state.id)).toBe(true);
      terminal.resolve({ status: "cancelled" });
      expect(await closeSessionPermanently(state, 2_000)).toBe("closed");
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      terminal.resolve({ status: "cancelled" });
      await completion;
    }
  });
});

describe("late callbacks after close", () => {
  test("late usage, status and terminal results change neither the session nor its journal", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const agent = attachFake(state, { hold: runGate.promise });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      const options = agent.sends[0]!.options as {
        onDelta: (args: { update: unknown }) => void;
      };
      const closing = close(state);
      await waitFor(() => state.closed === true);
      const snapshot = () =>
        JSON.stringify({
          usage: state.usage ?? null,
          live: state.currentRunUsage ?? null,
          journal: Array.from(state.promptJournal.values()),
          error: state.error ?? null,
        });
      const before = snapshot();
      options.onDelta({
        update: { type: "turn-ended", usage: { inputTokens: 900, outputTokens: 900 } },
      });
      expect(snapshot()).toBe(before);
      runGate.resolve();
      expect((await closing).status).toBe(200);
      // The run's terminal result arrived after the close owned the turn: it
      // is not recorded as a completion, and nothing republishes the session.
      options.onDelta({
        update: { type: "turn-ended", usage: { inputTokens: 5, outputTokens: 5 } },
      });
      expect(snapshot()).toBe(before);
      expect(state.promptJournal.get("run-1")?.state).toBe("accepted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expectGoneOnDisk(state);
    } finally {
      runGate.resolve();
    }
  });
});

describe("local work and reads while closing", () => {
  test("an idle /steer is not answered locally by a closing session", async () => {
    const state = await harness.createSession();
    const disposeGate = deferred();
    attachFake(state, { holdDispose: disposeGate.promise });
    try {
      const closing = close(state);
      await waitFor(() => state.closed === true);
      const messages = JSON.stringify(state.messages);
      const refused = await harness.call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "/steer go left", requestId: "local-1" }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ kind: "session-closing" });
      expect(JSON.stringify(state.messages)).toBe(messages);
      expect(state.promptJournal.has("local-1")).toBe(false);
      disposeGate.resolve();
      expect((await closing).status).toBe(200);
    } finally {
      disposeGate.resolve();
    }
  });

  test("reads mark a closing session, and activity stays working while its run lives", async () => {
    const state = await harness.createSession();
    const runGate = deferred();
    const disposeGate = deferred();
    attachFake(state, { hold: runGate.promise, holdDispose: disposeGate.promise });
    try {
      expect((await prompt(state, "run-1")).status).toBe(202);
      expect(await (await harness.call(`/session/${state.id}`)).json()).not.toHaveProperty(
        "closing",
      );
      expect(await (await harness.call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "working",
      });

      const closing = close(state);
      await waitFor(() => state.closed === true);
      expect(await (await harness.call(`/session/${state.id}`)).json()).toMatchObject({
        closing: true,
      });
      expect(await (await harness.call(`/session/${state.id}/status`)).json()).toMatchObject({
        closing: true,
      });
      expect(await (await harness.call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "working",
        closing: true,
      });

      // The run has stopped; only the agent's release is outstanding.
      runGate.resolve();
      await waitFor(() => state.turnCompletion === undefined && state.status !== "running");
      expect(await (await harness.call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "idle",
        closing: true,
      });
      disposeGate.resolve();
      expect((await closing).status).toBe(200);
      expect(await (await harness.call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "missing",
      });
    } finally {
      runGate.resolve();
      disposeGate.resolve();
    }
  });
});

describe("rewind is owned by close", () => {
  function rewindableSession(state: SessionState): void {
    state.agentId = "rewind-agent";
    state.messages = [
      {
        id: "user-1",
        role: "user",
        content: "synthetic",
        parts: [],
        createdAt: new Date(0).toISOString(),
        runId: "run-1",
      },
    ];
  }

  function fakeStore(listed: Promise<void>): {
    store: LocalAgentStore;
    listCalls: () => number;
    writes: () => number;
  } {
    let listCalls = 0;
    let writes = 0;
    const store = {
      runs: {
        list: async () => {
          listCalls += 1;
          await listed;
          return {
            items: [{ runId: "run-1", turnNumber: 1, startCheckpointRef: "checkpoint-1" }],
          };
        },
        delete: async () => {
          writes += 1;
        },
      },
      runEvents: {
        delete: async () => {
          writes += 1;
        },
      },
      agents: {
        get: async () => ({ agentId: "rewind-agent", status: "idle" }),
        update: async () => {
          writes += 1;
        },
      },
    } as unknown as LocalAgentStore;
    return { store, listCalls: () => listCalls, writes: () => writes };
  }

  test("a close waits for a rewind in flight, which stops before its first write", async () => {
    const state = await harness.createSession();
    rewindableSession(state);
    const listed = deferred();
    const fake = fakeStore(listed.promise);
    const restoreAttach = stubAttach({});
    const previousStore = useCursorLocalAgentStoreForTests(fake.store);
    try {
      const rewind = harness.call(`/session/${state.id}/rewind-messages`, {
        method: "POST",
        body: JSON.stringify({ messageId: "user-1" }),
      });
      await waitFor(() => fake.listCalls() === 1);
      expect(state.rewinding).toBeDefined();
      expect(await closeSessionPermanently(state, 20)).toBe("pending");
      expect(sessions.has(state.id)).toBe(true);
      listed.resolve();
      const answered = await rewind;
      expect(answered.status).toBe(409);
      expect(await answered.json()).toMatchObject({ kind: "session-closing" });
      // The provider's store was never rewritten.
      expect(fake.writes()).toBe(0);
      expect(state.messages).toHaveLength(1);
      expect(await closeSessionPermanently(state, 2_000)).toBe("closed");
      expect(state.rewinding).toBeUndefined();
    } finally {
      listed.resolve();
      useCursorLocalAgentStoreForTests(previousStore);
      restoreAttach();
    }
  });

  test("a closing session starts no rewind", async () => {
    const state = await harness.createSession();
    rewindableSession(state);
    const disposeGate = deferred();
    attachFake(state, { holdDispose: disposeGate.promise });
    state.agentId = "rewind-agent";
    const fake = fakeStore(Promise.resolve());
    const restoreAttach = stubAttach({});
    const previousStore = useCursorLocalAgentStoreForTests(fake.store);
    try {
      const closing = close(state);
      await waitFor(() => state.closed === true);
      const refused = await harness.call(`/session/${state.id}/rewind-messages`, {
        method: "POST",
        body: JSON.stringify({ messageId: "user-1" }),
      });
      expect(refused.status).toBe(409);
      expect(fake.listCalls()).toBe(0);
      disposeGate.resolve();
      expect((await closing).status).toBe(200);
    } finally {
      disposeGate.resolve();
      useCursorLocalAgentStoreForTests(previousStore);
      restoreAttach();
    }
  });
});
