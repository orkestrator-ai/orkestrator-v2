import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";

import {
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import {
  decodePreviewTunnelMuxData,
  encodePreviewTunnelMuxData,
  encodePreviewTunnelMuxFrame,
  PREVIEW_TUNNEL_MUX,
  PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_OFFERED_SUBPROTOCOLS,
  PREVIEW_TUNNEL_SUBPROTOCOL_V2,
  type PreviewTunnelMuxClientFrame,
} from "@orkestrator/protocol/preview-tunnel-mux";
import {
  connectPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import { compatibilityPathUsage } from "./core/compatibility-path-usage.js";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PreviewTunnelServer } from "./preview-tunnel-server.js";

type PreviewTunnelServerLimits = PreviewHarness["runtime"]["limits"];

type Frame = Record<string, unknown> & { type: string; stream?: number };

interface MuxClient {
  ws: PreviewWebSocket;
  data: Map<number, Buffer[]>;
  closed: Promise<{ code: number; reason: string }>;
  send(frame: PreviewTunnelMuxClientFrame): void;
  next(type: string, stream?: number): Promise<Frame>;
  frames(type: string, stream?: number): Frame[];
  bytes(stream: number): Buffer;
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

describe("PreviewTunnelServer v2 (multiplexed)", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let server: Server;
  let tunnel: PreviewTunnelServer;
  let port: number;
  let serviceId: string;
  const sockets: PreviewWebSocket[] = [];

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "mux-app" });
    harness = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "app",
      targetKind: "backend-host",
      applicationPort: fixture.port,
      addressFamily: "ipv4",
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    serviceId = created.definition.serviceId;
    tunnel = new PreviewTunnelServer({
      runtime: harness.runtime,
      metrics: harness.runtime.metrics,
      helloTimeoutMs: 200,
    });
    server = createServer((_request, response) => response.end("not a tunnel"));
    server.on("upgrade", (request, socket, head) => {
      if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
    await harness.cleanup();
  });

  async function connect(
    protocol: string | readonly string[] = PREVIEW_TUNNEL_OFFERED_SUBPROTOCOLS,
  ) {
    const ws = await connectPreviewWebSocket({
      url: `ws://127.0.0.1:${port}${PREVIEW_TUNNEL_PATH}`,
      protocol,
      maxPayload: 1024 * 1024,
      connectTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
    });
    sockets.push(ws);
    return ws;
  }

  async function open(): Promise<MuxClient> {
    const ws = await connect();
    expect(ws.protocol).toBe(PREVIEW_TUNNEL_SUBPROTOCOL_V2);
    const control: Frame[] = [];
    const data = new Map<number, Buffer[]>();
    const waiters: Array<{ type: string; stream?: number; resolve: (frame: Frame) => void }> = [];
    const matches = (frame: Frame, type: string, stream?: number) =>
      frame.type === type && (stream === undefined || frame.stream === stream);
    ws.on("message", (payload, binary) => {
      if (binary) {
        const decoded = decodePreviewTunnelMuxData(payload)!;
        const list = data.get(decoded.stream) ?? [];
        list.push(Buffer.from(decoded.data));
        data.set(decoded.stream, list);
        return;
      }
      const frame = JSON.parse(String(payload)) as Frame;
      control.push(frame);
      const index = waiters.findIndex((waiter) => matches(frame, waiter.type, waiter.stream));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason })),
    );
    ws.start();
    return {
      ws,
      data,
      closed,
      send: (frame) => ws.send(encodePreviewTunnelMuxFrame(frame)),
      next: (type, stream) =>
        new Promise((resolve) => {
          const seen = control.find((frame) => matches(frame, type, stream));
          if (seen) resolve(seen);
          else waiters.push({ type, stream, resolve });
        }),
      frames: (type, stream) => control.filter((frame) => matches(frame, type, stream)),
      bytes: (stream) => Buffer.concat(data.get(stream) ?? []),
    };
  }

  async function attachment(): Promise<PreviewAttachmentDescriptor> {
    return harness.runtime.access.createAttachment({ serviceId, surface: "desktop-tunnel" });
  }

  async function ready(client: MuxClient) {
    const att = await attachment();
    client.send({
      type: "hello",
      version: 2,
      attachmentId: att.attachmentId,
      credential: att.tunnel!.credential,
    });
    expect(await client.next("ready")).toMatchObject({ serviceId });
    return att;
  }

  async function openStream(client: MuxClient, stream: number) {
    client.send({ type: "open", stream });
    expect(await client.next("open-ok", stream)).toEqual({ type: "open-ok", stream });
  }

  function write(client: MuxClient, stream: number, text: string | Buffer) {
    const bytes = typeof text === "string" ? Buffer.from(text) : text;
    for (let offset = 0; offset < bytes.length; offset += PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES)
      client.ws.send(
        encodePreviewTunnelMuxData(
          stream,
          bytes.subarray(offset, offset + PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES),
        ),
        true,
      );
  }

  test("attachments advertise v2, and a client offering only v1 still gets v1", async () => {
    expect((await attachment()).tunnel).toMatchObject({
      subprotocol: PREVIEW_TUNNEL_SUBPROTOCOL,
      multiplexSubprotocol: PREVIEW_TUNNEL_SUBPROTOCOL_V2,
    });
    const v1Count = () => compatibilityPathUsage.snapshot().paths["preview.tunnel-v1"]?.count ?? 0;
    const before = v1Count();
    await connect();
    expect(v1Count()).toBe(before);
    expect((await connect(PREVIEW_TUNNEL_SUBPROTOCOL)).protocol).toBe(PREVIEW_TUNNEL_SUBPROTOCOL);
    // An older desktop's socket is counted for retiring the v1 path.
    expect(v1Count()).toBe(before + 1);
  });

  test("several HTTP exchanges share one authenticated socket, each on its own upstream", async () => {
    const client = await open();
    await ready(client);
    const ids = [1, 2, 3];
    for (const id of ids) await openStream(client, id);
    for (const id of ids)
      write(
        client,
        id,
        `GET /health?n=${id} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`,
      );
    for (const id of ids) await client.next("closed", id);
    for (const id of ids) {
      expect(client.bytes(id).toString()).toStartWith("HTTP/1.1 200");
      expect(client.bytes(id).toString()).toContain('"marker":"mux-app"');
    }
    expect(tunnel.stats()).toMatchObject({ sockets: 1, sessions: 1 });
    expect(tunnel.stats().admission).toMatchObject({ admitted: 3, active: 0 });
    // The session outlives its streams and takes another.
    await openStream(client, 4);
    expect(tunnel.stats().admission.active).toBe(1);
    client.ws.close(1000);
    await client.closed;
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats()).toMatchObject({ sockets: 0, sessions: 0, aggregateQueuedBytes: 0 });
    expect(tunnel.stats().admission.active).toBe(0);
  });

  test("a stream whose reader stopped stalls at its window without stalling another", async () => {
    const client = await open();
    await ready(client);
    await openStream(client, 1);
    await openStream(client, 2);
    // Stream 1 never returns credit, like paused media.
    write(client, 1, "GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n");
    await until(() => client.bytes(1).length >= PREVIEW_TUNNEL_MUX.windowBytes);
    write(client, 2, "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
    await client.next("closed", 2);
    expect(client.bytes(2).toString()).toStartWith("HTTP/1.1 200");
    await Bun.sleep(100);
    expect(client.bytes(1).length).toBe(PREVIEW_TUNNEL_MUX.windowBytes);
    // Credit releases exactly that much more.
    client.send({ type: "credit", stream: 1, bytes: PREVIEW_TUNNEL_MUX.windowBytes });
    await until(() => client.bytes(1).length >= 2 * PREVIEW_TUNNEL_MUX.windowBytes);
    await Bun.sleep(100);
    expect(client.bytes(1).length).toBe(2 * PREVIEW_TUNNEL_MUX.windowBytes);
    client.send({ type: "cancel", stream: 1 });
    await until(() => tunnel.stats().admission.active === 0);
    expect(client.frames("closed", 1)).toEqual([]);
  });

  test("an upload larger than the window is credited as the upstream takes it", async () => {
    const client = await open();
    await ready(client);
    await openStream(client, 1);
    const body = Buffer.alloc(PREVIEW_TUNNEL_MUX.windowBytes * 3);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 241;
    write(
      client,
      1,
      `POST /echo HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncontent-length: ${body.length}\r\n\r\n`,
    );
    let sent = 0;
    // The request head already used part of the window.
    const credit = PREVIEW_TUNNEL_MUX.windowBytes - 200;
    while (sent < body.length) {
      const credited = client
        .frames("credit", 1)
        .reduce((total, frame) => total + (frame.bytes as number), 0);
      const allowed = Math.min(body.length, credit + credited - sent);
      if (allowed > 0) {
        write(client, 1, body.subarray(sent, sent + allowed));
        sent += allowed;
      } else await Bun.sleep(5);
    }
    client.send({ type: "eof", stream: 1 });
    await client.next("closed", 1);
    const response = client.bytes(1).toString();
    expect(response).toStartWith("HTTP/1.1 200");
    expect(response).toContain(`"bytes":${body.length}`);
    expect(response).toContain(createHash("sha256").update(body).digest("hex"));
    expect(client.frames("credit", 1).length).toBeGreaterThan(0);
  });

  test("revocation closes the session and every stream on it", async () => {
    const client = await open();
    await ready(client);
    await openStream(client, 1);
    await openStream(client, 2);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    expect((await client.closed).code).toBe(4410);
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().admission.active).toBe(0);
  });

  /** Serve later connections from a tunnel server with these limits. */
  function withLimits(
    overrides: Partial<PreviewTunnelServerLimits>,
    upstream?: ConstructorParameters<typeof PreviewTunnelServer>[0]["upstream"],
  ): PreviewTunnelServer {
    const runtime = Object.create(harness.runtime, {
      limits: { value: { ...harness.runtime.limits, ...overrides } },
    }) as typeof harness.runtime;
    const replacement = new PreviewTunnelServer({
      runtime,
      metrics: harness.runtime.metrics,
      upstream,
    });
    server.removeAllListeners("upgrade");
    server.on("upgrade", (request, socket, head) => {
      if (!replacement.handleUpgrade(request, socket, head)) socket.destroy();
    });
    const previous = tunnel;
    tunnel = replacement;
    previous.close();
    return replacement;
  }

  test("an OPEN refused for capacity leaves the session and its other streams up", async () => {
    withLimits({ tunnelsPerService: 1 });
    const client = await open();
    await ready(client);
    await openStream(client, 1);
    client.send({ type: "open", stream: 2 });
    expect(await client.next("open-failed", 2)).toMatchObject({
      error: { category: "capacity-exceeded" },
    });
    write(client, 1, "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
    await client.next("closed", 1);
    expect(client.bytes(1).toString()).toStartWith("HTTP/1.1 200");
    expect(client.ws.isOpen).toBe(true);
  });

  test("data beyond the granted credit closes the session as a protocol violation", async () => {
    // An upstream that never flushes, so no credit can come back.
    const stuck = new Duplex({ read() {}, write() {} });
    const target = await harness.runtime.registry.acquireTarget(
      serviceId,
      (await attachment()).endpointGeneration,
    );
    spyOn(harness.runtime.registry, "acquireTarget").mockResolvedValue({
      ...target,
      relay: { environmentId: "local", containerId: "controlled", port: fixture.port },
    });
    withLimits({}, { relayConnect: async () => stuck });
    const client = await open();
    await ready(client);
    await openStream(client, 1);
    write(client, 1, Buffer.alloc(PREVIEW_TUNNEL_MUX.windowBytes));
    await Bun.sleep(50);
    expect(client.ws.isOpen).toBe(true);
    write(client, 1, Buffer.alloc(1));
    expect((await client.closed).code).toBe(4400);
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().admission.active).toBe(0);
    expect(stuck.destroyed).toBe(true);
  });

  test.each([
    ["a reused stream id", (client: MuxClient) => client.send({ type: "open", stream: 1 })],
    ["data on a stream never opened", (client: MuxClient) => write(client, 9, "x")],
    [
      "an OPEN naming a destination",
      (client: MuxClient) =>
        client.ws.send(JSON.stringify({ type: "open", stream: 2, host: "127.0.0.1", port: 22 })),
    ],
    ["a v1 frame", (client: MuxClient) => client.ws.send(JSON.stringify({ type: "open" }))],
  ])("%s closes the session as a protocol violation", async (_name, violate) => {
    const client = await open();
    await ready(client);
    await openStream(client, 1);
    violate(client);
    expect((await client.closed).code).toBe(4400);
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().admission.active).toBe(0);
  });

  test("streams cannot be opened before HELLO, nor beyond the per-session bound", async () => {
    const early = await open();
    early.send({ type: "open", stream: 1 });
    expect((await early.closed).code).toBe(4400);

    // Admission allows more upstreams per service than one session may carry.
    withLimits({ tunnelsPerService: 64 });
    const client = await open();
    await ready(client);
    const ws = client.ws;
    for (let id = 1; id <= PREVIEW_TUNNEL_MUX.maxStreams + 1; id += 1)
      ws.send(encodePreviewTunnelMuxFrame({ type: "open", stream: id }));
    expect((await client.closed).code).toBe(4400);
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().admission.active).toBe(0);
  });
});
