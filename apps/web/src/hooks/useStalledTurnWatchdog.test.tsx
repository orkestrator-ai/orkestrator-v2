import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useStalledTurnWatchdog } from "./useStalledTurnWatchdog";

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

afterEach(() => cleanup());

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

  test("keeps polling after a failed reconcile", async () => {
    // A failed poll is not actionable, but it must not disarm the watchdog —
    // the stall it exists to catch is still there.
    const reconcile = mock(async () => {
      throw new Error("bridge unavailable");
    });
    render(<Harness {...BASE} reconcile={reconcile} />);

    await waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThan(1));
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
