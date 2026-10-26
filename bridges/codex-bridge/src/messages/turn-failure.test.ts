import { describe, expect, test } from "bun:test";
import { MAX_TURN_FAILURE_CHARS, turnFailureItemId, turnFailureText } from "./turn-failure.js";

describe("turn failure text", () => {
  test("takes the provider's sentence out of a JSON error body", () => {
    expect(
      turnFailureText(
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
      ),
    ).toBe("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.");
    expect(turnFailureText('{"message":"rate limited"}')).toBe("rate limited");
  });

  test("shows anything else as it came, bounded", () => {
    expect(turnFailureText("  stream disconnected  ")).toBe("stream disconnected");
    expect(turnFailureText("{not json")).toBe("{not json");
    expect(turnFailureText("")).toBe("Codex ended the turn on an error.");
    expect(turnFailureText("x".repeat(MAX_TURN_FAILURE_CHARS * 2))).toHaveLength(
      MAX_TURN_FAILURE_CHARS,
    );
  });

  test("one id per turn", () => {
    expect(turnFailureItemId("turn-1")).toBe("turn-error:turn-1");
  });
});
