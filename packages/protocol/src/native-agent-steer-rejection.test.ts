import { describe, expect, test } from "bun:test";
import {
  MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS,
  NATIVE_AGENT_STEER_REJECTION_REASONS,
  boundNativeAgentSteerRejectionMessage,
  isNativeAgentSteerRejectedOutcome,
  isNativeAgentSteerRejectionReason,
  normalizeNativeAgentRuntimeSteerJournal,
  nativeAgentSteerRejectionMessage,
  parseNativeAgentSteerRejection,
  type NativeAgentSessionActionOutcome,
} from "./native-agent";

const body = {
  outcome: "rejected",
  reason: "steer-capacity-exceeded",
  requestId: "steer-1",
  message: "Wait for this turn to finish, then send again.",
};

describe("native agent steer rejection", () => {
  test("accepts only the verified 429 shape for the same request", () => {
    expect(parseNativeAgentSteerRejection(429, body, "steer-1")).toEqual({
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "steer-1",
      message: "Wait for this turn to finish, then send again.",
    });
    expect(
      parseNativeAgentSteerRejection(
        429,
        { ...body, reason: "steer-history-unavailable", message: undefined },
        "steer-1",
      ),
    ).toEqual({ outcome: "rejected", reason: "steer-history-unavailable", requestId: "steer-1" });
    expect(
      parseNativeAgentSteerRejection(429, { ...body, reason: "steer-not-recorded" }, "steer-1"),
    ).toEqual({
      outcome: "rejected",
      reason: "steer-not-recorded",
      requestId: "steer-1",
      message: body.message,
    });
  });

  test("an unrecorded steer is definitive only on the verified 429 shape", () => {
    const notRecorded = { ...body, reason: "steer-not-recorded" };
    expect(parseNativeAgentSteerRejection(503, notRecorded, "steer-1")).toBeUndefined();
    expect(parseNativeAgentSteerRejection(500, notRecorded, "steer-1")).toBeUndefined();
    expect(parseNativeAgentSteerRejection(429, notRecorded, "steer-2")).toBeUndefined();
    // The bridge's conservative answer for a fenced run without a record.
    expect(
      parseNativeAgentSteerRejection(503, { outcome: "unknown", requestId: "steer-1" }, "steer-1"),
    ).toBeUndefined();
  });

  test.each([
    ["a non-429 status", 409, body, "steer-1"],
    ["a 503", 503, body, "steer-1"],
    ["a 200", 200, body, "steer-1"],
    ["a different request id", 429, body, "steer-2"],
    ["a missing request id", 429, { ...body, requestId: undefined }, "steer-1"],
    ["an unknown reason", 429, { ...body, reason: "rate-limited" }, "steer-1"],
    ["a missing reason", 429, { ...body, reason: undefined }, "steer-1"],
    ["another outcome", 429, { ...body, outcome: "unknown" }, "steer-1"],
    ["an array body", 429, [body], "steer-1"],
    ["a null body", 429, null, "steer-1"],
    ["a string body", 429, "rejected", "steer-1"],
    ["a blank request id", 429, { ...body, requestId: " " }, " "],
    ["an oversized request id", 429, { ...body, requestId: "x".repeat(513) }, "x".repeat(513)],
  ] as const)("refuses %s", (_name, status, candidate, requestId) => {
    expect(parseNativeAgentSteerRejection(status, candidate, requestId)).toBeUndefined();
  });

  test("bounds and sanitizes untrusted refusal text", () => {
    expect(boundNativeAgentSteerRejectionMessage(42)).toBeUndefined();
    expect(boundNativeAgentSteerRejectionMessage(" \n\t\u0000 ")).toBeUndefined();
    expect(boundNativeAgentSteerRejectionMessage("Wait\n\nfor\u0007 it\u2028now")).toBe(
      "Wait for it now",
    );
    const long = `${"a".repeat(MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS - 2)}😀😀😀`;
    const bounded = boundNativeAgentSteerRejectionMessage(long)!;
    expect(bounded.length).toBeLessThanOrEqual(MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS);
    expect(bounded.endsWith("…")).toBe(true);
    // Never splits a surrogate pair.
    expect(bounded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // Bounding is idempotent, so validated outcomes stay valid.
    expect(boundNativeAgentSteerRejectionMessage(bounded)).toBe(bounded);
    const huge = parseNativeAgentSteerRejection(
      429,
      { ...body, message: "x".repeat(10 * 1024 * 1024) },
      "steer-1",
    );
    expect(huge?.message?.length).toBeLessThanOrEqual(
      MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS,
    );
    expect(isNativeAgentSteerRejectedOutcome(huge, "steer-1")).toBe(true);
  });

  test("validates normalized outcomes, optionally for one request", () => {
    const outcome = parseNativeAgentSteerRejection(429, body, "steer-1")!;
    expect(isNativeAgentSteerRejectedOutcome(outcome)).toBe(true);
    expect(isNativeAgentSteerRejectedOutcome(outcome, "steer-1")).toBe(true);
    expect(isNativeAgentSteerRejectedOutcome(outcome, "steer-2")).toBe(false);
    expect(isNativeAgentSteerRejectedOutcome({ ...outcome, reason: "other" })).toBe(false);
    expect(isNativeAgentSteerRejectedOutcome({ ...outcome, reason: "steer-not-recorded" })).toBe(
      true,
    );
    expect(isNativeAgentSteerRejectedOutcome({ ...outcome, requestId: undefined })).toBe(false);
    expect(isNativeAgentSteerRejectedOutcome({ ...outcome, message: 7 })).toBe(false);
    expect(isNativeAgentSteerRejectedOutcome({ ...outcome, message: "x".repeat(400) })).toBe(false);
    expect(isNativeAgentSteerRejectedOutcome({ outcome: "applied" })).toBe(false);
    expect(isNativeAgentSteerRejectedOutcome(null)).toBe(false);
  });

  test("gives actionable text, preferring the bridge's bounded message", () => {
    expect(
      nativeAgentSteerRejectionMessage({ reason: "steer-capacity-exceeded", message: "Hold on." }),
    ).toBe("Hold on.");
    expect(nativeAgentSteerRejectionMessage({ reason: "steer-capacity-exceeded" })).toMatch(
      /cannot accept more steering.*send your message again/,
    );
    expect(nativeAgentSteerRejectionMessage({ reason: "steer-history-unavailable" })).toMatch(
      /Steering is unavailable.*send your message again/,
    );
    expect(nativeAgentSteerRejectionMessage({ reason: "steer-not-recorded" })).toMatch(
      /was not sent.*Send it again/,
    );
    for (const reason of NATIVE_AGENT_STEER_REJECTION_REASONS) {
      expect(isNativeAgentSteerRejectionReason(reason)).toBe(true);
      expect(nativeAgentSteerRejectionMessage({ reason }).length).toBeLessThanOrEqual(
        MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS,
      );
    }
  });

  test("is a member of the session action outcome union", () => {
    const outcome: NativeAgentSessionActionOutcome = parseNativeAgentSteerRejection(
      429,
      body,
      "steer-1",
    )!;
    // Other actions read these fields without narrowing; a refusal has neither.
    expect(outcome.shareUrl).toBeUndefined();
    expect(outcome.preview).toBeUndefined();
    expect(outcome.outcome).toBe("rejected");
  });

  test("normalizes the steer-history summary to counts and limits only", () => {
    const summary = {
      entries: 256,
      limitEntries: 256,
      bytes: 4096,
      limitBytes: 524288,
      fencedRuns: 1,
      saturated: true,
    };
    expect(
      normalizeNativeAgentRuntimeSteerJournal({
        ...summary,
        requestIds: ["steer-1"],
        digest: "sha256:abc",
        text: "secret steering",
      }),
    ).toEqual(summary);
    expect(
      normalizeNativeAgentRuntimeSteerJournal({ ...summary, entries: Number.MAX_SAFE_INTEGER }),
    ).toEqual({ ...summary, entries: 1_000_000 });
    for (const broken of [
      null,
      [],
      "full",
      { ...summary, entries: -1 },
      { ...summary, bytes: 1.5 },
      { ...summary, limitBytes: "512" },
      { ...summary, fencedRuns: undefined },
      { ...summary, saturated: "yes" },
    ]) {
      expect(normalizeNativeAgentRuntimeSteerJournal(broken)).toBeUndefined();
    }
  });
});
