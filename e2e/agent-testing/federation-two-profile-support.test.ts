import { describe, expect, test } from "bun:test";
import {
  HOLD_MARKER,
  describeStream,
  frameFacts,
  isRelayedFrame,
  lagSummary,
  legacyMainStreamUrl,
  shouldHold,
  withoutPerNodeEvents,
} from "./federation-two-profile-support";

const ORIGIN = "http://127.0.0.1:4000";
const MAIN = `${ORIGIN}/__orkestrator/events?excludeEvents=terminal-output-&relayedEvents=per-node&keepaliveEvents=1`;

describe("shouldHold", () => {
  test("holds only when the latest user message carries the marker", () => {
    expect(shouldHold([{ role: "user", content: `Wait. ${HOLD_MARKER}` }])).toBe(true);
    expect(
      shouldHold([
        { role: "user", content: [{ type: "text", text: HOLD_MARKER }] },
        { role: "assistant", content: "ok" },
      ]),
    ).toBe(true);
    expect(
      shouldHold([
        { role: "user", content: HOLD_MARKER },
        { role: "user", content: "Name this session." },
      ]),
    ).toBe(false);
    expect(shouldHold(undefined)).toBe(false);
  });
});

describe("describeStream", () => {
  test("tells the main, relayed and terminal streams apart as the gateway does", () => {
    expect(describeStream(MAIN)).toEqual({ kind: "main", perNode: true, relayedNodes: [] });
    expect(
      describeStream(
        `${ORIGIN}/__orkestrator/events?includeEvents=relayed-node-event%3Ab%2Crelayed-node-event%3Aa&since=g%3A3`,
      ),
    ).toEqual({ kind: "relayed", perNode: false, relayedNodes: ["a", "b"] });
    expect(
      describeStream(`${ORIGIN}/__orkestrator/events?includeEvents=terminal-output-abc`).kind,
    ).toBe("terminal");
    expect(describeStream(`${ORIGIN}/__orkestrator/invoke`).kind).toBe("other");
  });
});

describe("legacyMainStreamUrl", () => {
  test("drops only the per-node opt-in, keeping the cursor and the other parameters", () => {
    const legacy = legacyMainStreamUrl(`${MAIN}&since=gen%3A12`);
    expect(legacy).not.toBeNull();
    const parsed = new URL(legacy!);
    expect(parsed.searchParams.has("relayedEvents")).toBe(false);
    expect(parsed.searchParams.get("since")).toBe("gen:12");
    expect(parsed.searchParams.get("excludeEvents")).toBe("terminal-output-");
    expect(parsed.searchParams.get("keepaliveEvents")).toBe("1");
  });

  test("leaves relayed, terminal and already-legacy streams alone", () => {
    expect(
      legacyMainStreamUrl(`${ORIGIN}/__orkestrator/events?includeEvents=relayed-node-event%3Aa`),
    ).toBeNull();
    expect(
      legacyMainStreamUrl(`${ORIGIN}/__orkestrator/events?excludeEvents=terminal-output-`),
    ).toBeNull();
  });
});

describe("withoutPerNodeEvents", () => {
  test("removes perNodeEvents from a watch answer only", () => {
    const answer = { result: { watchId: "w", renewed: true, perNodeEvents: true } };
    expect(withoutPerNodeEvents("watch_node_events", answer)).toEqual({
      result: { watchId: "w", renewed: true },
    });
    expect(withoutPerNodeEvents("get_projects", answer)).toBe(answer);
    expect(withoutPerNodeEvents("watch_node_events", { error: "x" })).toEqual({ error: "x" });
  });
});

describe("frameFacts", () => {
  test("keeps names, node ids and kinds, never payload bodies", () => {
    expect(
      frameFacts(
        JSON.stringify({
          event: "relayed-node-event:leaf",
          payload: {
            nodeId: "leaf",
            kind: "event",
            event: "change-projection-changed",
            payload: { secret: "x" },
          },
        }),
      ),
    ).toEqual({
      event: "relayed-node-event:leaf",
      nodeId: "leaf",
      relayedKind: "event",
      relayedEvent: "change-projection-changed",
    });
    expect(
      frameFacts(
        JSON.stringify({
          event: "relayed-node-event",
          payload: { nodeId: "leaf", kind: "resync" },
        }),
      ),
    ).toEqual({ event: "relayed-node-event", nodeId: "leaf", relayedKind: "resync" });
    expect(frameFacts(JSON.stringify({ event: "resource-changed", payload: { id: "e" } }))).toEqual(
      { event: "resource-changed" },
    );
    // Only the exact old name or the per-node prefix is relayed.
    expect(
      frameFacts(
        JSON.stringify({ event: "relayed-node-events", payload: { nodeId: "leaf", kind: "x" } }),
      ),
    ).toEqual({ event: "relayed-node-events" });
    expect(frameFacts("not json")).toBeNull();
    expect(frameFacts("null")).toBeNull();
    expect(frameFacts(JSON.stringify({ payload: 1 }))).toBeNull();
  });

  test("recognises both relayed names", () => {
    expect(isRelayedFrame({ event: "relayed-node-event" })).toBe(true);
    expect(isRelayedFrame({ event: "relayed-node-event:leaf" })).toBe(true);
    expect(isRelayedFrame({ event: "resource-changed" })).toBe(false);
    expect(isRelayedFrame({ event: "relayed-node-events" })).toBe(false);
  });
});

describe("lagSummary", () => {
  test("summarises samples and an empty run", () => {
    expect(lagSummary([300, 100, 200, 400])).toEqual({
      count: 4,
      minMs: 100,
      medianMs: 250,
      maxMs: 400,
    });
    expect(lagSummary([5])).toEqual({ count: 1, minMs: 5, medianMs: 5, maxMs: 5 });
    expect(lagSummary([])).toEqual({ count: 0, minMs: 0, medianMs: 0, maxMs: 0 });
  });
});
