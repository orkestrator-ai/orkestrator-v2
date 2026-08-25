/**
 * What happens to a turn that does not end on its own.
 *
 * `followRun` is driven directly here rather than through the prompt route.
 * The turn budget has a deliberate one-minute floor (`parseBoundedInteger` in
 * `config.ts`), so the environment cannot lower it, and the branch that matters
 * most — giving up on a run that is still executing — would otherwise be
 * untestable at any sane wall-clock cost.
 */
import { describe, expect, test } from "bun:test";
import { followRun, type FollowableRun } from "./prompt.js";
import { newSessionState } from "./agent-session.js";
import { sessionIsWorking, type SessionState } from "./state.js";

function runningSession(): SessionState {
  const state = newSessionState();
  state.status = "running";
  state.promptSequence = 1;
  state.currentTurnOutput = null;
  return state;
}

interface FakeRun extends FollowableRun {
  readonly cancels: () => number;
  readonly finish: (result?: { status: string }) => void;
}

/** A run whose terminal acknowledgement is controlled by the test. */
function controlledRun(onCancel?: () => void): FakeRun {
  let cancels = 0;
  let finishRun!: (result: { status: string }) => void;
  let finishStream!: () => void;
  const terminal = new Promise<{ status: string }>((resolve) => {
    finishRun = resolve;
  });
  const streamClosed = new Promise<void>((resolve) => {
    finishStream = resolve;
  });
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      await streamClosed;
    },
    wait: () => terminal,
    cancel: async () => {
      cancels += 1;
      onCancel?.();
    },
    cancels: () => cancels,
    finish: (result = { status: "cancelled" }) => {
      finishRun(result);
      finishStream();
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("a turn that outlives its budget", () => {
  test("cancels the run it is about to abandon", async () => {
    const state = runningSession();
    const run = controlledRun();

    const completion = followRun(
      state,
      run,
      state.promptSequence,
      { prompt: "forever", images: [] },
      5,
    );
    await waitFor(() => run.cancels() === 1);

    expect(run.cancels()).toBe(1);
    expect(state.status).toBe("running");
    expect(state.error).toContain("time budget");

    run.finish();
    await completion;
    expect(state.status).toBe("idle");
  });

  test("reports the session as working until cancellation is acknowledged", async () => {
    const state = runningSession();
    state.activeSubagentDescriptors.set("tool-1", { description: "child" });
    const run = controlledRun();

    const completion = followRun(state, run, state.promptSequence, { prompt: "x", images: [] }, 5);
    await waitFor(() => run.cancels() === 1);

    expect(sessionIsWorking(state)).toBe(true);
    run.finish();
    await completion;
    expect(sessionIsWorking(state)).toBe(false);
  });

  test("does not claim a terminal state when cancellation cannot be confirmed", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      // eslint-disable-next-line require-yield
      async *stream() {
        await new Promise<void>(() => undefined);
      },
      wait: () => new Promise(() => undefined),
      // A cancel that never settles must not strand the session as running,
      // which is the state the timeout exists to get it out of.
      cancel: () => new Promise(() => undefined),
    };

    const settled = await Promise.race([
      followRun(state, run, state.promptSequence, { prompt: "x", images: [] }, 5).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);

    expect(settled).toBe(false);
    expect(state.status).toBe("running");
    expect(sessionIsWorking(state)).toBe(true);
  });

  test("leaves a turn that was already superseded alone", async () => {
    const state = runningSession();
    const run = controlledRun();

    // A cancelled or superseded turn keeps emitting for a while; writing its
    // outcome onto the session would overwrite the live turn's.
    const completion = followRun(
      state,
      run,
      state.promptSequence - 1,
      { prompt: "x", images: [] },
      5,
    );
    await waitFor(() => run.cancels() === 1);

    expect(state.status).toBe("running");
    expect(state.error).toBeUndefined();
    run.finish();
    await completion;
  });

  test("does not settle the journal until the run itself is terminal", async () => {
    const state = runningSession();
    const run = controlledRun();

    const completion = followRun(
      state,
      run,
      state.promptSequence,
      { prompt: "x", images: [], requestId: "r1" },
      5,
    );
    await waitFor(() => run.cancels() === 1);

    expect(state.promptJournal.get("r1")).toBeUndefined();
    run.finish();
    await completion;
    expect(state.promptJournal.get("r1")?.state).toBe("completed");
  });
});
