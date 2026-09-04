import { describe, expect, test } from "bun:test";
import { createSession } from "./session-manager-core.js";
import {
  ClaudeStreamUsageAccumulator,
  inProgressClaudeUsage,
  reconcileClaudeUsage,
} from "./session-manager-usage.js";

function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { type: "stream_event", event };
}

describe("Claude streamed usage", () => {
  test("publishes only completed model calls and accumulates them once", () => {
    const accumulator = new ClaudeStreamUsageAccumulator();

    expect(
      accumulator.apply(
        streamEvent({
          type: "message_start",
          message: {
            model: "claude-opus-test",
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 90,
              cache_creation_input_tokens: 5,
            },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      accumulator.apply(streamEvent({ type: "message_delta", usage: { output_tokens: 7 } })),
    ).toBeUndefined();
    expect(
      accumulator.apply(streamEvent({ type: "content_block_stop", index: 0 })),
    ).toBeUndefined();
    expect(accumulator.apply(streamEvent({ type: "message_stop" }))).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
      latest: {
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 90,
        cacheWriteTokens: 5,
      },
      modelId: "claude-opus-test",
    });

    accumulator.apply(
      streamEvent({
        type: "message_start",
        message: { usage: { input_tokens: 20, cache_read_input_tokens: 100 } },
      }),
    );
    accumulator.apply(streamEvent({ type: "message_delta", usage: { output_tokens: 8 } }));
    expect(accumulator.apply(streamEvent({ type: "message_stop" }))).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 190,
      cacheWriteTokens: 5,
      latest: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 100 },
    });
  });

  test("projects a monotonic lower bound over the last exact session total", () => {
    const session = createSession("live usage");
    session.usage = {
      usedTokens: 80,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 65,
      cacheWriteTokens: 0,
      lastTurnTokens: 80,
      sessionTokens: 80,
      source: "claude",
      updatedAt: new Date(0).toISOString(),
    };

    const usage = inProgressClaudeUsage(session, {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      latest: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });

    expect(usage).toMatchObject({
      usedTokens: 130,
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 165,
      lastTurnTokens: 130,
      sessionTokens: 210,
      estimated: true,
      source: "claude",
    });
  });

  test("does not reuse context capacity after the streamed model changes", () => {
    const session = createSession("model switch");
    session.usage = {
      usedTokens: 80_000,
      totalTokens: 200_000,
      percentUsed: 40,
      modelId: "claude-old",
      contextCategories: [{ name: "Prompt", tokens: 80_000 }],
      sessionTokens: 80_000,
      source: "claude",
      updatedAt: new Date(0).toISOString(),
    };

    const usage = inProgressClaudeUsage(session, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latest: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      modelId: "claude-new",
    });

    expect(usage.modelId).toBe("claude-new");
    expect(usage).not.toHaveProperty("totalTokens");
    expect(usage).not.toHaveProperty("percentUsed");
    expect(usage).not.toHaveProperty("contextCategories");
  });

  test("combines terminal context metadata with the streamed token floor", () => {
    const terminal = {
      usedTokens: 120,
      totalTokens: 200_000,
      percentUsed: 0.06,
      modelId: "claude-new",
      inputTokens: 10,
      outputTokens: 5,
      lastTurnTokens: 0,
      sessionTokens: 80,
      costUsd: 1.25,
      source: "claude" as const,
      updatedAt: new Date(1).toISOString(),
    };
    const streamed = {
      usedTokens: 130,
      modelId: "claude-new",
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 165,
      cacheWriteTokens: 0,
      lastTurnTokens: 130,
      sessionTokens: 210,
      estimated: true,
      source: "claude" as const,
      updatedAt: new Date(0).toISOString(),
    };

    expect(reconcileClaudeUsage(terminal, streamed)).toMatchObject({
      usedTokens: 120,
      totalTokens: 200_000,
      modelId: "claude-new",
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 165,
      lastTurnTokens: 130,
      sessionTokens: 210,
      costUsd: 1.25,
      estimated: true,
    });
  });
});
