import { afterEach, describe, expect, test } from "bun:test";
import { GATEWAY_CURSOR_EVENT, readSseStream } from "@orkestrator/protocol/gateway-event-stream";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  RELAYED_NODE_EVENT,
  relayedNodeEventName,
  type RelayedNodeEvent,
} from "@orkestrator/protocol/node-events";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import { RelayedEventStream } from "@orkestrator/protocol/relayed-event-stream";

import { OrkestratorGateway } from "../src/gateway";
import type { GatewayEventReplay } from "../src/gateway-event-replay";
import {
  eventClients,
  eventFrames,
  frameId,
  openEventStream,
  readGatewayMetrics,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

const LEAF = "bk_leaf" as BackendId;
const OTHER = "bk_other" as BackendId;
const LEAF_EVENT = relayedNodeEventName(LEAF);
const OTHER_EVENT = relayedNodeEventName(OTHER);
const NEWER_RENDERER = "?excludeEvents=terminal-output-&relayedEvents=per-node";

function relayedEvent(nodeId: BackendId, id: string): RelayedNodeEvent {
  return { nodeId, kind: "event", event: "resource-changed", payload: { id } };
}

function emitRelayed(gateway: OrkestratorGateway, nodeId: BackendId, id: string) {
  gateway.emit(relayedNodeEventName(nodeId), relayedEvent(nodeId, id));
}

function rings(gateway: OrkestratorGateway) {
  return gateway as unknown as {
    eventReplay: GatewayEventReplay;
    relayedEventReplay: GatewayEventReplay;
  };
}

async function closeAndWait(
  gateway: OrkestratorGateway,
  stream: Awaited<ReturnType<typeof openEventStream>>,
) {
  stream.response.destroy();
  stream.close();
  await waitUntil(() => eventClients(gateway).size === 0, "Stream did not close");
}

describe("a main stream", () => {
  for (const query of [
    "?excludeEvents=terminal-output-",
    "?relayedEvents=legacy",
    "?relayedEvents=bogus",
  ]) {
    test(`carries no relayed events, whatever it asks for (${query})`, async () => {
      const { gateway, info } = await startGateway();
      const main = await openEventStream(gateway, info, query);
      emitRelayed(gateway, LEAF, "one");
      gateway.emit(LEAF_EVENT, { nodeId: LEAF, kind: "resync" });
      gateway.emit("environment-renamed", { id: "after" });
      await waitUntil(() => main.received().includes('"id":"after"'), "Main stream stalled");
      expect(main.received()).not.toContain(RELAYED_NODE_EVENT);
      expect(main.received()).not.toContain(LEAF_EVENT);
      main.close();
    });
  }

  test("a reconnect replays its own window and is sent no relayed resync", async () => {
    const { gateway, info } = await startGateway();
    gateway.emit("environment-renamed", { id: "before" });
    const cursor = rings(gateway).eventReplay.latestCursor;
    emitRelayed(gateway, LEAF, "missed");
    gateway.emit("environment-renamed", { id: "replayed" });
    const resumed = await openEventStream(gateway, info, `?since=${encodeURIComponent(cursor)}`);
    await waitUntil(() => resumed.received().includes('"id":"replayed"'), "No replay");
    expect(eventFrames(resumed.received(), "gateway.connected")[0]).toContain(
      '"status":"replayed"',
    );
    expect(resumed.received()).not.toContain('"kind":"resync"');
    resumed.close();
  });

  test("a stream that names no relayed events on its filter gets none", async () => {
    const { gateway, info } = await startGateway();
    const scoped = await openEventStream(gateway, info, "?events=menu-");
    const terminal = await openEventStream(
      gateway,
      info,
      "?excludeEvents=terminal-output-&includeEvents=terminal-output-one",
    );

    emitRelayed(gateway, LEAF, "one");
    gateway.emit("menu-zoom", "in");
    await waitUntil(() => scoped.received().includes("menu-zoom"), "Scoped stream stalled");

    expect(scoped.received()).not.toContain(RELAYED_NODE_EVENT);
    expect(terminal.received()).not.toContain(RELAYED_NODE_EVENT);
    scoped.close();
    terminal.close();
  });
});

describe("per-node relayed streams", () => {
  test("a renderer's main stream carries none; its own stream carries only its nodes", async () => {
    const { gateway, info } = await startGateway();
    const main = await openEventStream(gateway, info, NEWER_RENDERER);
    const relayed = await openEventStream(
      gateway,
      info,
      `?includeEvents=${encodeURIComponent(LEAF_EVENT)}`,
    );
    emitRelayed(gateway, LEAF, "mine");
    emitRelayed(gateway, OTHER, "not-mine");
    gateway.emit("environment-renamed", { id: "authoritative" });
    await waitUntil(
      () =>
        eventFrames(relayed.received(), LEAF_EVENT).length === 1 &&
        main.received().includes("environment-renamed"),
      "A frame never arrived",
    );

    expect(main.received()).not.toContain(RELAYED_NODE_EVENT);
    expect(relayed.received()).not.toContain(OTHER_EVENT);
    expect(relayed.received()).not.toContain("environment-renamed");
    main.close();
    relayed.close();
  });

  test("its cursor is the relayed ring's, and a reconnect replays what it missed", async () => {
    const { gateway, info } = await startGateway();
    const filter = `?includeEvents=${encodeURIComponent(LEAF_EVENT)}`;
    const first = await openEventStream(gateway, info, filter);
    const relayedRing = rings(gateway).relayedEventReplay;
    gateway.emit("environment-renamed", { id: "main-only" });
    emitRelayed(gateway, LEAF, "seen");
    await waitUntil(() => first.received().includes(LEAF_EVENT), "No first frame");
    const cursor = frameId(eventFrames(first.received(), LEAF_EVENT)[0]!);
    expect(cursor).toBe(relayedRing.latestCursor);
    expect(eventFrames(first.received(), "gateway.connected")[0]).toContain('"status":"fresh"');
    await closeAndWait(gateway, first);

    emitRelayed(gateway, OTHER, "skipped");
    emitRelayed(gateway, LEAF, "missed");
    emitRelayed(gateway, OTHER, "trailing");
    const resumed = await openEventStream(
      gateway,
      info,
      `${filter}&since=${encodeURIComponent(cursor!)}`,
    );
    await waitUntil(
      () =>
        frameId(eventFrames(resumed.received(), GATEWAY_CURSOR_EVENT).at(-1) ?? "") ===
        relayedRing.latestCursor,
      "Replay did not end on the relayed ring's latest revision",
    );
    const replayed = eventFrames(resumed.received(), LEAF_EVENT);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toContain('"id":"missed"');
    expect(resumed.received()).not.toContain(OTHER_EVENT);
    resumed.close();
  });

  test("a busy leaf expires relayed cursors only; a main cursor still replays", async () => {
    const { gateway, info } = await startGateway({
      relayedEventReplay: { frameCapacity: 8, idleRetentionMs: 60_000 },
    });
    const main = await openEventStream(gateway, info, NEWER_RENDERER);
    const filter = `?includeEvents=${encodeURIComponent(LEAF_EVENT)}`;
    const relayed = await openEventStream(gateway, info, filter);
    const mainCursor = frameId(eventFrames(main.received(), "gateway.connected")[0]!);
    const relayedCursor = frameId(eventFrames(relayed.received(), "gateway.connected")[0]!);
    relayed.response.destroy();
    relayed.close();
    await closeAndWait(gateway, main);

    const before = rings(gateway).eventReplay.latestRevision;
    for (let index = 0; index < 5_000; index += 1) emitRelayed(gateway, LEAF, String(index));
    expect(rings(gateway).eventReplay.latestRevision).toBe(before);
    expect(rings(gateway).relayedEventReplay.getStats().retainedFrames).toBe(8);

    const mainAgain = await openEventStream(
      gateway,
      info,
      `${NEWER_RENDERER}&since=${encodeURIComponent(mainCursor!)}`,
    );
    expect(eventFrames(mainAgain.received(), "gateway.connected")[0]).toContain(
      '"status":"caught-up"',
    );
    expect(mainAgain.received()).not.toContain("gateway.reconcile-required");

    const relayedAgain = await openEventStream(
      gateway,
      info,
      `${filter}&since=${encodeURIComponent(relayedCursor!)}`,
    );
    await waitUntil(
      () => relayedAgain.received().includes("gateway.reconcile-required"),
      "An expired relayed cursor was not told to reconcile",
    );
    expect(relayedAgain.received()).toContain('"reason":"cursor-expired"');
    mainAgain.close();
    relayedAgain.close();
  });

  test("the relayed ring keeps its byte bound, and a main cursor is not valid on it", async () => {
    const { gateway, info } = await startGateway({
      relayedEventReplay: { maxBytes: 2_048, idleRetentionMs: 60_000 },
    });
    for (let index = 0; index < 64; index += 1) emitRelayed(gateway, LEAF, `event-${index}`);
    const stats = rings(gateway).relayedEventReplay.getStats();
    expect(stats.retainedBytes).toBeLessThanOrEqual(2_048);
    expect(stats.droppedFrames).toBeGreaterThan(0);

    const relayed = await openEventStream(
      gateway,
      info,
      `?includeEvents=${encodeURIComponent(LEAF_EVENT)}&since=${encodeURIComponent(
        rings(gateway).eventReplay.latestCursor,
      )}`,
    );
    await waitUntil(
      () => relayed.received().includes('"reason":"prior-generation"'),
      "A main stream's cursor should not resume the relayed stream",
    );
    relayed.close();
  });

  test("metrics report the ring and label the frames without a node id", async () => {
    const { gateway, info } = await startGateway();
    const relayed = await openEventStream(
      gateway,
      info,
      `?includeEvents=${encodeURIComponent(LEAF_EVENT)}`,
    );
    emitRelayed(gateway, LEAF, "one");
    await waitUntil(() => relayed.received().includes(LEAF_EVENT), "No frame arrived");

    const metrics = (await readGatewayMetrics(info)) as unknown as {
      events: Record<string, { frames: number }>;
      replay: { relayedRing: { retainedFrames: number; frameCapacity: number; maxBytes: number } };
    };
    expect(metrics.events[RELAYED_NODE_EVENT]?.frames).toBe(1);
    expect(metrics.events[LEAF_EVENT]).toBeUndefined();
    expect(metrics.replay.relayedRing).toEqual(
      expect.objectContaining({ retainedFrames: 1, frameCapacity: 512, maxBytes: 512 * 1024 }),
    );
    relayed.close();
  });
});

describe("the renderer's relayed stream against a real gateway", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  function startStream(info: { url: string; token: string }, reconnectDelayMs = 1) {
    const delivered: Array<{ event: string; payload: unknown }> = [];
    const opens: string[] = [];
    const stream = new RelayedEventStream({
      backoff: new ReconnectBackoff({
        initialDelayMs: reconnectDelayMs,
        maxDelayMs: reconnectDelayMs,
        healthyAfterMs: 1,
      }),
      deliver: (event, payload) => delivered.push({ event, payload }),
      open: (events, since, handlers) => {
        const params = new URLSearchParams({ includeEvents: events.join(",") });
        if (since) params.set("since", since);
        opens.push(params.toString());
        const controller = new AbortController();
        void (async () => {
          try {
            const response = await fetch(`${info.url}__orkestrator/events?${params}`, {
              headers: { authorization: `Bearer ${info.token}` },
              signal: controller.signal,
            });
            handlers.onOpen();
            await readSseStream(response.body!, controller.signal, (frame) => {
              if (frame.data) handlers.onMessage(frame.data, frame.id);
            });
          } catch {
            // Aborted by `close()`.
          }
        })();
        return { close: () => controller.abort() };
      },
    });
    stops.push(() => stream.dispose());
    return { stream, delivered, opens };
  }

  test("widening the filter resumes from its cursor, losing and repeating nothing", async () => {
    const { gateway, info } = await startGateway();
    const { stream, delivered, opens } = startStream(info);
    stream.add(LEAF_EVENT);
    await stream.ready(LEAF_EVENT);
    await waitUntil(() => eventClients(gateway).size === 1, "Stream never registered");
    emitRelayed(gateway, LEAF, "first");
    await waitUntil(() => delivered.length > 0, "First frame never arrived");
    await waitUntil(
      () => delivered.some((entry) => (entry.payload as RelayedNodeEvent).kind === "event"),
      "First event never arrived",
    );

    stream.add(OTHER_EVENT);
    emitRelayed(gateway, LEAF, "during-the-swap");
    await stream.ready(OTHER_EVENT);
    await waitUntil(() => opens.length === 2, "The filter was not widened");
    expect(opens[1]).toContain("since=");
    emitRelayed(gateway, OTHER, "second-node");

    const events = () =>
      delivered
        .filter((entry) => (entry.payload as RelayedNodeEvent).kind === "event")
        .map((entry) => (entry.payload as { payload: { id: string } }).payload.id);
    await waitUntil(() => events().length >= 3, "A frame was lost across the swap");
    expect(events()).toEqual(["first", "during-the-swap", "second-node"]);
  });

  test("a gap the ring cannot cover resyncs every watched node and nothing else", async () => {
    const { gateway, info } = await startGateway({
      relayedEventReplay: { frameCapacity: 4, idleRetentionMs: 60_000 },
    });
    // Long enough that only `retryWaiting` brings it back, after the gap.
    const { stream, delivered } = startStream(info, 60_000);
    stream.add(LEAF_EVENT);
    await stream.ready(LEAF_EVENT);
    await waitUntil(() => delivered.length > 0, "Fresh stream never announced");
    delivered.length = 0;

    stream.dropConnection();
    await waitUntil(() => eventClients(gateway).size === 0, "Stream did not close");
    for (let index = 0; index < 32; index += 1) emitRelayed(gateway, LEAF, String(index));
    stream.retryWaiting();

    await waitUntil(() => delivered.length > 0, "The gap was never reported");
    expect(delivered[0]).toEqual({
      event: LEAF_EVENT,
      payload: { nodeId: LEAF, kind: "resync" },
    });
  });
});

describe("relayed stream boundaries", () => {
  test("expired relayed cursors have separate handshake metrics", async () => {
    const { gateway, info } = await startGateway();
    const cursor = rings(gateway).relayedEventReplay.latestCursor;
    for (let i = 0; i < 513; i++) emitRelayed(gateway, LEAF, String(i));
    const stream = await openEventStream(
      gateway,
      info,
      `?includeEvents=${LEAF_EVENT}&since=${cursor}`,
    );
    const metrics = (await readGatewayMetrics(info)) as unknown as {
      replay: { reconciled: number };
      relayedReplay: { reconciled: number };
    };
    expect(metrics.replay.reconciled).toBe(0);
    expect(metrics.relayedReplay.reconciled).toBe(1);
    stream.close();
  });

  test("keepalive uses the relayed generation and ignores main omissions", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 15 });
    const stream = await openEventStream(gateway, info, `?includeEvents=${LEAF_EVENT}`);
    gateway.emit("environment-renamed", { id: "main" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(eventFrames(stream.received(), GATEWAY_CURSOR_EVENT)).toHaveLength(0);
    emitRelayed(gateway, OTHER, "omitted");
    await waitUntil(
      () => eventFrames(stream.received(), GATEWAY_CURSOR_EVENT).length > 0,
      "No cursor",
    );
    expect(frameId(eventFrames(stream.received(), GATEWAY_CURSOR_EVENT)[0]!)).toBe(
      rings(gateway).relayedEventReplay.latestCursor,
    );
    stream.close();
  });
});
