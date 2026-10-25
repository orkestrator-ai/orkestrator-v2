import { expect, test } from "bun:test";
import {
  isNodeEventWatchId,
  isRelayedNodeEvent,
  parseNodeEventPrefixes,
  MAX_NODE_EVENT_PREFIXES,
  MAX_NODE_EVENT_PREFIX_LENGTH,
} from "./node-events.js";

test("prefixes have count and length bounds, deduplicate and sort", () => {
  expect(parseNodeEventPrefixes(["b-", "a-", "b-"])).toEqual(["a-", "b-"]);
  expect(
    parseNodeEventPrefixes(Array.from({ length: MAX_NODE_EVENT_PREFIXES }, (_, i) => `e${i}`)),
  ).toHaveLength(MAX_NODE_EVENT_PREFIXES);
  expect(parseNodeEventPrefixes(["a".repeat(MAX_NODE_EVENT_PREFIX_LENGTH)])).toHaveLength(1);
  for (const value of [
    null,
    {},
    [],
    [1],
    [""],
    ["a,b"],
    ["a b"],
    ["terminal"],
    ["terminal-output-x"],
    ["relayed-node-event"],
    ["a".repeat(MAX_NODE_EVENT_PREFIX_LENGTH + 1)],
    Array(MAX_NODE_EVENT_PREFIXES + 1).fill("a"),
  ])
    expect(() => parseNodeEventPrefixes(value)).toThrow();
});

test("watch identities are bounded safe tokens", () => {
  for (const value of ["a", "watch-id_1", "a".repeat(64)])
    expect(isNodeEventWatchId(value)).toBe(true);
  for (const value of [null, 1, {}, "", "a".repeat(65), "a b", "a/b", "a,b"])
    expect(isNodeEventWatchId(value)).toBe(false);
});

test("validates relayed frames before dispatch", () => {
  expect(isRelayedNodeEvent({ nodeId: "bk_leaf", kind: "resync" })).toBe(true);
  expect(
    isRelayedNodeEvent({
      nodeId: "bk_leaf",
      kind: "event",
      event: "resource-changed",
      payload: null,
    }),
  ).toBe(true);
  for (const value of [
    null,
    [],
    "event",
    {},
    { nodeId: "", kind: "resync" },
    { nodeId: "bad node", kind: "resync" },
    { nodeId: 1, kind: "resync" },
    { nodeId: "bk_leaf", kind: "unknown" },
    ...[
      undefined,
      1,
      "",
      "bad name",
      "a".repeat(129),
      "terminal-output-s1",
      "relayed-node-event",
    ].map((event) => ({ nodeId: "bk_leaf", kind: "event", event, payload: {} })),
    { nodeId: "bk_leaf", kind: "event", event: "resource-changed" },
  ])
    expect(isRelayedNodeEvent(value)).toBe(false);
});
