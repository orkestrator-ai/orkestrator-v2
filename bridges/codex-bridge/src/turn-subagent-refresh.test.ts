import { describe, expect, mock, spyOn, test } from "bun:test";

process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");
const { startTurnSubagentRefreshForTesting } = __testing;

function assistantMessage(content = "") {
  return {
    id: "assistant-1",
    role: "assistant",
    content,
    parts: content ? [{ type: "text", content }] : [],
    createdAt: new Date(0).toISOString(),
  };
}

function createSession(overrides: Record<string, unknown> = {}) {
  const message = assistantMessage();
  return {
    id: "session-refresh",
    conversationMode: "build",
    fastMode: false,
    threadOptions: {},
    messages: [message],
    status: "running",
    currentAssistantMessageId: message.id,
    currentAssistantTurnStartedAt: "2026-07-17T20:00:00.000Z",
    currentItems: new Map(),
    currentItemOrder: [],
    currentTimelineOrder: [],
    currentSubagentParts: new Map(),
    currentSubagentFingerprints: new Map(),
    currentTimelineGeneration: 0,
    fileChangeBaselines: new Map(),
    fileChangeDiffCache: new Map(),
    pendingAttachments: [],
    lastAccessed: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("startTurnSubagentRefresh", () => {
  test("emits changed snapshots once and deduplicates identical rebuilds", async () => {
    const session = createSession();
    const changed = assistantMessage("changed");
    const emitEvent = mock(() => {});
    const rebuild = mock(async () => changed);
    const controller = startTurnSubagentRefreshForTesting(session, () => true, {
      intervalMs: 60_000,
      rebuild,
      emitEvent,
    });

    try {
      await controller.refreshNow();
      await controller.refreshNow();
      expect(rebuild).toHaveBeenCalledTimes(2);
      expect(emitEvent).toHaveBeenCalledTimes(1);
      expect(emitEvent.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ type: "message.updated" }),
      );
    } finally {
      controller.stop();
    }
  });

  test("does not rebuild before settlement when the turn is no longer current", async () => {
    const session = createSession();
    const rebuild = mock(async () => assistantMessage("stale"));
    const emitEvent = mock(() => {});
    const controller = startTurnSubagentRefreshForTesting(session, () => false, {
      intervalMs: 60_000,
      rebuild,
      emitEvent,
    });

    try {
      await controller.refreshNow();
      expect(rebuild).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
    } finally {
      controller.stop();
    }
  });

  test("prevents overlapping rebuilds", async () => {
    const session = createSession();
    const pending = deferred<any>();
    const rebuild = mock(() => pending.promise);
    const controller = startTurnSubagentRefreshForTesting(session, () => true, {
      intervalMs: 60_000,
      rebuild,
    });

    const first = controller.refreshNow();
    const second = controller.refreshNow();
    expect(rebuild).toHaveBeenCalledTimes(1);
    pending.resolve(assistantMessage("done"));
    await Promise.all([first, second]);
    controller.stop();
  });

  test("recovers after rejected and null rebuilds", async () => {
    const session = createSession();
    const rebuild = mock()
      .mockRejectedValueOnce(new Error("transcript unavailable"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(assistantMessage("recovered"));
    const emitEvent = mock(() => {});
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const controller = startTurnSubagentRefreshForTesting(session, () => true, {
      intervalMs: 60_000,
      rebuild,
      emitEvent,
    });

    try {
      await controller.refreshNow();
      await controller.refreshNow();
      await controller.refreshNow();
      expect(rebuild).toHaveBeenCalledTimes(3);
      expect(emitEvent).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      controller.stop();
      errorLog.mockRestore();
    }
  });

  test("suppresses an in-flight result after the target changes or the controller stops", async () => {
    for (const disposal of ["target", "stop"] as const) {
      const session = createSession();
      const pending = deferred<any>();
      const emitEvent = mock(() => {});
      const controller = startTurnSubagentRefreshForTesting(session, () => true, {
        intervalMs: 60_000,
        rebuild: () => pending.promise,
        emitEvent,
      });

      const refresh = controller.refreshNow();
      if (disposal === "target") {
        session.currentAssistantMessageId = "assistant-2";
      } else {
        controller.stop();
      }
      pending.resolve(assistantMessage("stale"));
      await refresh;
      expect(emitEvent).not.toHaveBeenCalled();
      expect(controller.isStopped()).toBe(true);
      controller.stop();
    }
  });

  test("continues after parent settlement until pending children finish and stabilize", async () => {
    let now = 0;
    const session = createSession();
    const pendingPart = { type: "subagent", toolState: "pending" };
    session.currentSubagentParts.set("child", pendingPart);
    const rebuild = mock(async () => assistantMessage(
      session.currentSubagentParts.get("child")?.toolState ?? "missing",
    ));
    const controller = startTurnSubagentRefreshForTesting(session, () => false, {
      intervalMs: 60_000,
      settleGraceMs: 100,
      settleTimeoutMs: 1_000,
      now: () => now,
      rebuild,
    });

    controller.markParentSettled();
    await controller.refreshNow();
    now = 500;
    await controller.refreshNow();
    expect(controller.isStopped()).toBe(false);

    session.currentSubagentParts.set("child", { type: "subagent", toolState: "success" });
    now = 500;
    await controller.refreshNow();
    expect(controller.isStopped()).toBe(false);
    now = 599;
    await controller.refreshNow();
    expect(controller.isStopped()).toBe(false);
    now = 600;
    await controller.refreshNow();
    expect(controller.isStopped()).toBe(true);
  });

  test("bounds settlement even when a child remains pending", async () => {
    let now = 0;
    const session = createSession();
    session.currentSubagentParts.set("child", { type: "subagent", toolState: "pending" });
    const controller = startTurnSubagentRefreshForTesting(session, () => false, {
      intervalMs: 60_000,
      settleGraceMs: 100,
      settleTimeoutMs: 1_000,
      now: () => now,
      rebuild: async () => assistantMessage(),
    });

    controller.markParentSettled();
    await controller.refreshNow();
    now = 1_000;
    await controller.refreshNow();
    expect(controller.isStopped()).toBe(true);
  });

  test("starting a new watcher disposes the previous session watcher", () => {
    const session = createSession();
    const first = startTurnSubagentRefreshForTesting(session, () => true, {
      intervalMs: 60_000,
    });
    const second = startTurnSubagentRefreshForTesting(session, () => true, {
      intervalMs: 60_000,
    });

    expect(first.isStopped()).toBe(true);
    expect(second.isStopped()).toBe(false);
    second.stop();
  });
});
