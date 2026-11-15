import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PREVIEW_TUNNEL_PATH } from "@orkestrator/protocol/preview-access";
import {
  decodePreviewTunnelMuxData,
  encodePreviewTunnelMuxData,
  encodePreviewTunnelMuxFrame,
  PREVIEW_TUNNEL_SUBPROTOCOL_V2,
} from "@orkestrator/protocol/preview-tunnel-mux";
import {
  connectPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import { createPreviewHarness, type PreviewHarness } from "../src/core/preview-test-support";
import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server";
import { openTerminalSocket, requestUrl, startGateway } from "./gateway-test-harness.js";

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

  /** A tunnel session; `data` collects the bytes of stream 1, the only one these tests open. */
  async function tunnel(url: string): Promise<{
    ws: PreviewWebSocket;
    frames: Array<Record<string, unknown>>;
    data: Buffer[];
    closed: Promise<number>;
    /** OPEN stream 1, then write `request` on it once the backend answers OPEN_OK. */
    request(request: string): Promise<void>;
  }> {
    const ws = await connectPreviewWebSocket({
      url: `${url.replace(/^http/, "ws").replace(/\/$/, "")}${PREVIEW_TUNNEL_PATH}`,
      protocol: PREVIEW_TUNNEL_SUBPROTOCOL_V2,
      maxPayload: 1024 * 1024,
      connectTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
    });
    const frames: Array<Record<string, unknown>> = [];
    const data: Buffer[] = [];
    ws.on("message", (payload, binary) => {
      if (!binary) return void frames.push(JSON.parse(String(payload)));
      const decoded = decodePreviewTunnelMuxData(payload);
      if (decoded?.stream === 1) data.push(Buffer.from(decoded.data));
    });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.start();
    const request = async (text: string) => {
      ws.send(encodePreviewTunnelMuxFrame({ type: "open", stream: 1 }));
      await until(() => frames.some((frame) => frame.type === "open-ok"));
      ws.send(encodePreviewTunnelMuxData(1, Buffer.from(text)), true);
    };
    return { ws, frames, data, closed, request };
  }

  function hello(
    client: { ws: PreviewWebSocket },
    attachment: { attachmentId: string; tunnel?: { credential: string } },
  ) {
    client.ws.send(
      encodePreviewTunnelMuxFrame({
        type: "hello",
        version: 2,
        attachmentId: attachment.attachmentId,
        credential: attachment.tunnel!.credential,
      }),
    );
  }

  /** The backend released stream 1: its upstream answered and closed. */
  const streamClosed = (client: { frames: Array<Record<string, unknown>> }) =>
    until(() => client.frames.some((frame) => frame.type === "closed" && frame.stream === 1));

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
    hello(client, attachment);
    await until(() => client.frames.some((frame) => frame.type === "ready"));
    await client.request("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
    await streamClosed(client);
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
    hello(client, attachment);
    await until(() => client.frames.some((frame) => frame.type === "ready"));
    await gateway.setToken("rotated-token-0123456789abcdef");
    expect(await client.closed).toBe(4410);

    const again = await tunnel(info.url);
    hello(again, attachment);
    expect(await again.closed).toBe(4410);
  });

  async function helloReady(url: string, runtime = harness.runtime) {
    const attachment = await runtime.access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
    });
    const client = await tunnel(url);
    hello(client, attachment);
    await until(() => client.frames.some((frame) => frame.type === "ready"));
    return { attachment, client };
  }

  test("scoped preview credentials never authenticate gateway routes", async () => {
    const { info } = await startGateway({ previews: harness.runtime });
    const attachment = await harness.runtime.access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
    });
    const scoped = { authorization: `Bearer ${attachment.tunnel!.credential}` };
    const proxy = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${fixture.port}/health`,
      { headers: scoped },
    );
    expect(proxy.status).toBe(401);
    const control = await requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: { ...scoped, "content-type": "application/json" },
      body: JSON.stringify({ command: "get_preview_diagnostics" }),
    });
    expect(control.status).toBe(401);
    expect(fixture.requests).toHaveLength(0);
  });

  test("the removed legacy preview route serves no preview", async () => {
    const { info } = await startGateway({ previews: harness.runtime });
    const response = await requestUrl(
      `${info.url}__orkestrator/browser/loopback/${fixture.port}/health`,
      { headers: { authorization: `Bearer ${info.token}` } },
    );
    expect(response.body).not.toContain("gateway-app");
    expect(fixture.requests).toHaveLength(0);
  });

  test("rollback drill: stop issuance, revoke, preserve services, re-enable and reconnect", async () => {
    // Driven by stored settings only: an environment override would pin the switch.
    const runtime = harness.newRuntime({ env: {} });
    await runtime.init();
    await runtime.updateSettings((current) => ({ ...current, transport: true }));
    const { info } = await startGateway({ previews: runtime });
    // An active streaming exchange and a hidden (idle, ready) tunnel.
    const streaming = await helloReady(info.url, runtime);
    await streaming.client.request("GET /sse HTTP/1.1\r\nhost: localhost\r\n\r\n");
    await until(() => Buffer.concat(streaming.client.data).includes("data:"));
    const hidden = await helloReady(info.url, runtime);

    // 1. Stop minting new access; capabilities say why.
    await runtime.updateSettings((current) => ({ ...current, transport: false }));
    const capabilities = runtime.capabilities();
    expect(capabilities.surfaces.desktopTunnel.available).toBe(false);
    expect(capabilities.surfaces.desktopTunnel.reason).toContain("disabled");
    await expect(
      runtime.access.createAttachment({ serviceId, surface: "desktop-tunnel" }),
    ).rejects.toThrow();

    // 2. Revoke active access: every tunnel closes with the revoked code.
    expect(runtime.access.revokeAll("operator-revoked")).toBeGreaterThanOrEqual(2);
    expect(await streaming.client.closed).toBe(4410);
    expect(await hidden.client.closed).toBe(4410);

    // 3. Service definitions and the application itself are untouched.
    expect(runtime.registry.getDefinition(serviceId)).not.toBeNull();
    expect(fixture.server.listening).toBe(true);

    // 4. Re-enable: fresh access reaches the same service identity, and
    //    nothing from the revoked streams is replayed.
    await runtime.updateSettings((current) => ({ ...current, transport: true }));
    const requestsBefore = fixture.requests.length;
    const again = await helloReady(info.url, runtime);
    expect(again.client.frames.find((frame) => frame.type === "ready")).toMatchObject({
      serviceId,
    });
    await again.client.request(
      "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    );
    await streamClosed(again.client);
    expect(Buffer.concat(again.client.data).toString()).toContain('"marker":"gateway-app"');
    expect(fixture.requests.slice(requestsBefore).map((request) => request.path)).toEqual([
      "/health",
    ]);
  });
});
