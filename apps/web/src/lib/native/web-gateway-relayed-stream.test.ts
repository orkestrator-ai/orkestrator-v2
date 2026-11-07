import { afterEach, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { relayedNodeEventName } from "@orkestrator/protocol/node-events";
import { createBrowserGatewayApi } from "./web-gateway";

const LEAF = relayedNodeEventName("bk_leaf" as BackendId);
const OTHER = relayedNodeEventName("bk_other" as BackendId);

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

type StreamRequest = {
  url: URL;
  signal: AbortSignal;
  headers: Record<string, string>;
  send(id: string | null, event: string, payload: unknown): void;
  end(): void;
};

/** Answers every event stream request with an open body the test writes to. */
function eventStreams(): StreamRequest[] {
  const requests: StreamRequest[] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    requests.push({
      url,
      signal: init!.signal!,
      headers: (init?.headers ?? {}) as Record<string, string>,
      send: (id, event, payload) =>
        controller.enqueue(
          encoder.encode(
            `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify({ event, payload })}\n\n`,
          ),
        ),
      end: () => controller.close(),
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return requests;
}

function bearerApi() {
  return createBrowserGatewayApi({
    baseUrl: "https://workstation.tailnet.ts.net",
    token: "direct-token-123456",
    eventReconnectDelayMs: 1,
    eventReconnectMaxDelayMs: 1,
  });
}

const relayedRequests = (requests: StreamRequest[]) =>
  requests.filter((request) => request.url.searchParams.has("includeEvents"));

test("the main stream asks for no relayed events and never carries a node's filter", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const stopMain = api.listen("resource-changed", () => undefined);
  const stopLeaf = api.listen(LEAF, () => undefined);
  await flush();

  const main = requests.find((request) => !request.url.searchParams.has("includeEvents"))!;
  expect(main.url.searchParams.get("relayedEvents")).toBe("per-node");
  expect(main.url.searchParams.get("excludeEvents")).toBe("terminal-output-");
  stopMain();
  stopLeaf();
});

test("a listener only on a node's name opens that stream and no main stream", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const stop = api.listen(LEAF, () => undefined);
  await flush();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.searchParams.get("includeEvents")).toBe(LEAF);
  expect(requests[0]!.headers.authorization).toBe("Bearer direct-token-123456");
  stop();
});

test("one stream carries every watched node, and each keeps its own frames", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const leaf: unknown[] = [];
  const other: unknown[] = [];
  const stopLeaf = api.listen(LEAF, (payload) => leaf.push(payload));
  const stopOther = api.listen(OTHER, (payload) => other.push(payload));
  await flush();
  await api.eventStreamReady(LEAF);
  await api.eventStreamReady(OTHER);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.searchParams.get("includeEvents")).toBe(`${LEAF},${OTHER}`);
  requests[0]!.send("relay0001:1", LEAF, { kind: "event" });
  requests[0]!.send("relay0001:2", OTHER, { kind: "resync" });
  await flush();
  expect(leaf).toEqual([{ kind: "event" }]);
  expect(other).toEqual([{ kind: "resync" }]);
  stopLeaf();
  stopOther();
});

test("a filter change resumes from the stream's cursor, with no resync for the node it carried", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const leaf: unknown[] = [];
  const stopLeaf = api.listen(LEAF, (payload) => leaf.push(payload));
  await flush();
  requests[0]!.send("relay0001:5", "gateway.connected", { status: "fresh" });
  await flush();
  expect(leaf).toEqual([{ nodeId: "bk_leaf", kind: "resync" }]);
  leaf.length = 0;

  const stopOther = api.listen(OTHER, () => undefined);
  await flush();
  const relayed = relayedRequests(requests);
  expect(relayed).toHaveLength(2);
  expect(relayed[0]!.signal.aborted).toBe(true);
  expect(relayed[1]!.url.searchParams.get("since")).toBe("relay0001:5");
  relayed[1]!.send("relay0001:5", "gateway.connected", { status: "replayed" });
  relayed[1]!.send("relay0001:6", LEAF, { kind: "event" });
  await flush();
  expect(leaf).toEqual([{ kind: "event" }]);
  stopLeaf();
  stopOther();
});

test("an unchanged filter leaves the stream alone; the last release closes it", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const first = api.listen(LEAF, () => undefined);
  const second = api.listen(LEAF, () => undefined);
  await flush();
  expect(relayedRequests(requests)).toHaveLength(1);
  second();
  await flush();
  expect(relayedRequests(requests)).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(false);
  first();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush();
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(relayedRequests(requests)).toHaveLength(1);
});

test("a reconcile on this stream becomes a resync for each watched node, not the whole client", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const connected: unknown[] = [];
  const stopConnected = api.listen("native-event-stream-connected", () => connected.push(true));
  const leaf: unknown[] = [];
  const other: unknown[] = [];
  const stopLeaf = api.listen(LEAF, (payload) => leaf.push(payload));
  const stopOther = api.listen(OTHER, (payload) => other.push(payload));
  await flush();
  const relayed = relayedRequests(requests)[0]!;
  relayed.send("relay0001:7", "gateway.reconcile-required", { reason: "cursor-expired" });
  await flush();
  expect(leaf).toEqual([{ nodeId: "bk_leaf", kind: "resync" }]);
  expect(other).toEqual([{ nodeId: "bk_other", kind: "resync" }]);
  expect(connected).toEqual([]);
  stopConnected();
  stopLeaf();
  stopOther();
});

test("a stream that ends reconnects from its cursor", async () => {
  const requests = eventStreams();
  const api = bearerApi();
  const stop = api.listen(LEAF, () => undefined);
  await flush();
  requests[0]!.send("relay0001:9", "gateway.connected", { status: "fresh" });
  await flush();
  requests[0]!.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flush();
  const relayed = relayedRequests(requests);
  expect(relayed).toHaveLength(2);
  expect(relayed[1]!.url.searchParams.get("since")).toBe("relay0001:9");
  stop();
});

test("a same-origin page reads it with an EventSource, whose ids advance the cursor", async () => {
  const requests = eventStreams();
  const sources: Array<{
    url: string;
    onopen?: () => void;
    onmessage?: (message: { data: string; lastEventId: string }) => void;
    close(): void;
  }> = [];
  globalThis.EventSource = class {
    url: string;
    constructor(url: string) {
      this.url = url;
      sources.push(this as never);
    }
    close() {}
  } as unknown as typeof EventSource;
  const api = createBrowserGatewayApi({
    baseUrl: "http://127.0.0.1:4319",
    terminalEventSource: true,
  });
  const leaf: unknown[] = [];
  const stop = api.listen(LEAF, (payload) => leaf.push(payload));
  await flush();
  expect(requests).toHaveLength(0);
  expect(sources).toHaveLength(1);
  sources[0]!.onopen?.();
  await api.eventStreamReady(LEAF);
  sources[0]!.onmessage?.({
    data: JSON.stringify({ event: LEAF, payload: { kind: "event" } }),
    lastEventId: "relay0001:3",
  });
  expect(leaf).toEqual([{ kind: "event" }]);

  const stopOther = api.listen(OTHER, () => undefined);
  await flush();
  expect(new URL(sources[1]!.url).searchParams.get("since")).toBe("relay0001:3");
  stop();
  stopOther();
});

test("unanswered retry replaces pending connections and leaves open connections alone", async () => {
  const { RelayedEventStream } = await import("@orkestrator/protocol/relayed-event-stream");
  const { ReconnectBackoff } = await import("@orkestrator/protocol/reconnect-backoff");
  const attempts: Array<{
    handlers: import("@orkestrator/protocol/relayed-event-stream").RelayedEventConnectionHandlers;
    close: ReturnType<typeof mock>;
  }> = [];
  const stream = new RelayedEventStream({
    backoff: new ReconnectBackoff({
      initialDelayMs: 10000,
      maxDelayMs: 10000,
      healthyAfterMs: 1000,
    }),
    deliver: () => undefined,
    open: (_events, _since, handlers) => {
      const close = mock(() => undefined);
      attempts.push({ handlers, close });
      return { close };
    },
  });
  stream.add(LEAF);
  await flush();
  stream.retryUnanswered();
  await flush();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.close).toHaveBeenCalledTimes(1);
  attempts[1]!.handlers.onOpen();
  stream.retryUnanswered();
  await flush();
  expect(attempts).toHaveLength(2);
  stream.dropConnection();
  stream.retryWaiting();
  await flush();
  expect(attempts).toHaveLength(3);
  stream.dispose();
});
