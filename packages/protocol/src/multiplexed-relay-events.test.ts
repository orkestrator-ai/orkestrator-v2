import { describe, expect, test } from "bun:test";

import type { BackendId } from "./federation.js";
import { SseFrameDecoder } from "./gateway-event-stream.js";
import {
  encodeMultiplexedControlFrame,
  encodeMultiplexedNodeFrame,
  encodeSseFrame,
  MAX_MULTIPLEXED_NODES,
  MULTIPLEXED_CONNECTED_EVENT,
  MULTIPLEXED_NODE_EVENT,
  multiplexedEventsQuery,
  multiplexedFrameNode,
  parseMultiplexedControlFrame,
  parseMultiplexedEventsQuery,
} from "./multiplexed-relay-events.js";

const A = "bk_a" as BackendId;
const B = "bk_b:2.x" as BackendId;

describe("multiplexed relay events", () => {
  test("a query round-trips every node's workspace and cursor", () => {
    const nodes = [
      { nodeId: A, workspaceId: "w-1", cursor: "gen:12" },
      { nodeId: B, workspaceId: "w-2", cursor: null },
    ];
    const parsed = parseMultiplexedEventsQuery(new URLSearchParams(multiplexedEventsQuery(nodes)));
    expect(parsed).toEqual({ ok: true, nodes });
  });

  test("a query is refused past its bounds or without a workspace per node", () => {
    const refuse = (query: string) => parseMultiplexedEventsQuery(new URLSearchParams(query)).ok;
    expect(refuse("")).toBe(false);
    expect(refuse(`nodes=${A}`)).toBe(false);
    expect(refuse(`nodes=${A},${A}&workspace.${A}=w`)).toBe(false);
    expect(refuse(`nodes=not%20an%20id&workspace.not%20an%20id=w`)).toBe(false);
    expect(refuse(`nodes=${A}&workspace.${A}=${"w".repeat(129)}`)).toBe(false);
    expect(refuse(`nodes=${A}&workspace.${A}=w&since.${A}=${"1".repeat(257)}`)).toBe(false);
    const many = Array.from({ length: MAX_MULTIPLEXED_NODES + 1 }, (_, i) => ({
      nodeId: `bk_${i}` as BackendId,
      workspaceId: "w",
      cursor: null,
    }));
    expect(refuse(multiplexedEventsQuery(many))).toBe(false);
    expect(refuse(multiplexedEventsQuery(many.slice(0, MAX_MULTIPLEXED_NODES)))).toBe(true);
  });

  test("a node frame keeps the leaf's id and data and names its node", () => {
    const data = JSON.stringify({ event: "environment-changed", payload: { id: "e" } });
    const [frame] = new SseFrameDecoder().push(encodeMultiplexedNodeFrame(B, "gen:3", data));
    expect(frame).toEqual({ data, id: "gen:3", event: `node:${B}` });
    expect(multiplexedFrameNode(frame?.event)).toBe(B);
    expect(multiplexedFrameNode(undefined)).toBeNull();
    expect(multiplexedFrameNode("node:not an id")).toBeNull();
  });

  test("multi-line data survives the framing unchanged", () => {
    const [frame] = new SseFrameDecoder().push(encodeSseFrame({ data: "one\ntwo" }));
    expect(frame?.data).toBe("one\ntwo");
    expect(frame?.id).toBeNull();
  });

  test("control frames carry no id and decode tolerantly", () => {
    const connected = encodeMultiplexedControlFrame({
      event: MULTIPLEXED_CONNECTED_EVENT,
      payload: { nodes: [{ node: A, cursor: "gen:1" }] },
    });
    const [frame] = new SseFrameDecoder().push(connected);
    expect(frame?.id).toBeNull();
    expect(frame?.event).toBeUndefined();
    expect(parseMultiplexedControlFrame(frame!.data!)).toEqual({
      kind: "connected",
      payload: { nodes: [{ node: A, cursor: "gen:1" }] },
    });
    expect(
      parseMultiplexedControlFrame(
        JSON.stringify({
          event: MULTIPLEXED_NODE_EVENT,
          payload: { node: A, state: "down", reason: "a-newer-reason", extra: 1 },
        }),
      ),
    ).toEqual({ kind: "node", payload: { node: A, state: "down", reason: "a-newer-reason" } });
    expect(
      parseMultiplexedControlFrame(
        JSON.stringify({ event: MULTIPLEXED_NODE_EVENT, payload: { node: A, state: "odd" } }),
      ),
    ).toBeNull();
    expect(parseMultiplexedControlFrame(JSON.stringify({ event: "mux.newer" }))).toEqual({
      kind: "unknown",
    });
    expect(parseMultiplexedControlFrame("not json")).toBeNull();
  });
});
