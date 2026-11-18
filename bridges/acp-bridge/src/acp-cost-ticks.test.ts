import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import type { AcpProcess, SessionState } from "./acp-context.js";

const fixtureConfig = process.env.ACP_PROVIDER_CONFIG!;
process.env.ACP_PROVIDER_CONFIG = JSON.stringify({ ...JSON.parse(fixtureConfig), id: "grok" });
const { sessions } = await import("./acp-context.js");
const { restorePersistedUsage } = await import("./acp-persistence.js");
const { requestPromptWithRetriableProviderRetries } = await import("./acp-prompt.js");
const { publicContextUsage } = await import("./acp-public.js");
const { applySessionUpdate, finalizeHistoryReplayTurnUsage, finalizeTurnUsage, recordTurnUsage } =
  await import("./acp-session.js");
process.env.ACP_PROVIDER_CONFIG = fixtureConfig;

function newState(): SessionState {
  return {
    id: `cost-ticks-${crypto.randomUUID()}`,
    acpSessionId: "vendor-session",
    status: "idle",
    promptSequence: 0,
    messages: [],
    approvals: new Map(),
    interactions: new Map(),
    activeSubagentDescriptors: new Map(),
    uncheckedTranscriptBytes: 0,
    historyMessageIds: new Map(),
    revision: 0,
    sessionConfig: { composer: {} },
    currentTurnOutput: null,
  } as unknown as SessionState;
}

function startTurn(state: SessionState): void {
  state.promptSequence += 1;
  state.status = "running";
  state.turnStartedAt = Date.now();
  state.currentTurnUsage = {};
  state.currentAttemptUsage = {};
  state.completedAttemptUsage = undefined;
  state.currentTurnRequestId = `request-${state.promptSequence}`;
}

function settleTurn(state: SessionState, qualified?: boolean): void {
  finalizeTurnUsage(state, qualified);
  state.status = "idle";
  state.turnStartedAt = undefined;
  state.currentTurnUsage = undefined;
  state.currentTurnRequestId = undefined;
}

function result(usage: Record<string, unknown>) {
  return { stopReason: "end_turn", _meta: { usage } };
}

function complete(state: SessionState, usage: Record<string, unknown>, qualified = true): void {
  startTurn(state);
  recordTurnUsage(state, result(usage), "prompt-result");
  settleTurn(state, qualified);
}

function late(state: SessionState, usage: Record<string, unknown>): void {
  recordTurnUsage(state, { sessionUpdate: "turn_completed", usage }, "notification", true);
}

function costs(state: SessionState) {
  return state.usage?.turns?.map((turn) => turn.costUsd);
}

function dashboardUsd(amount: number) {
  return { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } };
}

describe("Grok ticks across a session", () => {
  test("production withholds tick-derived prices before billing qualification", () => {
    const state = newState();
    startTurn(state);
    recordTurnUsage(
      state,
      result({ totalTokens: 100, costUsdTicks: 200_000_000 }),
      "prompt-result",
    );
    settleTurn(state);
    expect(state.usage?.cost?.total).toEqual({ usd: 0, ticks: 200_000_000 });
    expect(costs(state)).toEqual([undefined]);
    expect(publicContextUsage(state)?.costUsd).toBeUndefined();
    state.usage = restorePersistedUsage(JSON.parse(JSON.stringify(state.usage))) ?? undefined;
    expect(publicContextUsage(state)?.costUsd).toBeUndefined();
    expect(costs(state)).toEqual([undefined]);
  });

  test("two differently priced qualified turns contribute once each", () => {
    const state = newState();
    complete(state, { totalTokens: 15_675, costUsdTicks: 226_620_000 });
    complete(state, { totalTokens: 80_000, costUsdTicks: 1_250_000_000 });
    expect(costs(state)).toEqual([0.022662, 0.125]);
    expect(publicContextUsage(state, true)).toMatchObject({
      sessionTokens: 95_675,
      costUsd: 0.147662,
      costSource: "provider",
    });
  });

  test("cumulative USD subtracts the priced prefix before entering usage history", () => {
    const state = newState();
    complete(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    startTurn(state);
    recordTurnUsage(state, result({ totalTokens: 20 }), "prompt-result");
    recordTurnUsage(state, dashboardUsd(0.05));
    settleTurn(state, true);
    expect(costs(state)?.[0]).toBe(0.02);
    expect(costs(state)?.[1]).toBeCloseTo(0.03, 12);
    expect(costs(state)?.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)).toBeCloseTo(0.05, 12);
    expect(publicContextUsage(state, true)?.costUsd).toBe(0.05);
  });

  test("uses explicit USD on the panel and omits a delta across an unknown prefix", () => {
    const state = newState();
    complete(state, { totalTokens: 10, costUsdTicks: 200_000_000 }, false);
    startTurn(state);
    recordTurnUsage(state, result({ totalTokens: 20 }), "prompt-result");
    recordTurnUsage(state, dashboardUsd(0.05));
    settleTurn(state);
    expect(costs(state)).toEqual([undefined, undefined]);
    expect(publicContextUsage(state)?.costUsd).toBe(0.05);
  });

  test("uses an idle cumulative USD snapshot as the next turn's baseline", () => {
    const state = newState();
    recordTurnUsage(state, dashboardUsd(0.02));
    startTurn(state);
    recordTurnUsage(state, result({ inputTokens: 20 }), "prompt-result");
    recordTurnUsage(state, dashboardUsd(0.05));
    settleTurn(state);
    expect(costs(state)?.[0]).toBeCloseTo(0.03, 12);
    expect(publicContextUsage(state)?.costUsd).toBe(0.05);
  });

  test("late ticks restore the subtotal and revise the same history row", () => {
    const state = newState();
    complete(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    complete(state, { totalTokens: 20 });
    const firstVersion = state.usage?.turns?.at(-1);
    expect(publicContextUsage(state, true)?.costUsd).toBeUndefined();
    late(state, { totalTokens: 20, costUsdTicks: 300_000_000 });
    expect(publicContextUsage(state, true)?.costUsd).toBe(0.05);
    expect(state.usage?.turns?.at(-1)).toMatchObject({
      turnId: firstVersion?.turnId,
      at: firstVersion?.at,
      revision: 1,
      costUsd: 0.03,
    });
    late(state, { totalTokens: 20, costUsdTicks: 300_000_000 });
    expect(state.usage?.turns?.at(-1)?.revision).toBe(1);
    late(state, { costIsPartial: true });
    expect(state.usage?.turns?.at(-1)).toMatchObject({ revision: 2, costUsd: undefined });
    expect(publicContextUsage(state, true)?.costUsd).toBeUndefined();
  });

  test("retracts a cost-only report even before the first token snapshot", () => {
    const state = newState();
    complete(state, { costUsdTicks: 200_000_000 });
    expect(publicContextUsage(state, true)).toMatchObject({
      costUsd: 0.02,
      occupancyUnknown: true,
    });
    expect(state.usage?.turns?.[0]?.totalTokens).toBeUndefined();
    late(state, { usageIsIncomplete: true });
    expect(publicContextUsage(state, true)?.turns?.[0]).toMatchObject({ revision: 1 });
    expect(publicContextUsage(state, true)?.costUsd).toBeUndefined();
  });

  test("a successful prompt with no usage invalidates a prior total", () => {
    const state = newState();
    complete(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    startTurn(state);
    recordTurnUsage(state, { stopReason: "end_turn" }, "prompt-result");
    settleTurn(state, true);
    expect(publicContextUsage(state, true)).toMatchObject({ usedTokens: 10 });
    expect(publicContextUsage(state, true)?.costUsd).toBeUndefined();
    expect(costs(state)).toEqual([0.02, undefined]);
  });

  test("keeps a zero-token unknown turn in the cost ledger across restart", () => {
    const state = newState();
    complete(state, { totalTokens: 0, costUsdTicks: 5, costIsPartial: true });
    state.usage = restorePersistedUsage(JSON.parse(JSON.stringify(state.usage))) ?? undefined;
    expect(state.usage?.cost).toBeDefined();
    complete(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    expect(costs(state)).toEqual([undefined, 0.02]);
    expect(publicContextUsage(state, true)?.costUsd).toBeUndefined();
  });

  test("restores the known prefix and rejects malformed persisted totals", () => {
    const state = newState();
    complete(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    const snapshot = JSON.parse(JSON.stringify(state.usage));
    const restored = restorePersistedUsage(snapshot);
    expect(restored?.cost).toEqual({
      beforeLastTurn: { usd: 0 },
      total: { usd: 0, ticks: 200_000_000 },
    });
    expect(
      restorePersistedUsage({
        ...snapshot,
        cost: { total: { usd: 0, ticks: Number.MAX_SAFE_INTEGER + 1 } },
      })?.cost?.total,
    ).toBeUndefined();
    expect(
      restorePersistedUsage({
        ...snapshot,
        cost: undefined,
        lastTurnCostUsdTicks: 200_000_000,
      })?.turns?.[0]?.costUsd,
    ).toBeUndefined();
  });

  test("hydrates replay ticks without counting duplicate carriers or inventing history rows", () => {
    const state = newState();
    state.historyReplay = "hydrate";
    function replayPrompt(id: string) {
      applySessionUpdate(state, {
        sessionId: state.acpSessionId,
        update: {
          sessionUpdate: "user_message",
          messageId: id,
          content: { type: "text", text: id },
        },
      });
    }
    replayPrompt("first");
    late(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    late(state, { totalTokens: 10, costUsdTicks: 200_000_000 });
    replayPrompt("second");
    late(state, { totalTokens: 20, costUsdTicks: 300_000_000 });
    finalizeHistoryReplayTurnUsage(state);
    expect(publicContextUsage(state, true)).toMatchObject({ sessionTokens: 30, costUsd: 0.05 });
    expect(state.usage?.turns).toBeUndefined();
    replayPrompt("unpriced");
    finalizeHistoryReplayTurnUsage(state);
    expect(publicContextUsage(state, true)?.costUsd).toBeUndefined();
  });

  test.each([true, false])(
    "accounts for continued attempts (first attempt priced: %s)",
    async (firstPriced) => {
      const state = newState();
      const replies = [
        {
          ...result(firstPriced ? { inputTokens: 10, costUsdTicks: 200_000_000 } : {}),
          stopReason: "cancelled",
        },
        result({ inputTokens: 20, costUsdTicks: 300_000_000 }),
      ];
      const child = {
        request() {
          if (replies.length === 2) state.policyDeniedRequests = 1;
          return Promise.resolve(replies.shift());
        },
      } as unknown as AcpProcess;
      startTurn(state);
      state.child = child;
      sessions.set(state.id, state);
      try {
        await requestPromptWithRetriableProviderRetries(
          state,
          child,
          {},
          state.promptSequence,
          undefined,
        );
        settleTurn(state, true);
        expect(replies).toHaveLength(0);
        expect(publicContextUsage(state, true)?.costUsd).toBe(firstPriced ? 0.05 : undefined);
        late(state, { inputTokens: 20, costUsdTicks: 400_000_000 });
        expect(publicContextUsage(state, true)?.costUsd).toBe(firstPriced ? 0.06 : undefined);
        expect(costs(state)).toEqual([firstPriced ? 0.06 : undefined]);
      } finally {
        sessions.delete(state.id);
      }
    },
  );
});
