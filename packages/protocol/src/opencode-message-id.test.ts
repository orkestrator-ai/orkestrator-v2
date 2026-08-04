import { describe, expect, test } from "bun:test";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
  openCodeRequestMarker,
  resolveOpenCodeMessageId,
} from "./opencode-message-id";

function entry(info: Record<string, unknown>): { info: Record<string, unknown> } {
  return { info };
}

function timePrefix(messageId: string): string {
  return messageId.slice(4, 16);
}

describe("OpenCode caller-owned message IDs", () => {
  test("publishes the contract through the package subpath", async () => {
    const exported = await import("@orkestrator/protocol/opencode-message-id");
    expect(exported.openCodeRequestMarker).toBe(openCodeRequestMarker);
    expect(exported.findOpenCodeMessageId).toBe(findOpenCodeMessageId);
    expect(exported.resolveOpenCodeMessageId).toBe(resolveOpenCodeMessageId);
    expect(exported.OPEN_CODE_MESSAGE_HISTORY_LIMIT).toBe(OPEN_CODE_MESSAGE_HISTORY_LIMIT);
  });

  test("places consecutive requests between completed server turns", () => {
    const first = resolveOpenCodeMessageId([], "zz", 1);
    const firstAssistant = "msg_000000002001hsJUIHGDARuWRB";
    const history = [
      entry({ id: first, role: "user" }),
      entry({ id: firstAssistant, role: "assistant", parentID: first }),
    ];
    const second = resolveOpenCodeMessageId(history, "aa", 3);

    expect(first < firstAssistant).toBe(true);
    expect(firstAssistant < second).toBe(true);
    expect(second.endsWith(openCodeRequestMarker("aa"))).toBe(true);
  });

  test("never treats a descending session ID as an ascending message anchor", () => {
    for (const sessionId of [
      "ses_ffffffffefffabcdefghijklmn",
      "ses_000000001000abcdefghijklmn",
    ]) {
      const coordinator = new OpenCodeMessageIdCoordinator();
      const user = coordinator.resolve(sessionId, [], "request", 1);
      expect(timePrefix(user)).toBe("000000001000");
      expect(user < "msg_000000002001hsJUIHGDARuWRB").toBe(true);
    }
  });

  test("orders message prefixes across the 48-bit OpenCode clock wrap", () => {
    const id = resolveOpenCodeMessageId([
      entry({ id: "msg_fffffffff000AAAAAAAAAAAAAA", role: "assistant" }),
      entry({ id: "msg_000000001000BBBBBBBBBBBBBB", role: "assistant" }),
    ], "after-wrap", 1);

    expect(timePrefix(id)).toBe("000000001000");
  });

  test("orders same-snapshot reservations by allocation order and reuses retries", () => {
    const coordinator = new OpenCodeMessageIdCoordinator();
    const sessionId = "ses_ffffffffefffabcdefghijklmn";
    const first = coordinator.resolve(sessionId, [], "zz", 1);
    const second = coordinator.resolve(sessionId, [], "aa", 1);

    expect(first < second).toBe(true);
    expect(coordinator.resolve(sessionId, [], "aa", 999)).toBe(second);
  });

  test("recovers the exact ID from either side of the parent relationship", () => {
    const id = resolveOpenCodeMessageId([], "request-1", 1);
    expect(resolveOpenCodeMessageId(
      [entry({ id, role: "user" })],
      "request-1",
      999,
    )).toBe(id);
    expect(findOpenCodeMessageId(
      [entry({ id: "assistant", role: "assistant", parentID: id })],
      "request-1",
    )).toBe(id);
  });

  test("keeps aliased and Unicode request IDs distinct and recoverable", () => {
    const plain = resolveOpenCodeMessageId([null, 1, {}], "foo", 1);
    const prefixed = resolveOpenCodeMessageId(
      [entry({ id: plain, role: "user" })],
      "msg_foo",
      1,
    );
    const emoji = resolveOpenCodeMessageId([], "😀", 1);

    expect(plain).not.toBe(prefixed);
    expect(openCodeRequestMarker("😀")).toBe("_ork_d83dde00");
    expect(openCodeRequestMarker("é")).not.toBe(openCodeRequestMarker("e\u0301"));
    expect(openCodeRequestMarker("😀")).not.toBe(openCodeRequestMarker("\ud83d"));
    expect(findOpenCodeMessageId([entry({ id: emoji, role: "user" })], "😀"))
      .toBe(emoji);
    expect(findOpenCodeMessageId([null, { info: null }], "foo")).toBeUndefined();
  });

  test("ignores malformed secondary sequences and increments the greatest valid one", () => {
    const prefix = `msg_000000001000${"z".repeat(14)}`;
    const next = resolveOpenCodeMessageId([
      entry({ id: `${prefix}00000000000a${openCodeRequestMarker("old")}`, role: "user" }),
      entry({ id: `${prefix}0000000000fg${openCodeRequestMarker("bad-hex")}`, role: "user" }),
      entry({ id: `${prefix}0000000000b${openCodeRequestMarker("short")}`, role: "user" }),
    ], "next", 1);

    expect(next.startsWith(`${prefix}00000000000b`)).toBe(true);
  });

  test("fails closed when the secondary sequence is exhausted", () => {
    const prefix = `msg_000000001000${"z".repeat(14)}`;
    expect(() => resolveOpenCodeMessageId([
      entry({ id: `${prefix}ffffffffffff${openCodeRequestMarker("old")}`, role: "user" }),
    ], "next", 1)).toThrow(/sequence is exhausted/i);
  });

  test.each([
    [0, "000000000000"],
    [1.9, "000000001000"],
    [-1, "000000000000"],
    [Number.NaN, "000000000000"],
    [Number.POSITIVE_INFINITY, "000000000000"],
    [2 ** 36 - 1, "fffffffff000"],
    [2 ** 36, "000000000000"],
  ] as const)("normalizes and wraps fallback clocks (%s)", (now, expected) => {
    expect(timePrefix(resolveOpenCodeMessageId([], "request", now))).toBe(expected);
  });

  test.each(["", "   "])("rejects a blank request ID (%j)", (requestId) => {
    expect(() => resolveOpenCodeMessageId([], requestId)).toThrow(TypeError);
    expect(() => findOpenCodeMessageId([], requestId)).toThrow(TypeError);
  });
});

describe("boundedOpenCodeMessageHistory", () => {
  test("accepts bounded parsed JSON and rejects count, byte, shape, and bound violations", () => {
    expect(boundedOpenCodeMessageHistory([entry({ role: "user" })], {
      count: 1,
      bytes: 128,
    })).toHaveLength(1);
    expect(() => boundedOpenCodeMessageHistory({}, { count: 1, bytes: 128 }))
      .toThrow(/malformed/i);
    expect(() => boundedOpenCodeMessageHistory([null, null], { count: 1, bytes: 128 }))
      .toThrow(/too many/i);
    expect(() => boundedOpenCodeMessageHistory(["oversized"], { count: 1, bytes: 4 }))
      .toThrow(/oversized/i);
    expect(() => boundedOpenCodeMessageHistory([], { count: -1, bytes: 1 }))
      .toThrow(/bounds/i);
  });

  test("fails closed for circular, unsupported, and excessively deep values", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    let deep: unknown = null;
    for (let index = 0; index < 66; index += 1) deep = [deep];

    expect(() => boundedOpenCodeMessageHistory(circular, { count: 1, bytes: 1_000 }))
      .toThrow(/oversized/i);
    expect(() => boundedOpenCodeMessageHistory([1n], { count: 1, bytes: 1_000 }))
      .toThrow(/oversized/i);
    expect(() => boundedOpenCodeMessageHistory([deep], { count: 1, bytes: 1_000 }))
      .toThrow(/oversized/i);
  });
});

describe("OpenCodeMessageIdCoordinator", () => {
  test("serializes operations and releases the tail after a failure", async () => {
    const coordinator = new OpenCodeMessageIdCoordinator();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.runExclusive("session", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      throw new Error("failed");
    });
    const second = coordinator.runExclusive("session", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("failed");
    await second;
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("fails closed instead of evicting unresolved reservations", () => {
    const coordinator = new OpenCodeMessageIdCoordinator(1, 1);
    coordinator.resolve("session", [], "first", 1);
    expect(() => coordinator.resolve("session", [], "second", 1))
      .toThrow(/reservation capacity/i);
    expect(() => coordinator.resolve("another", [], "request", 1))
      .toThrow(/session capacity/i);
  });

  test("evicts idle accepted sessions without losing active reservations", () => {
    const coordinator = new OpenCodeMessageIdCoordinator(1, 1);
    coordinator.resolve("first-session", [], "first", 1);
    expect(() => coordinator.resolve("second-session", [], "second", 1))
      .toThrow(/session capacity/i);

    coordinator.markAccepted("first-session", "first");
    expect(coordinator.resolve("second-session", [], "second", 1)).toBeString();
  });

  test("reconciles materialized reservations and frees bounded capacity", () => {
    const coordinator = new OpenCodeMessageIdCoordinator(1, 1);
    const first = coordinator.resolve("session", [], "first", 1);
    const history = [entry({ id: first, role: "user" })];
    expect(coordinator.resolve("session", history, "second", 2)).toBeString();
  });
});
