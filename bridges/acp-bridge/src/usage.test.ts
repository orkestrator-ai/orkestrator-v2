import { describe, expect, test } from "bun:test";
import { acpContextUsage, parseAcpTurnUsage } from "./usage.js";

const UPDATED_AT = "2026-08-14T18:00:00.000Z";

describe("parseAcpTurnUsage", () => {
  test("reads the camelCase breakdown Grok sends with turn_completed", () => {
    expect(
      parseAcpTurnUsage({
        sessionUpdate: "turn_completed",
        usage: {
          inputTokens: 15_639,
          outputTokens: 36,
          totalTokens: 15_675,
          cachedReadTokens: 5_888,
          cacheCreationTokens: 0,
          reasoningTokens: 31,
          modelCalls: 1,
          apiDurationMs: 1_448,
          costUsdTicks: 226_620_000,
        },
      }),
    ).toEqual({
      totalTokens: 15_675,
      inputTokens: 15_639,
      outputTokens: 36,
      cacheReadTokens: 5_888,
      cacheWriteTokens: 0,
      reasoningTokens: 31,
      apiDurationMs: 1_448,
    });
  });

  test("reads the snake_case spelling response_completed uses instead", () => {
    expect(
      parseAcpTurnUsage({
        usage: {
          input_tokens: 9_751,
          output_tokens: 36,
          cache_read_input_tokens: 5_888,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 31,
        },
      }),
    ).toEqual({
      inputTokens: 9_751,
      outputTokens: 36,
      cacheReadTokens: 5_888,
      cacheWriteTokens: 0,
      reasoningTokens: 31,
    });
  });

  test("prefers the nested usage object over the flattened copy beside it", () => {
    // The prompt result `_meta` carries both. They agree in practice, but the
    // nested object is the one that carries the full breakdown.
    expect(
      parseAcpTurnUsage({
        totalTokens: 1,
        inputTokens: 2,
        usage: { totalTokens: 15_675, inputTokens: 15_639, outputTokens: 36 },
      }),
    ).toEqual({ totalTokens: 15_675, inputTokens: 15_639, outputTokens: 36 });
  });

  test("falls back to flattened fields when there is no nested usage", () => {
    expect(parseAcpTurnUsage({ totalTokens: 15_675, modelId: "grok-4.6" })).toEqual({
      totalTokens: 15_675,
    });
  });

  test("reports nothing for a payload without token counts", () => {
    // Cursor's prompt result today. A zeroed snapshot here would render as a
    // usage meter claiming a measurement the agent never made.
    expect(parseAcpTurnUsage({ stopReason: "end_turn" })).toBeNull();
    expect(parseAcpTurnUsage(undefined)).toBeNull();
    expect(parseAcpTurnUsage("15675")).toBeNull();
  });

  test("reads ACP PromptResponse.usage, including thoughtTokens", () => {
    expect(
      parseAcpTurnUsage({
        stopReason: "end_turn",
        usage: {
          totalTokens: 12_345,
          inputTokens: 10_000,
          outputTokens: 2_000,
          thoughtTokens: 300,
          cachedReadTokens: 5_000,
          cachedWriteTokens: 45,
        },
      }),
    ).toEqual({
      totalTokens: 12_345,
      inputTokens: 10_000,
      outputTokens: 2_000,
      reasoningTokens: 300,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 45,
    });
  });

  test("reads occupancy and USD cost from an ACP usage_update", () => {
    expect(
      parseAcpTurnUsage({
        sessionUpdate: "usage_update",
        used: 15_675,
        size: 200_000,
        cost: { amount: 0.042, currency: "USD" },
      }),
    ).toEqual({
      contextUsedTokens: 15_675,
      contextWindow: 200_000,
      costUsd: 0.042,
    });
  });

  test("does not treat a generic used/size pair as occupancy", () => {
    expect(parseAcpTurnUsage({ used: 10, size: 100 })).toBeNull();
  });

  test("reads occupancy when the update uses type instead of sessionUpdate", () => {
    expect(
      parseAcpTurnUsage({
        type: "usage_update",
        used: 15_675,
        size: 200_000,
      }),
    ).toEqual({
      contextUsedTokens: 15_675,
      contextWindow: 200_000,
    });
  });

  test("reads ACP v2 idle state_update.usage, including thoughtTokens", () => {
    expect(
      parseAcpTurnUsage({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: {
          totalTokens: 8_000,
          inputTokens: 7_000,
          outputTokens: 1_000,
          thoughtTokens: 50,
          cachedReadTokens: 4_000,
          cachedWriteTokens: 20,
        },
      }),
    ).toEqual({
      totalTokens: 8_000,
      inputTokens: 7_000,
      outputTokens: 1_000,
      reasoningTokens: 50,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 20,
    });
  });

  test("reports nothing for a running state_update without usage", () => {
    expect(
      parseAcpTurnUsage({
        sessionUpdate: "state_update",
        state: "running",
      }),
    ).toBeNull();
  });

  test("reads a running state_update that already carries part of the count", () => {
    // `state` is deliberately not a gate. A turn may report its cache split
    // while it is still running and the rest of the breakdown when it settles,
    // and the caller merges the two; refusing the first report would lose the
    // fields the second one never repeats.
    expect(
      parseAcpTurnUsage({
        sessionUpdate: "state_update",
        state: "running",
        usage: { cachedWriteTokens: 20 },
      }),
    ).toEqual({ cacheWriteTokens: 20 });
  });

  test("ignores a usage_update cost that is not USD", () => {
    expect(
      parseAcpTurnUsage({
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 12, currency: "EUR" },
      }),
    ).toEqual({
      contextUsedTokens: 10,
      contextWindow: 100,
    });
  });

  test("merges PromptResponse.usage over the Grok _meta copy beside it", () => {
    expect(
      parseAcpTurnUsage({
        stopReason: "end_turn",
        usage: { totalTokens: 222, inputTokens: 200, outputTokens: 22 },
        _meta: { totalTokens: 15_675, usage: { inputTokens: 15_639, outputTokens: 36 } },
      }),
    ).toEqual({
      totalTokens: 222,
      inputTokens: 200,
      outputTokens: 22,
    });
  });

  test("still reads Grok usage when the whole PromptResponse is passed", () => {
    expect(
      parseAcpTurnUsage({
        stopReason: "end_turn",
        _meta: { totalTokens: 15_675, usage: { inputTokens: 15_639, outputTokens: 36 } },
      }),
    ).toEqual({
      totalTokens: 15_675,
      inputTokens: 15_639,
      outputTokens: 36,
    });
  });

  test("round-trips persisted occupancy fields under their stored names", () => {
    expect(
      parseAcpTurnUsage({
        contextUsedTokens: 15_675,
        contextWindow: 200_000,
        costUsd: 0.042,
        inputTokens: 10_000,
      }),
    ).toEqual({
      contextUsedTokens: 15_675,
      contextWindow: 200_000,
      costUsd: 0.042,
      inputTokens: 10_000,
    });
  });

  test("rejects counts that are not finite, non-negative numbers", () => {
    expect(
      parseAcpTurnUsage({
        totalTokens: Number.NaN,
        inputTokens: -1,
        outputTokens: "36",
        reasoningTokens: 1e15,
        cachedReadTokens: 5_888,
      }),
    ).toEqual({ cacheReadTokens: 5_888 });
  });
});

describe("acpContextUsage", () => {
  test("projects a full turn onto the neutral snapshot", () => {
    expect(
      acpContextUsage(
        {
          totalTokens: 15_675,
          inputTokens: 15_639,
          outputTokens: 36,
          cacheReadTokens: 5_888,
          reasoningTokens: 31,
          apiDurationMs: 1_448,
        },
        { modelId: "grok-4.6", durationMs: 3_200, updatedAt: UPDATED_AT },
      ),
    ).toEqual({
      usedTokens: 15_675,
      inputTokens: 15_639,
      outputTokens: 36,
      cacheReadTokens: 5_888,
      reasoningTokens: 31,
      apiDurationMs: 1_448,
      durationMs: 3_200,
      modelId: "grok-4.6",
      source: "provider",
      updatedAt: UPDATED_AT,
    });
  });

  test("derives the total from the input and output when it is not reported", () => {
    expect(
      acpContextUsage({ inputTokens: 9_751, outputTokens: 36 }, { updatedAt: UPDATED_AT }),
    ).toMatchObject({ usedTokens: 9_787 });
  });

  test("reports nothing when no token count survived parsing", () => {
    expect(acpContextUsage({ apiDurationMs: 1_448 }, { updatedAt: UPDATED_AT })).toBeNull();
  });

  test("omits Grok costUsdTicks", () => {
    // Grok reports `costUsdTicks` without documenting the tick. A dollar figure
    // derived from a guessed scale is indistinguishable from a correct one.
    const usage = acpContextUsage({ totalTokens: 15_675 }, { updatedAt: UPDATED_AT });
    expect(usage).not.toBeNull();
    expect(usage).not.toHaveProperty("costUsd");
  });

  test("uses usage_update occupancy as the context meter, with the window as denominator", () => {
    expect(
      acpContextUsage(
        {
          contextUsedTokens: 15_675,
          contextWindow: 200_000,
          inputTokens: 10_000,
          outputTokens: 2_000,
          costUsd: 0.042,
        },
        { updatedAt: UPDATED_AT },
      ),
    ).toEqual({
      usedTokens: 15_675,
      maximumTokens: 200_000,
      percentage: 7.8375,
      inputTokens: 10_000,
      outputTokens: 2_000,
      costUsd: 0.042,
      source: "provider",
      updatedAt: UPDATED_AT,
    });
  });

  test("does not invent a context window from a zero size", () => {
    const usage = acpContextUsage(
      { contextUsedTokens: 10, contextWindow: 0 },
      { updatedAt: UPDATED_AT },
    );
    expect(usage).toMatchObject({ usedTokens: 10 });
    expect(usage).not.toHaveProperty("maximumTokens");
    expect(usage).not.toHaveProperty("percentage");
  });
});
