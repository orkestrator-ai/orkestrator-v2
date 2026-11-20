import { describe, expect, test } from "bun:test";
import {
  PUSH_LIMITS,
  formatAutoPipelinePushId,
  formatReviewTranscriptPushKey,
  formatWorkflowPushKey,
  parseAutoPipelinePushId,
  parseReviewTranscriptPushKey,
  parseWorkflowPushKey,
  formatNativeSessionPushKey,
  parseNativeSessionPushKey,
  parsePushChangedPayload,
  parsePushResyncPayload,
  parsePushStreamOffer,
  parsePushStreamState,
  pushUtf8Bytes,
} from "./push-events";

const STREAM = "abcdefghijklmnopqrstuvwx";

describe("push stream offers", () => {
  test("reads a version-1 offer from a connected payload", () => {
    expect(
      parsePushStreamOffer({ status: "fresh", push: { versions: [1, 2], streamId: STREAM } }),
    ).toEqual({ versions: [1, 2], streamId: STREAM });
  });

  test("an older backend's connected frame offers nothing", () => {
    expect(parsePushStreamOffer({ status: "fresh", generation: "g", revision: 0 })).toBeNull();
  });

  test("an offer without version 1 or with a malformed stream id is no offer", () => {
    expect(parsePushStreamOffer({ push: { versions: [2], streamId: STREAM } })).toBeNull();
    expect(parsePushStreamOffer({ push: { versions: [1], streamId: "short" } })).toBeNull();
    expect(
      parsePushStreamOffer({ push: { versions: [1], streamId: "a b".repeat(10) } }),
    ).toBeNull();
  });

  test("the transport's stream state", () => {
    expect(parsePushStreamState({ state: "disconnected" })).toEqual({ state: "disconnected" });
    expect(parsePushStreamState({ state: "connected", offer: null })).toEqual({
      state: "connected",
      offer: null,
    });
    expect(
      parsePushStreamState({ state: "connected", offer: { versions: [1], streamId: STREAM } }),
    ).toEqual({ state: "connected", offer: { versions: [1], streamId: STREAM } });
    expect(parsePushStreamState({ state: "connected", offer: { versions: [9] } })).toEqual({
      state: "connected",
      offer: null,
    });
    expect(parsePushStreamState({ state: "other" })).toBeNull();
  });
});

describe("push frames", () => {
  test("a changed frame keeps only well-formed changes and bounded parts", () => {
    const parts = Array.from({ length: 20 }, (_, index) => `p${index}`);
    expect(
      parsePushChangedPayload({
        seq: 3,
        changes: [
          { topic: "native-session", key: "e/claude/k", generation: "g", revision: 2, parts },
          { topic: "native-session", key: "e/claude/k", generation: "g", revision: -1 },
          "nope",
        ],
      }),
    ).toEqual({
      seq: 3,
      changes: [
        {
          topic: "native-session",
          key: "e/claude/k",
          generation: "g",
          revision: 2,
          parts: parts.slice(0, PUSH_LIMITS.maxParts),
        },
      ],
    });
  });

  test("a frame without a positive seq is refused", () => {
    expect(parsePushChangedPayload({ seq: 0, changes: [] })).toBeNull();
    expect(parsePushChangedPayload({ changes: [] })).toBeNull();
    expect(parsePushResyncPayload({ seq: 0 })).toBeNull();
  });

  test("a resync names topics or everything", () => {
    expect(parsePushResyncPayload({ seq: 4, reason: "pending-bound", topics: ["a"] })).toEqual({
      seq: 4,
      reason: "pending-bound",
      topics: ["a"],
    });
    expect(parsePushResyncPayload({ seq: 5, reason: "unknown", topics: "all" })).toEqual({
      seq: 5,
      reason: "pending-bound",
      topics: "all",
    });
  });
});

describe("native-session keys", () => {
  test("round-trip, with a session key that holds slashes", () => {
    const key = { environmentId: "env-1", agent: "claude", logicalSessionKey: "tab:a/b/c" };
    expect(parseNativeSessionPushKey(formatNativeSessionPushKey(key))).toEqual(key);
  });

  test("malformed keys", () => {
    expect(parseNativeSessionPushKey("env/claude/")).toBeNull();
    expect(parseNativeSessionPushKey("/claude/k")).toBeNull();
    expect(parseNativeSessionPushKey("env//k")).toBeNull();
    expect(parseNativeSessionPushKey("env/Claude/k")).toBeNull();
    expect(parseNativeSessionPushKey("env-only")).toBeNull();
    expect(
      parseNativeSessionPushKey(`env/claude/${"x".repeat(PUSH_LIMITS.maxKeyBytes)}`),
    ).toBeNull();
  });

  test("utf-8 byte lengths", () => {
    expect(pushUtf8Bytes("abc")).toBe(3);
    expect(pushUtf8Bytes("é")).toBe(2);
    expect(pushUtf8Bytes("€")).toBe(3);
    expect(pushUtf8Bytes("😀")).toBe(4);
  });
});

describe("auto-pipeline workflow keys", () => {
  test("an environment's offer and one tab's draft round-trip", () => {
    const offer = formatWorkflowPushKey({
      kind: "auto-pipeline",
      id: formatAutoPipelinePushId({ environmentId: "env-1" }),
    });
    expect(offer).toBe("auto-pipeline/env-1");
    expect(parseWorkflowPushKey(offer)).toEqual({ kind: "auto-pipeline", id: "env-1" });
    const draftId = formatAutoPipelinePushId({ environmentId: "env-1", tabId: "tab a/b:c" });
    expect(draftId).toBe("env-1:tab%20a%2Fb%3Ac");
    expect(parseWorkflowPushKey(`auto-pipeline/${draftId}`)).toEqual({
      kind: "auto-pipeline",
      id: draftId,
    });
    expect(parseAutoPipelinePushId(draftId)).toEqual({
      environmentId: "env-1",
      tabId: "tab a/b:c",
    });
  });

  test("a second spelling of a tab, or an empty part, is no key", () => {
    expect(parseAutoPipelinePushId("env-1:%74ab")).toBeNull();
    expect(parseAutoPipelinePushId(":tab")).toBeNull();
    expect(parseAutoPipelinePushId("env-1:")).toBeNull();
    expect(parseAutoPipelinePushId("env-1:%E0%A4%A")).toBeNull();
    expect(parseWorkflowPushKey("auto-pipeline/env-1:%74ab")).toBeNull();
  });
});

describe("review-transcript keys", () => {
  test("a reviewer and a step round-trip", () => {
    const reviewer = formatReviewTranscriptPushKey({ workflowId: "wf-1", reviewerId: "r-1" });
    expect(reviewer).toBe("wf-1/reviewer/r-1");
    expect(parseReviewTranscriptPushKey(reviewer)).toEqual({
      workflowId: "wf-1",
      reviewerId: "r-1",
    });
    const step = formatReviewTranscriptPushKey({ workflowId: "wf-1", step: "consolidate" });
    expect(parseReviewTranscriptPushKey(step)).toEqual({
      workflowId: "wf-1",
      step: "consolidate",
    });
  });

  test("unknown kinds, steps, separators and oversized ids are refused", () => {
    expect(parseReviewTranscriptPushKey("wf-1/session/r-1")).toBeNull();
    expect(parseReviewTranscriptPushKey("wf-1/step/review")).toBeNull();
    expect(parseReviewTranscriptPushKey("wf-1/reviewer/r 1")).toBeNull();
    expect(parseReviewTranscriptPushKey("wf-1/reviewer/r-1/extra")).toBeNull();
    expect(parseReviewTranscriptPushKey("/reviewer/r-1")).toBeNull();
    expect(parseReviewTranscriptPushKey(`wf-1/reviewer/${"r".repeat(257)}`)).toBeNull();
  });
});
