import { describe, expect, test } from "bun:test";
import {
  OPENCODE2_MAX_EVENT_FRAME_BYTES,
  OpenCode2SequenceTracker,
  readOpenCode2Events,
  type OpenCode2StreamSignal,
} from "./events.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<OpenCode2StreamSignal[]> {
  const signals: OpenCode2StreamSignal[] = [];
  await readOpenCode2Events(body, (signal) => signals.push(signal));
  return signals;
}

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe("readOpenCode2Events", () => {
  test("parses durable and ephemeral frames, split across chunks", async () => {
    const durable = frame({
      id: "evt_1",
      type: "session.execution.started",
      data: { sessionID: "ses_1" },
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    });
    const delta = frame({ id: "evt_2", type: "session.text.delta", data: { delta: "x" } });
    const signals = await collect(
      streamOf(durable.slice(0, 17), durable.slice(17) + delta.slice(0, 5), delta.slice(5)),
    );
    expect(signals).toEqual([
      {
        kind: "event",
        event: {
          type: "session.execution.started",
          data: { sessionID: "ses_1" },
          durable: { aggregateID: "ses_1", seq: 2 },
        },
      },
      { kind: "event", event: { type: "session.text.delta", data: { delta: "x" } } },
    ]);
  });

  test("accepts CRLF framing and ignores comment and keep-alive frames", async () => {
    const signals = await collect(
      streamOf(": ping\r\n\r\n", `data: ${JSON.stringify({ type: "server.connected" })}\r\n\r\n`),
    );
    expect(signals).toEqual([
      { kind: "event", event: { type: "server.connected", data: undefined } },
    ]);
  });

  test("a malformed frame is a desync, not an exception", async () => {
    const signals = await collect(streamOf("data: {nope\n\n", frame({ data: 1 })));
    expect(signals).toEqual([
      { kind: "desync", reason: "malformed-frame" },
      { kind: "desync", reason: "malformed-frame" },
    ]);
  });

  test("an oversized frame is dropped once and reported, and reading continues", async () => {
    const huge = `data: "${"x".repeat(OPENCODE2_MAX_EVENT_FRAME_BYTES + 10)}"`;
    const signals = await collect(
      streamOf(
        huge.slice(0, OPENCODE2_MAX_EVENT_FRAME_BYTES + 5),
        huge.slice(-10),
        "\n\n",
        frame({ type: "after" }),
      ),
    );
    expect(signals).toEqual([
      { kind: "desync", reason: "oversized-frame" },
      { kind: "event", event: { type: "after", data: undefined } },
    ]);
  });

  test("aborting stops the read", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(frame({ type: "first" })));
      },
    });
    const signals: OpenCode2StreamSignal[] = [];
    const read = readOpenCode2Events(
      body,
      (signal) => {
        signals.push(signal);
        controller.abort();
      },
      controller.signal,
    );
    await read;
    expect(signals).toHaveLength(1);
  });
});

describe("OpenCode2SequenceTracker", () => {
  test("reports first, next, gap and stale per session", () => {
    const tracker = new OpenCode2SequenceTracker();
    expect(tracker.note("ses_a", 1)).toBe("first");
    expect(tracker.note("ses_a", 2)).toBe("next");
    expect(tracker.note("ses_b", 7)).toBe("first");
    expect(tracker.note("ses_a", 4)).toBe("gap");
    expect(tracker.note("ses_a", 4)).toBe("stale");
    expect(tracker.note("ses_a", 3)).toBe("stale");
    tracker.resync("ses_a", 10);
    expect(tracker.note("ses_a", 11)).toBe("next");
  });

  test("stays bounded and restarts an evicted session at first", () => {
    const tracker = new OpenCode2SequenceTracker(2);
    tracker.note("ses_a", 1);
    tracker.note("ses_b", 1);
    tracker.note("ses_c", 1);
    expect(tracker.note("ses_a", 2)).toBe("first");
  });
});

describe("readOpenCode2Events liveness", () => {
  async function lifeOf(...chunks: string[]) {
    const life: boolean[] = [];
    const signals: OpenCode2StreamSignal[] = [];
    await readOpenCode2Events(
      streamOf(...chunks),
      (signal) => signals.push(signal),
      undefined,
      (heartbeat) => life.push(heartbeat),
    );
    return { life, signals };
  }

  test("reports every chunk and every heartbeat comment, never as an event", async () => {
    const connected = frame({ type: "server.connected", data: {} });
    const { life, signals } = await lifeOf(
      connected + ": heartbeat\n\n",
      ": heart",
      "beat\r\n\r\n",
    );
    // Three chunks, two heartbeats (one split across chunks, CRLF-framed).
    expect(life).toEqual([false, true, false, false, true]);
    expect(signals).toEqual([{ kind: "event", event: { type: "server.connected", data: {} } }]);
  });

  test("other comments and a heartbeat beside data are bytes, not heartbeats", async () => {
    const { life, signals } = await lifeOf(": ping\n\n", `: heartbeat\n${frame({ type: "x" })}`);
    expect(life).toEqual([false, false]);
    expect(signals).toEqual([{ kind: "event", event: { type: "x", data: undefined } }]);
  });

  test("bytes inside an oversized frame still count as life", async () => {
    const huge = "x".repeat(OPENCODE2_MAX_EVENT_FRAME_BYTES + 1);
    const { life, signals } = await lifeOf(`data: ${huge}`, `${huge}\n\n`, ": heartbeat\n\n");
    expect(life).toEqual([false, false, false, true]);
    expect(signals).toEqual([{ kind: "desync", reason: "oversized-frame" }]);
  });
});
