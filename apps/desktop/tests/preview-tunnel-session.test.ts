import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  encodePreviewTunnelFrame,
  parsePreviewTunnelClientFrame,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import { PREVIEW_TUNNEL_MUX } from "@orkestrator/protocol/preview-tunnel-mux";
import { PREVIEW_LIMITS, previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";
import {
  acceptPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import {
  createPreviewHarness,
  type PreviewHarness,
} from "../../backend/src/core/preview-test-support";
import { PreviewTunnelServer } from "../../backend/src/preview-tunnel-server";
import { PreviewTunnelStream } from "../electron/preview-tunnel-client";
import { PreviewTunnelConnector, PreviewTunnelMuxStream } from "../electron/preview-tunnel-session";
import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server";

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

function readAll(stream: Duplex): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

describe("PreviewTunnelConnector (tunnel v2)", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let gateway: Server;
  let tunnel: PreviewTunnelServer;
  let url: string;
  let serviceId: string;
  let upgrades: number;
  let connector: PreviewTunnelConnector;

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "session-app" });
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
    });
    upgrades = 0;
    gateway = createServer((_request, response) => response.end());
    gateway.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}${PREVIEW_TUNNEL_PATH}`;
    connector = new PreviewTunnelConnector({ sessionIdleMs: 50 });
  });

  afterEach(async () => {
    connector.close();
    tunnel.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await fixture.close();
    await harness.cleanup();
  });

  async function attachment(): Promise<PreviewAttachmentDescriptor> {
    return harness.runtime.access.createAttachment({ serviceId, surface: "desktop-tunnel" });
  }

  function open(att: PreviewAttachmentDescriptor) {
    return connector.open(
      { url, attachmentId: att.attachmentId, credential: att.tunnel!.credential },
      att.tunnel!.multiplexSubprotocol !== undefined,
    );
  }

  test("parallel opens share one handshake and HELLO, and the session closes once idle", async () => {
    const att = await attachment();
    const streams = await Promise.all([open(att), open(att), open(att)]);
    expect(upgrades).toBe(1);
    for (const stream of streams) expect(stream).toBeInstanceOf(PreviewTunnelMuxStream);
    expect(connector.stats()).toEqual({ sessions: 1, streams: 3 });
    const responses = streams.map((stream) => {
      const body = readAll(stream);
      stream.end("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
      return body;
    });
    for (const response of await Promise.all(responses)) {
      expect(response.toString()).toStartWith("HTTP/1.1 200");
      expect(response.toString()).toContain('"marker":"session-app"');
    }
    await until(() => connector.stats().sessions === 0);
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().admission).toMatchObject({ admitted: 3, active: 0 });
  });

  test("a stopped reader stalls only its own stream, and resumes with credit", async () => {
    const att = await attachment();
    const stalled = await open(att);
    stalled.write("GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n");
    await until(() => stalled.readableLength > 0);
    // Nothing is reading: the backend stops at one window for this stream.
    await Bun.sleep(150);
    expect(stalled.readableLength).toBeLessThanOrEqual(PREVIEW_TUNNEL_MUX.windowBytes);

    const other = await open(att);
    expect(upgrades).toBe(1);
    const body = readAll(other);
    other.end("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
    expect((await body).toString()).toStartWith("HTTP/1.1 200");

    let read = 0;
    stalled.on("data", (chunk: Buffer) => (read += chunk.length));
    await until(() => read >= 4 * PREVIEW_TUNNEL_MUX.windowBytes);
    stalled.destroy();
    await until(() => tunnel.stats().admission.active === 0);
  });

  test("an upload larger than the window reaches the upstream intact", async () => {
    const att = await attachment();
    const stream = await open(att);
    const payload = Buffer.alloc(PREVIEW_TUNNEL_MUX.windowBytes * 3 + 17);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 239;
    const response = readAll(stream);
    stream.write(
      `POST /echo HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncontent-length: ${payload.length}\r\n\r\n`,
    );
    stream.end(payload);
    const text = (await response).toString();
    expect(text).toStartWith("HTTP/1.1 200");
    expect(text).toContain(`"bytes":${payload.length}`);
    expect(text).toContain(createHash("sha256").update(payload).digest("hex"));
  });

  test("revocation fails the session's streams and the next open is refused", async () => {
    const att = await attachment();
    const stream = await open(att);
    const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    expect(previewErrorFromUnknown(await failed)?.category).toBe("access-expired");
    await until(() => connector.stats().sessions === 0);
    const refused = await open(att).catch((error: unknown) => error);
    expect(previewErrorFromUnknown(refused)?.category).toBe("access-expired");
  });

  test("a cancelled open releases its upstream", async () => {
    const att = await attachment();
    await (await open(att)).destroy();
    const controller = new AbortController();
    const pending = connector.open(
      {
        url,
        attachmentId: att.attachmentId,
        credential: att.tunnel!.credential,
        signal: controller.signal,
      },
      true,
    );
    controller.abort();
    const error = await pending.catch((failure: unknown) => failure);
    expect(previewErrorFromUnknown(error)?.category).toBe("access-expired");
    await until(() => tunnel.stats().admission.active === 0);
  });
});

describe("PreviewTunnelConnector against a v1-only backend", () => {
  test("an attachment without v2, or a server answering v1, gets one v1 socket per connection", async () => {
    let upgrades = 0;
    const backends: PreviewWebSocket[] = [];
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      const backend = acceptPreviewWebSocket(request, socket, head, {
        protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
        maxPayload: PREVIEW_LIMITS.tunnelFrameMaxBytes,
      });
      if (!backend) return;
      backends.push(backend);
      backend.on("message", (data, binary) => {
        if (binary) return;
        const frame = parsePreviewTunnelClientFrame(data.toString());
        if (frame?.type === "open") backend.send(encodePreviewTunnelFrame({ type: "open-ok" }));
      });
      backend.start();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connector = new PreviewTunnelConnector();
    const options = {
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      attachmentId: "att_test",
      credential: "test-credential",
    };
    try {
      // The attachment advertised v2, but this server only speaks v1.
      const first = await connector.open(options, true);
      expect(first).toBeInstanceOf(PreviewTunnelStream);
      const [second, third] = await Promise.all([
        connector.open(options, true),
        connector.open(options, false),
      ]);
      expect(second).toBeInstanceOf(PreviewTunnelStream);
      expect(third).toBeInstanceOf(PreviewTunnelStream);
      expect(upgrades).toBe(3);
      expect(connector.stats()).toEqual({ sessions: 0, streams: 0 });
      for (const stream of [first, second, third]) stream.destroy();
    } finally {
      connector.close();
      for (const backend of backends) backend.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
