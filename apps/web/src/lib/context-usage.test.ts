import { describe, expect, test } from "bun:test";
import { extractContextUsage } from "./context-usage";

describe("context-usage extractContextUsage", () => {
  test("extracts usage from nested contextUsage payload", () => {
    const payload = {
      type: "session.updated",
      model: "anthropic/claude-sonnet-4",
      contextUsage: {
        usedTokens: 12_500,
        totalContextTokens: 200_000,
      },
    };

    const result = extractContextUsage(payload);

    expect(result).toEqual({
      usedTokens: 12_500,
      totalTokens: 200_000,
      percentUsed: 6.25,
      modelId: "anthropic/claude-sonnet-4",
    });
  });

  test("parses shorthand token values and falls back to input/output token sums", () => {
    const payload = {
      usage: {
        input_tokens: "2.5k",
        output_tokens: 500,
        max_tokens: "10k",
        model_id: "openai/gpt-5",
      },
    };

    const result = extractContextUsage(payload);

    expect(result).toEqual({
      usedTokens: 3_000,
      totalTokens: 10_000,
      percentUsed: 30,
      modelId: "openai/gpt-5",
    });
  });

  test("returns null for invalid candidates where used exceeds total", () => {
    const payload = {
      contextUsage: {
        usedTokens: 12_000,
        totalTokens: 10_000,
      },
    };

    expect(extractContextUsage(payload)).toBeNull();
  });
});
