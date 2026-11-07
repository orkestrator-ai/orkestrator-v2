import { describe, expect, test } from "bun:test";
import {
  MAX_LEDGER_MESSAGES,
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
      // OpenCode prices each response from its models.dev catalogue.
      costSource: "estimate",
      source: "opencode",
    });
    expect(usage?.costUsd).toBeCloseTo(0.22);
    expect(usage?.turns).toHaveLength(20);
    expect(usage?.turns?.[0]).toMatchObject({ turnId: "step-2", totalTokens: 11 });
    expect(usage?.turns?.at(-1)).toEqual({
      turnId: "step-21",
      costUsd: 0.005,
      costSource: "estimate",
      inputTokens: 5,
      outputTokens: 1,
      reasoningTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalTokens: 11,
      modelId: "openai/gpt-5",
    });
  });

  test("leaves a GitHub Copilot cost's source unknown", () => {
    // OpenCode reports Copilot's own `totalNanoAiu` when the response carries
    // it and a catalogue estimate otherwise; a message cannot say which.
    const copilot = (id: string, providerID: string) => ({
      info: {
        id,
        role: "assistant",
        providerID,
        modelID: "gpt-5",
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.01,
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: `step-${id}`,
          messageID: id,
          type: "step-finish",
          cost: 0.01,
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    });
    const onlyCopilot = openCodeContextUsage([copilot("c1", "github-copilot")]);
    expect(onlyCopilot?.costUsd).toBe(0.01);
    expect(onlyCopilot).not.toHaveProperty("costSource");
    expect(onlyCopilot?.turns?.[0]).not.toHaveProperty("costSource");

    // Any estimated part still makes the session's total an estimate.
    const mixed = openCodeContextUsage([
      copilot("c1", "github-copilot-enterprise"),
      copilot("o1", "openai"),
    ]);
    expect(mixed?.costSource).toBe("estimate");
    expect(mixed?.turns?.map((turn) => turn.costSource)).toEqual([undefined, "estimate"]);
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
      // The lifetime total remembers it is made of estimates once they have
      // left the window too.
      costSource: "estimate",
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
    recordOpenCodeUsageMessages(ledger, [
      assistantMessage("a", { input: 0, cacheRead: 0, cost: 0 }),
    ]);

    expect(openCodeContextUsageFromLedger(ledger, [])).toMatchObject({
      inputTokens: 80,
      cacheReadTokens: 20,
      sessionTokens: 100,
    });
  });

  test("replaying more than the ledger bound does not double-count retired ids", () => {
    const ledger = createOpenCodeUsageLedger();
    const messages = Array.from({ length: MAX_LEDGER_MESSAGES + 8 }, (_, index) =>
      assistantMessage(`message-${index}`, { input: 1 }),
    );
    recordOpenCodeUsageMessages(ledger, messages);
    const first = openCodeContextUsageFromLedger(ledger, []);
    recordOpenCodeUsageMessages(ledger, messages);
    const second = openCodeContextUsageFromLedger(ledger, []);

    expect(first).toMatchObject({
      inputTokens: MAX_LEDGER_MESSAGES + 8,
      sessionTokens: MAX_LEDGER_MESSAGES + 8,
    });
    expect(second).toEqual(first);
  });

  test("a late update to a retired message id does not charge it again", () => {
    const ledger = createOpenCodeUsageLedger();
    const messages = Array.from({ length: MAX_LEDGER_MESSAGES + 1 }, (_, index) =>
      assistantMessage(`message-${index}`, { input: 1 }),
    );
    recordOpenCodeUsageMessages(ledger, messages);
    const first = openCodeContextUsageFromLedger(ledger, []);
    recordOpenCodeUsageMessages(ledger, [assistantMessage("message-0", { input: 9, cost: 1 })]);

    expect(openCodeContextUsageFromLedger(ledger, [])).toEqual(first);
  });

  test("keeps incremental totals after filling the live ledger window", () => {
    const ledger = createOpenCodeUsageLedger();
    const messages = Array.from({ length: MAX_LEDGER_MESSAGES }, (_, index) =>
      assistantMessage(`message-${index}`, { input: 2, cacheRead: 1, cost: 0.01 }),
    );
    recordOpenCodeUsageMessages(ledger, messages);
    const first = openCodeContextUsageFromLedger(ledger, []);
    recordOpenCodeUsageMessages(ledger, messages);

    expect(first).toMatchObject({
      inputTokens: MAX_LEDGER_MESSAGES * 2,
      cacheReadTokens: MAX_LEDGER_MESSAGES,
      sessionTokens: MAX_LEDGER_MESSAGES * 3,
    });
    expect(first?.costUsd).toBeCloseTo(MAX_LEDGER_MESSAGES * 0.01);
    expect(openCodeContextUsageFromLedger(ledger, [])).toEqual(first);
  });

  test("omits updatedAt instead of throwing when a timestamp is outside the Date range", () => {
    const ledger = createOpenCodeUsageLedger();
    recordOpenCodeUsageMessages(ledger, [
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          tokens: { input: 7, output: 3 },
          time: { created: 1, completed: 1e18 },
        },
        parts: [],
      },
    ]);

    const usage = openCodeContextUsageFromLedger(ledger, []);
    expect(usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      sessionTokens: 10,
    });
    expect(usage?.updatedAt).toBeUndefined();
    expect(openCodeContextUsageFromLedger(ledger, [])).toEqual(usage);
  });
});
