import { describe, expect, test } from "bun:test";
import { parseProjectHomeMessage } from "./project-home-message";

const message = { mailRequestId: "request-1", body: "Update the checkout." };

describe("held project-home message validation", () => {
  test("preserves the approved delivery fields", () => {
    const input = {
      ...message,
      toTabId: "agent-1",
      subject: "Update",
      replyToMessageId: "parent-1",
      deliverNow: true,
    };
    expect(parseProjectHomeMessage(input)).toEqual(input);
  });

  for (const [field, values] of [
    ["toTabId", [123, " ", "x".repeat(257)]],
    ["subject", [123, "x".repeat(201)]],
    ["replyToMessageId", [123, " ", "x".repeat(301)]],
    ["deliverNow", ["true", 1, null]],
  ] as const) {
    test(`refuses invalid ${field} instead of dropping it`, () => {
      for (const value of values)
        expect(parseProjectHomeMessage({ ...message, [field]: value })).toBeNull();
    });
  }

  test("permits absent optional fields and an empty subject", () => {
    expect(parseProjectHomeMessage(message)).toEqual(message);
    expect(parseProjectHomeMessage({ ...message, subject: "" })).toEqual(message);
  });
});
