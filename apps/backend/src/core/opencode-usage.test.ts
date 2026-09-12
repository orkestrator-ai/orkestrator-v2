import { describe, expect, test } from "bun:test";
import {
  createOpenCodeUsageLedger,
  openCodeContextUsage,
  openCodeContextUsageFromLedger,
  recordOpenCodeUsageMessages,
} from "./opencode-usage.js";

function assistantMessage(
  id: string,
  tokens: { input: number; output?: number; cacheRead?: number; cost?: number },
) {
  return {
    info: {
      id,
      role: "assistant",
      tokens: {
        input: tokens.input,
        output: tokens.output ?? 0,
        cache: { read: tokens.cacheRead ?? 0, write: 0 },
      },
      cost: tokens.cost ?? 0,
      time: { created: 1, completed: 2 },
    },
    parts: [],
  };
}

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

  test("keeps lifetime session and cache totals after earlier messages leave the window", () => {
    const ledger = createOpenCodeUsageLedger();
    const earlier = [
      assistantMessage("a", { input: 100, cacheRead: 1_000, cost: 0.2 }),
      assistantMessage("b", { input: 50, cacheRead: 2_000, cost: 0.1 }),
    ];
    recordOpenCodeUsageMessages(ledger, earlier);

    const laterWindow = [assistantMessage("c", { input: 10, cacheRead: 500, cost: 0.05 })];
    recordOpenCodeUsageMessages(ledger, laterWindow);
    const usage = openCodeContextUsageFromLedger(ledger, laterWindow);

    expect(usage).toMatchObject({
      usedTokens: 510,
      inputTokens: 160,
      cacheReadTokens: 3_500,
      sessionTokens: 3_660,
      source: "opencode",
    });
    expect(usage?.costUsd).toBeCloseTo(0.35);
    expect(openCodeContextUsage(laterWindow)?.sessionTokens).toBe(510);
  });

  test("does not let an in-flight zero snapshot erase a completed message", () => {
    const ledger = createOpenCodeUsageLedger();
    recordOpenCodeUsageMessages(ledger, [
      assistantMessage("a", { input: 80, cacheRead: 20, cost: 0.4 }),
    ]);
    recordOpenCodeUsageMessages(ledger, [assistantMessage("a", { input: 0, cacheRead: 0, cost: 0 })]);

    expect(openCodeContextUsageFromLedger(ledger, [])).toMatchObject({
      inputTokens: 80,
      cacheReadTokens: 20,
      sessionTokens: 100,
    });
  });
});
