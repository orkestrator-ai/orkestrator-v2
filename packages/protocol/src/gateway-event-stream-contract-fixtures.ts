/**
 * Transport-neutral contract for consuming the gateway's authoritative event
 * stream, run by every client (the browser gateway's fetch path and the
 * desktop client). Each client's test file supplies an adapter that serves
 * scripted connections to its real stream consumer, then asserts `actual`
 * equals `expected` for every scenario.
 */
import {
  GATEWAY_CONNECTED_EVENT,
  GATEWAY_CURSOR_EVENT,
  GATEWAY_RECONCILE_REQUIRED_EVENT,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
} from "./gateway-event-stream.js";

export interface EventStreamContractConnection {
  /** Raw SSE text, written in order as separate chunks. */
  chunks: string[];
  /** Ends the response after the chunks; otherwise it stays open. */
  close: boolean;
}

/** Serves one connection attempt; `cursor` is the resume point the client sent. */
export type EventStreamContractServer = (
  attempt: number,
  cursor: string | null,
) => EventStreamContractConnection;

export interface EventStreamContractAdapter {
  /**
   * Starts the client's authoritative stream against `server` and forwards
   * every delivered event whose name is in `observe`. The client should retry
   * a closed connection within a few milliseconds.
   */
  start(
    server: EventStreamContractServer,
    observe: readonly string[],
    onEvent: (event: string, payload: unknown) => void,
  ): { stop(): void };
}

export interface EventStreamContractScenario {
  name: string;
  run(adapter: EventStreamContractAdapter): Promise<{ actual: unknown; expected: unknown }>;
}

const GENERATION = "contract1";
const cursorOf = (revision: number) => `${GENERATION}:${revision}`;

const frame = (event: string, payload: unknown, revision?: number): string =>
  `${revision === undefined ? "" : `id: ${cursorOf(revision)}\n`}data: ${JSON.stringify({
    event,
    payload,
  })}\n\n`;

const connected = (status: string, revision: number) =>
  frame(GATEWAY_CONNECTED_EVENT, { generation: GENERATION, revision, status }, revision);

/** Every event a scenario can observe, so leaks of transport frames are visible. */
const OBSERVED = [
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  GATEWAY_CONNECTED_EVENT,
  GATEWAY_RECONCILE_REQUIRED_EVENT,
  GATEWAY_CURSOR_EVENT,
  "changed",
] as const;

/** Runs until `done` returns true for the delivered events, or times out. */
async function collect(
  adapter: EventStreamContractAdapter,
  serve: (attempt: number) => EventStreamContractConnection,
  done: (events: string[]) => boolean,
): Promise<{ events: string[]; payloads: unknown[]; cursors: Array<string | null> }> {
  const events: string[] = [];
  const payloads: unknown[] = [];
  const cursors: Array<string | null> = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream = adapter.start(
    (attempt, cursor) => {
      cursors.push(cursor);
      return serve(attempt);
    },
    OBSERVED,
    (event, payload) => {
      events.push(event);
      payloads.push(payload);
      if (done(events)) finish();
    },
  );
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  try {
    await Promise.race([finished, timeout]);
  } finally {
    stream.stop();
  }
  return { events, payloads, cursors };
}

const quiet = (): EventStreamContractConnection => ({ chunks: [], close: false });

export const gatewayEventStreamContractScenarios: readonly EventStreamContractScenario[] = [
  {
    name: "announces a fresh connection once and resumes a reconnect from its cursor",
    async run(adapter) {
      const result = await collect(
        adapter,
        (attempt) =>
          attempt === 1
            ? { chunks: [connected("fresh", 0), frame("changed", "a", 1)], close: true }
            : attempt === 2
              ? { chunks: [connected("replayed", 1), frame("changed", "b", 2)], close: false }
              : quiet(),
        (events) => events.length >= 3,
      );
      return {
        actual: {
          events: result.events,
          payloads: result.payloads,
          cursors: result.cursors.slice(0, 2),
        },
        expected: {
          events: [NATIVE_EVENT_STREAM_CONNECTED_EVENT, "changed", "changed"],
          payloads: [undefined, "a", "b"],
          cursors: [null, cursorOf(1)],
        },
      };
    },
  },
  {
    name: "announces again when replay cannot cover a disconnect",
    async run(adapter) {
      const result = await collect(
        adapter,
        (attempt) =>
          attempt === 1
            ? { chunks: [connected("fresh", 0)], close: true }
            : attempt === 2
              ? {
                  chunks: [
                    connected("reconcile", 0),
                    frame(GATEWAY_RECONCILE_REQUIRED_EVENT, { reason: "cursor-expired" }, 9),
                    frame("changed", "c", 10),
                  ],
                  close: false,
                }
              : quiet(),
        (events) => events.includes("changed"),
      );
      return {
        actual: result.events,
        expected: [
          NATIVE_EVENT_STREAM_CONNECTED_EVENT,
          NATIVE_EVENT_STREAM_CONNECTED_EVENT,
          "changed",
        ],
      };
    },
  },
  {
    name: "never forwards transport frames or a server-sent connected event",
    async run(adapter) {
      const result = await collect(
        adapter,
        (attempt) =>
          attempt === 1
            ? {
                chunks: [
                  connected("fresh", 0),
                  frame(GATEWAY_CURSOR_EVENT, null, 3),
                  frame(NATIVE_EVENT_STREAM_CONNECTED_EVENT, null, 4),
                  connected("caught-up", 4),
                  frame("changed", "d", 5),
                ],
                close: false,
              }
            : quiet(),
        (events) => events.includes("changed"),
      );
      return {
        actual: result.events,
        expected: [NATIVE_EVENT_STREAM_CONNECTED_EVENT, "changed"],
      };
    },
  },
  {
    name: "cursor frames advance the resume point",
    async run(adapter) {
      const result = await collect(
        adapter,
        (attempt) =>
          attempt === 1
            ? { chunks: [connected("fresh", 0), frame(GATEWAY_CURSOR_EVENT, null, 7)], close: true }
            : attempt === 2
              ? { chunks: [connected("caught-up", 7), frame("changed", "e", 8)], close: false }
              : quiet(),
        (events) => events.includes("changed"),
      );
      return {
        actual: { events: result.events, cursors: result.cursors.slice(0, 2) },
        expected: {
          events: [NATIVE_EVENT_STREAM_CONNECTED_EVENT, "changed"],
          cursors: [null, cursorOf(7)],
        },
      };
    },
  },
  {
    name: "drops malformed frames and reassembles frames split across chunks",
    async run(adapter) {
      const split = frame("changed", "f", 1);
      const result = await collect(
        adapter,
        (attempt) =>
          attempt === 1
            ? {
                chunks: [
                  connected("fresh", 0),
                  "data: {not-json}\n\n",
                  split.slice(0, 17),
                  split.slice(17),
                ],
                close: false,
              }
            : quiet(),
        (events) => events.includes("changed"),
      );
      return {
        actual: { events: result.events, payloads: result.payloads },
        expected: {
          events: [NATIVE_EVENT_STREAM_CONNECTED_EVENT, "changed"],
          payloads: [undefined, "f"],
        },
      };
    },
  },
];
