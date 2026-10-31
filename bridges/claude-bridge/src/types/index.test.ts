import { describe, expect, test } from "bun:test";

import type { SdkMessageBase, SdkResultMessage } from "./index";
import { isSdkResultMessage } from "./index";

// This guard stands between the SDK's untyped message stream and the branch
// that builds the authoritative usage snapshot. A guard that is too loose
// routes an unrelated message into that branch; one that is too tight silently
// drops the turn's result. Both directions are asserted.

describe("isSdkResultMessage", () => {
  test("accepts a successful result and narrows to its usage fields", () => {
    const message: SdkMessageBase = {
      type: "result",
      subtype: "success",
      uuid: "r-1",
      total_cost_usd: 0.25,
      duration_ms: 1_200,
      user_message_uuid: "00000000-0000-4000-8000-000000000001",
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 5,
          outputTokens: 200,
          cacheReadInputTokens: 120_000,
          contextWindow: 200_000,
        },
      },
    } as SdkResultMessage;

    expect(isSdkResultMessage(message)).toBe(true);
    if (!isSdkResultMessage(message)) throw new Error("guard should narrow");
    expect(message.total_cost_usd).toBe(0.25);
    expect(message.modelUsage?.["claude-opus-5"]?.cacheReadInputTokens).toBe(120_000);
    // The link a fork boundary and a file rewind are resolved through.
    expect(message.user_message_uuid).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("accepts every error subtype the bridge branches on", () => {
    for (const subtype of [
      "error_max_turns",
      "error_during_execution",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
      "some_future_subtype",
    ]) {
      expect(isSdkResultMessage({ type: "result", subtype })).toBe(true);
    }
  });

  test("accepts a result with no subtype at all", () => {
    expect(isSdkResultMessage({ type: "result" })).toBe(true);
  });

  const rejected: Array<{ name: string; message: SdkMessageBase }> = [
    { name: "an assistant message", message: { type: "assistant" } },
    { name: "a compact boundary", message: { type: "system", subtype: "compact_boundary" } },
    { name: "a rate limit event", message: { type: "rate_limit_event" } },
    { name: "a stream event", message: { type: "stream_event" } },
    {
      name: "a message whose subtype merely looks like a result",
      message: { type: "system", subtype: "success" },
    },
  ];

  for (const { name, message } of rejected) {
    test(`rejects ${name}`, () => {
      expect(isSdkResultMessage(message)).toBe(false);
    });
  }
});
