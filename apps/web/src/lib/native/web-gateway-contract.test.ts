import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  gatewayEventStreamContractScenarios,
  type EventStreamContractAdapter,
} from "@orkestrator/protocol/gateway-event-stream-contract-fixtures";
import {
  terminalInputContractScenarios,
  type TerminalContractAdapter,
} from "@orkestrator/protocol/terminal-input-contract-fixtures";
import { createBrowserGatewayApi } from "./web-gateway";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

const browserTerminalAdapter: TerminalContractAdapter = {
  recovery: "rearm-on-lifecycle",
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
