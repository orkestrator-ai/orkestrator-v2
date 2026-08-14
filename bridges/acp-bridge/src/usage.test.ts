import { describe, expect, test } from "bun:test";
import { acpContextUsage, parseAcpTurnUsage } from "./usage.js";

const UPDATED_AT = "2026-08-14T18:00:00.000Z";

describe("parseAcpTurnUsage", () => {
  test("reads the camelCase breakdown Grok sends with turn_completed", () => {
    expect(parseAcpTurnUsage({
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
    })).toEqual({
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
    expect(parseAcpTurnUsage({
      usage: {
        input_tokens: 9_751,
        output_tokens: 36,
        cache_read_input_tokens: 5_888,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 31,
      },
    })).toEqual({
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
    expect(parseAcpTurnUsage({
      totalTokens: 1,
      inputTokens: 2,
      usage: { totalTokens: 15_675, inputTokens: 15_639, outputTokens: 36 },
    })).toEqual({ totalTokens: 15_675, inputTokens: 15_639, outputTokens: 36 });
  });

  test("falls back to flattened fields when there is no nested usage", () => {
    expect(parseAcpTurnUsage({ totalTokens: 15_675, modelId: "grok-4.6" }))
      .toEqual({ totalTokens: 15_675 });
  });

  test("reports nothing for a payload without token counts", () => {
    // Cursor's prompt result. A zeroed snapshot here would render as a usage
    // meter claiming a measurement the agent never made.
    expect(parseAcpTurnUsage({ stopReason: "end_turn" })).toBeNull();
    expect(parseAcpTurnUsage(undefined)).toBeNull();
    expect(parseAcpTurnUsage("15675")).toBeNull();
  });

  test("rejects counts that are not finite, non-negative numbers", () => {
    expect(parseAcpTurnUsage({
      totalTokens: Number.NaN,
      inputTokens: -1,
      outputTokens: "36",
      reasoningTokens: 1e15,
      cachedReadTokens: 5_888,
    })).toEqual({ cacheReadTokens: 5_888 });
  });
});

describe("acpContextUsage", () => {
  test("projects a full turn onto the neutral snapshot", () => {
    expect(acpContextUsage({
      totalTokens: 15_675,
      inputTokens: 15_639,
      outputTokens: 36,
      cacheReadTokens: 5_888,
      reasoningTokens: 31,
      apiDurationMs: 1_448,
    }, { modelId: "grok-4.6", durationMs: 3_200, updatedAt: UPDATED_AT })).toEqual({
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
    expect(acpContextUsage(
      { inputTokens: 9_751, outputTokens: 36 },
      { updatedAt: UPDATED_AT },
    )).toMatchObject({ usedTokens: 9_787 });
  });

  test("reports nothing when no token count survived parsing", () => {
    expect(acpContextUsage({ apiDurationMs: 1_448 }, { updatedAt: UPDATED_AT })).toBeNull();
  });

  test("omits cost entirely", () => {
    // Grok reports `costUsdTicks` without documenting the tick. A dollar figure
    // derived from a guessed scale is indistinguishable from a correct one.
    const usage = acpContextUsage({ totalTokens: 15_675 }, { updatedAt: UPDATED_AT });
    expect(usage).not.toBeNull();
    expect(usage).not.toHaveProperty("costUsd");
  });
});
