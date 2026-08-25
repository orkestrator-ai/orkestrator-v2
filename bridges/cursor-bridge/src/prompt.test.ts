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
  test("prefers RunResult usage over streamed and turn-ended usage", async () => {
    const state = runningSession();
    state.composer.selectedModelId = "requested-model";
    state.currentTurnUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
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
      // Occupancy comes from the final model call, spend from the run total.
      usedTokens: 55,
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

  test("sums multiple streamed SDK usage messages when the terminal result omits usage", async () => {
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
        yield {
          type: "usage",
          agent_id: "agent-1",
          run_id: "run-1",
          usage: {
            inputTokens: 6,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 1,
            reasoningTokens: 2,
            totalTokens: 11,
          },
        };
      },
      cancel: async () => undefined,
      wait: async () => ({ status: "finished" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(publicContextUsage(state)).toMatchObject({
      // 6 + 4 + 0 + 1: what the window held on the last call, not the run total.
      usedTokens: 11,
      lastTurnTokens: 66,
      inputTokens: 46,
      outputTokens: 14,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      reasoningTokens: 2,
      source: "provider",
    });
  });

  test("uses the provider total instead of reconstructing it from token categories", () => {
    const state = runningSession();
    state.usage = {
      turn: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 10,
        totalTokens: 121,
      },
      updatedAt: new Date(1).toISOString(),
    };

    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 121,
      lastTurnTokens: 121,
    });
  });

  test("records terminal usage when a run ends in error", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      async *stream() {},
      cancel: async () => undefined,
      wait: async () => ({
        status: "error",
        error: { message: "provider failed" },
        durationMs: 234,
        model: { id: "resolved-model" },
        usage: {
          inputTokens: 30,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          totalTokens: 37,
        },
      }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.status).toBe("error");
    expect(state.error).toBe("provider failed");
    expect(state.usage).toMatchObject({
      modelId: "resolved-model",
      durationMs: 234,
      turn: { inputTokens: 30, outputTokens: 5, totalTokens: 37 },
    });
  });

  test("records terminal usage when a run is cancelled", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      async *stream() {},
      cancel: async () => undefined,
      wait: async () => ({
        status: "cancelled",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
        },
      }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.status).toBe("idle");
    expect(state.error).toBeUndefined();
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 15,
      lastTurnTokens: 15,
    });
  });

  test("falls back to the turn-ended delta when neither terminal nor streamed usage exists", async () => {
    // The documented compatibility path for runtimes that report usage only
    // through `onDelta`. Nothing else covers the third tier of the chain.
    const state = runningSession();
    state.composer.selectedModelId = "requested-model";
    state.currentTurnUsage = { inputTokens: 70, outputTokens: 10, cacheReadTokens: 20 };
    const run: FollowableRun = {
      async *stream() {},
      cancel: async () => undefined,
      wait: async () => ({ status: "finished" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.usage?.turn).toEqual({
      inputTokens: 70,
      outputTokens: 10,
      cacheReadTokens: 20,
    });
    expect(publicContextUsage(state)).toMatchObject({
      // No provider total to trust, so the categories are summed.
      usedTokens: 100,
      lastTurnTokens: 100,
      modelId: "requested-model",
    });
    expect(state.currentTurnUsage).toBeUndefined();
  });

  test("keeps the previous snapshot when a turn reports no usage at all", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };
    const run: FollowableRun = {
      async *stream() {},
      cancel: async () => undefined,
      wait: async () => ({ status: "finished" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.usage?.turn).toEqual({ inputTokens: 90, outputTokens: 10, totalTokens: 100 });
  });

  test("recomputes the provider total when a streamed message omits it", async () => {
    // `terminalTurnUsage` accepts partial usage objects on purpose, so a
    // carried-forward `totalTokens` would summarise a different subset of
    // messages than the categories beside it — and the context projection
    // trusts the total over those categories.
    const state = runningSession();
    const run: FollowableRun = {
      async *stream() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 40,
            outputTokens: 10,
            cacheReadTokens: 5,
            cacheWriteTokens: 0,
            totalTokens: 55,
          },
        };
        yield { type: "usage", usage: { inputTokens: 6, outputTokens: 4 } };
      },
      cancel: async () => undefined,
      wait: async () => ({ status: "finished" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.usage?.turn).toMatchObject({
      inputTokens: 46,
      outputTokens: 14,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      // 46 + 14 + 5 + 0, not the 55 the first message reported.
      totalTokens: 65,
    });
    expect(publicContextUsage(state)).toMatchObject({ lastTurnTokens: 65 });
  });

  test("drops token counts that are not usable numbers", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      async *stream() {},
      cancel: async () => undefined,
      wait: async () => ({
        status: "finished",
        usage: {
          inputTokens: 50,
          outputTokens: -5,
          cacheReadTokens: Number.NaN,
          cacheWriteTokens: Number.POSITIVE_INFINITY,
          reasoningTokens: "12",
          totalTokens: 50,
        },
      }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.usage?.turn).toEqual({ inputTokens: 50, totalTokens: 50 });
  });

  test("ignores a terminal result whose usage is not an object", async () => {
    const state = runningSession();
    state.currentTurnUsage = { inputTokens: 8, outputTokens: 2 };
    const run: FollowableRun = {
      async *stream() {
        yield { type: "usage", usage: "not-an-object" };
        yield { type: "assistant", text: "no usage here" };
      },
      cancel: async () => undefined,
      wait: async () => ({ status: "finished", usage: "not-an-object" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    expect(state.usage?.turn).toEqual({ inputTokens: 8, outputTokens: 2 });
  });
});

describe("context occupancy versus turn spend", () => {
  test("measures the context gauge from the final model call, not the run total", async () => {
    const state = runningSession();
    state.composer.models = [
      {
        platform: "cursor",
        id: "big-model",
        label: "Big Model",
        providerLabel: "Cursor",
        contextWindow: 200_000,
      },
    ];
    state.composer.selectedModelId = "big-model";
    // Four model calls, each re-reading a ~120k context out of cache. The
    // cumulative spend is far past the window; the window itself never was.
    const call = {
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadTokens: 117_000,
      cacheWriteTokens: 0,
      totalTokens: 120_000,
    };
    const run: FollowableRun = {
      async *stream() {
        for (let index = 0; index < 4; index += 1) {
          yield { type: "usage", usage: call };
        }
      },
      cancel: async () => undefined,
      wait: async () => ({
        status: "finished",
        model: { id: "big-model" },
        usage: {
          inputTokens: 8_000,
          outputTokens: 4_000,
          cacheReadTokens: 468_000,
          cacheWriteTokens: 0,
          totalTokens: 480_000,
        },
      }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    const usage = publicContextUsage(state);
    expect(usage).toMatchObject({
      usedTokens: 120_000,
      maximumTokens: 200_000,
      lastTurnTokens: 480_000,
    });
    // The gauge stays inside the window rather than pegging at 100%.
    expect(usage?.usedTokens).toBeLessThan(usage?.maximumTokens ?? 0);
  });

  test("reports one figure when the run made a single model call", async () => {
    const state = runningSession();
    const run: FollowableRun = {
      async *stream() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 30,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 40,
          },
        };
      },
      cancel: async () => undefined,
      wait: async () => ({ status: "finished" }),
    };

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });

    // One reading, so nothing to disambiguate and nothing duplicated on disk.
    expect(state.usage?.context).toBeUndefined();
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 40,
      lastTurnTokens: 40,
    });
  });

  test("records streamed usage when the turn is abandoned after its budget", async () => {
    const state = runningSession();
    let released!: () => void;
    const streamOpen = new Promise<void>((resolve) => {
      released = resolve;
    });
    const run: FollowableRun = {
      async *stream() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 25,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 30,
          },
        };
        await streamOpen;
      },
      // Neither the wait nor the cancellation ever settles.
      wait: () => new Promise(() => undefined),
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
    await completion;
    released();

    expect(state.status).toBe("error");
    expect(state.error).toContain("did not stop");
    // The turn was abandoned, but the tokens it burned still happened.
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 30,
      lastTurnTokens: 30,
    });
  });

  test("records streamed usage when a terminal result arrives after the budget", async () => {
    const state = runningSession();
    const run = controlledRun();
    const streaming: FollowableRun = {
      async *stream() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 20,
          },
        };
        yield* run.stream();
      },
      wait: run.wait,
      cancel: run.cancel,
    };

    const completion = followRun(
      state,
      streaming,
      state.promptSequence,
      { prompt: "x", images: [] },
      5,
    );
    await waitFor(() => run.cancels() === 1);
    run.finish({ status: "cancelled" });
    await completion;

    expect(state.status).toBe("idle");
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 20,
      lastTurnTokens: 20,
    });
  });
});
