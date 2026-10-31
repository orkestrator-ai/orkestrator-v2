import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  gatewayEventStreamContractScenarios,
  type EventStreamContractAdapter,
} from "@orkestrator/protocol/gateway-event-stream-contract-fixtures";
import {
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  TERMINAL_EVENT_STREAM_CONNECTED_EVENT,
} from "@orkestrator/protocol/gateway-event-stream";
import { BackendHttpClient } from "../electron/backend-process";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.error = originalError;
});

function cursorOf(url: string): string | null {
  const match = /[?&]since=([^&]*)/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

const desktopAdapter: EventStreamContractAdapter = {
  start(server, observe, onEvent) {
    // Malformed frames and closed connections are part of the contract.
    console.warn = mock(() => undefined);
    console.error = mock(() => undefined);
    let attempt = 0;
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL) => {
        attempt += 1;
        const connection = server(attempt, cursorOf(String(input)));
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
      }),
      { preconnect: originalFetch.preconnect },
    );
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

for (const status of ["caught-up", "replayed"]) {
  test(`quiet terminal snapshot is recovered on a ${status} desktop reconnect`, async () => {
    let snapshot = "before";
    let rendered = "";
    let recoveries = 0;
    let resyncs = 0;
    const cursors: Array<string | null> = [];
    const stream = desktopAdapter.start(
      (attempt, cursor) => {
        cursors.push(cursor);
        if (attempt === 1)
          return {
            chunks: [
              'id: fixture1:1\ndata: {"event":"gateway.connected","payload":{"status":"fresh"}}\n\n',
              'data: {"event":"terminal-output-s","payload":"before"}\n\n' +
                'data: {"event":"terminal-event-stream-connected","payload":null}\n\n',
            ],
            close: true,
          };
        // Output generated during the outage is absent from the replay ring.
        snapshot = "before+missed";
        return {
          chunks: [
            `id: fixture1:1\ndata: {"event":"gateway.connected","payload":{"status":"${status}"}}\n\n`,
          ],
          close: false,
        };
      },
      [
        TERMINAL_EVENT_STREAM_CONNECTED_EVENT,
        NATIVE_EVENT_STREAM_CONNECTED_EVENT,
        "terminal-output-s",
      ],
      (event, payload) => {
        if (event === TERMINAL_EVENT_STREAM_CONNECTED_EVENT) {
          recoveries += 1;
          rendered = snapshot;
        }
        if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) resyncs += 1;
        if (event === "terminal-output-s") rendered = String(payload);
      },
    );
    try {
      const deadline = Date.now() + 1000;
      while (recoveries < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(rendered).toBe("before+missed");
      expect(recoveries).toBe(2);
      expect(resyncs).toBe(1);
      expect(cursors).toEqual([null, "fixture1:1"]);
    } finally {
      stream.stop();
    }
  });
}

test("does not announce a stream response arriving after stopListening", async () => {
  let answer!: (response: Response) => void;
  globalThis.fetch = Object.assign(
    mock(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ),
    { preconnect: originalFetch.preconnect },
  );
  const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token");
  const onEvent = mock(() => undefined);
  const cancelled = mock(() => undefined);
  client.listen(onEvent);
  client.stopListening();
  answer(new Response(new ReadableStream({ cancel: cancelled })));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  expect(onEvent).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledTimes(1);
});

test("a stream that stops its keepalives, or an attempt nothing answers, is given up on", async () => {
  console.error = mock(() => undefined);
  const encoder = new TextEncoder();
  const attempts: Array<{ aborted: boolean; push?: (text: string) => void }> = [];
  globalThis.fetch = Object.assign(
    mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const attempt: (typeof attempts)[number] = { aborted: false };
      attempts.push(attempt);
      // The second attempt is never answered, as on a link that has gone silent.
      const answered = attempts.length !== 2;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          attempt.aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
        if (!answered) return;
        resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                attempt.push = (text) => controller.enqueue(encoder.encode(text));
              },
            }),
            { status: 200 },
          ),
        );
      });
    }),
    { preconnect: originalFetch.preconnect },
  );
  const client = new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
    eventReconnectDelayMs: 1,
  });
  const states: string[] = [];
  client.listen(() => undefined, {
    onStreamState: (state) => states.push(state),
    streamSilenceLimitMs: 40,
    streamConnectTimeoutMs: 40,
  });
  const waitUntil = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await waitUntil(() => states[0] === "open", "The stream never opened");
    // Keepalive comments carry it past the limit.
    for (let tick = 0; tick < 5; tick += 1) {
      attempts[0]!.push?.(": keepalive\n\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(states).toEqual(["open"]);

    await waitUntil(() => states.includes("closed"), "The silent stream was never given up on");
    expect(attempts[0]!.aborted).toBe(true);
    await waitUntil(() => attempts.length >= 3, "The unanswered attempt was never retried");
    expect(attempts[1]!.aborted).toBe(true);
  } finally {
    client.stopListening();
  }
});
