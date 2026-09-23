import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  encodePreviewTunnelFrame,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
} from "@orkestrator/protocol/preview-access";
import {
  connectPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/preview-websocket";

import {
  createPreviewHarness,
  type PreviewHarness,
} from "../../../apps/backend/src/core/preview-test-support";
import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server";
import {
  auxiliaryServers,
  openTerminalSocket,
  requestUrl,
  startGateway,
} from "./gateway-test-harness.js";

describe("gateway preview integration", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let serviceId: string;

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "gateway-app" });
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
  });

  afterEach(async () => {
    await fixture.close();
    await harness.cleanup();
  });

  async function tunnel(url: string): Promise<{
    ws: PreviewWebSocket;
    frames: Array<Record<string, unknown>>;
    data: Buffer[];
    closed: Promise<number>;
  }> {
    const ws = await connectPreviewWebSocket({
      url: `${url.replace(/^http/, "ws").replace(/\/$/, "")}${PREVIEW_TUNNEL_PATH}`,
      protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
      maxPayload: 1024 * 1024,
      connectTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
    });
    const frames: Array<Record<string, unknown>> = [];
    const data: Buffer[] = [];
    ws.on("message", (payload, binary) =>
      binary ? data.push(payload) : frames.push(JSON.parse(String(payload))),
    );
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.start();
    return { ws, frames, data, closed };
  }

  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await Bun.sleep(5);
    expect(predicate()).toBe(true);
  };

  test("the tunnel reaches the service through the real gateway without a gateway credential", async () => {
    const { info } = await startGateway({ previews: harness.runtime });
    const attachment = await harness.runtime.access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
    });
    const client = await tunnel(info.url);
    client.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: attachment.attachmentId,
        credential: attachment.tunnel!.credential,
      }),
    );
    await until(() => client.frames.some((frame) => frame.type === "ready"));
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await until(() => client.frames.some((frame) => frame.type === "open-ok"));
    client.ws.send(
      Buffer.from("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"),
    );
    await client.closed;
    expect(Buffer.concat(client.data).toString()).toContain('"marker":"gateway-app"');
    // The gateway token never reached the application.
    expect(fixture.requests.at(-1)?.authorization).toBeUndefined();
  });

  test("terminal upgrades are unaffected by the preview route", async () => {
    const { info } = await startGateway({ previews: harness.runtime });
    const { socket } = await openTerminalSocket(info);
    socket.close();
  });

  test("capabilities advertise the tunnel only while the gateway listens", async () => {
    expect(harness.runtime.capabilities().surfaces.desktopTunnel.available).toBe(false);
    const { gateway } = await startGateway({ previews: harness.runtime });
    expect(harness.runtime.capabilities().surfaces.desktopTunnel.available).toBe(true);
    await gateway.stop();
    expect(harness.runtime.capabilities().surfaces.desktopTunnel.available).toBe(false);
  });

  test("credential rotation closes open tunnels and revokes their attachments", async () => {
    const { gateway, info } = await startGateway({ previews: harness.runtime, env: {} });
    const attachment = await harness.runtime.access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
    });
    const client = await tunnel(info.url);
    client.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: attachment.attachmentId,
        credential: attachment.tunnel!.credential,
      }),
    );
    await until(() => client.frames.some((frame) => frame.type === "ready"));
    await gateway.setToken("rotated-token-0123456789abcdef");
    expect(await client.closed).toBe(4410);

    const again = await tunnel(info.url);
    again.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: attachment.attachmentId,
        credential: attachment.tunnel!.credential,
      }),
    );
    expect(await again.closed).toBe(4410);
  });

  test("legacy preview: a stalled upstream is bounded by the headers deadline", async () => {
    const stalled = createServer(() => undefined);
    auxiliaryServers.push(stalled);
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const port = (stalled.address() as AddressInfo).port;
    const { info } = await startGateway({ browserPreviewHeadersTimeoutMs: 100 });
    const started = Date.now();
    const response = await requestUrl(`${info.url}__orkestrator/browser/loopback/${port}/`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(response.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("legacy preview: no-transform responses are not rewritten", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-transform" });
      response.end('<a href="/next">next</a>');
    });
    auxiliaryServers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as AddressInfo).port;
    const { info } = await startGateway();
    const response = await requestUrl(`${info.url}__orkestrator/browser/loopback/${port}/`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('href="/next"');
  });
});
