import { describe, expect, test } from "bun:test";
import { openCodeContextUsage } from "./opencode-usage.js";

describe("openCodeContextUsage", () => {
  test("keeps message totals and maps step-finish accounting into bounded turn rows", () => {
    const messages = Array.from({ length: 22 }, (_, index) => ({
      info: {
        id: `message-${index}`,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: {
          input: 10,
          output: 2,
          reasoning: 1,
          cache: { read: 3, write: 4 },
        },
        cost: 0.01,
        time: { created: index * 10, completed: index * 10 + 5 },
      },
      parts: [
        {
          id: `step-${index}`,
          messageID: `message-${index}`,
          type: "step-finish",
          cost: 0.005,
          tokens: {
            input: 5,
            output: 1,
            reasoning: 1,
            cache: { read: 2, write: 3 },
          },
        },
      ],
    }));

    const usage = openCodeContextUsage(messages);

    expect(usage).toMatchObject({
      usedTokens: 15,
      inputTokens: 220,
      outputTokens: 44,
      cacheReadTokens: 66,
      cacheWriteTokens: 88,
      reasoningTokens: 22,
      sessionTokens: 418,
      durationMs: 110,
      source: "opencode",
    });
    expect(usage?.costUsd).toBeCloseTo(0.22);
    expect(usage?.turns).toHaveLength(20);
    expect(usage?.turns?.[0]).toMatchObject({ turnId: "step-2", totalTokens: 11 });
    expect(usage?.turns?.at(-1)).toEqual({
      turnId: "step-21",
      costUsd: 0.005,
      inputTokens: 5,
      outputTokens: 1,
      reasoningTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalTokens: 11,
      modelId: "openai/gpt-5",
    });
  });

  test("derives updatedAt from the transcript so unchanged reads are byte-stable", () => {
    const messages = [
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          tokens: { input: 7, output: 3, cache: { read: 1, write: 0 } },
          time: { created: 1_000, completed: 1_500 },
        },
        parts: [],
      },
    ];

    const first = openCodeContextUsage(messages);
    const second = openCodeContextUsage(messages);

    expect(first?.updatedAt).toBe(new Date(1_500).toISOString());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("omits updatedAt when the transcript carries no usable timestamp", () => {
    const usage = openCodeContextUsage([
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          tokens: { input: 7, output: 3 },
        },
        parts: [],
      },
    ]);

    expect(usage).toMatchObject({ usedTokens: 10, source: "opencode" });
    expect(usage?.updatedAt).toBeUndefined();
  });
});
