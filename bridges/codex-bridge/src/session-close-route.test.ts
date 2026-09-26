import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";

import {
  codexHome,
  deferredSignal,
  harness,
  threadPayload,
  waitUntil,
  type Harness,
} from "./app-server-runtime-test-harness.js";
import { BridgeSessionStore } from "./sessions/persistence.js";
import { registerSessionCloseRoute } from "./session-close-route.js";

function closeApp(h: Harness): Hono {
  const app = new Hono();
  registerSessionCloseRoute(app, h.runtime);
  return app;
}

async function close(app: Hono, sessionId: string) {
  const response = await app.request(`/session/${encodeURIComponent(sessionId)}/close`, {
    method: "POST",
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** An interrupt the fake app-server honours by ending the turn. */
function honouredInterrupt(ref: { h?: Harness }) {
  return {
    "turn/interrupt": (params: Record<string, unknown>) => {
      queueMicrotask(() =>
        ref.h?.child().notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: params.turnId, status: "interrupted" },
        }),
      );
      return {};
    },
  };
}

function methods(h: Harness): string[] {
  return h.children.flatMap((child) => child.requests.map((request) => request.method));
}

function count(h: Harness, method: string): number {
  return methods(h).filter((entry) => entry === method).length;
}

/** A handler result the test releases, modelling a slow app-server response. */
function gated<T>(value: T) {
  const signal = deferredSignal();
  return {
    respond: () => signal.promise.then(() => value),
    release: signal.resolve,
  };
}

/** Bridge-session ids whose record the next process start would restore. */
async function persistedSessionIds(): Promise<string[]> {
  const records = await new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" }).load();
  return records.map((record) => record.bridgeSessionId);
}

/** A session whose thread exists and whose first turn has completed. */
async function idleThreadSession(h: Harness): Promise<string> {
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, { prompt: "work", requestId: "req-1", attachments: [] });
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  await h.drain();
  await waitUntil(() => h.runtime.getStatus(sessionId)?.phase === "idle", "turn settled");
  return sessionId;
}

const CLOSING = { ok: false, status: 409, error: "Session is closing" };

describe("POST /session/:id/close", () => {
  test("releases a completed session and keeps the thread listed and resumable", async () => {
    const h = await harness({
      "thread/list": () => ({ data: [threadPayload("thread-1")], nextCursor: null }),
    });
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "work", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    await waitUntil(() => h.runtime.getStatus(sessionId)?.phase === "idle", "turn settled");

    expect(await close(app, sessionId)).toEqual({
      status: 200,
      body: { closed: true, retained: true },
    });
    expect(h.runtime.getStatus(sessionId)).toBeNull();
    expect(methods(h)).toContain("thread/unsubscribe");
    expect(methods(h)).not.toContain("thread/delete");
    expect(methods(h)).not.toContain("turn/interrupt");

    const { sessions } = await h.runtime.listSessions();
    expect(sessions.map((session) => session.id)).toContain("thread-1");
    const resumed = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    expect(resumed?.sessionId).toBeTruthy();
  });

  test("answers an unknown session and a retried close in band", async () => {
    const h = await harness();
    const app = closeApp(h);
    expect(await close(app, "never-existed")).toEqual({
      status: 200,
      body: { closed: true, missing: true },
    });

    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect((await close(app, sessionId)).body).toEqual({ closed: true, retained: true });
    // The first response was lost: the retry must still confirm, never 404.
    expect(await close(app, sessionId)).toEqual({
      status: 200,
      body: { closed: true, missing: true },
    });
  });

  test("stops a running last-reference turn before confirming", async () => {
    const ref: { h?: Harness } = {};
    const h = await harness(honouredInterrupt(ref));
    ref.h = h;
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "long", requestId: "req-1", attachments: [] });
    expect(h.runtime.getStatus(sessionId)?.phase).toBe("running");

    expect((await close(app, sessionId)).body).toEqual({ closed: true, retained: true });
    expect(methods(h)).toContain("turn/interrupt");
    expect(methods(h)).not.toContain("thread/delete");
  });

  test("reports pending while the turn has not stopped, then closes on retry", async () => {
    const h = await harness();
    h.runtime.closeStopBudgetMs = 10;
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "stuck", requestId: "req-1", attachments: [] });

    expect(await close(app, sessionId)).toEqual({
      status: 503,
      body: { closed: false, pending: true, error: "Session close did not complete" },
    });
    // Nothing was released: the backend's durable intent can retry.
    expect(h.runtime.getStatus(sessionId)).not.toBeNull();
    expect(methods(h)).not.toContain("thread/unsubscribe");

    // The turn eventually honours the interrupt; the retry then confirms.
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });
    await h.drain();
    await waitUntil(
      () => h.runtime.getStatus(sessionId)?.phase === "idle",
      "interrupted turn settled",
      2_000,
    );
    expect((await close(app, sessionId)).body).toEqual({ closed: true, retained: true });
  });

  test("declines a pending approval on close", async () => {
    const ref: { h?: Harness } = {};
    const h = await harness(honouredInterrupt(ref));
    ref.h = h;
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);

    expect((await close(app, sessionId)).body).toEqual({ closed: true, retained: true });
    const written = h.child().stdin.lines.join("");
    expect(written).toContain('"id":9101');
    expect(written).not.toContain('"decision":"accept"');
  });

  test("closing one of two tabs on a shared thread leaves the other's turn running", async () => {
    const h = await harness({ "thread/resume": () => ({ thread: threadPayload("thread-7") }) });
    const app = closeApp(h);
    const a = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });
    const b = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });
    await h.runtime.prompt(b!.sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    expect((await close(app, a!.sessionId)).body).toEqual({ closed: true, retained: true });
    expect(methods(h)).not.toContain("turn/interrupt");
    expect(methods(h)).not.toContain("thread/unsubscribe");
    expect(h.runtime.getStatus(b!.sessionId)?.phase).toBe("running");
  });

  test("keeps the session when the removal is not published, and a retry closes it", async () => {
    const h = await harness();
    const app = closeApp(h);
    const sessionId = await idleThreadSession(h);
    await waitUntil(
      async () => (await persistedSessionIds()).includes(sessionId),
      "session record persisted",
    );
    const publish = spyOn(BridgeSessionStore.prototype, "publishRemoval").mockImplementationOnce(
      () => Promise.reject(new Error("EROFS")),
    );
    try {
      expect(await close(app, sessionId)).toEqual({
        status: 503,
        body: { closed: false, pending: true, error: "Session close did not complete" },
      });
    } finally {
      publish.mockRestore();
    }
    // Nothing was released: memory, disk and the app-server subscription agree.
    expect(h.runtime.getStatus(sessionId)).not.toBeNull();
    expect(await persistedSessionIds()).toContain(sessionId);
    expect(methods(h)).not.toContain("thread/unsubscribe");
    // The fence stays up while the backend's intent retries the close.
    expect(
      await h.runtime.prompt(sessionId, { prompt: "late", requestId: "req-2", attachments: [] }),
    ).toEqual(CLOSING);

    expect(await close(app, sessionId)).toEqual({
      status: 200,
      body: { closed: true, retained: true },
    });
    expect(h.runtime.getStatus(sessionId)).toBeNull();
    expect(await persistedSessionIds()).not.toContain(sessionId);
    expect(methods(h)).toContain("thread/unsubscribe");
    expect(count(h, "turn/start")).toBe(1);
  });

  test("refuses work that arrives after the turn is terminal but before the release", async () => {
    const h = await harness();
    const app = closeApp(h);
    const sessionId = await idleThreadSession(h);
    const gate = deferredSignal();
    const original = BridgeSessionStore.prototype.publishRemoval;
    const publish = spyOn(BridgeSessionStore.prototype, "publishRemoval").mockImplementation(
      async function (this: BridgeSessionStore, id: string) {
        await gate.promise;
        return original.call(this, id);
      },
    );
    try {
      const closing = close(app, sessionId);
      await waitUntil(() => publish.mock.calls.length === 1, "close publishing its removal");

      expect(
        await h.runtime.prompt(sessionId, { prompt: "late", requestId: "req-2", attachments: [] }),
      ).toEqual(CLOSING);
      expect(await h.runtime.compactSession(sessionId)).toBe("closing");
      expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "steer-1")).toBe("closing");
      expect(await h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" })).toEqual({
        outcome: "closing",
      });

      gate.resolve();
      expect((await closing).body).toEqual({ closed: true, retained: true });
    } finally {
      publish.mockRestore();
    }
    expect(count(h, "turn/start")).toBe(1);
    expect(methods(h)).not.toContain("review/start");
    expect(methods(h)).not.toContain("thread/compact/start");
  });

  test("a prompt still preparing when close released the session never starts a turn", async () => {
    const threadStart = gated({ thread: threadPayload("thread-1") });
    const h = await harness({ "thread/start": threadStart.respond });
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const prompting = h.runtime.prompt(sessionId, {
      prompt: "first",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("thread/start");

    expect((await close(app, sessionId)).body).toEqual({ closed: true, retained: true });
    threadStart.release();
    expect(await prompting).toEqual(CLOSING);
    expect(methods(h)).not.toContain("turn/start");
    // The empty thread created for the refused prompt is not left subscribed.
    await waitUntil(() => methods(h).includes("thread/unsubscribe"), "thread released");
    expect(h.runtime.getStatus(sessionId)).toBeNull();
  });

  test("waits for an in-flight turn/start, then stops the turn it registered", async () => {
    const ref: { h?: Harness } = {};
    const turnStart = gated({ turn: { id: "turn-1" } });
    const h = await harness({ ...honouredInterrupt(ref), "turn/start": turnStart.respond });
    ref.h = h;
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const prompting = h.runtime.prompt(sessionId, {
      prompt: "long",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start");
    expect(h.runtime.getRegistry().getThreadForSession(sessionId)?.dispatchInFlight).toBe(true);

    const closing = close(app, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(methods(h)).not.toContain("thread/unsubscribe");
    turnStart.release();
    expect((await prompting).ok).toBe(true);

    expect((await closing).body).toEqual({ closed: true, retained: true });
    const sent = methods(h);
    expect(sent).toContain("turn/interrupt");
    expect(sent.indexOf("turn/interrupt")).toBeLessThan(sent.indexOf("thread/unsubscribe"));
    expect(sent).not.toContain("thread/delete");
  });

  test("reports pending while turn/start is unanswered, then closes on retry", async () => {
    const ref: { h?: Harness } = {};
    const turnStart = gated({ turn: { id: "turn-1" } });
    const h = await harness({ ...honouredInterrupt(ref), "turn/start": turnStart.respond });
    ref.h = h;
    h.runtime.closeStopBudgetMs = 10;
    const app = closeApp(h);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const prompting = h.runtime.prompt(sessionId, {
      prompt: "long",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start");

    expect(await close(app, sessionId)).toEqual({
      status: 503,
      body: { closed: false, pending: true, error: "Session close did not complete" },
    });
    expect(h.runtime.getStatus(sessionId)).not.toBeNull();
    expect(methods(h)).not.toContain("thread/unsubscribe");

    turnStart.release();
    expect((await prompting).ok).toBe(true);
    expect((await close(app, sessionId)).body).toEqual({ closed: true, retained: true });
    expect(methods(h)).toContain("turn/interrupt");
    expect(count(h, "turn/start")).toBe(1);
  });
});
