/**
 * `/__orkestrator/nodes/events` (plan item 5005): several relayed leaves' main
 * streams on one request, against real leaf gateways and scripted fake leaves.
 */
import { describe, expect, mock, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { BackendId } from "@orkestrator/protocol/federation";
import { SseFrameDecoder, type SseFrame } from "@orkestrator/protocol/gateway-event-stream";
import {
  MAX_MULTIPLEXED_NODES,
  MULTIPLEXED_RELAY_EVENTS_PATH,
  multiplexedEventsQuery,
  multiplexedFrameNode,
  parseMultiplexedControlFrame,
  type MultiplexedNodeRequest,
} from "@orkestrator/protocol/multiplexed-relay-events";

import { auxiliaryServers, eventClients, startGateway, waitUntil } from "./gateway-test-harness.js";

const A = "bk_leaf-a" as BackendId;
const B = "bk_leaf-b" as BackendId;

type Received = { node: BackendId | null; frame: SseFrame };

/** Reads a multiplexed response with the client's own frame decoder. */
async function openMux(
  base: string,
  token: string,
  nodes: readonly MultiplexedNodeRequest[],
  init: { method?: string } = {},
) {
  const abort = new AbortController();
  const response = await fetch(
    `${base}${MULTIPLEXED_RELAY_EVENTS_PATH}?${multiplexedEventsQuery(nodes)}`,
    { headers: { authorization: `Bearer ${token}` }, signal: abort.signal, ...init },
  );
  const frames: Received[] = [];
  let ended = false;
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    const decoder = new SseFrameDecoder();
    const text = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          for (const frame of decoder.push(text.decode(value, { stream: !done }))) {
            if (frame.data) frames.push({ node: multiplexedFrameNode(frame.event), frame });
          }
          if (done) break;
        }
      } catch {
        // aborted
      } finally {
        ended = true;
      }
    })();
  }
  const control = () =>
    frames
      .filter((entry) => entry.node === null)
      .map((entry) => parseMultiplexedControlFrame(entry.frame.data!));
  const nodeFrames = (node: BackendId) =>
    frames
      .filter((entry) => entry.node === node)
      .map((entry) => ({
        id: entry.frame.id,
        ...(JSON.parse(entry.frame.data!) as { event: string; payload: unknown }),
      }));
  const states = (node: BackendId) =>
    control().flatMap((frame) =>
      frame?.kind === "node" && frame.payload.node === node
        ? [`${frame.payload.state}${frame.payload.reason ? `:${frame.payload.reason}` : ""}`]
        : [],
    );
  return {
    response,
    frames,
    control,
    nodeFrames,
    states,
    ended: () => ended,
    close: () => abort.abort(),
  };
}

function hooks(overrides: Record<string, unknown>) {
  return {
    isPortalOriginAllowed: mock(() => false),
    noteControllerContact: mock(() => undefined),
    ...overrides,
  };
}

async function twoLeaves(options: { open?: Set<string>; keepaliveMs?: number } = {}) {
  const { gateway: leafA, info: a } = await startGateway();
  const { gateway: leafB, info: b } = await startGateway();
  const targets = new Map<BackendId, { baseUrl: string; headers: Record<string, string> }>([
    [A, { baseUrl: a.url, headers: { authorization: `Bearer ${a.token}` } }],
    [B, { baseUrl: b.url, headers: { authorization: `Bearer ${b.token}` } }],
  ]);
  const open = options.open ?? new Set([`wa:${A}`, `wb:${B}`]);
  const { gateway: command, info } = await startGateway({
    ...(options.keepaliveMs ? { keepaliveMs: options.keepaliveMs } : {}),
    nodeHooks: hooks({
      relayTarget: (nodeId: BackendId) => targets.get(nodeId) ?? null,
      relayWorkspaceOpen: (workspaceId: string, nodeId: BackendId) =>
        open.has(`${workspaceId}:${nodeId}`),
    }),
  });
  return { leafA, leafB, command, info, targets, open };
}

const both = (cursorA: string | null = null, cursorB: string | null = null) => [
  { nodeId: A, workspaceId: "wa", cursor: cursorA },
  { nodeId: B, workspaceId: "wb", cursor: cursorB },
];

describe("multiplexed relay event stream", () => {
  test("carries both leaves' main streams, each with its own cursor and connected frame", async () => {
    const { leafA, leafB, info } = await twoLeaves();
    const mux = await openMux(info.url, info.token, both());
    expect(mux.response.status).toBe(200);
    expect(mux.response.headers.get("content-type")).toContain("text/event-stream");
    await waitUntil(
      () => mux.nodeFrames(A).length > 0 && mux.nodeFrames(B).length > 0,
      "both leaves connected",
    );
    // The first frame is the multiplexer's own, echoing the (absent) cursors.
    expect(mux.frames[0]?.node).toBeNull();
    expect(mux.control()[0]).toEqual({
      kind: "connected",
      payload: {
        nodes: [
          { node: A, cursor: null },
          { node: B, cursor: null },
        ],
      },
    });
    expect(mux.frames[0]?.frame.id).toBeNull();
    expect(mux.states(A)).toEqual(["live"]);
    expect(mux.states(B)).toEqual(["live"]);
    expect(mux.nodeFrames(A)[0]).toMatchObject({
      event: "gateway.connected",
      payload: { status: "fresh" },
    });

    leafA.emit("environment-changed", { id: "env-a" });
    leafB.emit("environment-changed", { id: "env-b" });
    // Terminal output never rides a main stream.
    leafA.emit("terminal-output-x", { text: "secret" });
    await waitUntil(
      () =>
        mux.nodeFrames(A).some((frame) => frame.event === "environment-changed") &&
        mux.nodeFrames(B).some((frame) => frame.event === "environment-changed"),
      "both events relayed",
    );
    const eventA = mux.nodeFrames(A).find((frame) => frame.event === "environment-changed")!;
    const eventB = mux.nodeFrames(B).find((frame) => frame.event === "environment-changed")!;
    expect(eventA.payload).toEqual({ id: "env-a" });
    expect(eventB.payload).toEqual({ id: "env-b" });
    expect(eventA.id).toBeTruthy();
    expect(eventB.id).toBeTruthy();
    expect(mux.nodeFrames(A).some((frame) => frame.event.startsWith("terminal-output-"))).toBe(
      false,
    );

    // Closing the request ends both leaf subscriptions.
    expect(eventClients(leafA).size).toBe(1);
    mux.close();
    await waitUntil(
      () => eventClients(leafA).size === 0 && eventClients(leafB).size === 0,
      "leaf streams closed",
    );
  });

  test("a reconnect sends each node's cursor: echoed unchanged, and each leaf replays only its own gap", async () => {
    const { leafA, leafB, info } = await twoLeaves();
    const first = await openMux(info.url, info.token, both());
    // Subscribed on both leaves first: a fresh stream gets only later events.
    await waitUntil(
      () => first.nodeFrames(A).length > 0 && first.nodeFrames(B).length > 0,
      "both connected",
    );
    leafA.emit("environment-changed", { id: "a-1" });
    leafB.emit("environment-changed", { id: "b-1" });
    await waitUntil(
      () =>
        first.nodeFrames(A).some((f) => f.event === "environment-changed") &&
        first.nodeFrames(B).some((f) => f.event === "environment-changed"),
      "first events",
    );
    const cursorA = first.nodeFrames(A).findLast((f) => f.id)!.id!;
    const cursorB = first.nodeFrames(B).findLast((f) => f.id)!.id!;
    first.close();
    await waitUntil(() => eventClients(leafA).size === 0, "first closed");

    leafA.emit("environment-changed", { id: "a-2" });
    leafA.emit("environment-changed", { id: "a-3" });
    const second = await openMux(info.url, info.token, both(cursorA, cursorB));
    await waitUntil(
      () =>
        second.nodeFrames(A).filter((f) => f.event === "environment-changed").length === 2 &&
        second.nodeFrames(B).some((f) => f.event === "gateway.connected"),
      "replayed",
    );
    expect(second.control()[0]).toEqual({
      kind: "connected",
      payload: {
        nodes: [
          { node: A, cursor: cursorA },
          { node: B, cursor: cursorB },
        ],
      },
    });
    // Each leaf's own connected frame echoes the cursor it was given.
    expect(second.nodeFrames(A)[0]).toMatchObject({
      id: cursorA,
      event: "gateway.connected",
      payload: { status: "replayed", replayed: 2 },
    });
    expect(second.nodeFrames(B)[0]).toMatchObject({
      id: cursorB,
      event: "gateway.connected",
      payload: { status: "caught-up" },
    });
    expect(
      second
        .nodeFrames(A)
        .filter((f) => f.event === "environment-changed")
        .map((f) => f.payload),
    ).toEqual([{ id: "a-2" }, { id: "a-3" }]);
    expect(second.nodeFrames(B).some((f) => f.event === "environment-changed")).toBe(false);
    second.close();
  });

  test("refuses a node the client holds no workspace for, and one whose workspace closes", async () => {
    const open = new Set([`wa:${A}`, `wb:${B}`]);
    const { leafA, leafB, info } = await twoLeaves({ open, keepaliveMs: 40 });
    const mux = await openMux(info.url, info.token, [
      { nodeId: A, workspaceId: "wa", cursor: null },
      // A workspace opened for another node is not a grant for this one.
      { nodeId: B, workspaceId: "wa", cursor: null },
    ]);
    await waitUntil(() => mux.states(B).length > 0 && mux.states(A).length > 0, "states");
    expect(mux.states(B)).toEqual(["refused:no-workspace"]);
    expect(mux.states(A)).toEqual(["live"]);
    expect(eventClients(leafB).size).toBe(0);
    leafB.emit("environment-changed", { id: "b" });

    open.delete(`wa:${A}`);
    await waitUntil(
      () => mux.states(A).includes("refused:no-workspace"),
      "lapsed workspace refused",
    );
    await waitUntil(() => eventClients(leafA).size === 0, "leaf stream closed after refusal");
    expect(mux.nodeFrames(B)).toEqual([]);
    mux.close();
  });

  test("bounds and refusals: node count, duplicates, workspaces, method, concurrent streams", async () => {
    const { info } = await twoLeaves();
    const nodes = Array.from({ length: MAX_MULTIPLEXED_NODES + 1 }, (_, index) => ({
      nodeId: `bk_n${index}` as BackendId,
      workspaceId: `w${index}`,
      cursor: null,
    }));
    const tooMany = await openMux(info.url, info.token, nodes);
    expect(tooMany.response.status).toBe(400);
    const url = (query: string) => `${info.url}${MULTIPLEXED_RELAY_EVENTS_PATH}?${query}`;
    const headers = { authorization: `Bearer ${info.token}` };
    expect((await fetch(url(`nodes=${A},${A}&workspace.${A}=wa`), { headers })).status).toBe(400);
    expect((await fetch(url(`nodes=${A}`), { headers })).status).toBe(400);
    expect(
      (await fetch(url(`nodes=${A}&workspace.${A}=wa&since.${A}=${"x".repeat(300)}`), { headers }))
        .status,
    ).toBe(400);
    expect((await fetch(url(""), { headers })).status).toBe(400);
    expect(
      (await fetch(url(`nodes=${A}&workspace.${A}=wa`), { method: "POST", headers })).status,
    ).toBe(405);
    // The client's own command-node credential comes first.
    expect((await fetch(url(`nodes=${A}&workspace.${A}=wa`))).status).toBe(401);

    const { info: capped } = await startGateway({
      nodeEventMultiplexer: { maxStreams: 1 },
      nodeHooks: hooks({ relayTarget: () => null, relayWorkspaceOpen: () => true }),
    });
    const held = await openMux(capped.url, capped.token, both());
    expect(held.response.status).toBe(200);
    const refused = await openMux(capped.url, capped.token, both());
    expect(refused.response.status).toBe(503);
    held.close();
  });

  test("an older command node (no hooks) answers 404, which the client reads as per-node streams", async () => {
    const { info } = await startGateway({ nodeHooks: hooks({ relayTarget: () => null }) });
    const mux = await openMux(info.url, info.token, both());
    expect(mux.response.status).toBe(404);
  });

  test("a client grant cannot use it", async () => {
    const grant = "okg_mux.secret";
    const { info } = await startGateway({
      nodeHooks: hooks({
        relayTarget: () => null,
        relayWorkspaceOpen: () => true,
        authenticateGrant: (token: string) => (token === grant ? Date.now() + 60_000 : null),
      }),
    });
    const mux = await openMux(info.url, grant, both());
    expect(mux.response.status).toBe(403);
  });
});

/** A scripted leaf: each connection's handler gets the request and response. */
async function fakeLeaf(
  handler: (request: IncomingMessage, response: ServerResponse, connection: number) => void,
) {
  let connections = 0;
  const seen: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://leaf.local");
    seen.push(url);
    connections += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    handler(request, response, connections);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  auxiliaryServers.push(server);
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, seen, connections: () => connections };
}

const sse = (id: string | null, event: string, payload: unknown = {}) =>
  `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify({ event, payload })}\n\n`;

async function commandWith(
  targets: Map<BackendId, string>,
  multiplexer: Record<string, number> = {},
) {
  return startGateway({
    nodeEventMultiplexer: {
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
      ...multiplexer,
    },
    nodeHooks: hooks({
      relayTarget: (nodeId: BackendId) => {
        const baseUrl = targets.get(nodeId);
        return baseUrl ? { baseUrl, headers: {} } : null;
      },
      relayWorkspaceOpen: () => true,
    }),
  });
}

describe("multiplexed relay event stream: one node's trouble stays that node's", () => {
  test("a leaf stream that ends is reopened from the last cursor forwarded, and the other node is untouched", async () => {
    const leafA = await fakeLeaf((_request, response, connection) => {
      if (connection === 1) {
        response.write(sse("g:1", "gateway.connected", { status: "fresh" }));
        response.end(sse("g:2", "environment-changed", { id: "a-1" }));
        return;
      }
      response.write(sse("g:2", "gateway.connected", { status: "caught-up" }));
    });
    const leafB = await fakeLeaf((_request, response) => {
      response.write(sse("h:1", "gateway.connected", { status: "fresh" }));
    });
    const { info } = await commandWith(
      new Map([
        [A, leafA.baseUrl],
        [B, leafB.baseUrl],
      ]),
    );
    const mux = await openMux(info.url, info.token, both());
    await waitUntil(() => leafA.connections() === 2, "reopened");
    await waitUntil(() => mux.states(A).length === 3, "down and live again");
    expect(mux.states(A)).toEqual(["live", "down:upstream-ended", "live"]);
    expect(leafA.seen[0]?.searchParams.get("since")).toBeNull();
    expect(leafA.seen[1]?.searchParams.get("since")).toBe("g:2");
    // The leaf's main stream shape: no terminal output, per-node relayed events.
    expect(leafA.seen[0]?.searchParams.get("excludeEvents")).toBe("terminal-output-");
    expect(leafA.seen[0]?.searchParams.get("relayedEvents")).toBe("per-node");
    expect(mux.states(B)).toEqual(["live"]);
    expect(leafB.connections()).toBe(1);
    mux.close();
  });

  test("a node that is not connected is down until it is, then streams", async () => {
    const leafA = await fakeLeaf((_request, response) => {
      response.write(sse("g:1", "gateway.connected", { status: "fresh" }));
    });
    const targets = new Map<BackendId, string>([[B, leafA.baseUrl]]);
    const { info } = await commandWith(targets);
    const mux = await openMux(info.url, info.token, both());
    await waitUntil(() => mux.states(A).length === 1, "A down");
    expect(mux.states(A)).toEqual(["down:not-connected"]);
    targets.set(A, leafA.baseUrl);
    await waitUntil(() => mux.states(A).length === 2, "A live");
    expect(mux.states(A)).toEqual(["down:not-connected", "live"]);
    await waitUntil(() => mux.nodeFrames(A).length === 1, "A connected frame");
    mux.close();
  });

  test("a frame too large to forward restarts that node afresh and asks the client to reconcile it", async () => {
    const leafA = await fakeLeaf((_request, response, connection) => {
      if (connection === 1) {
        response.write(sse("g:1", "gateway.connected", { status: "fresh" }));
        // A chunk of its own, so the frame before it is forwarded first.
        setTimeout(
          () => response.write(sse("g:2", "environment-changed", { padding: "x".repeat(4096) })),
          30,
        );
        return;
      }
      response.write(sse("g:9", "gateway.connected", { status: "fresh" }));
    });
    const { info } = await commandWith(new Map([[A, leafA.baseUrl]]), { maxFrameBytes: 1024 });
    const mux = await openMux(info.url, info.token, [
      { nodeId: A, workspaceId: "wa", cursor: null },
    ]);
    await waitUntil(() => mux.nodeFrames(A).length === 3, "reconnected and reconciled");
    expect(mux.states(A)).toEqual(["live", "down:frame-too-large", "live"]);
    // Afresh: replaying from g:1 would meet the same frame again.
    expect(leafA.seen[1]?.searchParams.get("since")).toBeNull();
    const frames = mux.nodeFrames(A);
    expect(frames.map((frame) => frame.event)).toEqual([
      "gateway.connected",
      "gateway.connected",
      "gateway.reconcile-required",
    ]);
    // The reconcile comes after the new subscription is live, with its cursor.
    expect(frames[1]?.id).toBe("g:9");
    expect(frames[2]?.id).toBeNull();
    mux.close();
  });

  test("a response past its byte bound is closed rather than dropping a frame", async () => {
    const leafA = await fakeLeaf((_request, response) => {
      response.write(sse("g:1", "gateway.connected", { status: "fresh" }));
      response.write(sse("g:2", "environment-changed", { padding: "x".repeat(8192) }));
    });
    const { info, gateway } = await commandWith(new Map([[A, leafA.baseUrl]]), {
      maxQueuedBytes: 4096,
    });
    const mux = await openMux(info.url, info.token, [
      { nodeId: A, workspaceId: "wa", cursor: null },
    ]);
    await waitUntil(() => mux.ended(), "closed");
    expect(mux.nodeFrames(A).map((frame) => frame.event)).toEqual(["gateway.connected"]);
    const multiplexer = (
      gateway as unknown as { context: { nodeEventMultiplexer: { size: number } } }
    ).context.nodeEventMultiplexer;
    expect(multiplexer.size).toBe(0);
  });

  test("a silent leaf stream is reopened", async () => {
    const leafA = await fakeLeaf((_request, response, connection) => {
      if (connection === 1) response.write(sse("g:1", "gateway.connected", { status: "fresh" }));
      else response.write(sse("g:1", "gateway.connected", { status: "caught-up" }));
    });
    const { info } = await commandWith(new Map([[A, leafA.baseUrl]]), { silenceMs: 80 });
    const mux = await openMux(info.url, info.token, [
      { nodeId: A, workspaceId: "wa", cursor: null },
    ]);
    await waitUntil(() => leafA.connections() >= 2, "reopened after silence");
    expect(mux.states(A).slice(0, 2)).toEqual(["live", "down:upstream-silent"]);
    expect(leafA.seen[1]?.searchParams.get("since")).toBe("g:1");
    mux.close();
  });
});
