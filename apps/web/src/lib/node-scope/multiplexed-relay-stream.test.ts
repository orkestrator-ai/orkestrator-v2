import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import type { BackendId } from "@orkestrator/protocol/federation";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import {
  encodeMultiplexedControlFrame,
  encodeMultiplexedNodeFrame,
  MULTIPLEXED_CONNECTED_EVENT,
  MULTIPLEXED_NODE_EVENT,
  parseMultiplexedEventsQuery,
  type MultiplexedNodeRequest,
} from "@orkestrator/protocol/multiplexed-relay-events";
import { createNodeTransport, type NodeTransport } from "@/lib/native/node-transport";
import {
  createMultiplexedRelayStreams,
  type MultiplexedRelayStreams,
  type MultiplexedRelayStreamsOptions,
} from "./multiplexed-relay-stream";

/**
 * Relayed nodes' main streams on one shared request (plan item 5005), with
 * real node transports over a fake command node that serves both the
 * per-node relay and `/__orkestrator/nodes/events`.
 */
const originalFetch = globalThis.fetch;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const CMD = "https://command.test";
const A = "bk_leaf-a" as BackendId;
const B = "bk_leaf-b" as BackendId;
const C = "bk_leaf-c" as BackendId;

type FakeStream = {
  url: URL;
  push(frame: string): void;
  end(): void;
  closedByClient(): boolean;
};

type Mux = FakeStream & { nodes: readonly MultiplexedNodeRequest[] };

const encoder = new TextEncoder();

function fakeCommandNode() {
  const own: FakeStream[] = [];
  const shared: Mux[] = [];
  const state = { muxStatus: 200 };
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/__orkestrator/status")) return new Response("{}");
    const isMux = url.pathname === "/__orkestrator/nodes/events";
    if (isMux && state.muxStatus === 0) throw new TypeError("Failed to fetch");
    if (isMux && state.muxStatus !== 200) return new Response(null, { status: state.muxStatus });
    if (!isMux && !url.pathname.endsWith("/__orkestrator/events")) {
      return new Response(null, { status: 404 });
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        closed = true;
      },
    });
    const stream: FakeStream = {
      url,
      push: (frame) => controller.enqueue(encoder.encode(frame)),
      end: () => {
        closed = true;
        controller.close();
      },
      closedByClient: () => closed || init?.signal?.aborted === true,
    };
    if (isMux) {
      const query = parseMultiplexedEventsQuery(url.searchParams);
      if (!query.ok) throw new Error(query.error);
      shared.push({ ...stream, nodes: query.nodes });
    } else {
      own.push(stream);
    }
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const openOwn = (nodeId: BackendId) =>
    own.filter(
      (stream) =>
        stream.url.pathname.startsWith(`/__orkestrator/nodes/${nodeId}/`) &&
        !stream.closedByClient(),
    );
  return {
    own,
    shared,
    state,
    openOwn,
    openShared: () => shared.filter((stream) => !stream.closedByClient()),
    /** Long-lived requests the page holds on the command node's origin right now. */
    longLived: () =>
      own.filter((stream) => !stream.closedByClient()).length +
      shared.filter((stream) => !stream.closedByClient()).length,
  };
}

const frame = (id: string, event: string, payload: unknown = {}) =>
  `id: ${id}\ndata: ${JSON.stringify({ event, payload })}\n\n`;
const nodeFrame = (nodeId: BackendId, id: string | null, event: string, payload: unknown = {}) =>
  encodeMultiplexedNodeFrame(nodeId, id, JSON.stringify({ event, payload }));
const nodeState = (node: BackendId, state: "live" | "down" | "refused", reason?: string) =>
  encodeMultiplexedControlFrame({
    event: MULTIPLEXED_NODE_EVENT,
    payload: { node, state, ...(reason ? { reason } : {}) },
  });

const waitFor = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
};

let transports: NodeTransport[] = [];
let streams: MultiplexedRelayStreams[] = [];
let logs: LogCapture;

beforeEach(() => {
  logs = captureLogs();
  happyDOM.setURL(`${CMD}/`);
});

afterEach(() => {
  for (const transport of transports.splice(0)) transport.dispose();
  for (const stream of streams.splice(0)) stream.dispose();
  globalThis.fetch = originalFetch;
  happyDOM.setURL(originalHref);
  logs.restore();
});

function relayStreams(options: MultiplexedRelayStreamsOptions = {}) {
  const created = createMultiplexedRelayStreams({
    reopenDelayMs: 1,
    detachGraceMs: 30,
    reconnectInitialDelayMs: 5,
    reconnectMaxDelayMs: 10,
    ...options,
  });
  streams.push(created);
  return created;
}

const workspaces = new Map<BackendId, string | null>([
  [A, "wa"],
  [B, "wb"],
  [C, "wc"],
]);

/** A relayed node's real transport, listening to its main stream. */
function relayedNode(mux: MultiplexedRelayStreams, nodeId: BackendId) {
  const transport = createNodeTransport({
    baseUrl: `${CMD}/__orkestrator/nodes/${nodeId}`,
    openMainStream: mux.opener(nodeId, () => workspaces.get(nodeId) ?? null),
    eventReconnectDelayMs: 5,
    eventReconnectRandom: () => 0.5,
  });
  transports.push(transport);
  const received: unknown[] = [];
  let resyncs = 0;
  const stopEvents = transport.listen("environment-changed", (payload) => received.push(payload));
  const stopResyncs = transport.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
    resyncs += 1;
  });
  const stop = () => {
    stopEvents();
    stopResyncs();
  };
  return {
    transport,
    received,
    resyncs: () => resyncs,
    state: () => transport.eventStreamConnection.state(),
    stop,
  };
}

/** Opens the shared request's nodes as the command node would. */
function goLive(shared: Mux, ...nodes: BackendId[]) {
  shared.push(
    encodeMultiplexedControlFrame({
      event: MULTIPLEXED_CONNECTED_EVENT,
      payload: { nodes: shared.nodes.map((node) => ({ node: node.nodeId, cursor: node.cursor })) },
    }),
  );
  for (const node of nodes) shared.push(nodeState(node, "live"));
}

describe("multiplexed relay streams", () => {
  test("one relayed node keeps its own stream; a second moves both onto one request", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    await waitFor(() => command.openOwn(A).length === 1, "A's own stream");
    command.openOwn(A)[0]!.push(frame("g:1", "gateway.connected", { status: "fresh" }));
    command.openOwn(A)[0]!.push(frame("g:2", "environment-changed", { id: "a-1" }));
    await waitFor(() => a.received.length === 1, "A's first event");
    expect(command.shared).toHaveLength(0);

    const b = relayedNode(mux, B);
    await waitFor(() => command.shared.length === 1, "the shared request");
    await waitFor(() => command.openOwn(A).length === 0, "A's own stream closed");
    // A was moved over and resumes from its own cursor; B starts fresh.
    await waitFor(() => command.shared.at(-1)!.nodes.length === 2, "both nodes on it");
    const shared = command.shared.at(-1)!;
    expect([...shared.nodes].sort((x, y) => x.nodeId.localeCompare(y.nodeId))).toEqual([
      { nodeId: A, workspaceId: "wa", cursor: "g:2" },
      { nodeId: B, workspaceId: "wb", cursor: null },
    ]);
    expect(command.own.filter((stream) => stream.url.pathname.includes(B))).toHaveLength(0);
    goLive(shared, A, B);
    shared.push(nodeFrame(B, "h:1", "gateway.connected", { status: "fresh" }));
    shared.push(nodeFrame(A, "g:2", "gateway.connected", { status: "caught-up" }));
    shared.push(nodeFrame(A, "g:3", "environment-changed", { id: "a-2" }));
    shared.push(nodeFrame(B, "h:2", "environment-changed", { id: "b-1" }));
    await waitFor(() => a.received.length === 2 && b.received.length === 1, "events per node");
    expect(a.received).toEqual([{ id: "a-1" }, { id: "a-2" }]);
    expect(b.received).toEqual([{ id: "b-1" }]);
    // One long-lived request for both nodes.
    expect(command.longLived()).toBe(1);
    expect(a.state()).toBe("connected");
    expect(b.state()).toBe("connected");
    // The moved node did not refetch: its replay was caught up.
    expect(a.resyncs()).toBe(1);
    expect(b.resyncs()).toBe(1);
  });

  test("a third node joins with one reopen that sends every node's own cursor", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    const b = relayedNode(mux, B);
    await waitFor(
      () => command.openShared().some((shared) => shared.nodes.length === 2),
      "A and B shared",
    );
    const first = command.openShared().at(-1)!;
    goLive(first, A, B);
    first.push(nodeFrame(A, "g:1", "gateway.connected", { status: "fresh" }));
    first.push(nodeFrame(B, "h:1", "gateway.connected", { status: "fresh" }));
    first.push(nodeFrame(A, "g:4", "environment-changed", { id: "a" }));
    await waitFor(() => a.received.length === 1, "A event");

    const c = relayedNode(mux, C);
    await waitFor(
      () => command.openShared().some((shared) => shared.nodes.length === 3),
      "C joined",
    );
    expect(first.closedByClient()).toBe(true);
    const second = command.openShared().at(-1)!;
    expect(Object.fromEntries(second.nodes.map((node) => [node.nodeId, node.cursor]))).toEqual({
      [A]: "g:4",
      [B]: "h:1",
      [C]: null,
    });
    goLive(second, A, B, C);
    second.push(nodeFrame(C, "k:1", "gateway.connected", { status: "fresh" }));
    second.push(nodeFrame(B, "h:2", "environment-changed", { id: "b" }));
    second.push(nodeFrame(C, "k:2", "environment-changed", { id: "c" }));
    await waitFor(() => b.received.length === 1 && c.received.length === 1, "events after reopen");
    // A and B kept their open streams across the reopen.
    expect(a.state()).toBe("connected");
    expect(command.longLived()).toBe(1);
  });

  test("an older command node (404) leaves every node on its own stream for the page", async () => {
    const command = fakeCommandNode();
    command.state.muxStatus = 404;
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    const b = relayedNode(mux, B);
    await waitFor(
      () => command.openOwn(A).length === 1 && command.openOwn(B).length === 1,
      "own streams",
    );
    expect(command.shared).toHaveLength(0);
    expect(mux.snapshot().groups[0]?.unsupported).toBe(true);
    command.openOwn(B)[0]!.push(frame("h:1", "environment-changed", { id: "b" }));
    await waitFor(() => b.received.length === 1, "B on its own stream");
    // A third node never tries the route again.
    relayedNode(mux, C);
    await waitFor(() => command.openOwn(C).length === 1, "C's own stream");
    expect(mux.snapshot().groups[0]?.requests).toBe(1);
    expect(a.state()).toBe("connected");
  });

  test("a 405 is the same; another failure answer falls back for a while, not for good", async () => {
    const command = fakeCommandNode();
    command.state.muxStatus = 405;
    const mux = relayStreams();
    relayedNode(mux, A);
    relayedNode(mux, B);
    await waitFor(() => command.openOwn(B).length === 1, "own streams");
    expect(mux.snapshot().groups[0]?.unsupported).toBe(true);

    const other = fakeCommandNode();
    other.state.muxStatus = 503;
    const later = relayStreams({ fallbackCooldownMs: 1 });
    relayedNode(later, A);
    relayedNode(later, B);
    await waitFor(() => other.openOwn(B).length === 1, "own streams after a 503");
    expect(later.snapshot().groups[0]?.unsupported).toBe(false);

    // No answer at all (a blocked path) is the same: own streams, not a stall.
    const blocked = fakeCommandNode();
    blocked.state.muxStatus = 0;
    const third = relayStreams();
    const a = relayedNode(third, A);
    relayedNode(third, B);
    await waitFor(() => blocked.openOwn(A).length === 1 && blocked.openOwn(B).length === 1, "own");
    blocked.openOwn(A)[0]!.push(frame("g:1", "environment-changed", { id: "a" }));
    await waitFor(() => a.received.length === 1, "A delivered on its own stream");
  });

  test("one node down: only its transport sees the outage, and it re-attaches without a reopen", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    const b = relayedNode(mux, B);
    await waitFor(() => command.openShared().some((s) => s.nodes.length === 2), "shared");
    const shared = command.openShared().at(-1)!;
    goLive(shared, A, B);
    shared.push(nodeFrame(A, "g:1", "gateway.connected", { status: "fresh" }));
    shared.push(nodeFrame(B, "h:1", "gateway.connected", { status: "fresh" }));
    await waitFor(() => a.state() === "connected" && b.state() === "connected", "both connected");
    const requests = mux.snapshot().groups[0]!.requests;

    shared.push(nodeState(A, "down", "upstream-ended"));
    await waitFor(() => a.state() === "disconnected", "A disconnected");
    expect(b.state()).toBe("connected");
    // The leaf comes back on the same request; its connected frame echoes A's cursor.
    shared.push(nodeState(A, "live"));
    shared.push(nodeFrame(A, "g:1", "gateway.connected", { status: "caught-up" }));
    shared.push(nodeFrame(A, "g:2", "environment-changed", { id: "a" }));
    await waitFor(() => a.received.length === 1 && a.state() === "connected", "A back");
    expect(mux.snapshot().groups[0]!.requests).toBe(requests);
    expect(b.received).toEqual([]);
  });

  test("a gap on one node makes only that node re-read", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    const b = relayedNode(mux, B);
    await waitFor(() => command.openShared().some((s) => s.nodes.length === 2), "shared");
    const shared = command.openShared().at(-1)!;
    goLive(shared, A, B);
    shared.push(nodeFrame(A, "g:1", "gateway.connected", { status: "fresh" }));
    shared.push(nodeFrame(B, "h:1", "gateway.connected", { status: "fresh" }));
    await waitFor(() => a.resyncs() === 1 && b.resyncs() === 1, "first reads");
    shared.push(nodeFrame(A, null, "gateway.reconcile-required", { reason: "frame-too-large" }));
    await waitFor(() => a.resyncs() === 2, "A re-reads");
    expect(b.resyncs()).toBe(1);
  });

  test("a refused node goes to its own stream; the other stays shared", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    const b = relayedNode(mux, B);
    await waitFor(() => command.openShared().some((s) => s.nodes.length === 2), "shared");
    const shared = command.openShared().at(-1)!;
    goLive(shared, B);
    shared.push(nodeState(A, "refused", "no-workspace"));
    await waitFor(() => command.openOwn(A).length === 1, "A's own stream");
    command.openOwn(A)[0]!.push(frame("g:1", "environment-changed", { id: "a" }));
    shared.push(nodeFrame(B, "h:1", "environment-changed", { id: "b" }));
    await waitFor(() => a.received.length === 1 && b.received.length === 1, "both delivered");
    expect(mux.snapshot().groups[0]!.nodes.find((node) => node.nodeId === A)?.mode).toBe("own");
  });

  test("the shared request ending fails both streams, and they resume from their own cursors", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    const b = relayedNode(mux, B);
    await waitFor(() => command.openShared().some((s) => s.nodes.length === 2), "shared");
    const first = command.openShared().at(-1)!;
    goLive(first, A, B);
    first.push(nodeFrame(A, "g:5", "gateway.connected", { status: "fresh" }));
    first.push(nodeFrame(B, "h:7", "gateway.connected", { status: "fresh" }));
    await waitFor(() => a.state() === "connected" && b.state() === "connected", "connected");
    first.end();
    await waitFor(
      () => command.shared.length >= 2 && command.shared.at(-1)!.nodes.length === 2,
      "retried",
    );
    const second = command.shared.at(-1)!;
    expect(Object.fromEntries(second.nodes.map((node) => [node.nodeId, node.cursor]))).toEqual({
      [A]: "g:5",
      [B]: "h:7",
    });
    goLive(second, A, B);
    second.push(nodeFrame(A, "g:5", "gateway.connected", { status: "caught-up" }));
    await waitFor(() => a.state() === "connected" && b.state() === "connected", "reconnected");
    expect(command.longLived()).toBe(1);
  });

  test("a node that stops listening leaves the request after its grace", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    const a = relayedNode(mux, A);
    relayedNode(mux, B);
    await waitFor(() => command.openShared().some((s) => s.nodes.length === 2), "shared");
    goLive(command.openShared().at(-1)!, A, B);
    await waitFor(() => a.state() === "connected", "connected");
    a.stop();
    await waitFor(
      () => command.openShared().length === 1 && command.openShared()[0]!.nodes.length === 1,
      "reopened without A",
    );
    expect(command.openShared()[0]!.nodes[0]?.nodeId).toBe(B);
  });

  test("a new workspace for a node is sent on a reopen", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    relayedNode(mux, A);
    relayedNode(mux, B);
    await waitFor(() => command.openShared().some((s) => s.nodes.length === 2), "shared");
    goLive(command.openShared().at(-1)!, A, B);
    workspaces.set(A, "wa-2");
    try {
      mux.refresh(A);
      await waitFor(
        () => command.openShared().some((s) => s.nodes.some((node) => node.workspaceId === "wa-2")),
        "the new workspace",
      );
    } finally {
      workspaces.set(A, "wa");
    }
  });

  test("dispose ends the shared request", async () => {
    const command = fakeCommandNode();
    const mux = relayStreams();
    relayedNode(mux, A);
    relayedNode(mux, B);
    await waitFor(() => command.openShared().length === 1, "shared");
    mux.dispose();
    expect(command.shared.every((shared) => shared.closedByClient())).toBe(true);
  });
});
