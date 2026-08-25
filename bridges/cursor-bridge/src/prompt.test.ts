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
import { publicContextUsage } from "./public.js";
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
  readonly finishTerminal: (result?: { status: string }) => void;
  readonly closeStream: () => void;
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
    finishTerminal: (result = { status: "cancelled" }) => {
      finishRun(result);
    },
    closeStream: () => {
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

  test("recovers with an explicit error when cancellation is never acknowledged", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      // eslint-disable-next-line require-yield
      async *stream() {
        await new Promise<void>(() => undefined);
      },
      wait: () => new Promise(() => undefined),
      // A cancel that never settles: the SDK never produces a terminal result.
      cancel: () => new Promise(() => undefined),
    };

    const completion = followRun(
      state,
      run,
      state.promptSequence,
      { prompt: "x", images: [] },
      5,
      50,
    );

    // Still running while the cancellation acknowledgement is outstanding.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.status).toBe("running");
    expect(state.error).toContain("time budget");
    expect(sessionIsWorking(state)).toBe(true);

    // Once the grace period elapses with no terminal, it fails explicitly
    // rather than holding the environment busy forever.
    await completion;
    expect(state.status).toBe("error");
    expect(state.error).toContain("did not stop");
    expect(sessionIsWorking(state)).toBe(false);
  });

  test("waits for the stream to drain before settling a timed-out turn", async () => {
    const state = runningSession();
    const run = controlledRun();

    const completion = followRun(state, run, state.promptSequence, { prompt: "x", images: [] }, 5);
    await waitFor(() => run.cancels() === 1);

    // The run reports terminal, but its stream is still open. The turn must not
    // settle until the stream drains — a run that never closes its stream has
    // not actually finished.
    run.finishTerminal();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.status).toBe("running");

    run.closeStream();
    await completion;
    expect(state.status).toBe("idle");
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

describe("terminal run usage", () => {
  test("uses RunResult usage when the turn-ended delta did not report it", async () => {
    const state = runningSession();
    state.composer.selectedModelId = "requested-model";
    state.currentTurnUsage = {};
    const run: FollowableRun = {
      // eslint-disable-next-line require-yield
      async *stream() {},
      cancel: async () => undefined,
      wait: async () => ({
        status: "finished",
        durationMs: 123,
        model: { id: "resolved-model" },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 10,
          reasoningTokens: 7,
          totalTokens: 135,
        },
      }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.usage).toMatchObject({
      modelId: "resolved-model",
      durationMs: 123,
      turn: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 10,
        reasoningTokens: 7,
        totalTokens: 135,
      },
    });
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 135,
      lastTurnTokens: 135,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
      reasoningTokens: 7,
      modelId: "resolved-model",
      durationMs: 123,
      source: "provider",
    });
  });

  test("uses streamed SDK usage when the terminal result omits usage", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      async *stream() {
        yield {
          type: "usage",
          agent_id: "agent-1",
          run_id: "run-1",
          usage: {
            inputTokens: 40,
            outputTokens: 10,
            cacheReadTokens: 5,
            cacheWriteTokens: 0,
            totalTokens: 55,
          },
        };
      },
      cancel: async () => undefined,
      wait: async () => ({ status: "finished" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 55,
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      source: "provider",
    });
  });
});
