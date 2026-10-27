/**
 * Streaming SSE gzip (`--compression on`) behaviour the remote bandwidth
 * qualification relies on (todo 0052): every frame leaves in its own
 * sync-flushed block rather than waiting for a large chunk or the end of the
 * stream, nothing is encoded twice, clients that do not negotiate gzip get
 * identity, replay and keepalives survive compression, and every compressor
 * lease is released on disconnect, gateway stop and credential rotation.
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { constants as zlibConstants, createGunzip, gunzipSync } from "node:zlib";

import type { OrkestratorGateway } from "../src/gateway";
import {
  auxiliaryServers,
  eventClients,
  eventFrames,
  frameId,
  openCompressedEventStream,
  readGatewayMetrics,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

type CompressionGauges = {
  streamingActive: number;
  streamingStarted: number;
  streamingDeclined: number;
  streamingFailures: number;
};

function compressionGauges(gateway: OrkestratorGateway): CompressionGauges {
  return (
    gateway as unknown as { metrics: { snapshot(): { compression: CompressionGauges } } }
  ).metrics.snapshot().compression;
}

/** A raw `/events` request that keeps the undecoded body and the response headers. */
async function openRawEventStream(
  info: { url: string; token: string },
  headers: Record<string, string>,
): Promise<{
  headers: IncomingHttpHeaders;
  body: () => Buffer;
  close: () => void;
}> {
  const parsed = new URL(`${info.url}__orkestrator/events`);
  const chunks: Buffer[] = [];
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: { authorization: `Bearer ${info.token}`, ...headers },
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
  response.on("data", (chunk: Buffer) => chunks.push(chunk));
  return {
    headers: response.headers,
    body: () => Buffer.concat(chunks),
    close: () => response.destroy(),
  };
}

describe("streaming SSE compression", () => {
  test("delivers every small frame in its own flushed block while the stream stays open", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const stream = await openCompressedEventStream(gateway, info);
    // Each frame is far smaller than the compressor's chunk size, so a
    // buffering encoder would hold all of them until the stream ended.
    for (let index = 0; index < 5; index += 1) {
      gateway.emit("environment-changed", { id: `environment-${index}` });
      await waitUntil(
        () => stream.received().includes(`environment-${index}`),
        `Frame ${index} was buffered instead of flushed`,
        500,
      );
    }
    expect(stream.aborted()).toBe(false);
    stream.close();
  });

  test("encodes once: one gunzip yields plain SSE text and the header names gzip once", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const raw = await openRawEventStream(info, { "accept-encoding": "gzip" });
    gateway.emit("environment-changed", { id: "single-encoding" });
    const decoded = () => {
      try {
        return gunzipSync(raw.body(), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("utf8");
      } catch {
        return "";
      }
    };
    await waitUntil(() => decoded().includes("single-encoding"), "Compressed frame never arrived");
    expect(raw.headers["content-encoding"]).toBe("gzip");
    expect(raw.headers.vary).toContain("Accept-Encoding");
    expect(decoded().startsWith(": compression-priming")).toBe(true);
    raw.close();
  });

  test("clients that do not negotiate gzip stream identity and take no compressor", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    for (const acceptEncoding of [undefined, "identity", "gzip;q=0", "br"]) {
      const raw = await openRawEventStream(
        info,
        acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
      );
      gateway.emit("environment-changed", { id: `identity-${acceptEncoding ?? "none"}` });
      await waitUntil(
        () =>
          raw
            .body()
            .toString("utf8")
            .includes(`identity-${acceptEncoding ?? "none"}`),
        `Identity stream for ${acceptEncoding ?? "no header"} never delivered`,
      );
      expect(raw.headers["content-encoding"]).toBeUndefined();
      // The representation still depends on the request header, so caches
      // must key on it.
      expect(raw.headers.vary).toContain("Accept-Encoding");
      raw.close();
    }
    expect(compressionGauges(gateway)).toMatchObject({ streamingStarted: 0, streamingDeclined: 0 });
  });

  test("a compressed reconnect replays the frames after its cursor", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const first = await openCompressedEventStream(gateway, info);
    for (const id of ["replay-a", "replay-b", "replay-c"]) {
      gateway.emit("environment-changed", { id });
    }
    await waitUntil(() => first.received().includes("replay-c"), "First stream missed frames");
    const cursor = frameId(eventFrames(first.received(), "environment-changed")[0]!);
    expect(cursor).not.toBeNull();
    first.close();

    const second = await openCompressedEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor!)}`,
    );
    await waitUntil(() => second.received().includes("replay-c"), "Replay was not delivered");
    const replayed = eventFrames(second.received(), "environment-changed").join("");
    expect(replayed).not.toContain("replay-a");
    expect(replayed).toContain("replay-b");
    // Live frames continue on the same compressed stream after replay.
    gateway.emit("environment-changed", { id: "replay-live" });
    await waitUntil(() => second.received().includes("replay-live"), "Live frame after replay");
    second.close();
  });

  test("a long idle compressed stream keeps delivering decodable keepalives", async () => {
    const { gateway, info } = await startGateway({ compression: "on", keepaliveMs: 20 });
    const stream = await openCompressedEventStream(gateway, info);
    await waitUntil(
      () => stream.received().split(": keepalive").length > 3,
      "Keepalives were not flushed through the compressor",
    );
    gateway.emit("environment-changed", { id: "after-idle" });
    await waitUntil(() => stream.received().includes("after-idle"), "Frame after idle period");
    stream.close();
  });

  test("a disconnect in the middle of a burst releases the compressor without a failure", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const stream = await openCompressedEventStream(gateway, info);
    for (let index = 0; index < 200; index += 1) {
      gateway.emit("environment-changed", { id: `burst-${index}`, padding: "x".repeat(512) });
      if (index === 100) stream.close();
    }
    await waitUntil(() => eventClients(gateway).size === 0, "Client was not unregistered");
    expect((await readGatewayMetrics(info)).compression).toMatchObject({
      streamingActive: 0,
      streamingFailures: 0,
    });
  });

  test("credential rotation and gateway stop release every compressor lease", async () => {
    const { gateway, info } = await startGateway({ compression: "on", env: {} });
    const rotated = await openCompressedEventStream(gateway, info);
    expect(compressionGauges(gateway).streamingActive).toBe(1);
    const replacement = "replacement-token-123456";
    await gateway.setToken(replacement);
    await waitUntil(() => rotated.aborted(), "Stream on the old credential stayed open");
    await waitUntil(
      () => compressionGauges(gateway).streamingActive === 0,
      "Rotation left a compressor lease",
    );
    rotated.close();

    const streams = [
      await openCompressedEventStream(gateway, { ...info, token: replacement }),
      await openCompressedEventStream(gateway, { ...info, token: replacement }),
    ];
    expect(compressionGauges(gateway).streamingActive).toBe(2);
    await gateway.stop();
    await waitUntil(
      () => compressionGauges(gateway).streamingActive === 0,
      "Gateway stop left a compressor lease",
    );
    expect(eventClients(gateway).size).toBe(0);
    for (const stream of streams) stream.close();
  });

  test("a proxied event stream flushes each upstream frame while the upstream stays open", async () => {
    const upstreamWrites: Array<(frame: string) => void> = [];
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      });
      upstreamWrites.push((frame) => response.write(frame));
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "on" });
    const endpoint = new URL(`${info.url}__orkestrator/proxy/loopback/${address.port}/events`);

    let decoded = "";
    let encoding: string | undefined;
    const downstream = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        headers: { authorization: `Bearer ${info.token}`, "accept-encoding": "gzip" },
      },
      (response) => {
        encoding = response.headers["content-encoding"];
        const decoder = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
        response.pipe(decoder);
        decoder.on("data", (chunk: Buffer) => {
          decoded += chunk.toString("utf8");
        });
      },
    );
    downstream.end();
    await waitUntil(() => upstreamWrites.length === 1, "Proxy never reached the upstream");
    for (let index = 0; index < 4; index += 1) {
      upstreamWrites[0]!(`data: proxied-${index}\n\n`);
      await waitUntil(
        () => decoded.includes(`proxied-${index}`),
        `Proxied frame ${index} was buffered`,
        500,
      );
    }
    expect(encoding).toBe("gzip");
    downstream.destroy();
  });
});
