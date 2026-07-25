import { describe, test, expect } from "bun:test";
import {
  OverlappingTurnError,
  ThreadRegistry,
  phaseToExternalStatus,
  type BridgeSession,
} from "./thread-registry.js";
import { TurnAccumulator } from "./turn-accumulator.js";
import type { EngineTurnConfig } from "../engine/types.js";

const CONFIG: EngineTurnConfig = { mode: "build", model: "gpt-5.6-sol" };

function makeRegistry(): ThreadRegistry {
  return new ThreadRegistry();
}

function createSession(registry: ThreadRegistry, id: string, threadId: string | null = null): BridgeSession {
  return registry.createSession({ id, threadId, config: CONFIG });
}

describe("status mapping", () => {
  test("transient phases report running so callers cannot treat them as finished", () => {
    // The build pipeline advances a phase on idle. Reporting cancelling or
    // recovering as idle would let it advance while a turn may still execute.
    expect(phaseToExternalStatus("cancelling")).toBe("running");
    expect(phaseToExternalStatus("recovering")).toBe("running");
    expect(phaseToExternalStatus("starting")).toBe("running");
    expect(phaseToExternalStatus("running")).toBe("running");
  });

  test("only idle is idle and only failed is error", () => {
    expect(phaseToExternalStatus("idle")).toBe("idle");
    expect(phaseToExternalStatus("failed")).toBe("error");
  });
});

describe("lazy thread creation", () => {
  test("a new session has no thread until it is attached", () => {
    const registry = makeRegistry();
    const session = createSession(registry, "s1");

    // No persisted Codex thread yet, so an abandoned session leaves no empty
    // thread in the resume dialog.
    expect(session.threadId).toBeNull();
    expect(registry.getThreadForSession("s1")).toBeUndefined();
    expect(registry.listThreads()).toHaveLength(0);
  });

  test("attaching creates the canonical context and binds the session", () => {
    const registry = makeRegistry();
    createSession(registry, "s1");
    const context = registry.attach("s1", "thread-1", { engineHandle: "thread-1" });

    expect(context.threadId).toBe("thread-1");
    expect(registry.getSession("s1")!.threadId).toBe("thread-1");
    expect(registry.referenceCount("thread-1")).toBe(1);
  });

  test("a session created with a thread id attaches immediately", () => {
    const registry = makeRegistry();
    createSession(registry, "s1", "thread-1");
    expect(registry.referenceCount("thread-1")).toBe(1);
  });
});

describe("same thread in multiple tabs", () => {
  test("two sessions share one canonical transcript", () => {
    const registry = makeRegistry();
    createSession(registry, "tab-a");
    createSession(registry, "tab-b");

    const first = registry.attach("tab-a", "thread-1", { engineHandle: "thread-1" });
    const second = registry.attach("tab-b", "thread-1", { engineHandle: "thread-1" });

    // Same object, not two divergent copies of one conversation.
    expect(second).toBe(first);
    expect(registry.referenceCount("thread-1")).toBe(2);

    first.messages.push({
      id: "m1",
      role: "user",
      content: "hello",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    expect(registry.getThreadForSession("tab-b")!.messages).toHaveLength(1);
  });

  test("both sessions are notified of a thread-scoped change", () => {
    const registry = makeRegistry();
    createSession(registry, "tab-a");
    createSession(registry, "tab-b");
    registry.attach("tab-a", "thread-1", { engineHandle: "thread-1" });
    registry.attach("tab-b", "thread-1", { engineHandle: "thread-1" });

    expect(registry.sessionsForThread("thread-1").map((s) => s.id).sort()).toEqual([
      "tab-a",
      "tab-b",
    ]);
  });

  test("a second tab cannot start an overlapping turn on the same thread", () => {
    const registry = makeRegistry();
    createSession(registry, "tab-a");
    createSession(registry, "tab-b");
    const context = registry.attach("tab-a", "thread-1", { engineHandle: "thread-1" });
    registry.attach("tab-b", "thread-1", { engineHandle: "thread-1" });

    context.activeTurn = new TurnAccumulator({
      threadId: "thread-1",
      turnId: "turn-1",
      engineGeneration: 1,
      assistantMessageId: "m1",
    });

    // The guard is per *thread*, so it fires regardless of which tab asked.
    expect(() => registry.assertNoActiveTurn(registry.getThreadForSession("tab-b"))).toThrow(
      OverlappingTurnError,
    );
  });

  test("closing one tab does not release a thread another tab still holds", () => {
    const registry = makeRegistry();
    createSession(registry, "tab-a");
    createSession(registry, "tab-b");
    registry.attach("tab-a", "thread-1", { engineHandle: "thread-1" });
    registry.attach("tab-b", "thread-1", { engineHandle: "thread-1" });

    const released = registry.releaseSession("tab-a");
    // No unsubscribe: the thread is still being watched.
    expect(released.removedThread).toBeNull();
    expect(registry.referenceCount("thread-1")).toBe(1);

    const finalRelease = registry.releaseSession("tab-b");
    expect(finalRelease.removedThread?.threadId).toBe("thread-1");
    expect(registry.getThread("thread-1")).toBeUndefined();
  });

  test("the released thread is handed back for unsubscribe, not deletion", () => {
    const released: string[] = [];
    const registry = new ThreadRegistry({
      onThreadReleased: (context) => released.push(context.threadId),
    });
    createSession(registry, "s1");
    registry.attach("s1", "thread-1", { engineHandle: "thread-1" });

    const result = registry.releaseSession("s1");
    expect(released).toEqual(["thread-1"]);
    // The context survives so the caller can unsubscribe; the rollout is intact.
    expect(result.removedThread).not.toBeNull();
    expect(result.removedThread!.unsubscribed).toBe(false);
  });
});

describe("overlapping turn guard", () => {
  test("permits a turn on an idle thread", () => {
    const registry = makeRegistry();
    createSession(registry, "s1");
    const context = registry.attach("s1", "thread-1", { engineHandle: "thread-1" });
    expect(() => registry.assertNoActiveTurn(context)).not.toThrow();
  });

  test("blocks while a dispatch is mid-flight", () => {
    const registry = makeRegistry();
    createSession(registry, "s1");
    const context = registry.attach("s1", "thread-1", { engineHandle: "thread-1" });
    context.dispatchInFlight = true;
    expect(() => registry.assertNoActiveTurn(context)).toThrow(OverlappingTurnError);
  });

  test.each(["running", "starting", "cancelling", "recovering"] as const)(
    "blocks in phase %s",
    (phase) => {
      const registry = makeRegistry();
      createSession(registry, "s1");
      const context = registry.attach("s1", "thread-1", { engineHandle: "thread-1" });
      registry.setPhase(context, phase);
      expect(() => registry.assertNoActiveTurn(context)).toThrow(OverlappingTurnError);
    },
  );

  test("a session with no thread yet is never blocked", () => {
    const registry = makeRegistry();
    expect(() => registry.assertNoActiveTurn(undefined)).not.toThrow();
  });
});

describe("dispatch lock", () => {
  test("serializes concurrent dispatches on one thread", async () => {
    const registry = makeRegistry();
    const session = createSession(registry, "s1", "thread-1");
    const order: string[] = [];

    const first = registry.withDispatchLock(session, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first:end");
    });
    const second = registry.withDispatchLock(session, async () => {
      order.push("second:start");
    });

    await Promise.all([first, second]);
    // The critical section spans "is this id new?" through "journalled accepted",
    // so it must not interleave.
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("a failing dispatch releases the lock for the next one", async () => {
    const registry = makeRegistry();
    const session = createSession(registry, "s1", "thread-1");

    await expect(
      registry.withDispatchLock(session, async () => {
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");

    await expect(registry.withDispatchLock(session, async () => "ok")).resolves.toBe("ok");
  });

  test("two sessions on the same thread share one lock", async () => {
    const registry = makeRegistry();
    const a = createSession(registry, "tab-a", "thread-1");
    const b = createSession(registry, "tab-b", "thread-1");
    const order: string[] = [];

    const first = registry.withDispatchLock(a, async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a:end");
    });
    const second = registry.withDispatchLock(b, async () => order.push("b:start"));

    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("sessions without a thread lock independently, keyed by session", async () => {
    const registry = makeRegistry();
    const a = createSession(registry, "s1");
    const b = createSession(registry, "s2");
    const running: string[] = [];

    // Different sessions must not block each other before threads exist...
    const first = registry.withDispatchLock(a, async () => {
      running.push("a");
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const second = registry.withDispatchLock(b, async () => {
      running.push("b");
    });
    await Promise.all([first, second]);
    expect(running.sort()).toEqual(["a", "b"]);

    // ...but two prompts on the same threadless session still serialize, or both
    // would call thread/start.
    const order: string[] = [];
    await Promise.all([
      registry.withDispatchLock(a, async () => {
        order.push("first");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
      registry.withDispatchLock(a, async () => {
        order.push("second");
      }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("generation recovery", () => {
  test("active threads become recovering, not failed", () => {
    const registry = makeRegistry();
    createSession(registry, "s1");
    const context = registry.attach("s1", "thread-1", { engineHandle: "thread-1" });
    registry.setPhase(context, "running");

    const affected = registry.markAllRecovering();

    expect(affected.map((entry) => entry.threadId)).toEqual(["thread-1"]);
    // A crash must not masquerade as a completed turn.
    expect(context.phase).toBe("recovering");
    expect(phaseToExternalStatus(context.phase)).toBe("running");
  });

  test("idle threads are untouched", () => {
    const registry = makeRegistry();
    createSession(registry, "s1");
    const context = registry.attach("s1", "thread-1", { engineHandle: "thread-1" });

    expect(registry.markAllRecovering()).toHaveLength(0);
    expect(context.phase).toBe("idle");
  });

  test("re-attaching after a restart refreshes the engine handle and generation", () => {
    const registry = makeRegistry();
    createSession(registry, "s1");
    registry.attach("s1", "thread-1", { engineHandle: "handle-1", engineGeneration: 1 });

    const reattached = registry.attach("s1", "thread-1", {
      engineHandle: "handle-2",
      engineGeneration: 2,
    });

    expect(reattached.engineHandle).toBe("handle-2");
    expect(reattached.engineGeneration).toBe(2);
    // Still one reference — re-attaching the same session must not double-count.
    expect(registry.referenceCount("thread-1")).toBe(1);
  });
});
