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
import type { SDKAgent } from "@cursor/sdk";
import {
  followRun,
  refreshAgentUsage,
  scheduleAgentUsageRefresh,
  type FollowableRun,
} from "./prompt.js";
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

  test("publishes Cursor Grok tokens before account usage catches up", async () => {
    const state = runningSession();
    state.composer.selectedModelId = "grok-4.6";

    await followRun(
      state,
      finishedRun({
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100,
      }),
      state.promptSequence,
      { prompt: "review", images: [] },
    );

    // The slower account endpoint has not supplied a billed total, but the
    // completed run's exact cumulative floor is already usable by Multi Review.
    expect(state.usage?.sessionTokens).toBeUndefined();
    expect(state.usage?.sessionTokenFloor).toBe(100);
    expect(publicContextUsage(state)).toMatchObject({
      modelId: "grok-4.6",
      lastTurnTokens: 100,
      sessionTokens: 100,
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

/** A run that is already terminal, reporting exactly this usage. */
function finishedRun(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}): FollowableRun {
  return {
    async *stream() {},
    cancel: async () => undefined,
    wait: async () => ({ status: "finished", usage }),
  };
}

/**
 * A billed-usage report in the shape `agent.getUsage()` answers with.
 *
 * `rawCostCents` is deliberately not `chargedCents`: the snapshot must read the
 * amount actually charged, not the undiscounted list price.
 */
function usageReport(totalTokens: number | undefined, chargedCents?: number): unknown {
  return {
    ...(totalTokens === undefined
      ? {}
      : {
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens,
          },
        }),
    ...(chargedCents === undefined
      ? {}
      : { cost: { rawCostCents: chargedCents * 2, chargedCents } }),
    runs: [],
  };
}

function usageAgent(getUsage: () => unknown): Pick<SDKAgent, "getUsage"> {
  return { getUsage } as unknown as Pick<SDKAgent, "getUsage">;
}

function attachUsageAgent(state: SessionState, getUsage: () => unknown): void {
  state.agent = { getUsage } as unknown as NonNullable<SessionState["agent"]>;
}

/** Let every already-resolved continuation run without advancing wall clock. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("cumulative agent usage", () => {
  test("refreshes billed usage off the terminal path after a run finishes", async () => {
    const state = runningSession();
    attachUsageAgent(state, async () => ({
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 750,
        cacheWriteTokens: 0,
        totalTokens: 1_000,
      },
      cost: { rawCostCents: 60, chargedCents: 40 },
      runs: [],
    }));
    const run = finishedRun({
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 100,
    });

    await followRun(state, run, state.promptSequence, { prompt: "x", images: [] });
    // The run is already terminal; the supplemental account request catches up
    // independently and advances the authoritative snapshot when it arrives.
    expect(state.status).toBe("idle");
    await waitFor(() => state.usage?.sessionTokens === 1_000);
    expect(publicContextUsage(state)).toMatchObject({ sessionTokens: 1_000, costUsd: 0.4 });
  });

  test("adds the SDK's billed session total and actual charge to the public snapshot", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(3_000, 125)),
      state.promptSequence,
      100,
      100,
    );

    // With no earlier charge baseline this useful snapshot is merged, but the
    // bounded chain still follows up in case billing has not settled.
    expect(outcome).toBe("retry");
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 100,
      lastTurnTokens: 100,
      sessionTokens: 3_000,
      // `chargedCents`, not the undiscounted raw cost.
      costUsd: 1.25,
    });
  });

  test("does not let a late usage read overwrite a newer turn", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };
    let resolveUsage!: (value: unknown) => void;
    const usage = new Promise<unknown>((resolve) => {
      resolveUsage = resolve;
    });

    const refresh = refreshAgentUsage(
      state,
      usageAgent(() => usage),
      state.promptSequence,
      100,
      100,
    );
    state.promptSequence += 1;
    state.usage = {
      turn: { inputTokens: 180, outputTokens: 20, totalTokens: 200 },
      updatedAt: new Date(2).toISOString(),
    };
    resolveUsage(usageReport(1_000, 40));

    expect(await refresh).toBe("stale");
    expect(state.usage.sessionTokens).toBeUndefined();
    expect(state.usage.costUsd).toBeUndefined();
  });

  test("retries an eventually consistent total that is older than the completed turn", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(50)),
      state.promptSequence,
      100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBeUndefined();
  });

  test("measures staleness against the cumulative it already had, not the last turn alone", async () => {
    const state = runningSession();
    // A second turn: 1,000 tokens were already billed before it, and it spent
    // 100 more. Anything below 1,100 is a view of the account taken before the
    // turn landed, even though it comfortably exceeds the turn's own spend.
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      sessionTokens: 1_000,
      costUsd: 0.4,
      updatedAt: new Date(1).toISOString(),
    };

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(1_050, 45)),
      state.promptSequence,
      1_100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBe(1_000);
    // The charge in that report is exactly as old as its token total, so it is
    // not taken either.
    expect(state.usage.costUsd).toBe(0.4);
  });

  test("keeps following up for a charge when an earlier turn's is carried forward", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      sessionTokens: 1_000,
      costUsd: 0.4,
      updatedAt: new Date(1).toISOString(),
    };

    // The token total has caught up; the charge has not. The $0.40 already on
    // the snapshot is the *previous* turn's, so it is not evidence that this
    // turn's charge has landed — the follow-ups have to keep running or the
    // session would show a cost that stopped advancing after the first turn.
    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(1_100)),
      state.promptSequence,
      1_100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBe(1_100);
    expect(state.usage.costUsd).toBe(0.4);
  });

  test("takes a charge from a report that carries no token total at all", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };
    const before = state.revision;

    // A partial object from an older vendored runtime says nothing about
    // freshness, so its charge is still worth recording — but the missing
    // total keeps the follow-ups running.
    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(undefined, 250)),
      state.promptSequence,
      100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.costUsd).toBe(2.5);
    expect(state.usage.sessionTokens).toBeUndefined();
    // The bridge is polled on `revision`, so a merged snapshot nothing bumped
    // would never reach the client.
    expect(state.revision).toBe(before + 1);
  });

  test("leaves the revision alone when the report changes nothing", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      sessionTokens: 3_000,
      costUsd: 1.25,
      updatedAt: new Date(1).toISOString(),
    };
    const before = state.revision;

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(3_000, 125)),
      state.promptSequence,
      100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.revision).toBe(before);
  });

  test("never moves a cumulative token total backward on a later retry", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      sessionTokens: 3_000,
      sessionTokenFloor: 3_000,
      updatedAt: new Date(1).toISOString(),
    };

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(async () => usageReport(2_500, 100)),
      state.promptSequence,
      100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBe(3_000);
    expect(state.usage.costUsd).toBeUndefined();
  });

  test("tolerates an account read that fails", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(() => Promise.reject(new Error("billing is down"))),
      state.promptSequence,
      100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBeUndefined();
  });

  test("tolerates a runtime whose agent has no account endpoint", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };

    // An older vendored SDK simply does not have `getUsage`. Usage is
    // supplemental, so that must degrade rather than throw on a turn's
    // terminal path.
    const outcome = await refreshAgentUsage(
      state,
      {} as unknown as Pick<SDKAgent, "getUsage">,
      state.promptSequence,
      100,
      100,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBeUndefined();
  });

  test("gives up on an account read that never answers", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };

    const outcome = await refreshAgentUsage(
      state,
      usageAgent(() => new Promise(() => undefined)),
      state.promptSequence,
      100,
      5,
    );

    expect(outcome).toBe("retry");
    expect(state.usage.sessionTokens).toBeUndefined();
  });
});

describe("the billed-usage retry chain", () => {
  function refreshableSession(getUsage: () => unknown): SessionState {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };
    attachUsageAgent(state, getUsage);
    return state;
  }

  test("follows a lagging account read through its bounded retries", async () => {
    let calls = 0;
    const state = refreshableSession(async () => {
      calls += 1;
      // Eventually consistent: the account only catches up on the third read.
      return calls < 3 ? usageReport(undefined) : usageReport(3_000, 125);
    });

    scheduleAgentUsageRefresh(state, 100, [1, 1], 100);

    await waitFor(() => state.usage?.sessionTokens === 3_000);
    expect(calls).toBe(3);
    expect(state.usage?.costUsd).toBe(1.25);
  });

  test("stops as soon as the charge advances from a known baseline", async () => {
    let calls = 0;
    const state = refreshableSession(async () => {
      calls += 1;
      return usageReport(3_000, 125);
    });
    state.usage = { ...state.usage!, costUsd: 0 };

    scheduleAgentUsageRefresh(state, 100, [1, 1], 100, 0);

    await waitFor(() => state.usage?.sessionTokens === 3_000);
    // Well past both delays: a chain that kept going would have read again.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(1);
  });

  test("follows up a first-turn zero charge when there is no baseline", async () => {
    let calls = 0;
    const state = refreshableSession(async () => {
      calls += 1;
      return usageReport(100, calls === 1 ? 0 : 5);
    });

    scheduleAgentUsageRefresh(state, 100, [1, 1], 100);

    await waitFor(() => calls === 3);
    expect(state.usage?.sessionTokens).toBe(100);
    expect(state.usage?.costUsd).toBe(0.05);
  });

  test("keeps retrying when the token total advanced but the cumulative charge did not", async () => {
    let calls = 0;
    const state = refreshableSession(async () => {
      calls += 1;
      return calls === 1 ? usageReport(1_100, 40) : usageReport(1_100, 45);
    });
    state.usage = {
      ...state.usage!,
      sessionTokens: 1_000,
      sessionTokenFloor: 1_100,
      costUsd: 0.4,
    };

    scheduleAgentUsageRefresh(state, 1_100, [1, 1], 100, 0.4);

    await waitFor(() => state.usage?.costUsd === 0.45);
    expect(calls).toBe(2);
    expect(state.usage?.sessionTokens).toBe(1_100);
  });

  test("gives up after the last delay rather than retrying forever", async () => {
    let calls = 0;
    const state = refreshableSession(async () => {
      calls += 1;
      return usageReport(undefined);
    });

    scheduleAgentUsageRefresh(state, 100, [1, 1], 100);

    await waitFor(() => calls === 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(3);
    expect(state.usage?.sessionTokens).toBeUndefined();
  });

  test("abandons the chain when a newer turn has taken over", async () => {
    let calls = 0;
    const state = refreshableSession(async () => {
      calls += 1;
      return usageReport(undefined);
    });

    // Delays with headroom over the poll below, so the sequence is provably
    // bumped between the first read and the retry that observes it.
    scheduleAgentUsageRefresh(state, 100, [15, 15], 100);
    await waitFor(() => calls === 1);
    // The next turn claimed the session while the first read was in flight.
    state.promptSequence += 1;

    await new Promise((resolve) => setTimeout(resolve, 60));
    // The retry woke, saw the newer sequence and stopped there — the staleness
    // check runs before the read, so a turn this chain no longer owns does not
    // cost a billing request, and cannot have its snapshot overwritten.
    expect(calls).toBe(1);
  });

  test("does nothing when the session has no attached agent", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      updatedAt: new Date(1).toISOString(),
    };
    const before = state.revision;

    scheduleAgentUsageRefresh(state, 100, [1, 1], 100);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(state.revision).toBe(before);
    expect(state.usage.sessionTokens).toBeUndefined();
  });
});

describe("billed usage across successive turns", () => {
  /** Run one already-terminal turn of `totalTokens` to completion. */
  async function runTurn(state: SessionState, totalTokens: number): Promise<void> {
    state.status = "running";
    state.currentTurnOutput = null;
    state.promptSequence += 1;
    await followRun(
      state,
      finishedRun({
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens,
      }),
      state.promptSequence,
      { prompt: "x", images: [] },
    );
  }

  test("keeps the cumulative account figures visible while the next read catches up", async () => {
    const state = runningSession();
    let answer = true;
    attachUsageAgent(state, () =>
      // The second turn's read never answers, so nothing can have refreshed
      // the snapshot by the time it is asserted on.
      answer ? Promise.resolve(usageReport(1_000, 40)) : new Promise(() => undefined),
    );

    await runTurn(state, 100);
    await waitFor(() => state.usage?.sessionTokens === 1_000);

    answer = false;
    await runTurn(state, 250);

    // The exact local floor advances immediately instead of leaving the panel
    // on the prior account snapshot while billing catches up.
    expect(publicContextUsage(state)).toMatchObject({
      lastTurnTokens: 250,
      sessionTokens: 1_250,
      costUsd: 0.4,
    });
  });

  test("does not accept a billed total that predates the turn just recorded", async () => {
    let calls = 0;
    const state = runningSession();
    attachUsageAgent(state, async () => {
      calls += 1;
      // 1,050 exceeds the second turn's own 100-token spend but cannot yet
      // include it: 1,000 was already billed before that turn began.
      return calls === 1 ? usageReport(1_000, 40) : usageReport(1_050, 45);
    });

    await runTurn(state, 100);
    await waitFor(() => state.usage?.sessionTokens === 1_000);

    await runTurn(state, 100);
    await waitFor(() => calls >= 2);
    await tick();

    expect(state.usage?.sessionTokens).toBe(1_000);
    expect(state.usage?.costUsd).toBe(0.4);
  });

  test("retains an unsettled turn in the floor when the next turn takes over", async () => {
    let calls = 0;
    const state = runningSession();
    attachUsageAgent(state, () => {
      calls += 1;
      // Turn A's read never lands. Turn B must still remember A's locally
      // measured spend when this account snapshot contains A but not B.
      return calls === 1 ? new Promise(() => undefined) : usageReport(100, 40);
    });

    await runTurn(state, 100);
    await waitFor(() => calls === 1);
    await runTurn(state, 40);
    await waitFor(() => calls === 2);
    await tick();

    expect(state.usage?.sessionTokenFloor).toBe(140);
    expect(state.usage?.sessionTokens).toBeUndefined();
    expect(state.usage?.costUsd).toBeUndefined();
  });

  test("adds a new turn to a durable floor restored before billing settled", async () => {
    const state = runningSession();
    state.usage = {
      turn: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
      sessionTokens: 1_000,
      // Represents a prior turn that was persisted before its account read
      // reached 1,100 and before the bridge restarted.
      sessionTokenFloor: 1_100,
      costUsd: 0.4,
      updatedAt: new Date(1).toISOString(),
    };
    attachUsageAgent(state, () => usageReport(1_100, 45));

    await runTurn(state, 100);
    await tick();

    expect(state.usage?.sessionTokenFloor).toBe(1_200);
    expect(state.usage?.sessionTokens).toBe(1_000);
    expect(state.usage?.costUsd).toBe(0.4);
  });
});

describe("context occupancy versus turn spend", () => {
  test("keeps cumulative account figures visible after a zero-token turn", () => {
    const state = runningSession();
    state.usage = {
      turn: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      sessionTokens: 1_000,
      sessionTokenFloor: 1_000,
      costUsd: 0.4,
      updatedAt: new Date(1).toISOString(),
    };

    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 0,
      lastTurnTokens: 0,
      sessionTokens: 1_000,
      costUsd: 0.4,
    });
  });

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
