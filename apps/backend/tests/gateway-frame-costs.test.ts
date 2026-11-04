import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";

import { OrkestratorGateway } from "../src/gateway";
import type { GatewayEventReplay } from "../src/gateway-event-replay";
import { GzipEventClientWriter, IdentityEventClientWriter } from "../src/gateway-support-extra";
import {
  eventClients,
  eventFrames,
  frameId,
  openCompressedEventStream,
  openEventStream,
  readGatewayMetrics,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

function offlineGateway() {
  return new OrkestratorGateway({
    backend: { invoke: mock(async () => null) },
    dataDir: "/tmp",
    rendererRoot: "/tmp",
  });
}

function fakeClient() {
  const writes: Array<{ chunk: string | Buffer; bytes: number | undefined }> = [];
  return {
    writes,
    client: {
      writableLength: 0,
      write: mock((chunk: string | Buffer, bytes?: number) => {
        writes.push({ chunk, bytes });
        return true;
      }),
      destroy: mock(() => undefined),
    },
  };
}

function subscribeAll(gateway: OrkestratorGateway, client: object) {
  (gateway as unknown as { clients: Map<object, unknown> }).clients.set(client, {
    prefixes: null,
    includedPrefixes: null,
    excludedPrefixes: null,
    desyncedSessions: new Set<string>(),
  });
}

function replayOf(gateway: OrkestratorGateway): GatewayEventReplay {
  return (gateway as unknown as { eventReplay: GatewayEventReplay }).eventReplay;
}

describe("gateway event frames are encoded once", () => {
  const byteLength = spyOn(Buffer, "byteLength");
  afterEach(() => byteLength.mockClear());
  /** Metric labels are measured too; only a measured SSE frame is the cost at issue. */
  const frameMeasures = () =>
    byteLength.mock.calls.filter(
      ([value]) => Buffer.isBuffer(value) || String(value).includes("data:"),
    ).length;

  test("an authoritative event writes one buffer to every subscriber and measures nothing", () => {
    const gateway = offlineGateway();
    const first = fakeClient();
    const second = fakeClient();
    subscribeAll(gateway, first.client);
    subscribeAll(gateway, second.client);

    gateway.emit("environment-renamed", { label: "café 🙂" });
    expect(frameMeasures()).toBe(0);

    const written = first.writes[0]!;
    expect(Buffer.isBuffer(written.chunk)).toBe(true);
    expect(second.writes[0]!.chunk).toBe(written.chunk);
    expect(written.bytes).toBe((written.chunk as Buffer).byteLength);
    expect(String(written.chunk)).toContain('"label":"café 🙂"');
    replayOf(gateway).releaseRetained();
  });

  test("a droppable event is encoded on first match and shared the same way", () => {
    const gateway = offlineGateway();
    const first = fakeClient();
    const second = fakeClient();
    subscribeAll(gateway, first.client);
    subscribeAll(gateway, second.client);

    gateway.emit("terminal-output-session", { bytesBase64: "eA==" });
    expect(frameMeasures()).toBe(0);

    expect(first.writes[0]!.chunk).toBe(second.writes[0]!.chunk);
    expect(String(first.writes[0]!.chunk)).toBe(
      `data: ${JSON.stringify({
        event: "terminal-output-session",
        payload: { bytesBase64: "eA==" },
      })}\n\n`,
    );
  });

  test("replay writes the ring's own buffer, and control frames carry their count", () => {
    const gateway = offlineGateway();
    const replay = replayOf(gateway);
    const frame = replay.append("environment-renamed", { id: "one" });
    const { client, writes } = fakeClient();
    const events = gateway as unknown as {
      writeReplayFrames(client: object, state: object, frames: readonly (typeof frame)[]): boolean;
      clients: Map<object, unknown>;
    };
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: null,
      desyncedSessions: new Set<string>(),
    };
    events.clients.set(client, state);

    expect(events.writeReplayFrames(client, state, [frame])).toBe(true);
    expect(writes).toEqual([{ chunk: frame.message, bytes: frame.encodedBytes }]);
    expect(writes[0]!.chunk).toBe(frame.message);

    const filtered = fakeClient();
    const filteredState = { ...state, prefixes: ["menu-"] };
    events.clients.set(filtered.client, filteredState);
    expect(events.writeReplayFrames(filtered.client, filteredState, [frame])).toBe(true);
    const cursor = filtered.writes[0]!;
    expect(cursor.bytes).toBe(Buffer.from(cursor.chunk as string).byteLength);
    replay.releaseRetained();
  });

  test("the writers trust a passed byte count and still measure a bare string", () => {
    const seen: number[] = [];
    const metrics = { sourceBytes: (bytes: number) => seen.push(bytes), encodedBytes: () => {} };
    const response = new EventEmitter() as unknown as ServerResponse;
    const responseWrites: unknown[] = [];
    (response as unknown as { write(chunk: unknown): boolean }).write = (chunk) => {
      responseWrites.push(chunk);
      return true;
    };
    const writer = new IdentityEventClientWriter(response, metrics);
    const frame = Buffer.from("data: é\n\n");

    writer.write(frame, 12_345);
    expect(byteLength).not.toHaveBeenCalled();
    expect(responseWrites[0]).toBe(frame);
    expect(seen).toEqual([12_345]);

    writer.write(": keepalive é\n\n");
    expect(seen).toEqual([12_345, Buffer.from(": keepalive é\n\n").byteLength]);
  });

  test("the gzip writer accounts a frame by its passed count and compresses its bytes", async () => {
    const seen: number[] = [];
    const body: Buffer[] = [];
    const response = new EventEmitter() as EventEmitter & {
      write(chunk: Buffer): boolean;
      end(): void;
      destroyed: boolean;
      destroy(): void;
      writableLength: number;
    };
    response.write = (chunk) => {
      body.push(Buffer.from(chunk));
      return true;
    };
    response.end = () => {};
    response.destroyed = false;
    response.destroy = () => {};
    response.writableLength = 0;
    const writer = new GzipEventClientWriter(response as unknown as ServerResponse, {
      sourceBytes: (bytes) => seen.push(bytes),
      encodedBytes: () => {},
    });
    const frame = Buffer.from("data: café 🙂\n\n");

    writer.write(frame, frame.byteLength);
    expect(byteLength).not.toHaveBeenCalled();
    expect(seen).toEqual([frame.byteLength]);
    await waitUntil(() => body.length > 0, "The compressor never flushed");
    expect(gunzipSync(Buffer.concat(body), { finishFlush: 2 }).toString("utf8")).toBe(
      "data: café 🙂\n\n",
    );
    writer.destroy();
  });

  test("real streams receive the same multi-byte frame and the metric counts its bytes", async () => {
    const { gateway, info } = await startGateway();
    const first = await openEventStream(gateway, info);
    const second = await openEventStream(gateway, info);
    const payload = { label: "café 🙂" };

    gateway.emit("environment-renamed", payload);
    await waitUntil(
      () =>
        first.received().includes('"label":"café 🙂"') &&
        second.received().includes('"label":"café 🙂"'),
      "Both streams should have received the frame",
    );
    const replay = replayOf(gateway);
    const expected =
      `id: ${replay.latestCursor}\n` +
      `data: ${JSON.stringify({ event: "environment-renamed", payload })}\n\n`;
    expect(eventFrames(first.received(), "environment-renamed")).toEqual(
      eventFrames(second.received(), "environment-renamed"),
    );
    const metrics = await readGatewayMetrics(info);
    expect(metrics.events["environment-renamed"]).toMatchObject({
      frames: 2,
      serializedBytes: Buffer.byteLength(expected) * 2,
    });
    first.close();
    second.close();
  });
});

describe("one frame buffer shared across content codings", () => {
  test("gzip and plain streams all decode the same frame", async () => {
    const { gateway, info } = await startGateway();
    const plain = await openEventStream(gateway, info);
    const firstGzip = await openCompressedEventStream(gateway, info);
    const secondGzip = await openCompressedEventStream(gateway, info);
    const streams = [plain, firstGzip, secondGzip];

    gateway.emit("environment-renamed", { label: "café 🙂" });
    await waitUntil(
      () => streams.every((stream) => stream.received().includes('"label":"café 🙂"')),
      "Every stream should have received the frame",
    );
    const frames = streams.map((stream) => eventFrames(stream.received(), "environment-renamed"));
    expect(frames[0]).toHaveLength(1);
    expect(frames[1]).toEqual(frames[0]!);
    expect(frames[2]).toEqual(frames[0]!);
    for (const stream of streams) stream.close();
  });
});

describe("scoped replay cursor frames", () => {
  type Stream = Awaited<ReturnType<typeof openEventStream>>;

  async function connectThenClose(
    gateway: OrkestratorGateway,
    info: { url: string; token: string },
  ) {
    const initial = await openEventStream(gateway, info, "?events=menu-");
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Scoped cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial scoped stream did not close");
    return cursor;
  }

  /** Frames after the handshake's connected frame, in stream order. */
  function replayFrames(stream: Stream) {
    return stream
      .received()
      .split("\n\n")
      .filter((frame) => frame.includes("data:") && !frame.includes("gateway.connected"))
      .map((frame) => ({
        id: frameId(frame),
        event: /"event":"([^"]+)"/.exec(frame)?.[1],
      }));
  }

  test("a run of skips costs one cursor before the next match and one at the end", async () => {
    const { gateway, info } = await startGateway();
    const cursor = await connectThenClose(gateway, info);
    const replay = replayOf(gateway);
    const emit = (event: string) => {
      gateway.emit(event, { id: event });
      return replay.latestCursor;
    };

    emit("environment-renamed");
    emit("environment-renamed");
    const beforeFirstMatch = emit("environment-renamed");
    const firstMatch = emit("menu-zoom");
    const secondMatch = emit("menu-open");
    emit("environment-renamed");
    const beforeThirdMatch = emit("environment-renamed");
    const thirdMatch = emit("menu-close");
    emit("environment-renamed");
    emit("environment-renamed");
    const finalCursor = emit("environment-renamed");

    const resumed = await openEventStream(
      gateway,
      info,
      `?events=menu-&since=${encodeURIComponent(cursor)}`,
    );
    await waitUntil(
      () => frameId(eventFrames(resumed.received(), "gateway.cursor").at(-1) ?? "") === finalCursor,
      "Scoped replay did not end on the final skipped revision",
    );
    expect(replayFrames(resumed)).toEqual([
      { id: beforeFirstMatch, event: "gateway.cursor" },
      { id: firstMatch, event: "menu-zoom" },
      { id: secondMatch, event: "menu-open" },
      { id: beforeThirdMatch, event: "gateway.cursor" },
      { id: thirdMatch, event: "menu-close" },
      { id: finalCursor, event: "gateway.cursor" },
    ]);
    // `replayed` still counts the whole window, as it did with a frame per skip.
    expect(eventFrames(resumed.received(), "gateway.connected")[0]).toContain('"replayed":11');
    expect(finalCursor).toBe(replay.latestCursor);
    resumed.close();
  });

  test("a window of nothing but skips ends on one cursor at the latest revision", async () => {
    const { gateway, info } = await startGateway();
    const cursor = await connectThenClose(gateway, info);
    for (let index = 0; index < 200; index += 1) {
      gateway.emit("environment-renamed", { index });
    }
    const latest = replayOf(gateway).latestCursor;

    const resumed = await openEventStream(
      gateway,
      info,
      `?events=menu-&since=${encodeURIComponent(cursor)}`,
    );
    await waitUntil(
      () => eventFrames(resumed.received(), "gateway.cursor").length > 0,
      "Scoped replay wrote no cursor",
    );
    expect(replayFrames(resumed)).toEqual([{ id: latest, event: "gateway.cursor" }]);
    resumed.response.destroy();
    resumed.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Resumed stream did not close");

    // That one frame is the whole of what the client needs to come back caught up.
    const again = await openEventStream(
      gateway,
      info,
      `?events=menu-&since=${encodeURIComponent(latest)}`,
    );
    expect(eventFrames(again.received(), "gateway.connected")[0]).toContain('"status":"caught-up"');
    expect(replayFrames(again)).toEqual([]);
    again.close();
  });

  test("a window ending on a match, and an unscoped client, get no trailing cursor", async () => {
    const { gateway, info } = await startGateway();
    const cursor = await connectThenClose(gateway, info);
    const replay = replayOf(gateway);
    gateway.emit("environment-renamed", { id: "skipped" });
    const skipped = replay.latestCursor;
    gateway.emit("menu-zoom", "in");
    const match = replay.latestCursor;

    const scoped = await openEventStream(
      gateway,
      info,
      `?events=menu-&since=${encodeURIComponent(cursor)}`,
    );
    await waitUntil(() => scoped.received().includes("menu-zoom"), "Scoped replay never matched");
    expect(replayFrames(scoped)).toEqual([
      { id: skipped, event: "gateway.cursor" },
      { id: match, event: "menu-zoom" },
    ]);

    const unscoped = await openEventStream(gateway, info, `?since=${encodeURIComponent(cursor)}`);
    await waitUntil(() => unscoped.received().includes("menu-zoom"), "Replay never finished");
    expect(replayFrames(unscoped)).toEqual([
      { id: skipped, event: "environment-renamed" },
      { id: match, event: "menu-zoom" },
    ]);
    scoped.close();
    unscoped.close();
  });

  test("a skip run's cursor at the hard limit drops the client instead of skipping it", () => {
    const gateway = offlineGateway();
    const replay = replayOf(gateway);
    const skipped = replay.append("environment-renamed", { id: "one" });
    const match = replay.append("menu-zoom", "in");
    const { client, writes } = fakeClient();
    client.writableLength = 8 * 1024 * 1024;
    const internals = gateway as unknown as {
      writeReplayFrames(client: object, state: object, frames: readonly unknown[]): boolean;
      clients: Map<object, unknown>;
    };
    const state = {
      prefixes: ["menu-"],
      includedPrefixes: null,
      excludedPrefixes: null,
      desyncedSessions: new Set<string>(),
    };
    internals.clients.set(client, state);

    expect(internals.writeReplayFrames(client, state, [skipped, match])).toBe(false);
    expect(writes).toEqual([]);
    expect(internals.clients.has(client)).toBe(false);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    replay.releaseRetained();
  });
});

describe("oversized replay appends", () => {
  test("are visible in the gateway metrics", async () => {
    const { gateway, info } = await startGateway({
      eventReplay: { maxBytes: 1024, idleRetentionMs: 60_000 },
    });
    const before = (await readGatewayMetrics(info)) as unknown as {
      replay: { ring: { oversizedAppends: number } };
    };
    expect(before.replay.ring.oversizedAppends).toBe(0);

    gateway.emit("environment-renamed", { id: "small" });
    gateway.emit("environment-renamed", { id: "x".repeat(4096) });

    const after = (await readGatewayMetrics(info)) as unknown as {
      replay: { ring: { oversizedAppends: number; retainedFrames: number } };
    };
    expect(after.replay.ring).toMatchObject({ oversizedAppends: 1, retainedFrames: 0 });
  });
});
