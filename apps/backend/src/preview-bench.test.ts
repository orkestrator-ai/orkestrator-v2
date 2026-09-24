import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import {
  encodePreviewTunnelFrame,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import { connectPreviewWebSocket } from "@orkestrator/protocol/preview-websocket";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { certificates, TEST_PREVIEW_DOMAIN } from "./preview-test-pki.js";
import { PreviewTunnelServer } from "./preview-tunnel-server.js";

/**
 * Opt-in route comparison (`ORKESTRATOR_PREVIEW_BENCH=1`): connect plus time to
 * the first response byte for one `GET /health`, on a fresh connection each
 * time, over loopback on one machine. It records numbers for the evidence log;
 * the only assertion is that every route completes.
 */
const enabled = process.env.ORKESTRATOR_PREVIEW_BENCH === "1";
const SAMPLES = Number(process.env.ORKESTRATOR_PREVIEW_BENCH_SAMPLES ?? 200);
const REQUEST = "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n";

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2) };
}

describe.skipIf(!enabled)("preview route latency (loopback, one machine)", () => {
  let fixture: PreviewFixture;
  let harness: PreviewHarness;
  let tunnel: PreviewTunnelServer;
  let gateway: Server;
  let gatewayPort: number;
  let manager: PreviewPublicationManager;
  let publishedPort: number;
  let pki: string;
  let ca: string;
  let serviceId: string;
  let host: string;
  let cookie: string;

  beforeAll(async () => {
    fixture = await startPreviewFixture({ marker: "bench" });
    harness = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "bench",
      targetKind: "backend-host",
      applicationPort: fixture.port,
      addressFamily: "ipv4",
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    serviceId = created.definition.serviceId;

    tunnel = new PreviewTunnelServer({
      runtime: harness.runtime,
      metrics: harness.runtime.metrics,
      logger: { debug: () => undefined, warn: () => undefined },
    });
    gateway = createServer((_request, response) => response.end());
    gateway.on("upgrade", (request, socket, head) => {
      if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayPort = (gateway.address() as AddressInfo).port;

    pki = await mkdtemp(join(tmpdir(), "ork-preview-bench-"));
    certificates(pki);
    ca = await readFile(join(pki, "ca.pem"), "utf8");
    await harness.runtime.updateSettings((current) => ({
      ...current,
      publication: {
        ...current.publication,
        enabled: true,
        domain: TEST_PREVIEW_DOMAIN,
        certFile: join(pki, "leaf.pem"),
        keyFile: join(pki, "leaf.key"),
        listenAddress: "127.0.0.1",
        port: 0,
      },
    }));
    manager = new PreviewPublicationManager({
      runtime: harness.runtime,
      logger: { info: () => undefined, warn: () => undefined },
    });
    await manager.start();
    publishedPort = manager.status().listening!.port;
    const attachment = await harness.runtime.access.createAttachment({
      serviceId,
      surface: "browser-top-level",
    });
    const { code, origin } = harness.runtime.access.consumeBootstrapGrant(
      attachment.attachmentId,
      attachment.bootstrap!.grant,
    );
    host = new URL(origin).hostname;
    const session = harness.runtime.access.consumeSessionCode(code, serviceId);
    cookie = `__Host-orkestrator-preview=${session.session}`;
  });

  afterAll(async () => {
    tunnel?.close();
    gateway?.closeAllConnections();
    gateway?.close();
    await manager?.dispose();
    await fixture?.close();
    await harness?.cleanup();
    if (pki) await rm(pki, { recursive: true, force: true });
  });

  function direct(): Promise<number> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const socket = netConnect({ host: "127.0.0.1", port: fixture.port }, () =>
        socket.write(REQUEST),
      );
      socket.once("data", () => {
        resolve(performance.now() - started);
        socket.destroy();
      });
      socket.once("error", reject);
    });
  }

  let tunnelAttachment: PreviewAttachmentDescriptor | null = null;

  async function viaTunnel(): Promise<number> {
    // The desktop client reuses one attachment for all of a service's
    // connections, so issuance is outside the measured path.
    const attachment = (tunnelAttachment ??= await harness.runtime.access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
    }));
    const started = performance.now();
    const ws = await connectPreviewWebSocket({
      url: `ws://127.0.0.1:${gatewayPort}${PREVIEW_TUNNEL_PATH}`,
      protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
      maxPayload: 1024 * 1024,
      connectTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
    });
    return new Promise((resolve, reject) => {
      ws.on("message", (payload, binary) => {
        if (binary) {
          resolve(performance.now() - started);
          ws.terminate();
          return;
        }
        const frame = JSON.parse(String(payload)) as { type: string };
        if (frame.type === "ready") ws.send(encodePreviewTunnelFrame({ type: "open" }));
        if (frame.type === "open-ok") ws.send(Buffer.from(REQUEST));
      });
      ws.on("close", () => reject(new Error("tunnel closed early")));
      ws.start();
      ws.send(
        encodePreviewTunnelFrame({
          type: "hello",
          version: 1,
          attachmentId: attachment.attachmentId,
          credential: attachment.tunnel!.credential,
        }),
      );
    });
  }

  function published(): Promise<number> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const socket = tlsConnect(
        { host: "127.0.0.1", port: publishedPort, servername: host, ca },
        () =>
          socket.write(
            `GET /health HTTP/1.1\r\nhost: ${host}:${publishedPort}\r\ncookie: ${cookie}\r\nconnection: close\r\n\r\n`,
          ),
      );
      socket.once("data", () => {
        resolve(performance.now() - started);
        socket.destroy();
      });
      socket.once("error", reject);
    });
  }

  test("direct, desktop tunnel, and private origin", async () => {
    const results: Record<string, ReturnType<typeof summary>> = {};
    for (const [name, run] of [
      ["direct", direct],
      ["desktop-tunnel", viaTunnel],
      ["private-origin", published],
    ] as const) {
      for (let warm = 0; warm < 10; warm += 1) await run();
      const samples: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) samples.push(await run());
      results[name] = summary(samples);
    }
    console.log(`[preview-bench] ${JSON.stringify({ unit: "ms", ...results })}`);
    expect(Object.keys(results)).toHaveLength(3);
  }, 120_000);
});
