/**
 * INC-04: a session the bridge acknowledges is one a restarted bridge can load.
 *
 * Every recovery assertion reads the published file as a successor would —
 * directly, or through `loadPersistedState` into cleared registries — and never
 * drains first. A graceful flush would save exactly the state these tests
 * exist to prove was already on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadPersistedState, persistBarrierWaitersForTests } from "./persistence.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
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

let harness: RouterHarness;

beforeEach(async () => {
  harness = await startRouterHarness();
});

afterEach(async () => {
  await harness.close();
});

type Published = {
  sessions: Array<Record<string, unknown> & { id: string; composer?: Record<string, unknown> }>;
  closing?: Array<{ id: string }>;
};

async function published(): Promise<Published> {
  return (await harness.readPublished()) as Published;
}

function create(body: Record<string, unknown>): Promise<Response> {
  return harness.call("/session/create", {
    method: "POST",
    body: JSON.stringify({ policy: defaultPolicy, ...body }),
  });
}

/** Let every already-queued continuation run; no timers involved. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function restartFromDisk(): Promise<void> {
  sessions.clear();
  clientSessionKeys.clear();
  await loadPersistedState();
}

describe("create acknowledgement", () => {
  test("a 201 means a successor recovers the id, key and pre-send selections", async () => {
    const response = await create({
      clientSessionKey: "tab-1",
      modelId: "composer-2",
      mode: "plan",
    });
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };

    const file = await published();
    expect(file.sessions.map((entry) => entry.id)).toEqual([sessionId]);
    await restartFromDisk();
    expect(clientSessionKeys.get("tab-1")).toBe(sessionId);
    expect(sessions.get(sessionId)?.composer).toMatchObject({
      selectedModelId: "composer-2",
      selectedModeId: "plan",
    });
  });

  test("concurrent same-key creates resolve to one identity, neither acknowledged early", async () => {
    const hold = holdPublication();
    try {
      const first = create({ clientSessionKey: "tab-1" });
      await hold.held;
      const second = create({ clientSessionKey: "tab-1" });
      let settled = 0;
      void first.then(() => (settled += 1));
      void second.then(() => (settled += 1));
      // Both handlers are provably parked on the barrier behind the held
      // write — observed, not slept on — so neither can have answered.
      await waitFor(() => persistBarrierWaitersForTests() === 2);
      await flushMicrotasks();
      expect(hold.renames()).toBe(0);
      expect(harness.unanswered()).toBe(2);
      expect(settled).toBe(0);
      hold.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const ids = await Promise.all([a.json(), b.json()]);
      expect((ids[0] as { sessionId: string }).sessionId).toBe(
        (ids[1] as { sessionId: string }).sessionId,
      );
      expect(sessions.size).toBe(1);
    } finally {
      hold.restore();
    }
  });

  test("a failed publication is not acknowledged, and a same-key retry republishes one session", async () => {
    const hold = holdPublication();
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const failed = await create({ clientSessionKey: "tab-1" });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ kind: "persistence-unavailable" });
      // Retained in memory under its key, so the retry cannot mint a second one.
      expect(sessions.size).toBe(1);
      const retainedId = clientSessionKeys.get("tab-1");

      hold.failWith(undefined);
      const retried = await create({ clientSessionKey: "tab-1" });
      expect(retried.status).toBe(201);
      expect(((await retried.json()) as { sessionId: string }).sessionId).toBe(retainedId!);
      expect(sessions.size).toBe(1);
      expect((await published()).sessions.map((entry) => entry.id)).toEqual([retainedId!]);
    } finally {
      hold.restore();
    }
  });

  test("a lost response is recovered by retrying the same key", async () => {
    const first = (await (await create({ clientSessionKey: "tab-1" })).json()) as {
      sessionId: string;
    };
    const again = (await (await create({ clientSessionKey: "tab-1" })).json()) as {
      sessionId: string;
    };
    expect(again.sessionId).toBe(first.sessionId);
    expect(sessions.size).toBe(1);
  });

  test("persisted records carry no credential and no SDK handle", async () => {
    const state = await harness.createSession({
      clientSessionKey: "tab-1",
      agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "tab-bearer-secret" },
    });
    state.agent = fakeAgent();
    await create({ clientSessionKey: "tab-1" });
    const raw = JSON.stringify(await published());
    expect(raw).not.toContain("tab-bearer-secret");
    expect(raw).not.toContain("agentMcp");
    expect(raw).not.toContain("hostedMcp");
    expect(raw).not.toContain("workspaceWarmRelease");
  });

  test("a close that wins the race is not revived by a late create acknowledgement", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const hold = holdPublication();
    try {
      const retry = create({ clientSessionKey: "tab-1" });
      await hold.held;
      const closing = harness.call(`/session/${state.id}`, { method: "DELETE" });
      await waitFor(() => state.closed === true);
      hold.release();
      expect((await retry).status).toBe(409);
      expect((await closing).status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);
      expect(clientSessionKeys.has("tab-1")).toBe(false);
      const file = await published();
      expect(file.sessions).toEqual([]);
      expect(file.closing ?? []).toEqual([]);
    } finally {
      hold.restore();
    }
  });
});

describe("attach and resume acknowledgement", () => {
  test("attach publishes a newly created provider identity before answering", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const agent = fakeAgent();
    (agent as unknown as { agentId: string }).agentId = "provider-agent-1";
    const restore = stubAttach({ create: async () => agent });
    const hold = holdPublication();
    try {
      const response = harness.call(`/session/${state.id}/attach`, {
        method: "POST",
        body: "{}",
      });
      await hold.held;
      let answered = false;
      void response.then(() => (answered = true));
      // Parked on the barrier for the new identity, behind the held write.
      await waitFor(() => persistBarrierWaitersForTests() === 1);
      await flushMicrotasks();
      expect(hold.renames()).toBe(0);
      expect(harness.unanswered()).toBe(1);
      expect(answered).toBe(false);
      hold.release();
      expect((await response).status).toBe(200);
      expect((await published()).sessions[0]).toMatchObject({ agentId: "provider-agent-1" });
    } finally {
      hold.restore();
      restore();
    }
  });

  test("attach publishes a replacement identity after a failed resume", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    state.agentId = "gone-agent";
    const replacement = fakeAgent();
    (replacement as unknown as { agentId: string }).agentId = "replacement-agent";
    const restore = stubAttach({
      resume: async () => {
        throw new Error("no such agent");
      },
      create: async () => replacement,
    });
    try {
      const response = await harness.call(`/session/${state.id}/attach`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect((await published()).sessions[0]).toMatchObject({ agentId: "replacement-agent" });
    } finally {
      restore();
    }
  });

  test("an unchanged warm attach does not rewrite; a previously failed one does", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const agent = fakeAgent();
    (agent as unknown as { agentId: string }).agentId = "provider-agent-1";
    const restore = stubAttach({ create: async () => agent });
    try {
      expect(
        (await harness.call(`/session/${state.id}/attach`, { method: "POST", body: "{}" })).status,
      ).toBe(200);
      const hold = holdPublication();
      try {
        hold.release();
        const warm = await harness.call(`/session/${state.id}/attach`, {
          method: "POST",
          body: "{}",
        });
        expect(warm.status).toBe(200);
        // Give any write the attach might have queued time to start: an
        // unchanged warm attach whose identity is on disk queues none.
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(hold.writes()).toBe(0);
        const before = hold.renames();

        // Now make the identity dirty and the next write fail.
        state.agentId = "provider-agent-2";
        hold.failWith(new Error("disk full"));
        const failed = await harness.call(`/session/${state.id}/attach`, {
          method: "POST",
          body: "{}",
        });
        expect(failed.status).toBe(503);
        hold.failWith(undefined);
        const retried = await harness.call(`/session/${state.id}/attach`, {
          method: "POST",
          body: "{}",
        });
        expect(retried.status).toBe(200);
        expect(hold.renames()).toBeGreaterThan(before);
        expect((await published()).sessions[0]).toMatchObject({ agentId: "provider-agent-2" });
      } finally {
        hold.restore();
      }
    } finally {
      restore();
    }
  });

  test("a resumed conversation's adopted identity reloads without a prompt", async () => {
    const restore = stubAttach({ resume: async () => fakeAgent() });
    try {
      const response = await harness.call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: "vendor-agent-9", policy: defaultPolicy }),
      });
      expect(response.status).toBe(201);
      const { sessionId } = (await response.json()) as { sessionId: string };
      await restartFromDisk();
      expect(sessions.get(sessionId)?.agentId).toBe("vendor-agent-9");
    } finally {
      restore();
    }
  });
});

describe("config and resume publication", () => {
  test("a config change is acknowledged only once published, and reverted when it cannot be", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1", modelId: "composer-2" });
    const hold = holdPublication();
    try {
      const pending = harness.call(`/session/${state.id}/config`, {
        method: "POST",
        body: JSON.stringify({ modelId: "held-model" }),
      });
      await hold.held;
      let answered = false;
      void pending.then(() => (answered = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answered).toBe(false);
      hold.release();
      expect((await pending).status).toBe(200);
      expect((await published()).sessions[0]!.composer).toMatchObject({
        selectedModelId: "held-model",
      });

      hold.failWith(new Error("disk full"));
      const failed = await harness.call(`/session/${state.id}/config`, {
        method: "POST",
        body: JSON.stringify({ modelId: "lost-model" }),
      });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ kind: "persistence-unavailable" });
      // Not answered with a selection a restart would silently undo.
      expect(state.composer.selectedModelId).toBe("held-model");
      expect(state.dispatching).toBe(false);

      hold.failWith(undefined);
      const retried = await harness.call(`/session/${state.id}/config`, {
        method: "POST",
        body: JSON.stringify({ modelId: "lost-model" }),
      });
      expect(retried.status).toBe(200);
      await restartFromDisk();
      expect(sessions.get(state.id)?.composer.selectedModelId).toBe("lost-model");
    } finally {
      hold.restore();
    }
  });

  test("a resume whose publication failed is retried onto the same adopted session", async () => {
    let resumes = 0;
    const restore = stubAttach({
      resume: async () => {
        resumes += 1;
        return fakeAgent();
      },
    });
    const hold = holdPublication();
    const resume = () =>
      harness.call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: "vendor-agent-7", policy: defaultPolicy }),
      });
    try {
      hold.failWith(new Error("disk full"));
      hold.release();
      const failed = await resume();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ kind: "persistence-unavailable" });
      // Retained, so the retry cannot adopt the same conversation twice.
      expect(sessions.size).toBe(1);
      const retainedId = Array.from(sessions.keys())[0]!;

      hold.failWith(undefined);
      const retried = await resume();
      expect(retried.status).toBe(201);
      expect(((await retried.json()) as { sessionId: string }).sessionId).toBe(retainedId);
      expect(sessions.size).toBe(1);
      expect(resumes).toBe(0);
      await restartFromDisk();
      expect(sessions.get(retainedId)?.agentId).toBe("vendor-agent-7");
    } finally {
      hold.restore();
      restore();
    }
  });
});

describe("create under aggregate pressure", () => {
  test("a new identity and older sessions' essentials survive transcript shedding", async () => {
    const old = await harness.createSession({ clientSessionKey: "old-tab" });
    old.agentId = "old-agent";
    old.lastAccessed = 1;
    // Just under the per-transcript budget; two of these do not fit together
    // with everything else, so the oldest is shed.
    const text = "x".repeat(15 * 1024 * 1024);
    old.messages.push({
      id: "m0",
      role: "assistant",
      content: text,
      parts: [],
      createdAt: new Date(0).toISOString(),
    });
    const other = await harness.createSession({ clientSessionKey: "other-tab" });
    other.lastAccessed = 2;
    other.messages.push({
      id: "m1",
      role: "assistant",
      content: text,
      parts: [],
      createdAt: new Date(0).toISOString(),
    });
    const other2 = await harness.createSession({ clientSessionKey: "other-tab-2" });
    other2.lastAccessed = 3;
    other2.messages.push({
      id: "m2",
      role: "assistant",
      content: text,
      parts: [],
      createdAt: new Date(0).toISOString(),
    });

    const response = await create({ clientSessionKey: "new-tab" });
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    await restartFromDisk();
    expect(clientSessionKeys.get("new-tab")).toBe(sessionId);
    const restoredOld = sessions.get(old.id)!;
    expect(restoredOld.agentId).toBe("old-agent");
    expect(restoredOld.messages).toEqual([]);
    expect(restoredOld.transcriptTruncated).toBe(true);
    expect(restoredOld.droppedMessages).toBe(1);
    // The live transcript was never touched by the persisted projection.
    expect(old.messages).toHaveLength(1);
  });
});

void deferred;
void ({} as SessionState);
