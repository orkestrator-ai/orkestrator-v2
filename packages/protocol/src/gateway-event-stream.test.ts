import { describe, expect, test } from "bun:test";
import {
  GATEWAY_CONNECTED_EVENT,
  GATEWAY_CURSOR_EVENT,
  GATEWAY_RECONCILE_REQUIRED_EVENT,
  GatewayEventFrameTooLargeError,
  GatewayEventStreamState,
  isGatewayTransportEvent,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  parseGatewayEventData,
  parseSseBlock,
  readSseStream,
  SseFrameDecoder,
} from "./gateway-event-stream";

const envelope = (event: string, payload: unknown = null) => JSON.stringify({ event, payload });

function streamOf(chunks: Array<string | Uint8Array>, onCancel?: () => void) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe("SSE framing", () => {
  test("takes the last id line and joins multi-line data", () => {
    expect(parseSseBlock("id: a:1\nid: a:2\ndata: one\ndata:two")).toEqual({
      id: "a:2",
      data: "one\ntwo",
    });
    expect(parseSseBlock(": comment")).toEqual({ id: null, data: null });
    expect(parseSseBlock("id: a:3")).toEqual({ id: "a:3", data: null });
  });

  test("keeps a named event, last line winning", () => {
    expect(parseSseBlock("event: one\nevent: session.idle\nid: 4\ndata: {}")).toEqual({
      id: "4",
      data: "{}",
      event: "session.idle",
    });
  });

  test("reassembles frames split across chunks, including CRLF boundaries", () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push('data: {"event":"a"')).toEqual([]);
    expect(decoder.push(',"payload":1}\r\n\r\ndata: x\n')).toEqual([
      { id: null, data: '{"event":"a","payload":1}' },
    ]);
    expect(decoder.push("\n")).toEqual([{ id: null, data: "x" }]);
  });

  test("refuses a frame over the byte bound whether or not it was terminated", () => {
    // Three UTF-8 bytes per character: within the limit by length, over it by bytes.
    expect(() => new SseFrameDecoder(8).push("data: €€\n\n")).toThrow(
      GatewayEventFrameTooLargeError,
    );
    expect(() => new SseFrameDecoder(8).push("data: unterminated")).toThrow(
      GatewayEventFrameTooLargeError,
    );
    expect(new SseFrameDecoder(8).push("data: ab\n\n")).toEqual([{ id: null, data: "ab" }]);
  });

  test("counts a surrogate pair as four bytes", () => {
    expect(() => new SseFrameDecoder(9).push("data: 😀\n\n")).toThrow(
      GatewayEventFrameTooLargeError,
    );
    expect(new SseFrameDecoder(10).push("data: 😀\n\n")).toEqual([{ id: null, data: "😀" }]);
  });

  test("reads a body to its end, decoding characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(`data: ${envelope("é")}\n\n`);
    const frames: Array<string | null> = [];
    await readSseStream(
      streamOf([bytes.slice(0, 20), bytes.slice(20)]),
      new AbortController().signal,
      (frame) => frames.push(frame.data),
    );
    expect(frames).toEqual([envelope("é")]);
  });

  test("cancels a still-open body when a frame is too large", async () => {
    let cancelled = false;
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 0123456789"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readSseStream(open, new AbortController().signal, () => undefined, 8),
    ).rejects.toThrow(GatewayEventFrameTooLargeError);
    expect(cancelled).toBe(true);
  });

  test("stops delivering frames once aborted", async () => {
    const controller = new AbortController();
    const seen: Array<string | null> = [];
    await readSseStream(streamOf(["data: a\n\ndata: b\n\n"]), controller.signal, (frame) => {
      seen.push(frame.data);
      controller.abort();
    });
    expect(seen).toEqual(["a"]);
  });

  test("an abort ends a read waiting on a silent connection", async () => {
    const controller = new AbortController();
    // Opens and then never sends or closes, as a half-open route does.
    const silent = new ReadableStream<Uint8Array>({ start() {} });
    const reading = readSseStream(silent, controller.signal, () => undefined);
    setTimeout(() => controller.abort(), 5);
    await reading;
  });

  test("reports every chunk, keepalive comments included", async () => {
    let chunks = 0;
    await readSseStream(
      streamOf([": keepalive\n\n", "data: a\n\n"]),
      new AbortController().signal,
      () => undefined,
      undefined,
      () => chunks++,
    );
    expect(chunks).toBeGreaterThanOrEqual(2);
  });
});

describe("gateway event envelopes", () => {
  test("accepts only object envelopes with a string event", () => {
    expect(parseGatewayEventData(envelope("x", 1))).toEqual({ event: "x", payload: 1 });
    expect(parseGatewayEventData("{not json")).toBeNull();
    expect(parseGatewayEventData("null")).toBeNull();
    expect(parseGatewayEventData(JSON.stringify({ event: 1 }))).toBeNull();
  });

  test("identifies every transport-only event", () => {
    for (const event of [
      GATEWAY_CONNECTED_EVENT,
      GATEWAY_RECONCILE_REQUIRED_EVENT,
      GATEWAY_CURSOR_EVENT,
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    ]) {
      expect(isGatewayTransportEvent(event)).toBe(true);
    }
    expect(isGatewayTransportEvent("environment-updated")).toBe(false);
  });
});

describe("GatewayEventStreamState", () => {
  const connected = (status: unknown) => envelope(GATEWAY_CONNECTED_EVENT, { status });

  test("resyncs once for the first fresh connection, not for replayed reconnects", () => {
    const state = new GatewayEventStreamState();
    expect(state.accept(connected("fresh"), "gen00001:0")).toEqual({ kind: "resync" });
    expect(state.accept(envelope("changed", 1), "gen00001:1")).toEqual({
      kind: "event",
      event: "changed",
      payload: 1,
    });
    expect(state.accept(connected("replayed"), "gen00001:1")).toEqual({ kind: "control" });
    expect(state.accept(connected("caught-up"), "gen00001:1")).toEqual({ kind: "control" });
    // A later "fresh" is impossible once a cursor exists, but must not re-announce.
    expect(state.accept(connected("fresh"), "gen00001:1")).toEqual({ kind: "control" });
    expect(state.cursor).toBe("gen00001:1");
  });

  test("resyncs for every explicit reconciliation", () => {
    const state = new GatewayEventStreamState();
    const reconcile = envelope(GATEWAY_RECONCILE_REQUIRED_EVENT, { reason: "cursor-expired" });
    expect(state.accept(connected("reconcile"), "gen00001:4")).toEqual({ kind: "control" });
    expect(state.accept(reconcile, "gen00002:9")).toEqual({ kind: "resync" });
    expect(state.accept(reconcile, "gen00002:9")).toEqual({ kind: "resync" });
    // Reconciliation counts as the first announcement.
    expect(state.accept(connected("fresh"), "gen00002:9")).toEqual({ kind: "control" });
    expect(state.cursor).toBe("gen00002:9");
  });

  test("ignores missing and malformed connected statuses", () => {
    const state = new GatewayEventStreamState();
    expect(state.accept(envelope(GATEWAY_CONNECTED_EVENT), null)).toEqual({ kind: "control" });
    expect(state.accept(connected(7), null)).toEqual({ kind: "control" });
    expect(state.accept(connected("fresh"), null)).toEqual({ kind: "resync" });
  });

  test("advances the cursor from cursor frames without delivering them", () => {
    const state = new GatewayEventStreamState();
    expect(state.accept(envelope(GATEWAY_CURSOR_EVENT), "gen00001:7")).toEqual({
      kind: "control",
    });
    expect(state.cursor).toBe("gen00001:7");
  });

  test("never lets a server frame impersonate the transport", () => {
    const state = new GatewayEventStreamState();
    expect(state.accept(envelope(NATIVE_EVENT_STREAM_CONNECTED_EVENT), "gen00001:1")).toEqual({
      kind: "control",
    });
  });

  test("keeps the cursor for empty ids and malformed frames", () => {
    const state = new GatewayEventStreamState();
    state.accept(envelope("a"), "gen00001:3");
    expect(state.accept(envelope("b"), "")).toMatchObject({ kind: "event" });
    expect(state.accept("{bad", "gen00001:99")).toEqual({ kind: "malformed" });
    expect(state.cursor).toBe("gen00001:3");
  });
});
