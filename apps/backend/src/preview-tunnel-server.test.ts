import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  encodePreviewTunnelFrame,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import {
  connectPreviewWebSocket,
  PreviewWebSocketHandshakeError,
  type PreviewWebSocket,
} from "@orkestrator/protocol/preview-websocket";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PreviewMetrics } from "./preview-metrics.js";
import { PreviewTunnelServer } from "./preview-tunnel-server.js";

interface TunnelClient {
  ws: PreviewWebSocket;
  control: Array<Record<string, unknown>>;
  data: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  nextControl(type?: string): Promise<Record<string, unknown>>;
}

describe("PreviewTunnelServer", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let server: Server;
  let tunnel: PreviewTunnelServer;
  let port: number;
  let serviceId: string;
  const clients: PreviewWebSocket[] = [];

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "tunnel-app" });
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
      metrics: new PreviewMetrics(),
      logger: { debug: () => undefined, warn: () => undefined },
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
    for (const client of clients.splice(0)) client.terminate();
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
    await harness.cleanup();
  });

  async function open(
    options: { protocol?: string; headers?: Array<[string, string]>; path?: string } = {},
  ): Promise<TunnelClient> {
    const ws = await connectPreviewWebSocket({
      url: `ws://127.0.0.1:${port}${options.path ?? PREVIEW_TUNNEL_PATH}`,
      protocol: options.protocol ?? PREVIEW_TUNNEL_SUBPROTOCOL,
      maxPayload: 1024 * 1024,
      connectTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
      headers: options.headers,
    });
    clients.push(ws);
    const control: Array<Record<string, unknown>> = [];
    const data: Buffer[] = [];
    const waiters: Array<{ type?: string; resolve: (frame: Record<string, unknown>) => void }> = [];
    ws.on("message", (payload, isBinary) => {
      if (isBinary) {
        data.push(payload);
        return;
      }
      const frame = JSON.parse(String(payload)) as Record<string, unknown>;
      const index = waiters.findIndex((waiter) => !waiter.type || waiter.type === frame.type);
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
      else control.push(frame);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason })),
    );
    ws.start();
    return {
      ws,
      control,
      data,
      closed,
      nextControl: (type) =>
        new Promise((resolve) => {
          const existing = control.find((frame) => !type || frame.type === type);
          if (existing) {
            control.splice(control.indexOf(existing), 1);
            resolve(existing);
          } else waiters.push({ type, resolve });
        }),
    };
  }

  async function rejectedStatus(options: Parameters<typeof open>[0]): Promise<number | null> {
    try {
      await open(options);
      return null;
    } catch (error) {
      return error instanceof PreviewWebSocketHandshakeError ? error.status : -1;
    }
  }

  async function attachment(): Promise<PreviewAttachmentDescriptor> {
    return harness.runtime.access.createAttachment({ serviceId, surface: "desktop-tunnel" });
  }

  async function ready(client: TunnelClient, descriptor?: PreviewAttachmentDescriptor) {
    const att = descriptor ?? (await attachment());
    client.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: att.tunnel!.credential,
      }),
    );
    expect(await client.nextControl("ready")).toMatchObject({
      serviceId,
      endpointGeneration: att.endpointGeneration,
    });
    return att;
  }

  async function exchange(client: TunnelClient, request: string): Promise<string> {
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(Buffer.from(request));
    await client.closed;
    return Buffer.concat(client.data).toString();
  }

  test("carries an HTTP exchange to exactly the authorized service", async () => {
    const client = await open();
    await ready(client);
    const response = await exchange(
      client,
      "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    );
    expect(response).toStartWith("HTTP/1.1 200");
    expect(response).toContain('"marker":"tunnel-app"');
    expect(tunnel.stats()).toMatchObject({ sockets: 0, aggregateQueuedBytes: 0 });
  });

  test("OPEN frames naming a destination are protocol violations", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(JSON.stringify({ type: "open", host: "127.0.0.1", port: 22 }));
    expect((await client.closed).code).toBe(4400);
  });

  test("application bytes before OPEN_OK are refused", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    expect((await client.closed).code).toBe(4400);
  });

  test("wrong credentials, missing hello, and browser origins are rejected", async () => {
    const att = await attachment();
    const wrong = await open();
    wrong.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: "z".repeat(43),
      }),
    );
    expect((await wrong.closed).code).toBe(4401);

    const silent = await open();
    expect((await silent.closed).code).toBe(4408);

    expect(await rejectedStatus({ headers: [["origin", "https://evil.test"]] })).toBe(403);
    expect(await rejectedStatus({ protocol: "something-else" })).toBe(426);
  });

  test("oversized frames close the tunnel", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(Buffer.alloc(harness.runtime.limits.tunnelFrameMaxBytes + 1));
    expect((await client.closed).code).toBe(1009);
  });

  test("revocation and generation change close open tunnels; no replay on reconnect", async () => {
    const client = await open();
    const att = await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(Buffer.from("GET /sse HTTP/1.1\r\nhost: localhost\r\n\r\n"));
    while (!fixture.requests.some((request) => request.path === "/sse")) await Bun.sleep(5);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    expect((await client.closed).code).toBe(4410);

    const again = await open();
    again.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: att.tunnel!.credential,
      }),
    );
    expect((await again.closed).code).toBe(4410);
    expect(fixture.requests.filter((request) => request.path === "/sse")).toHaveLength(1);
  });

  test("half-close delivers the request and the full response", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(
      Buffer.from(
        "POST /echo HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello",
      ),
    );
    client.ws.send(encodePreviewTunnelFrame({ type: "eof" }));
    await client.closed;
    const response = Buffer.concat(client.data).toString();
    expect(response).toContain('"bytes":5');
  });

  test("a stopped reader cannot grow the queue without bound", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    // Stop reading at the TCP level: the server must pause the upstream.
    client.ws.pause();
    client.ws.send(Buffer.from("GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n"));
    await Bun.sleep(300);
    const queued = tunnel.stats().aggregateQueuedBytes;
    expect(queued).toBeLessThanOrEqual(
      harness.runtime.limits.tunnelQueueMaxBytesPerDirection * 2 +
        harness.runtime.limits.tunnelFrameMaxBytes,
    );
    client.ws.terminate();
    await client.closed;
    await Bun.sleep(20);
    expect(tunnel.stats()).toMatchObject({ sockets: 0, aggregateQueuedBytes: 0 });
  });

  test("admission bounds tunnels per service and releases on close", async () => {
    const limit = harness.runtime.limits.tunnelsPerService;
    const descriptor = await attachment();
    const opened: TunnelClient[] = [];
    for (let index = 0; index < limit; index += 1) {
      const client = await open();
      await ready(client, descriptor);
      opened.push(client);
    }
    const extra = await open();
    extra.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: descriptor.attachmentId,
        credential: descriptor.tunnel!.credential,
      }),
    );
    expect((await extra.closed).code).toBe(4429);
    for (const client of opened) client.ws.close();
    await Promise.all(opened.map((client) => client.closed));
    await Bun.sleep(10);
    expect(tunnel.stats().admission.active).toBe(0);
  });

  test("unknown paths are not claimed", async () => {
    expect(await rejectedStatus({ path: "/__orkestrator/terminal" })).toBe(-1);
  });
});
