import { describe, expect, mock, spyOn, test } from "bun:test";
import { CodexRuntimeTail } from "./app-server-runtime-tail.js";
import type { CodexRuntimeContext } from "./app-server-runtime-context.js";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import type { CodexRuntimeSessions } from "./app-server-runtime-sessions.js";
import { TurnAccumulator, unconfirmedTurnId } from "./sessions/turn-accumulator.js";

function turn(id: string) {
  return new TurnAccumulator({
    threadId: `thread-${id}`,
    turnId: id,
    engineGeneration: 1,
    assistantMessageId: `assistant-${id}`,
    requestId: `req-${id}`,
  });
}
function fixture(
  turns: Array<TurnAccumulator | null>,
  engine: {
    interruptTurn: (handle: string, turnId: string) => Promise<void>;
    waitForTurnTerminal: (
      handle: string,
      turnId: string,
      options: { timeoutMs: number },
    ) => Promise<unknown>;
  },
  /** Turns a capacity retry is waiting on, which it ends itself. */
  retrying: ReadonlySet<TurnAccumulator> = new Set(),
) {
  // Only the context surface this collaborator consumes; no app-server process or I/O.
  const context = {
    registry: {
      listThreads: () =>
        turns.map((activeTurn, index) => ({ activeTurn, engineHandle: `handle-${index}` })),
    },
    options: { engine },
  } as unknown as CodexRuntimeContext;
  const lifecycle = {
    capacityRetry: {
      endForParentExit: (_context: unknown, turn: TurnAccumulator) => retrying.has(turn),
    },
  } as unknown as CodexRuntimeLifecycle;
  return new CodexRuntimeTail(context, lifecycle, {} as CodexRuntimeSessions);
}

describe("parent exit interrupt deadline", () => {
  test("interrupts every confirmed active thread concurrently and skips idle, terminal and unconfirmed turns", async () => {
    const first = turn("first");
    const second = turn("second");
    const ended = turn("ended");
    ended.complete("completed");
    const unconfirmed = turn(unconfirmedTurnId("pending"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interruptTurn = mock(async () => {
      await gate;
    });
    const waitForTurnTerminal = mock(async () => "interrupted");
    const tail = fixture([first, null, second, ended, unconfirmed], {
      interruptTurn,
      waitForTurnTerminal,
    });
    const stopping = tail.interruptForParentExit(1000);
    try {
      expect(interruptTurn.mock.calls).toEqual([
        ["handle-0", "first"],
        ["handle-2", "second"],
      ]);
      expect(first.stoppedByShutdown).toBe(true);
      expect(second.stoppedByShutdown).toBe(true);
      expect(ended.stoppedByShutdown).toBe(false);
      expect(unconfirmed.stoppedByShutdown).toBe(false);
      expect(waitForTurnTerminal).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(await stopping).toBe(2);
    expect(waitForTurnTerminal.mock.calls).toEqual([
      ["handle-0", "first", { timeoutMs: 1000 }],
      ["handle-2", "second", { timeoutMs: 1000 }],
    ]);
  });

  test("a turn waiting on a capacity retry is ended by the retry, never interrupted", async () => {
    const waiting = turn("waiting");
    const running = turn("running");
    const interruptTurn = mock(async () => undefined);
    const waitForTurnTerminal = mock(async () => "interrupted");
    const tail = fixture(
      [waiting, running],
      { interruptTurn, waitForTurnTerminal },
      new Set([waiting]),
    );
    expect(await tail.interruptForParentExit(1000)).toBe(1);
    expect(interruptTurn.mock.calls).toEqual([["handle-1", "running"]]);
  });

  test("a rejected interrupt is contained and leaves shutdown ownership on the turn", async () => {
    const active = turn("failed-interrupt");
    const waitForTurnTerminal = mock(async () => "interrupted");
    const tail = fixture([active], {
      interruptTurn: async () => {
        throw new Error("interrupt rejected");
      },
      waitForTurnTerminal,
    });
    expect(await tail.interruptForParentExit(1000)).toBe(1);
    expect(active.stoppedByShutdown).toBe(true);
    expect(active.isTerminal()).toBe(false);
    expect(waitForTurnTerminal).not.toHaveBeenCalled();
  });

  test.each(["interrupt", "terminal"] as const)(
    "the deadline bounds a never-settling %s acknowledgement",
    async (blockedAt) => {
      const active = turn("hung");
      const never = new Promise<never>(() => {});
      const waitForTurnTerminal = mock(async () => never);
      const tail = fixture([active], {
        interruptTurn: async () => {
          if (blockedAt === "interrupt") await never;
        },
        waitForTurnTerminal,
      });
      let deadline!: () => void;
      const handle = {} as ReturnType<typeof setTimeout>;
      const nativeSetTimeout = globalThis.setTimeout;
      const nativeClearTimeout = globalThis.clearTimeout;
      let cleared = false;
      const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        ms?: number,
      ) => {
        if (ms !== 1234) return nativeSetTimeout(callback, ms);
        deadline = callback;
        return handle;
      }) as typeof setTimeout);
      const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        if (timer === handle) cleared = true;
        else nativeClearTimeout(timer);
      });
      try {
        const stopping = tail.interruptForParentExit(1234);
        await Promise.resolve();
        expect(active.stoppedByShutdown).toBe(true);
        expect(waitForTurnTerminal).toHaveBeenCalledTimes(blockedAt === "terminal" ? 1 : 0);
        deadline();
        expect(await stopping).toBe(1);
        expect(cleared).toBe(true);
        // A deadline doesn't fabricate a terminal outcome before the engine stops.
        expect(active.isTerminal()).toBe(false);
      } finally {
        setTimer.mockRestore();
        clearTimer.mockRestore();
      }
    },
  );
});
