import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexHome,
  deferredSignal,
  harness,
  threadPayload,
  waitUntil,
} from "./app-server-runtime-test-harness.js";
import type { EngineEvent } from "./engine/types.js";

function storeLogin(): void {
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { refresh_token: "stored" } }),
  );
}

function observeReloads(engine: Awaited<ReturnType<typeof harness>>["engine"]): EngineEvent[] {
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  return events;
}

const reloadCount = (events: EngineEvent[]) =>
  events.filter((event) => event.kind === "account.reload.requested").length;

describe("stored account reload admission", () => {
  test.each(["probe", "journal", "review"] as const)(
    "drains other threads after admitted %s preparation, then rebinds before later prompts",
    async (preparation) => {
      const resumeGate = deferredSignal();
      let holdResume = false;
      let signedIn = false;
      const h = await harness(
        {
          "account/read": () => ({
            account: signedIn ? { type: "chatgpt" } : null,
            requiresOpenaiAuth: true,
          }),
          "thread/resume": async (params) => {
            if (holdResume) await resumeGate.promise;
            return { thread: threadPayload(String(params.threadId)) };
          },
          "review/start": () => ({ turn: { id: "review-1" }, reviewThreadId: "thread-b" }),
        },
        { environmentDrainTimeoutMs: 5_000 },
      );
      const events = observeReloads(h.engine);
      const a = await h.runtime.resumeSession({ threadId: "thread-a", mode: "build" });
      const b = await h.runtime.resumeSession({ threadId: "thread-b", mode: "build" });
      const c = await h.runtime.resumeSession({ threadId: "thread-c", mode: "build" });
      await h.runtime.prompt(a!.sessionId, {
        prompt: "background work",
        requestId: "a",
        attachments: [],
      });

      const entered = deferredSignal();
      const release = deferredSignal();
      const primeOwner = h.runtime as unknown as { primeCommandChanges: () => Promise<void> };
      const pause =
        preparation === "journal"
          ? spyOn(h.runtime.getJournal(), "markPrepared").mockImplementationOnce(async (record) => {
              entered.resolve();
              await release.promise;
              // Restore before invoking the original durable operation.
              pause.mockRestore();
              return h.runtime.getJournal().markPrepared(record);
            })
          : spyOn(primeOwner, "primeCommandChanges").mockImplementationOnce(async () => {
              entered.resolve();
              await release.promise;
            });
      const pending =
        preparation === "review"
          ? h.runtime.startNativeReview(b!.sessionId, { type: "uncommittedChanges" })
          : h.runtime.prompt(b!.sessionId, { prompt: "claimed", requestId: "b", attachments: [] });
      try {
        await entered.promise;
        expect(h.runtime.getRegistry().getThread("thread-b")!.dispatchInFlight).toBe(true);
        storeLogin();
        await h.engine.readAccount();
        await waitUntil(() => reloadCount(events) === 1, "reload was not requested");
        expect(h.engine.getHealth().state).toBe("ready");
        let laterSettled = false;
        const later = h.runtime
          .prompt(c!.sessionId, { prompt: "after reload", requestId: "c", attachments: [] })
          .finally(() => {
            laterSettled = true;
          });
        release.resolve();
        expect(await pending).toMatchObject(
          preparation === "review" ? { outcome: "accepted" } : { ok: true },
        );
        await waitUntil(() => h.engine.getHealth().state === "draining", "reload did not drain");
        const original = h.children[0]!;
        expect(
          original.requests.filter(
            (r) =>
              r.method === (preparation === "review" ? "review/start" : "turn/start") &&
              r.params.threadId === "thread-b",
          ),
        ).toHaveLength(1);
        expect(laterSettled).toBe(false);
        expect(h.children).toHaveLength(1);
        signedIn = true;
        holdResume = true;
        original.notify("turn/completed", {
          threadId: "thread-b",
          turn: { id: preparation === "review" ? "review-1" : "turn-1", status: "completed" },
        });
        await h.engine.getSupervisor().notificationQueue.drainAll();
        expect(h.children).toHaveLength(1); // Thread A is still executing off-screen.
        original.notify("turn/completed", {
          threadId: "thread-a",
          turn: { id: "turn-1", status: "completed" },
        });
        await waitUntil(
          () =>
            h.children.length === 2 && h.child().requests.some((r) => r.method === "thread/resume"),
          "replacement never resumed threads",
        );
        expect(h.child().requests.some((r) => r.method === "turn/start")).toBe(false);
        expect(laterSettled).toBe(false);
        resumeGate.resolve();
        expect(await later).toMatchObject({ ok: true });
        await h.drain();
        const methods = h.child().requests.map((r) => r.method);
        expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("turn/start"));
        expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
        expect(h.runtime.getStatus(c!.sessionId)).toMatchObject({
          phase: "running",
          engineGeneration: 2,
        });
        expect(h.runtime.getStatus(a!.sessionId)?.phase).toBe("idle");
        expect(h.runtime.getStatus(b!.sessionId)?.phase).toBe("idle");
      } finally {
        release.resolve();
        resumeGate.resolve();
        pause.mockRestore();
        await h.runtime.stop();
      }
    },
  );

  test("runtime restart failures permit another request for the same stored login", async () => {
    const h = await harness({
      "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
    });
    const events = observeReloads(h.engine);
    storeLogin();
    const restart = spyOn(h.engine.getSupervisor(), "restartWhenIdle").mockRejectedValueOnce(
      new Error("restart unavailable"),
    );
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await h.engine.readAccount();
      await waitUntil(
        () => warning.mock.calls.length > 0,
        "runtime did not handle restart failure",
      );
      await h.drain();
      expect(reloadCount(events)).toBe(1);
      await h.engine.readAccount();
      await waitUntil(() => h.children.length === 2, "same login was not retried");
      await h.drain();
      expect(reloadCount(events)).toBe(2);
    } finally {
      restart.mockRestore();
      warning.mockRestore();
      await h.runtime.stop();
    }
  });

  test("shutdown abandons reload admission while dispatch preparation is pending", async () => {
    const h = await harness({
      "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
    });
    const events = observeReloads(h.engine);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const entered = deferredSignal();
    const release = deferredSignal();
    const journal = spyOn(h.runtime.getJournal(), "markPrepared").mockImplementationOnce(
      async () => {
        entered.resolve();
        await release.promise;
        throw new Error("stopped preparation");
      },
    );
    const pending = h.runtime.prompt(sessionId, {
      prompt: "claimed",
      requestId: "stopping",
      attachments: [],
    });
    try {
      await entered.promise;
      storeLogin();
      await h.engine.readAccount();
      await waitUntil(() => reloadCount(events) === 1, "reload was not requested");
      await h.runtime.stop();
      expect(h.children).toHaveLength(1);
      expect(h.engine.getHealth().state).toBe("stopped");
      // A late event during shutdown must also release the engine's reservation.
      await (
        h.runtime as unknown as { reloadStoredAccountLogin: () => Promise<void> }
      ).reloadStoredAccountLogin();
    } finally {
      release.resolve();
      await pending;
      journal.mockRestore();
    }
  });

  test("shutdown releases a stored-login drain without launching a replacement", async () => {
    const h = await harness({
      "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "running", requestId: "running", attachments: [] });
    storeLogin();
    await h.engine.readAccount();
    await waitUntil(() => h.engine.getHealth().state === "draining", "reload did not drain");
    await h.runtime.stop();
    expect(h.children).toHaveLength(1);
    expect(h.engine.getHealth().state).toBe("stopped");
  });
});
