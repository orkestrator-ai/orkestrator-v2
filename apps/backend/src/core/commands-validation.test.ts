import { describe, expect, test } from "bun:test";
import {
  MAX_EXECUTION_PROFILE_ID_LENGTH,
  asNativeAgentControlUpdate,
} from "./commands-validation.js";

describe("asNativeAgentControlUpdate", () => {
  test("accepts an ordinary execution profile id", () => {
    expect(asNativeAgentControlUpdate({ executionProfileId: "plan" }))
      .toEqual({ executionProfileId: "plan" });
  });

  test("trims an execution profile id before measuring it", () => {
    expect(asNativeAgentControlUpdate({ executionProfileId: "  reviewer  " }))
      .toEqual({ executionProfileId: "reviewer" });
    // Padding must not count towards the bound, or a legal id becomes illegal
    // purely by how the client serialised it.
    const padded = ` ${"a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH)} `;
    expect(asNativeAgentControlUpdate({ executionProfileId: padded }))
      .toEqual({ executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH) });
  });

  test("keeps an explicit null, which clears the stored selection", () => {
    expect(asNativeAgentControlUpdate({ executionProfileId: null }))
      .toEqual({ executionProfileId: null });
  });

  test("rejects a blank execution profile id", () => {
    expect(() => asNativeAgentControlUpdate({ executionProfileId: "   " }))
      .toThrow("Expected executionProfileId to be a non-blank string");
  });

  test("bounds the execution profile id length", () => {
    // The id is persisted to the sessions file and forwarded verbatim as the
    // provider's `agent` name, and the empty-listing branch accepts it without
    // a list to check against, so the length bound is the only thing between a
    // client and an arbitrarily large stored value.
    expect(asNativeAgentControlUpdate({
      executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH),
    })).toEqual({
      executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH),
    });
    expect(() => asNativeAgentControlUpdate({
      executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH + 1),
    })).toThrow(
      `Expected executionProfileId to be at most ${MAX_EXECUTION_PROFILE_ID_LENGTH} characters`,
    );
  });

  test("rejects an unknown field rather than dropping it", () => {
    expect(() => asNativeAgentControlUpdate({ nope: true }))
      .toThrow("Native agent control update has unknown fields");
  });

  test("rejects an empty update", () => {
    expect(() => asNativeAgentControlUpdate({}))
      .toThrow("Native agent control update must not be empty");
  });
});
