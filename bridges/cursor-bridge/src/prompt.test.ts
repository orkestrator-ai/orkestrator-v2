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
}

/** A run that never settles, which is the shape a timeout has to survive. */
function stalledRun(onCancel?: () => void): FakeRun {
  let cancels = 0;
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      await new Promise<void>(() => undefined);
    },
    wait: () => new Promise(() => undefined),
    cancel: async () => {
      cancels += 1;
      onCancel?.();
    },
    cancels: () => cancels,
  };
}

describe("a turn that outlives its budget", () => {
  test("cancels the run it is about to abandon", async () => {
    const state = runningSession();
    const run = stalledRun();

    await followRun(state, run, state.promptSequence, { prompt: "forever", images: [] }, 5);

    // Failing the turn clears `cancelTurn` and settles every child, so a run
    // left alive would keep writing to the workspace with nothing able to stop
    // it and `/activity` answering idle.
    expect(run.cancels()).toBe(1);
    expect(state.status).toBe("error");
    expect(state.error).toContain("time budget");
  });

  test("does not report the session as working once it has given up", async () => {
    const state = runningSession();
    state.activeSubagentDescriptors.set("tool-1", { description: "child" });

    await followRun(state, stalledRun(), state.promptSequence, { prompt: "x", images: [] }, 5);

    expect(sessionIsWorking(state)).toBe(false);
  });

  test("still fails the turn when the cancel itself hangs", async () => {
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
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);

    expect(settled).toBe(true);
    expect(state.status).toBe("error");
  });

  test("leaves a turn that was already superseded alone", async () => {
    const state = runningSession();
    const run = stalledRun();

    // A cancelled or superseded turn keeps emitting for a while; writing its
    // outcome onto the session would overwrite the live turn's.
    await followRun(state, run, state.promptSequence - 1, { prompt: "x", images: [] }, 5);

    expect(state.status).toBe("running");
    expect(state.error).toBeUndefined();
  });

  test("records a failed journal entry so the id is never replayed", async () => {
    const state = runningSession();

    await followRun(
      state,
      stalledRun(),
      state.promptSequence,
      { prompt: "x", images: [], requestId: "r1" },
      5,
    );

    expect(state.promptJournal.get("r1")?.state).toBe("failed");
  });
});
