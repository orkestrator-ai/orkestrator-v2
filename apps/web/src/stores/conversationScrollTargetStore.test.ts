import { beforeEach, describe, expect, test } from "bun:test";
import {
  CONVERSATION_SCROLL_TARGET_TTL_MS,
  MAX_PENDING_CONVERSATION_SCROLL_TARGETS,
  resetConversationScrollTargets,
  resolveConversationScrollIndex,
  useConversationScrollTargetStore,
} from "./conversationScrollTargetStore";

const store = () => useConversationScrollTargetStore.getState();

beforeEach(() => resetConversationScrollTargets());

describe("conversation scroll target store", () => {
  test("parks one request per tab and the next attempt replaces it", () => {
    const first = store().request("env-1", "tab-1", { messageId: "m-1" }, 1_000);
    const second = store().request("env-1", "tab-1", { turnId: "turn-2" }, 1_001);

    expect(first?.messageId).toBe("m-1");
    expect(store().peek("env-1", "tab-1", 1_002)).toMatchObject({ turnId: "turn-2" });
    expect(store().peek("env-1", "tab-1", 1_002)?.messageId).toBeUndefined();
    expect(second?.nonce).not.toBe(first?.nonce);
    expect(store().peek("env-1", "tab-2", 1_002)).toBeNull();
    expect(store().peek("env-2", "tab-1", 1_002)).toBeNull();
  });

  test("a request with no ids parks nothing and drops an earlier one", () => {
    store().request("env-1", "tab-1", { messageId: "m-1" }, 1_000);
    expect(store().request("env-1", "tab-1", { messageId: " " }, 1_001)).toBeNull();
    expect(store().peek("env-1", "tab-1", 1_002)).toBeNull();
  });

  test("clear only removes the request it was given", () => {
    const first = store().request("env-1", "tab-1", { messageId: "m-1" }, 1_000)!;
    store().request("env-1", "tab-1", { messageId: "m-2" }, 1_001);

    store().clear("env-1", "tab-1", first.nonce);
    expect(store().peek("env-1", "tab-1", 1_002)?.messageId).toBe("m-2");

    store().clear("env-1", "tab-1");
    expect(store().peek("env-1", "tab-1", 1_002)).toBeNull();
  });

  test("requests expire and are pruned on the next write", () => {
    store().request("env-1", "tab-1", { messageId: "m-1" }, 1_000);
    const expiredAt = 1_000 + CONVERSATION_SCROLL_TARGET_TTL_MS;

    expect(store().peek("env-1", "tab-1", expiredAt - 1)).not.toBeNull();
    expect(store().peek("env-1", "tab-1", expiredAt)).toBeNull();

    store().request("env-1", "tab-2", { messageId: "m-2" }, expiredAt);
    expect(store().targets.size).toBe(1);
  });

  test("the number of pending tabs is bounded", () => {
    for (let index = 0; index < MAX_PENDING_CONVERSATION_SCROLL_TARGETS + 5; index += 1) {
      store().request("env-1", `tab-${index}`, { messageId: `m-${index}` }, 1_000 + index);
    }
    expect(store().targets.size).toBe(MAX_PENDING_CONVERSATION_SCROLL_TARGETS);
    expect(store().peek("env-1", "tab-0", 2_000)).toBeNull();
    expect(
      store().peek("env-1", `tab-${MAX_PENDING_CONVERSATION_SCROLL_TARGETS + 4}`, 2_000),
    ).not.toBeNull();
  });
});

describe("resolveConversationScrollIndex", () => {
  const messages = [
    { id: "u-1" },
    { id: "a-1" },
    { id: "a-1:text-block:3" },
    { id: "u-2" },
    { id: "a-2" },
  ];
  const boundaries = [
    { turnId: "turn-1", messageId: "u-1" },
    { turnId: "turn-2", messageId: "u-2" },
    { turnId: "turn-3" },
  ];

  test("finds a message by its projection id", () => {
    expect(resolveConversationScrollIndex(messages, { messageId: "u-2" })).toBe(3);
  });

  test("maps a turn id through the turn boundaries", () => {
    expect(resolveConversationScrollIndex(messages, { turnId: "turn-1" }, boundaries)).toBe(0);
    expect(resolveConversationScrollIndex(messages, { turnId: "turn-3" }, boundaries)).toBe(-1);
    expect(resolveConversationScrollIndex(messages, { turnId: "turn-2" })).toBe(-1);
  });

  test("prefers the message id and falls back to the turn", () => {
    expect(
      resolveConversationScrollIndex(messages, { messageId: "u-1", turnId: "turn-2" }, boundaries),
    ).toBe(0);
    expect(
      resolveConversationScrollIndex(
        messages,
        { messageId: "outside-window", turnId: "turn-2" },
        boundaries,
      ),
    ).toBe(3);
  });

  test("resolves a split row to its first block and reports a missing message", () => {
    expect(resolveConversationScrollIndex([{ id: "x:text-block:1" }], { messageId: "x" })).toBe(0);
    expect(resolveConversationScrollIndex(messages, { messageId: "missing" })).toBe(-1);
    expect(resolveConversationScrollIndex(messages, {})).toBe(-1);
  });
});
