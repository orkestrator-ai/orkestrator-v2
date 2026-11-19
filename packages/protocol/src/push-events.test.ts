import { describe, expect, test } from "bun:test";
import {
  PUSH_LIMITS,
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
