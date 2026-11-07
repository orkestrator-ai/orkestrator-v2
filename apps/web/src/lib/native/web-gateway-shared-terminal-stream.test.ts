import { afterEach, expect, mock, test } from "bun:test";
import { createBrowserGatewayApi } from "./web-gateway";

/**
 * Bearer and cross-origin clients read terminal output with `fetch`, and carry
 * every terminal on one filtered stream rather than one request each: on
 * HTTP/1.1 a browser has about six connections per host, and each streaming
 * response can also hold one of the gateway's few gzip slots.
 */
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

type TerminalRequest = {
  events: string[];
  signal: AbortSignal;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  send(event: string, payload: unknown): void;
};

/** Answers every terminal stream request with an open body the test writes to. */
function terminalStreams(): TerminalRequest[] {
  const requests: TerminalRequest[] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const included = url.searchParams.get("includeEvents");
    if (!included) throw new Error(`Unexpected request ${url.pathname}`);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    requests.push({
      events: included.split(","),
      signal: init!.signal!,
      headers: (init?.headers ?? {}) as Record<string, string>,
      credentials: init?.credentials,
      send: (event, payload) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, payload })}\n\n`)),
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return requests;
}

/** An `EventSource` the code under test must not open. */
function recordEventSources(): string[] {
  const opened: string[] = [];
  globalThis.EventSource = class {
    constructor(url: string) {
      opened.push(url);
    }
    close() {}
  } as unknown as typeof EventSource;
  return opened;
}

test("a bearer client carries every terminal on one authenticated fetch stream", async () => {
  const requests = terminalStreams();
  const eventSources = recordEventSources();
  const api = createBrowserGatewayApi({
    baseUrl: "https://workstation.tailnet.ts.net",
    token: "direct-token-123456",
  });
  const payloads = { a: [] as unknown[], b: [] as unknown[], c: [] as unknown[] };
  const stopA = api.listen("terminal-output-a", (payload) => payloads.a.push(payload));
  const stopB = api.listen("terminal-output-b", (payload) => payloads.b.push(payload));
  await flush();

  expect(requests).toHaveLength(1);
  expect(requests[0]!.events).toEqual(["terminal-output-a", "terminal-output-b"]);
  expect(requests[0]!.headers.authorization).toBe("Bearer direct-token-123456");
  expect(requests[0]!.credentials).toBe("omit");
  expect(eventSources).toEqual([]);
  await api.eventStreamReady("terminal-output-a");
  await api.eventStreamReady("terminal-output-b");

  // Each frame reaches only its own terminal's listeners.
  requests[0]!.send("terminal-output-a", { bytesBase64: "YQ==" });
  requests[0]!.send("terminal-output-b", { bytesBase64: "Yg==" });
  await flush();
  expect(payloads.a).toEqual([{ bytesBase64: "YQ==" }]);
  expect(payloads.b).toEqual([{ bytesBase64: "Yg==" }]);

  // A new terminal rebuilds the one stream. The terminals it already carried
  // missed output during the swap, so each is told to re-read its snapshot;
  // the new one has nothing to reconcile against.
  const stopC = api.listen("terminal-output-c", (payload) => payloads.c.push(payload));
  await flush();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.events).toEqual([
    "terminal-output-a",
    "terminal-output-b",
    "terminal-output-c",
  ]);
  await api.eventStreamReady("terminal-output-c");
  expect(payloads.a.at(-1)).toEqual({ desynced: true });
  expect(payloads.b.at(-1)).toEqual({ desynced: true });
  expect(payloads.c).toEqual([]);

  // A terminal re-listening to the same event leaves the filter unchanged, so
  // the stream, and every other terminal's view, stays as it is.
  stopB();
  const stopBAgain = api.listen("terminal-output-b", (payload) => payloads.b.push(payload));
  await api.eventStreamReady("terminal-output-b");
  await flush();
  expect(requests).toHaveLength(2);
  expect(payloads.a.filter((payload) => (payload as { desynced?: boolean }).desynced)).toHaveLength(
    1,
  );

  stopA();
  stopBAgain();
  stopC();
  await flush();
  expect(requests[1]!.signal.aborted).toBe(true);
  expect(requests).toHaveLength(2);
});

test("a cross-origin client without a token shares one credential-free fetch stream", async () => {
  const requests = terminalStreams();
  const eventSources = recordEventSources();
  const api = createBrowserGatewayApi({ baseUrl: "https://elsewhere.example" });
  const stops = ["one", "two", "three", "four", "five", "six", "seven"].map((id) =>
    api.listen(`terminal-output-${id}`, () => undefined),
  );
  await flush();

  expect(requests).toHaveLength(1);
  expect(requests[0]!.events).toHaveLength(7);
  expect(requests[0]!.headers.authorization).toBeUndefined();
  expect(requests[0]!.credentials).toBe("omit");
  expect(eventSources).toEqual([]);
  for (const stop of stops) stop();
  await flush();
  expect(requests[0]!.signal.aborted).toBe(true);
});

test("an EventSource carries the shared stream only when no bearer token has to be sent", async () => {
  const requests = terminalStreams();
  const eventSources = recordEventSources();
  const desktop = createBrowserGatewayApi({
    baseUrl: "http://127.0.0.1:4319",
    terminalEventSource: true,
  });
  const stopDesktop = desktop.listen("terminal-output-a", () => undefined);
  await flush();
  expect(eventSources).toHaveLength(1);
  expect(requests).toHaveLength(0);
  stopDesktop();

  // An `EventSource` cannot send an authorization header.
  const bearer = createBrowserGatewayApi({
    baseUrl: "http://127.0.0.1:4319",
    token: "direct-token-123456",
    terminalEventSource: true,
  });
  const stopBearer = bearer.listen("terminal-output-a", () => undefined);
  await flush();
  expect(eventSources).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.authorization).toBe("Bearer direct-token-123456");
  stopBearer();
  await flush();
});
