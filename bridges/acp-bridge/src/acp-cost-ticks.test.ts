import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import type { SessionState } from "./acp-context.js";
import { restorePersistedUsage } from "./acp-persistence.js";
import { publicContextUsage } from "./acp-public.js";
import { finalizeTurnUsage, recordTurnUsage } from "./acp-session.js";

/**
 * Grok's `costUsdTicks` through the session: each turn's row carries that
 * turn's own cost, the panel's `costUsd` carries the session total, and an
 * explicit USD figure wins over both. See `usage.ts` for the evidence that
 * the ticks are per prompt.
 */

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
    revision: 0,
    sessionConfig: { composer: {} },
    currentTurnOutput: null,
  } as unknown as SessionState;
}

/** One turn as the HTTP handler drives it: start, carriers, finalize, clear. */
function runTurn(state: SessionState, carriers: unknown[]): void {
  state.promptSequence += 1;
  state.turnStartedAt = Date.now();
  state.currentTurnUsage = {};
  state.currentAttemptUsage = {};
  state.completedAttemptUsage = undefined;
  state.currentTurnRequestId = `request-${state.promptSequence}`;
  for (const carrier of carriers) recordTurnUsage(state, carrier);
  finalizeTurnUsage(state);
  state.turnStartedAt = undefined;
  state.currentTurnUsage = undefined;
  state.currentAttemptUsage = undefined;
  state.completedAttemptUsage = undefined;
  state.currentTurnRequestId = undefined;
}

/** What Grok sends for one prompt: `turn_completed`, then the prompt result. */
function grokTurn(totalTokens: number, costUsdTicks: number, extra: Record<string, unknown> = {}) {
  const usage = { totalTokens, inputTokens: totalTokens - 10, outputTokens: 10, modelCalls: 1 };
  return [
    { sessionUpdate: "turn_completed", usage: { ...usage, costUsdTicks, ...extra } },
    { stopReason: "end_turn", _meta: { usage: { ...usage, costUsdTicks, ...extra } } },
  ];
}

describe("Grok ticks across a session", () => {
  test("each row has its own turn's cost and the panel shows their sum", () => {
    const state = newState();
    runTurn(state, grokTurn(15_675, 226_620_000));
    runTurn(state, grokTurn(80_000, 1_250_000_000));

    expect(state.usage?.turns?.map((turn) => [turn.costUsd, turn.costSource])).toEqual([
      [0.022662, "provider"],
      [0.125, "provider"],
    ]);
    expect(state.usage).toMatchObject({
      sessionTokens: 95_675,
      lastTurnCostUsdTicks: 1_250_000_000,
      sessionCostUsdTicks: 1_476_620_000,
    });
    const usage = publicContextUsage(state);
    expect(usage?.costUsd).toBeCloseTo(0.147662, 12);
    expect(usage?.costSource).toBe("provider");
  });

  test("a partial turn shows no cost and leaves the session total unknown", () => {
    const state = newState();
    runTurn(state, grokTurn(100, 1_000));
    runTurn(state, grokTurn(200, 2_000, { costIsPartial: true }));
    runTurn(state, grokTurn(300, 3_000));

    expect(state.usage?.turns?.map((turn) => turn.costUsd)).toEqual([
      1_000 / 1e10,
      undefined,
      3_000 / 1e10,
    ]);
    expect(state.usage?.sessionCostUsdTicks).toBeUndefined();
    expect(publicContextUsage(state)).not.toHaveProperty("costUsd");
  });

  test("a turn with tokens but no ticks leaves the session total unknown", () => {
    const state = newState();
    runTurn(state, [{ stopReason: "end_turn", usage: { totalTokens: 40 } }]);
    runTurn(state, grokTurn(100, 1_000));

    expect(state.usage?.turns?.at(-1)?.costUsd).toBe(1_000 / 1e10);
    expect(state.usage?.sessionCostUsdTicks).toBeUndefined();
    expect(publicContextUsage(state)).not.toHaveProperty("costUsd");
  });

  test("an explicit USD session cost takes precedence over ticks", () => {
    const state = newState();
    runTurn(state, [
      ...grokTurn(100, 1_000),
      {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1_000,
        cost: { amount: 0.5, currency: "USD" },
      },
    ]);

    expect(state.usage?.turns?.[0]).toMatchObject({ costUsd: 0.5, costSource: "provider" });
    expect(publicContextUsage(state)).toMatchObject({ costUsd: 0.5, costSource: "provider" });
  });

  test("a late repeat of the last turn's carrier does not count its ticks twice", () => {
    const state = newState();
    runTurn(state, grokTurn(100, 1_000));
    runTurn(state, grokTurn(200, 2_000));
    recordTurnUsage(state, grokTurn(200, 2_000)[0]);

    expect(state.usage).toMatchObject({
      sessionTokens: 300,
      lastTurnCostUsdTicks: 2_000,
      sessionCostUsdTicks: 3_000,
    });
  });

  test("the tick totals survive a restart", () => {
    const state = newState();
    runTurn(state, grokTurn(100, 1_000));
    const restored = restorePersistedUsage(JSON.parse(JSON.stringify(state.usage)));

    expect(restored).toMatchObject({
      turn: { costUsdTicks: 1_000 },
      lastTurnCostUsdTicks: 1_000,
      sessionCostUsdTicks: 1_000,
    });
    expect(restored?.turns?.[0]).toMatchObject({ costUsd: 1_000 / 1e10, costSource: "provider" });
    expect(
      restorePersistedUsage({
        ...JSON.parse(JSON.stringify(state.usage)),
        sessionCostUsdTicks: -5,
        lastTurnCostUsdTicks: 1.5,
      }),
    ).not.toHaveProperty("sessionCostUsdTicks");
  });
});
