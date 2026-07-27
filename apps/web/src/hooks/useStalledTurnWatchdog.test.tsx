import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  DEFAULT_MIN_RECONCILE_INTERVAL_MS,
  DEFAULT_TURN_STALE_AFTER_MS,
  useStalledTurnWatchdog,
} from "./useStalledTurnWatchdog";

function Harness(
  props: Parameters<typeof useStalledTurnWatchdog>[0],
) {
  useStalledTurnWatchdog(props);
  return null;
}

/**
 * Margins are deliberately wide relative to `ACTIVITY_GAP_MS` below: these are
 * real timers, and a tighter ratio turns a loaded parallel run into a flake
 * rather than a signal.
 */
const BASE = {
  agentLabel: "Test",
  isLoading: true,
  isReady: true,
  intervalMs: 10,
  staleAfterMs: 100,
};

/** Comfortably shorter than `staleAfterMs`, so activity keeps resetting it. */
const ACTIVITY_GAP_MS = 20;

/** Wait past `staleAfterMs` plus several poll intervals. */
function afterStale() {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * The default cadence (1s ticks, 1.5s staleness, 10s reconcile floor) is far too
 * slow to exercise with real timers, so those tests drive the interval callback
 * by hand against a mocked clock. Only `setInterval`/`clearInterval` are stubbed
 * — `setTimeout` stays real so microtasks can still be flushed.
 */
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;

let mockedNow = 0;
let registeredIntervals: Array<{ callback: () => void; delayMs?: number }> = [];

function installTimerHarness(startTime: number) {
  mockedNow = startTime;
  registeredIntervals = [];
  Date.now = () => mockedNow;
  let nextHandle = 1;
  globalThis.setInterval = (((callback: TimerHandler, delayMs?: number) => {
    registeredIntervals.push({ callback: callback as () => void, delayMs });
    return nextHandle++ as unknown as ReturnType<typeof setInterval>;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
}

function restoreTimerHarness() {
  Date.now = ORIGINAL_DATE_NOW;
  globalThis.setInterval = ORIGINAL_SET_INTERVAL;
  globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
  registeredIntervals = [];
}

/** Fire every registered interval and let the async poll settle. */
async function tick(callbacks = registeredIntervals.map((entry) => entry.callback)) {
  await act(async () => {
    for (const callback of callbacks) callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
  restoreTimerHarness();
});

describe("useStalledTurnWatchdog", () => {
  test("reconciles once the turn stops reporting", async () => {
    const reconcile = mock(async () => {});
    render(<Harness {...BASE} reconcile={reconcile} />);

    await waitFor(() => expect(reconcile).toHaveBeenCalled());
  });

  test("stays quiet while activity keeps arriving", async () => {
    /**
     * A turn that is still streaming is not stalled. Reconciling under it costs
     * bridge round trips for nothing and its store writes race the user's own
     * refresh — the reason this gate exists.
     */
    const reconcile = mock(async () => {});
    const { rerender } = render(
      <Harness {...BASE} activitySignal={0} reconcile={reconcile} />,
    );

    for (let tick = 1; tick <= 8; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVITY_GAP_MS));
      rerender(<Harness {...BASE} activitySignal={tick} reconcile={reconcile} />);
    }

    expect(reconcile).not.toHaveBeenCalled();
  });

  test("fires once activity goes quiet after streaming", async () => {
    const reconcile = mock(async () => {});
    const { rerender } = render(
      <Harness {...BASE} activitySignal={0} reconcile={reconcile} />,
    );

    rerender(<Harness {...BASE} activitySignal={1} reconcile={reconcile} />);
    await afterStale();

    expect(reconcile).toHaveBeenCalled();
  });

  test("does not arm while the turn is idle or the tab is not ready", async () => {
    const idle = mock(async () => {});
    render(<Harness {...BASE} isLoading={false} reconcile={idle} />);
    const notReady = mock(async () => {});
    render(<Harness {...BASE} isReady={false} reconcile={notReady} />);

    await afterStale();
    expect(idle).not.toHaveBeenCalled();
    expect(notReady).not.toHaveBeenCalled();
  });

  test("runs one reconcile at a time", async () => {
    // These hit the network; a slow response must not stack a new request on
    // every tick.
    let resolveReconcile!: () => void;
    const reconcile = mock(
      () => new Promise<void>((resolve) => { resolveReconcile = resolve; }),
    );
    render(<Harness {...BASE} reconcile={reconcile} />);

    await afterStale();
    expect(reconcile).toHaveBeenCalledTimes(1);
    resolveReconcile();
  });

  test("honours an explicit shouldReconcile veto", async () => {
    const reconcile = mock(async () => {});
    render(
      <Harness {...BASE} reconcile={reconcile} shouldReconcile={() => false} />,
    );

    await afterStale();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("uses the latest callbacks after a rerender", async () => {
    const staleReconcile = mock(async () => {});
    const latestReconcile = mock(async () => {});
    const staleGate = mock(() => false);
    const latestGate = mock(() => true);
    const view = render(
      <Harness
        {...BASE}
        reconcile={staleReconcile}
        shouldReconcile={staleGate}
      />,
    );

    view.rerender(
      <Harness
        {...BASE}
        reconcile={latestReconcile}
        shouldReconcile={latestGate}
      />,
    );

    await waitFor(() => expect(latestReconcile).toHaveBeenCalled());
    expect(staleReconcile).not.toHaveBeenCalled();
    expect(staleGate).not.toHaveBeenCalled();
    expect(latestGate).toHaveBeenCalled();
  });

  test("keeps polling after a failed reconcile", async () => {
    // A failed poll is not actionable, but it must not disarm the watchdog —
    // the stall it exists to catch is still there.
    const reconcile = mock(async () => {
      throw new Error("bridge unavailable");
    });
    render(<Harness {...BASE} reconcile={reconcile} />);

    await waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThan(1));
  });

  test("logs a failed poll at debug rather than surfacing it", async () => {
    const originalDebug = console.debug;
    const debugSpy = mock(() => {});
    console.debug = debugSpy as unknown as typeof console.debug;
    const failure = new Error("bridge unavailable");
    const reconcile = mock(async () => {
      throw failure;
    });

    try {
      render(<Harness {...BASE} reconcile={reconcile} />);
      await waitFor(() =>
        expect(debugSpy).toHaveBeenCalledWith(
          "[TestChatTab] Stalled-turn poll failed:",
          failure,
        ),
      );
    } finally {
      console.debug = originalDebug;
    }
  });

  test("polls on the exported default cadence when none is supplied", async () => {
    // Every other test overrides both knobs, so the shipped defaults — the ones
    // all three chat tabs actually run with — would otherwise go unexercised.
    installTimerHarness(50_000);
    const reconcile = mock(async () => {});
    render(
      <Harness agentLabel="Test" isLoading isReady reconcile={reconcile} />,
    );

    expect(registeredIntervals.map((entry) => entry.delayMs)).toContain(1000);

    mockedNow = 50_000 + DEFAULT_TURN_STALE_AFTER_MS - 1;
    await tick();
    expect(reconcile).not.toHaveBeenCalled();

    mockedNow = 50_000 + DEFAULT_TURN_STALE_AFTER_MS;
    await tick();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("throttles reconciles on a long silent turn", async () => {
    /**
     * Callers pass the session as their activity signal, and an applied
     * reconcile replaces that session — so the staleness gate re-opens on the
     * very next tick and a quiet turn becomes a sustained ~2.5s poll loop
     * (roughly four bridge GETs a round for Claude). `minReconcileIntervalMs`
     * is the floor that stops it.
     */
    installTimerHarness(100_000);
    const reconcile = mock(async () => {});
    const { rerender } = render(
      <Harness
        agentLabel="Test"
        isLoading
        isReady
        activitySignal={0}
        reconcile={reconcile}
      />,
    );

    const turnDurationMs = DEFAULT_MIN_RECONCILE_INTERVAL_MS + 5_000;
    for (let elapsed = 1000; elapsed <= turnDurationMs; elapsed += 1000) {
      mockedNow = 100_000 + elapsed;
      await tick();
      // Stand in for the store write every applied reconcile performs.
      rerender(
        <Harness
          agentLabel="Test"
          isLoading
          isReady
          activitySignal={reconcile.mock.calls.length}
          reconcile={reconcile}
        />,
      );
    }

    // Staleness alone would have reconciled every other tick — seven times
    // across these fifteen seconds — because each reconcile re-opens the gate.
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  test("ignores a tick that lands after cleanup", async () => {
    // clearInterval is not guaranteed to have run before an already-queued tick
    // executes, so the effect's own cancelled flag is the real guard.
    installTimerHarness(200_000);
    const reconcile = mock(async () => {});
    const { unmount } = render(
      <Harness
        agentLabel="Test"
        isLoading
        isReady
        staleAfterMs={100}
        reconcile={reconcile}
      />,
    );
    const orphanedTicks = registeredIntervals.map((entry) => entry.callback);

    unmount();
    mockedNow = 210_000;
    await tick(orphanedTicks);

    expect(reconcile).not.toHaveBeenCalled();
  });

  test("stops polling on unmount", async () => {
    const reconcile = mock(async () => {});
    const { unmount } = render(<Harness {...BASE} reconcile={reconcile} />);

    await waitFor(() => expect(reconcile).toHaveBeenCalled());
    unmount();
    const callsAtUnmount = reconcile.mock.calls.length;

    await afterStale();
    expect(reconcile.mock.calls.length).toBe(callsAtUnmount);
  });
});
