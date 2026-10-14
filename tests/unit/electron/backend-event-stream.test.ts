import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  gatewayEventStreamContractScenarios,
  type EventStreamContractAdapter,
} from "@orkestrator/protocol/gateway-event-stream-contract-fixtures";
import { BackendHttpClient } from "../../../apps/desktop/electron/backend-process";
import { nativeWebPlatform } from "../../register-dom";

const originalFetch = globalThis.fetch;
const originalController = globalThis.AbortController;
const originalSignal = globalThis.AbortSignal;
const originalWarn = console.warn;
const originalError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.AbortController = originalController;
  globalThis.AbortSignal = originalSignal;
  console.warn = originalWarn;
  console.error = originalError;
});

/** Happy DOM's URL misreads query strings here, so read the cursor directly. */
function cursorOf(url: string): string | null {
  const match = /[?&]since=([^&]*)/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

const desktopAdapter: EventStreamContractAdapter = {
  start(server, observe, onEvent) {
    globalThis.AbortController = nativeWebPlatform.AbortController;
    globalThis.AbortSignal = nativeWebPlatform.AbortSignal;
    // Malformed frames and closed connections are part of the contract.
    console.warn = mock(() => undefined);
    console.error = mock(() => undefined);
    let attempt = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      attempt += 1;
      const connection = server(attempt, cursorOf(String(input)));
      const encoder = new TextEncoder();
      return new nativeWebPlatform.Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of connection.chunks) controller.enqueue(encoder.encode(chunk));
            if (connection.close) controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
      eventReconnectDelayMs: 5,
    });
    const observed = new Set(observe);
    client.listen((event, payload) => {
      if (observed.has(event)) onEvent(event, payload);
    });
    return { stop: () => client.stopListening() };
  },
};

describe("Electron gateway event stream contract", () => {
  for (const scenario of gatewayEventStreamContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(desktopAdapter);
      expect(actual).toEqual(expected);
    });
  }
});
