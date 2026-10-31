import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  gatewayEventStreamContractScenarios,
  type EventStreamContractAdapter,
} from "@orkestrator/protocol/gateway-event-stream-contract-fixtures";
import {
  terminalInputContractScenarios,
  type TerminalContractAdapter,
} from "@orkestrator/protocol/terminal-input-contract-fixtures";
import { SseFrameDecoder } from "@orkestrator/protocol/gateway-event-stream";
import { createBrowserGatewayApi } from "./web-gateway";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  globalThis.EventSource = originalEventSource;
});

const browserTerminalAdapter: TerminalContractAdapter = {
  create(backend, options = {}) {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const reply = await backend(
        JSON.parse(String(init?.body)) as { command: string; args: Record<string, unknown> },
        init?.signal ?? null,
      );
      return "result" in reply
        ? new Response(JSON.stringify({ result: reply.result }), { status: 200 })
        : new Response(JSON.stringify({ error: reply.error }), { status: reply.status });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputSendTimeoutMs: options.sendTimeoutMs });
    return { invoke: (command, args) => api.invoke(command, args) };
  },
};

/** The direct (bearer) client, whose authoritative stream is a fetch body. */
const browserEventStreamAdapter: EventStreamContractAdapter = {
  start(server, observe, onEvent) {
    // Malformed frames and closed connections are part of the contract.
    console.warn = mock(() => undefined);
    let attempt = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      attempt += 1;
      const connection = server(attempt, new URL(String(input)).searchParams.get("since"));
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of connection.chunks) controller.enqueue(encoder.encode(chunk));
            if (connection.close) controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "contract-token-123456",
      eventReconnectDelayMs: 5,
    });
    const unlisten = observe.map((event) =>
      api.listen(event, (payload: unknown) => onEvent(event, payload)),
    );
    return { stop: () => unlisten.forEach((stop) => stop()) };
  },
};

describe("browser gateway terminal input contract", () => {
  for (const scenario of terminalInputContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(browserTerminalAdapter);
      expect(actual).toEqual(expected);
    });
  }
});

describe("browser gateway event stream contract", () => {
  for (const scenario of gatewayEventStreamContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(browserEventStreamAdapter);
      expect(actual).toEqual(expected);
    });
  }
});

/** Native retries preserve Last-Event-ID; a replaced source resumes via `since`. */
function sameOriginAdapter(nativeRetry: boolean): EventStreamContractAdapter {
  return {
    start(server, observe, onEvent) {
      console.warn = mock(() => undefined);
      globalThis.fetch = mock(async () => new Response("{}")) as unknown as typeof fetch;
      let attempt = 0;
      const sources: ScriptedEventSource[] = [];
      class ScriptedEventSource {
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        readyState = 0;
        addEventListener(_type: string, _listener: () => void): void {}
        lastEventId: string | null = null;
        timer: ReturnType<typeof setTimeout> | null = null;
        closed = false;
        constructor(readonly url: string) {
          sources.push(this);
          this.timer = setTimeout(() => this.connect(), 0);
        }
        connect() {
          if (this.closed) return;
          // This models the browser-owned header taking priority over the URL's
          // original query, which remains fixed across native retries.
          const cursor =
            this.lastEventId ?? new URL(this.url, "http://localhost").searchParams.get("since");
          const connection = server(++attempt, cursor);
          this.readyState = 1;
          this.onopen?.();
          const decoder = new SseFrameDecoder();
          for (const chunk of connection.chunks) {
            for (const frame of decoder.push(chunk)) {
              if (frame.id) this.lastEventId = frame.id;
              if (frame.data)
                this.onmessage?.({ data: frame.data, lastEventId: this.lastEventId ?? "" });
            }
          }
          if (connection.close && !this.closed) {
            this.readyState = nativeRetry ? 0 : 2;
            this.onerror?.();
            if (nativeRetry) this.timer = setTimeout(() => this.connect(), 5);
          }
        }
        close() {
          this.closed = true;
          this.readyState = 2;
          if (this.timer) clearTimeout(this.timer);
        }
      }
      globalThis.EventSource = ScriptedEventSource as unknown as typeof EventSource;
      const api = createBrowserGatewayApi({ eventReconnectDelayMs: 5 });
      const unlisten = observe.map((event) =>
        api.listen(event, (payload: unknown) => onEvent(event, payload)),
      );
      return {
        stop: () => {
          unlisten.forEach((stop) => stop());
          sources.forEach((source) => source.close());
        },
      };
    },
  };
}

for (const nativeRetry of [true, false]) {
  describe(`same-origin EventSource contract (${nativeRetry ? "Last-Event-ID" : "since query"})`, () => {
    for (const scenario of gatewayEventStreamContractScenarios) {
      test(scenario.name, async () => {
        const { actual, expected } = await scenario.run(sameOriginAdapter(nativeRetry));
        expect(actual).toEqual(expected);
      });
    }
  });
}
