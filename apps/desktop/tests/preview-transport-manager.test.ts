import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";

import {
  PREVIEW_INGRESS_HEADER,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import { previewFailure } from "@orkestrator/protocol/preview-services";
import { WebSocket as WsClient } from "ws";

import { createCommandRegistry } from "../../backend/src/core/commands";
import type { CommandContext } from "../../backend/src/core/commands-context";
import {
  createPreviewHarness,
  type PreviewHarness,
} from "../../backend/src/core/preview-test-support";
import { PreviewMetrics } from "../../backend/src/preview-metrics";
import { PreviewTunnelServer } from "../../backend/src/preview-tunnel-server";
import { connectionPreviewBackend } from "../electron/preview-connection-backend";
import { liveServicePartitionSuffixes } from "../electron/preview-partition-retention";
import {
  PreviewTransportManager,
  previewServicePartitionSuffix,
  type PreviewServiceSession,
} from "../electron/preview-transport-manager";
import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server";

type HeaderHook = Parameters<PreviewServiceSession["webRequest"]["onBeforeSendHeaders"]>[0];
type RequestHook = Parameters<PreviewServiceSession["webRequest"]["onBeforeRequest"]>[0];

class FakeSession implements PreviewServiceSession {
  headerHook: HeaderHook | null = null;
  requestHook: RequestHook | null = null;
  cleared = 0;
  webRequest = {
    onBeforeSendHeaders: (listener: HeaderHook) => {
      this.headerHook = listener;
    },
    onBeforeRequest: (listener: RequestHook) => {
      this.requestHook = listener;
    },
  };
  async clearStorageData() {
    this.cleared += 1;
  }

  /** What Chromium would send for `url` after the session hooks run. */
  headersFor(url: string, headers: Record<string, string> = {}): Promise<Record<string, string>> {
    return new Promise((resolve) =>
      this.headerHook!({ url, requestHeaders: headers }, (response) =>
        resolve(response.requestHeaders ?? headers),
      ),
    );
  }

  cancels(url: string): Promise<boolean> {
    return new Promise((resolve) =>
      this.requestHook!({ url }, (response) => resolve(Boolean(response.cancel))),
    );
  }
}

describe("PreviewTransportManager (desktop tunnel end to end)", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let gateway: Server;
  let tunnel: PreviewTunnelServer;
  let gatewayPort: number;
  let manager: PreviewTransportManager;
  let serviceId: string;
  let backendInstanceId: string;
  let remote: boolean;
  let failAttach: Error | null;
  let beforeAttach: (() => Promise<void>) | undefined;
  /** Attachments omit `multiplexSubprotocol`, as from a backend that predates tunnel v2. */
  let legacyBackend: boolean;
  const sessions = new Map<string, FakeSession>();
  const invoked: string[] = [];

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "desktop-app" });
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
    backendInstanceId = harness.runtime.registry.backendInstanceId;
    tunnel = new PreviewTunnelServer({
      runtime: harness.runtime,
      metrics: new PreviewMetrics(),
    });
    gateway = createServer((_request, response) => response.end());
    gateway.on("upgrade", (request, socket, head) => {
      if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayPort = (gateway.address() as AddressInfo).port;
    const commands = createCommandRegistry();
    const context = {
      storage: harness.storage,
      previews: harness.runtime,
    } as unknown as CommandContext;
    remote = true;
    failAttach = null;
    beforeAttach = undefined;
    legacyBackend = false;
    invoked.length = 0;
    sessions.clear();
    manager = new PreviewTransportManager({
      invoke: async <T>(command: string, args: Record<string, unknown>) => {
        invoked.push(command);
        if (command === "create_preview_attachment") await beforeAttach?.();
        if (failAttach && command === "create_preview_attachment") throw failAttach;
        const result = await commands.get(command)!(args, context);
        if (legacyBackend && command === "create_preview_attachment") {
          const attachment = result as PreviewAttachmentDescriptor;
          const { multiplexSubprotocol: _omitted, ...tunnel } = attachment.tunnel!;
          return { ...attachment, tunnel } as T;
        }
        return result as T;
      },
      tunnelUrl: () => `ws://127.0.0.1:${gatewayPort}/__orkestrator/preview/tunnel`,
      isRemote: () => remote,
      partitionFor: (target) => `persist:test-${target.serviceId}`,
      sessionFor: (partition) => {
        let session = sessions.get(partition);
        if (!session) {
          session = new FakeSession();
          sessions.set(partition, session);
        }
        return session;
      },
      clientKey: "window-test",
      retirementMs: 50,
      // Hermetic: public names resolve to a public address.
      lookupHost: async () => ["93.184.216.34"],
    });
  });

  afterEach(async () => {
    await manager.disposeAll();
    tunnel.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await fixture.close();
    await harness.cleanup();
  });

  const target = (path = "/") => ({ backendInstanceId, environmentId: "local", serviceId, path });

  function get(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(url, { headers, agent: false }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      request.on("error", reject);
      request.end();
    });
  }

  test("warns when disposal cannot reach the attachment backend and still closes ingress", async () => {
    const unavailable = connectionPreviewBackend(() => null);
    const warn = mock(() => undefined);
    // Creation reaches the real backend. Teardown exercises the adapter with
    // no retained client, including its asynchronous unavailable rejection.
    const releaseManager = new PreviewTransportManager({
      invoke: (command, args) =>
        command === "release_preview_attachment"
          ? unavailable.invoke(command, args)
          : harnessCommand(command, args),
      tunnelUrl: unavailable.tunnelUrl,
      isRemote: () => true,
      partitionFor: () => "persist:release-failure",
      sessionFor: () => new FakeSession(),
      clientKey: "release-failure",
      logger: { warn },
    });
    function harnessCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
      const commands = createCommandRegistry();
      return Promise.resolve(
        commands.get(command)!(args, {
          storage: harness.storage,
          previews: harness.runtime,
        } as unknown as CommandContext),
      ) as Promise<T>;
    }
    try {
      const descriptor = await releaseManager.acquire(target(), "tab-release");
      await expect(releaseManager.disposeAll()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("attachment.release-failed");
      expect(warn).toHaveBeenCalledTimes(1);
      await expect(get(descriptor.origin)).rejects.toThrow();
      expect(releaseManager.stats().services).toBe(0);
      await releaseManager.disposeAll();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await releaseManager.disposeAll();
    }
  });

  test("serves the service through a credentialed loopback ingress", async () => {
    const descriptor = await manager.acquire(target("/app/page?x=1"), "tab-1");
    expect(descriptor.url).toBe(`${descriptor.origin}/app/page?x=1`);
    expect(descriptor.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Other local processes (no credential) are refused.
    expect((await get(descriptor.url)).status).toBe(403);

    const session = sessions.get(descriptor.partition)!;
    const headers = await session.headersFor(descriptor.url, { authorization: "Bearer app-token" });
    expect(headers[PREVIEW_INGRESS_HEADER]).toBeTruthy();
    const page = await get(descriptor.url, headers);
    expect(page.status).toBe(200);
    expect(page.headers["x-service-marker"]).toBe("desktop-app");
    const reached = fixture.requests.at(-1)!;
    expect(reached.host).toBe(`localhost:${fixture.port}`);
    expect(reached.authorization).toBe("Bearer app-token");
    expect(reached.headerNames).not.toContain(PREVIEW_INGRESS_HEADER);
  });

  test("the credential is only injected for the service's own origin", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const session = sessions.get(descriptor.partition)!;
    expect(
      (await session.headersFor("http://127.0.0.1:1/"))[PREVIEW_INGRESS_HEADER],
    ).toBeUndefined();
    expect(
      (await session.headersFor("https://example.com/"))[PREVIEW_INGRESS_HEADER],
    ).toBeUndefined();
    const spoofed = await session.headersFor("https://example.com/", {
      [PREVIEW_INGRESS_HEADER]: "guess",
    });
    expect(spoofed[PREVIEW_INGRESS_HEADER]).toBeUndefined();
    const socket = `${descriptor.origin.replace("http:", "ws:")}/ws`;
    expect((await session.headersFor(socket))[PREVIEW_INGRESS_HEADER]).toBeTruthy();
  });

  test("remote previews cannot reach client-local services; own origin and public sites are allowed", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const session = sessions.get(descriptor.partition)!;
    expect(await session.cancels(descriptor.url)).toBe(false);
    expect(await session.cancels("http://localhost:3000/api")).toBe(true);
    expect(await session.cancels("ws://127.0.0.1:5173/")).toBe(true);
    expect(await session.cancels("http://192.168.1.10/")).toBe(true);
    expect(await session.cancels("https://cdn.example.com/lib.js")).toBe(false);
    remote = false;
    expect(await session.cancels("http://localhost:3000/api")).toBe(false);
  });

  test("DNS-rebinding requests with a foreign Host are refused even with a credential", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    expect((await get(descriptor.url, { ...headers, host: "evil.test" })).status).toBe(403);
  });

  test("keep-alive upstream connections are pooled", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    await get(`${descriptor.origin}/health`, headers);
    await get(`${descriptor.origin}/assets/app.css`, headers);
    await get(`${descriptor.origin}/assets/app.js`, headers);
    expect(tunnel.stats().admission.admitted).toBe(1);
  });

  test("parallel connections share one authenticated tunnel socket", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    let upgrades = 0;
    gateway.prependListener("upgrade", () => (upgrades += 1));
    const paths = ["/health", "/assets/app.css", "/assets/app.js", "/health", "/assets/app.css"];
    const responses = await Promise.all(
      paths.map((path) => get(`${descriptor.origin}${path}`, headers)),
    );
    expect(responses.map((response) => response.status)).toEqual(paths.map(() => 200));
    // Five upstream connections, one WebSocket handshake and one HELLO.
    expect(tunnel.stats().admission.admitted).toBe(paths.length);
    expect(upgrades).toBe(1);
    expect(tunnel.stats().sessions).toBe(1);
    expect(manager.stats().tunnelSessions).toBe(1);
  });

  test("against a backend without tunnel v2, each connection opens its own socket", async () => {
    legacyBackend = true;
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    let upgrades = 0;
    gateway.prependListener("upgrade", () => (upgrades += 1));
    const responses = await Promise.all([
      get(`${descriptor.origin}/health`, headers),
      get(`${descriptor.origin}/assets/app.css`, headers),
      get(`${descriptor.origin}/assets/app.js`, headers),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(upgrades).toBe(3);
    expect(tunnel.stats().sessions).toBe(0);
    expect(manager.stats().tunnelSessions).toBe(0);
  });

  test("application websockets pass through the ingress with subprotocols", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(`${descriptor.origin}/ws`);
    const socket = new WsClient(`${descriptor.origin.replace("http:", "ws:")}/ws`, ["fixture.v1"], {
      headers,
    });
    const hello = await new Promise<string>((resolve, reject) => {
      socket.on("message", (data: unknown) => resolve(String(data)));
      socket.on("error", reject);
    });
    expect(JSON.parse(hello)).toEqual({ hello: "desktop-app", protocol: "fixture.v1" });
    expect(socket.protocol).toBe("fixture.v1");
    socket.close();
  });

  test("revoked access reattaches transparently for new connections", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    const after = await get(`${descriptor.origin}/health`, headers);
    expect(after.status).toBe(200);
    expect(invoked.filter((command) => command === "create_preview_attachment").length).toBe(2);
  });

  test("a failed reattach during a connection retry reports the transport unavailable until one succeeds", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    failAttach = previewFailure("capacity-exceeded");
    expect((await get(`${descriptor.origin}/health`, headers)).status).not.toBe(200);
    expect(manager.transportState(descriptor.serviceKey)).toMatchObject({
      state: "unavailable",
      failure: "capacity-exceeded",
    });
    failAttach = null;
    expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
    expect(manager.transportState(descriptor.serviceKey)).toEqual({
      mode: "desktop-tunnel",
      state: "ready",
    });
  });

  test("ingress timing and reconnects are reported to the backend's preview metrics", async () => {
    type Metrics = {
      counters: Record<string, number>;
      histograms: Record<string, { count: number; max: number }>;
    };
    const diagnostics = async () =>
      (
        (await createCommandRegistry().get("get_preview_diagnostics")!({}, {
          storage: harness.storage,
          previews: harness.runtime,
        } as unknown as CommandContext)) as { metrics: Metrics }
      ).metrics;
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    const revoke = async () => {
      harness.runtime.access.revokeServices([serviceId], "operator-revoked");
      // Let the revocation close the pooled connections before the next request.
      await Bun.sleep(20);
    };
    expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
    await revoke();
    expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
    await revoke();
    failAttach = previewFailure("capacity-exceeded");
    expect((await get(`${descriptor.origin}/health`, headers)).status).not.toBe(200);
    failAttach = null;
    expect((await get(`${descriptor.origin}/assets/app.css`, headers)).status).toBe(200);

    // Nothing is reported until the batch is flushed (here, by disposal).
    expect(invoked).not.toContain("record_preview_client_metrics");
    expect((await diagnostics()).histograms["desktop.connect_ms"]).toBeUndefined();
    await manager.disposeAll();
    expect(invoked.filter((command) => command === "record_preview_client_metrics")).toHaveLength(
      1,
    );

    const metrics = await diagnostics();
    expect(metrics.histograms["desktop.connect_ms"]!.count).toBeGreaterThanOrEqual(2);
    expect(metrics.histograms["desktop.first_byte_ms"]!.count).toBe(3);
    expect(metrics.counters["desktop.reconnect{access-expired}"]).toBe(3);
    expect(metrics.counters["desktop.reconnect_failed{capacity-exceeded}"]).toBe(1);
    // Content-free: no ingress origin, path, service or attachment identity.
    const serialized = JSON.stringify(metrics);
    for (const secret of [descriptor.origin, "/health", "app.css", serviceId, backendInstanceId])
      expect(serialized).not.toContain(secret);
  });

  for (const external of [false, true]) {
    test(`first-byte timing is reported before an open SSE body ends (${external ? "external" : "loopback"})`, async () => {
      // Keep the body open under test control, beyond any reporting interval.
      fixture.server.removeAllListeners("request");
      let upstream: ServerResponse | undefined;
      fixture.server.on("request", (_request, response) => {
        upstream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: ready\n\n");
      });
      const reports: Array<{ histograms: Record<string, number[]> }> = [];
      const session = new FakeSession();
      const timed = new PreviewTransportManager({
        invoke: async <T>(command: string, args: Record<string, unknown>) => {
          if (command === "record_preview_client_metrics")
            reports.push(args.report as (typeof reports)[number]);
          return (await createCommandRegistry().get(command)!(args, {
            storage: harness.storage,
            previews: harness.runtime,
          } as unknown as CommandContext)) as T;
        },
        tunnelUrl: () => `ws://127.0.0.1:${gatewayPort}/__orkestrator/preview/tunnel`,
        isRemote: () => false,
        partitionFor: () => "persist:stream-metrics",
        sessionFor: () => session,
        clientKey: "stream-metrics",
        metricsReportMs: 20,
      });
      let response: IncomingMessage | undefined;
      try {
        const descriptor = await timed.acquire(target(), "stream");
        const url = external ? await timed.forwardExternally(target()) : descriptor.url;
        const headers = external ? {} : await session.headersFor(url);
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          const request = httpRequest(url, { headers, agent: false }, resolve);
          request.on("error", reject);
          request.end();
        });
        response.resume();
        expect(response.statusCode).toBe(200);
        const deadline = Date.now() + 2_000;
        while (
          !reports.some((report) => report.histograms["desktop.first_byte_ms"]) &&
          Date.now() < deadline
        )
          await Bun.sleep(5);
        const samples = () =>
          reports.flatMap((report) => report.histograms["desktop.first_byte_ms"] ?? []);
        expect(samples()).toHaveLength(1);
        expect(samples()[0]).toBeGreaterThanOrEqual(0);
        expect(upstream!.writableEnded).toBe(false);
        expect(response.complete).toBe(false);
        const ended = new Promise<void>((resolve) => response!.once("end", resolve));
        upstream!.end();
        await ended;
        await timed.disposeAll();
        // Body completion must not record the same response twice.
        expect(samples()).toHaveLength(1);
      } finally {
        upstream?.end();
        response?.destroy();
        await timed.disposeAll();
      }
    });
  }

  test("concurrent connections joining a pending reattach count one reconnect", async () => {
    const descriptor = await manager.acquire(target(), "concurrent");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeAttach = () => gate;
    const requests = [get(descriptor.url, headers), get(descriptor.url, headers)];
    try {
      const deadline = Date.now() + 2_000;
      while (
        invoked.filter((command) => command === "create_preview_attachment").length < 2 &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      // Hold the reattach while both refused tunnel opens join it.
      await Bun.sleep(50);
    } finally {
      release();
    }
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([200, 200]);
    expect(invoked.filter((command) => command === "create_preview_attachment")).toHaveLength(2);
    await manager.disposeAll();
    expect(harness.runtime.metrics.snapshot().counters["desktop.reconnect{access-expired}"]).toBe(
      1,
    );
  });

  const invocations = (command: string) => invoked.filter((entry) => entry === command).length;

  for (const pooled of [false, true]) {
    test(`two concurrent requests after a revocation recover on one reattach (${pooled ? "pooled connection" : "no pooled connection"})`, async () => {
      const descriptor = await manager.acquire(target(), "tab-1");
      const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
      if (pooled) expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
      harness.runtime.access.revokeServices([serviceId], "operator-revoked");
      const responses = await Promise.all([
        get(`${descriptor.origin}/health`, headers),
        get(`${descriptor.origin}/assets/app.css`, headers),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(invocations("create_preview_attachment")).toBe(2);
      expect(invocations("release_preview_attachment")).toBe(1);
      expect(manager.transportState(descriptor.serviceKey)).toEqual({
        mode: "desktop-tunnel",
        state: "ready",
      });
      await manager.disposeAll();
      expect(harness.runtime.metrics.snapshot().counters["desktop.reconnect{access-expired}"]).toBe(
        1,
      );
    });
  }

  test("two concurrent requests after a generation change recover on one reattach", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    // The first attachment is the only one bound to the old generation.
    const access = harness.runtime.access;
    const authenticate = access.authenticateTunnel.bind(access);
    let stale: string | undefined;
    access.authenticateTunnel = (attachmentId, credential) => {
      stale ??= attachmentId;
      if (attachmentId === stale) throw previewFailure("generation-changed");
      return authenticate(attachmentId, credential);
    };
    const responses = await Promise.all([
      get(`${descriptor.origin}/health`, headers),
      get(`${descriptor.origin}/assets/app.css`, headers),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(invocations("create_preview_attachment")).toBe(2);
    await manager.disposeAll();
    expect(
      harness.runtime.metrics.snapshot().counters["desktop.reconnect{generation-changed}"],
    ).toBe(1);
  });

  test("a connection refused after its attachment was replaced retries without reattaching", async () => {
    // Two tunnel handshakes racing needs one socket per connection: on v2 the
    // second request joins the first's session.
    legacyBackend = true;
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    // Hold both tunnel opens so each is sent on the revoked attachment, then
    // let the second reach the server only after the first has fully recovered.
    const held: Array<() => void> = [];
    let holding = true;
    gateway.removeAllListeners("upgrade");
    gateway.on("upgrade", (request, socket, head) => {
      const accept = () => {
        if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
      };
      if (holding) held.push(accept);
      else accept();
    });
    const requests = [
      get(`${descriptor.origin}/health`, headers),
      get(`${descriptor.origin}/assets/app.css`, headers),
    ];
    const deadline = Date.now() + 2_000;
    while (held.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(held).toHaveLength(2);
    holding = false;
    held[0]!();
    const first = await Promise.race(requests);
    expect(first.status).toBe(200);
    expect(invocations("create_preview_attachment")).toBe(2);

    held[1]!();
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(invocations("create_preview_attachment")).toBe(2);
    expect(invocations("release_preview_attachment")).toBe(1);
    expect(manager.transportState(descriptor.serviceKey)).toEqual({
      mode: "desktop-tunnel",
      state: "ready",
    });
    await manager.disposeAll();
    expect(harness.runtime.metrics.snapshot().counters["desktop.reconnect{access-expired}"]).toBe(
      1,
    );
  });

  for (const recovery of ["revoked replacement", "pending attach", "refused final open"] as const) {
    test(`a delayed refusal recovers across a second revocation (${recovery})`, async () => {
      // Needs two racing handshakes, so one socket per connection (v1).
      legacyBackend = true;
      const descriptor = await manager.acquire(target(), "tab-1");
      const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
      const held: Array<() => void> = [];
      let holding = true;
      let releaseAttach!: () => void;
      const attachGate = new Promise<void>((resolve) => {
        releaseAttach = resolve;
      });
      gateway.removeAllListeners("upgrade");
      gateway.on("upgrade", (request, socket, head) => {
        const accept = () => {
          if (recovery === "refused final open" && invocations("create_preview_attachment") === 3)
            harness.runtime.access.revokeServices([serviceId], "operator-revoked");
          if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
        };
        if (holding) held.push(accept);
        else accept();
      });
      harness.runtime.access.revokeServices([serviceId], "operator-revoked");
      const requests = [get(descriptor.url, headers), get(descriptor.url, headers)];
      const waitFor = async (condition: () => boolean) => {
        const deadline = Date.now() + 2_000;
        while (!condition() && Date.now() < deadline) await Bun.sleep(5);
        expect(condition()).toBe(true);
      };
      try {
        await waitFor(() => held.length === 2);
        holding = false;
        held[0]!();
        expect((await Promise.race(requests)).status).toBe(200);
        expect(invocations("create_preview_attachment")).toBe(2);
        harness.runtime.access.revokeServices([serviceId], "operator-revoked");
        if (recovery === "pending attach") {
          beforeAttach = () => attachGate;
          const third = get(descriptor.url, headers);
          requests.push(third);
          await waitFor(() => invocations("create_preview_attachment") === 3);
        }
        let lateRefused = false;
        const authenticate = harness.runtime.access.authenticateTunnel.bind(harness.runtime.access);
        harness.runtime.access.authenticateTunnel = (id, credential) => {
          lateRefused = true;
          return authenticate(id, credential);
        };
        held[1]!();
        await waitFor(() => lateRefused);
        // Let the refused open join the pending attach before completing it.
        if (recovery === "pending attach") await Bun.sleep(30);
        releaseAttach();
        const responses = await Promise.all(requests);
        if (recovery === "refused final open")
          expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
        else expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(invocations("create_preview_attachment")).toBe(3);
        expect(invocations("release_preview_attachment")).toBe(2);
        expect(manager.transportState(descriptor.serviceKey)).toEqual({
          mode: "desktop-tunnel",
          state: "ready",
        });
        await manager.disposeAll();
        expect(
          harness.runtime.metrics.snapshot().counters["desktop.reconnect{access-expired}"],
        ).toBe(2);
      } finally {
        releaseAttach();
      }
    });
  }

  test("buffered ingress metrics are reported on a timer while the window stays open", async () => {
    const reports: unknown[] = [];
    const session = new FakeSession();
    const timed = new PreviewTransportManager({
      invoke: async <T>(command: string, args: Record<string, unknown>) => {
        if (command === "record_preview_client_metrics") {
          reports.push(args.report);
          throw new Error("an older backend does not know this command");
        }
        return (await createCommandRegistry().get(command)!(args, {
          storage: harness.storage,
          previews: harness.runtime,
        } as unknown as CommandContext)) as T;
      },
      tunnelUrl: () => `ws://127.0.0.1:${gatewayPort}/__orkestrator/preview/tunnel`,
      isRemote: () => false,
      partitionFor: () => "persist:metrics-timer",
      sessionFor: () => session,
      clientKey: "metrics-timer",
      metricsReportMs: 20,
    });
    try {
      const descriptor = await timed.acquire(target(), "tab-timer");
      expect(reports).toEqual([]);
      const headers = await session.headersFor(descriptor.url);
      expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
      // The timer starts at the first buffered sample, the tunnel connect. On a
      // loaded host the first byte can land more than one interval later, so
      // the two samples may arrive in one report or in two consecutive ones.
      const reported = (name: string) =>
        reports.flatMap(
          (report) => (report as { histograms: Record<string, number[]> }).histograms[name] ?? [],
        );
      const deadline = Date.now() + 2_000;
      while (reported("desktop.first_byte_ms").length === 0 && Date.now() < deadline)
        await Bun.sleep(10);
      expect(reports.length).toBeGreaterThanOrEqual(1);
      expect(reports.length).toBeLessThanOrEqual(2);
      expect(reported("desktop.connect_ms")).toEqual([expect.any(Number)]);
      expect(reported("desktop.first_byte_ms")).toEqual([expect.any(Number)]);
      // A rejected report is dropped, not retried or kept growing.
      const reportsBeforeDispose = reports.length;
      await timed.disposeAll();
      expect(reports).toHaveLength(reportsBeforeDispose);
    } finally {
      await timed.disposeAll();
    }
  });

  test("an unmapped or stopped service fails acquire with a stable category", async () => {
    await harness.storage.updateEnvironment("local", { status: "stopped" });
    await harness.runtime.registry.settle();
    const container = await harness.runtime.registry.register({
      environmentId: "local",
      label: "wt",
      targetKind: "worktree",
      applicationPort: 5173,
    });
    if (container.kind !== "definition") throw new Error("expected definition");
    const error = await manager
      .acquire(
        {
          backendInstanceId,
          environmentId: "local",
          serviceId: container.definition.serviceId,
          path: "/",
        },
        "tab-2",
      )
      .catch((failure: unknown) => failure);
    expect(String(error)).toContain("environment-stopped");
    expect(manager.stats().services).toBe(0);
  });

  test("hiding does not close the listener; the last release retires it and frees the attachment", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    await manager.acquire(target("/other"), "tab-2");
    manager.release(descriptor.serviceKey, "tab-1");
    await Bun.sleep(80);
    const headers = await sessions.get(descriptor.partition)!.headersFor(descriptor.url);
    expect((await get(`${descriptor.origin}/health`, headers)).status).toBe(200);
    manager.release(descriptor.serviceKey, "tab-2");
    // Retirement drops the service at once, then closes the listener and only
    // then releases the attachment, so wait for the last step rather than for
    // a fixed slice of a possibly loaded host's time.
    const deadline = Date.now() + 3_000;
    while (
      (!invoked.includes("release_preview_attachment") ||
        harness.runtime.access.stats().attachments !== 0) &&
      Date.now() < deadline
    )
      await Bun.sleep(5);
    expect(manager.stats().services).toBe(0);
    expect(invoked).toContain("release_preview_attachment");
    expect(harness.runtime.access.stats().attachments).toBe(0);
    await expect(get(`${descriptor.origin}/health`, headers)).rejects.toThrow();
  });

  test("maps runtime URLs back to service identity and application address", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    expect(manager.describe(`${descriptor.origin}/a/b?c=1#d`)).toEqual({
      serviceKey: descriptor.serviceKey,
      serviceId,
      path: "/a/b?c=1#d",
      displayUrl: `http://localhost:${fixture.port}/a/b?c=1#d`,
    });
    expect(manager.scopeFor(`${descriptor.origin}/x`)).toBe(`service:${descriptor.serviceKey}`);
    expect(manager.scopeFor("http://127.0.0.1:1/")).toBeNull();
  });

  test("a service from another backend identity is refused", async () => {
    const error = await manager
      .acquire(
        { backendInstanceId: "bk_another_backend", environmentId: "local", serviceId, path: "/" },
        "tab-1",
      )
      .catch((failure: unknown) => failure);
    expect(String(error)).toContain("not-found");
  });

  test("reset clears only the service partition", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    await manager.resetSiteData(target());
    expect(sessions.get(descriptor.partition)!.cleared).toBe(1);
  });

  test("reports held partitions and its own backend's full service list for retention", async () => {
    const suffix = previewServicePartitionSuffix(target());
    const descriptor = await manager.acquire(target(), "tab-1");
    expect(manager.partitionsInUse()).toEqual([descriptor.partition]);
    expect(liveServicePartitionSuffixes(await manager.listServices())).toEqual(new Set([suffix]));

    await harness.runtime.registry.remove(serviceId, undefined);
    expect(liveServicePartitionSuffixes(await manager.listServices())).toEqual(new Set());

    await manager.disposeAll();
    expect(manager.closed).toBe(true);
    expect(manager.partitionsInUse()).toEqual([]);
    await expect(manager.listServices()).rejects.toThrow();
  });
});

describe("PreviewTransportManager lifecycle and local-network policy", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => (resolve = settle));
    return { promise, resolve };
  }

  const target = {
    backendInstanceId: "bk_backend_1",
    environmentId: "env",
    serviceId: "svc_aaaaaaaa",
    path: "/",
  };
  const attachment = (attachmentId = "att_1"): PreviewAttachmentDescriptor =>
    ({
      attachmentId,
      serviceId: target.serviceId,
      environmentId: target.environmentId,
      backendInstanceId: target.backendInstanceId,
      applicationPort: 3000,
      tunnel: { credential: "secret" },
    }) as unknown as PreviewAttachmentDescriptor;

  function setup(
    options: {
      attach?: () => Promise<PreviewAttachmentDescriptor>;
      renew?: () => Promise<unknown>;
      onListen?: () => void;
      lookupHost?: (hostname: string) => Promise<string[]>;
      isRemote?: () => boolean;
    } = {},
  ) {
    const invoked: Array<{ command: string; args: Record<string, unknown> }> = [];
    const sessions = new Map<string, FakeSession>();
    const ports: number[] = [];
    let remote = true;
    const manager = new PreviewTransportManager({
      invoke: async <T>(command: string, args: Record<string, unknown>) => {
        invoked.push({ command, args });
        if (command === "create_preview_attachment") {
          return (await (options.attach?.() ?? attachment())) as T;
        }
        if (command === "renew_preview_attachment" && options.renew) {
          return (await options.renew()) as T;
        }
        return undefined as T;
      },
      tunnelUrl: () => null,
      isRemote: options.isRemote ?? (() => remote),
      partitionFor: (service) => `persist:test-${service.serviceId}`,
      sessionFor: (partition) => {
        let session = sessions.get(partition);
        if (!session) {
          session = new FakeSession();
          sessions.set(partition, session);
        }
        return session;
      },
      clientKey: "window-test",
      renewIntervalMs: 5,
      portHints: {
        get: () => {
          options.onListen?.();
          return undefined;
        },
        set: (_key, port) => ports.push(port),
      },
      ...(options.lookupHost ? { lookupHost: options.lookupHost } : {}),
    });
    return {
      manager,
      invoked,
      sessions,
      ports,
      setRemote: (value: boolean) => (remote = value),
    };
  }

  const refused = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = netConnect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });

  test("disposal while attaching releases the late attachment and binds nothing", async () => {
    const pending = deferred<PreviewAttachmentDescriptor>();
    const { manager, invoked, sessions, ports } = setup({ attach: () => pending.promise });
    const acquired = manager.acquire(target, "tab-1").catch((error: unknown) => error);
    await Bun.sleep(0);
    await manager.disposeAll();
    pending.resolve(attachment());
    expect(String(await acquired)).toContain("backend-unavailable");
    await Bun.sleep(30);
    expect(ports).toEqual([]);
    expect(invoked.map((entry) => entry.command)).toEqual([
      "create_preview_attachment",
      "release_preview_attachment",
    ]);
    expect(invoked[1]!.args).toEqual({ attachmentId: "att_1" });
    expect(sessions.size).toBe(0);
    expect(manager.stats().services).toBe(0);
  });

  test("a renewal refused for a moved generation counts one reconnect", async () => {
    let refuse = true;
    const { manager, invoked } = setup({
      renew: async () => {
        if (!refuse) return undefined;
        refuse = false;
        throw previewFailure("generation-changed");
      },
    });
    const descriptor = await manager.acquire(target, "tab-1");
    const deadline = Date.now() + 2_000;
    while (
      invoked.filter((entry) => entry.command === "create_preview_attachment").length < 2 &&
      Date.now() < deadline
    )
      await Bun.sleep(5);
    await Bun.sleep(20);
    expect(manager.transportState(descriptor.serviceKey)).toEqual({
      mode: "desktop-tunnel",
      state: "ready",
    });
    await manager.disposeAll();
    const reports = invoked.filter((entry) => entry.command === "record_preview_client_metrics");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.args.report).toEqual({
      counters: [{ name: "desktop.reconnect", category: "generation-changed", count: 1 }],
      histograms: {},
    });
  });

  for (const pending of [false, true]) {
    test(`a renewal refused after replacement ${pending ? "joins the next attach" : "does not reattach again"}`, async () => {
      let releaseAttach!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseAttach = resolve;
      });
      let refuseSlowRenewal!: (failure: unknown) => void;
      const slowRenewal = new Promise<void>((_resolve, reject) => {
        refuseSlowRenewal = reject;
      });
      let attaches = 0;
      let renewals = 0;
      const { manager, invoked } = setup({
        attach: async () => {
          const id = ++attaches;
          if (pending && id === 3) await gate;
          return attachment(`att_${id}`);
        },
        renew: async () => {
          renewals += 1;
          // The first renewal of att_1 is still pending when the second replaces it.
          if (renewals === 1) return slowRenewal;
          if (renewals === 2 || (pending && renewals === 3))
            throw previewFailure("generation-changed");
          return undefined;
        },
      });
      const called = (command: string) => invoked.filter((entry) => entry.command === command);
      const descriptor = await manager.acquire(target, "tab-1");
      const deadline = Date.now() + 2_000;
      while (called("release_preview_attachment").length < 1 && Date.now() < deadline)
        await Bun.sleep(5);
      if (pending) {
        while (called("create_preview_attachment").length < 3 && Date.now() < deadline)
          await Bun.sleep(5);
        expect(called("create_preview_attachment")).toHaveLength(3);
      }
      // The backend refuses the pending renewal because att_1 has been released.
      refuseSlowRenewal(previewFailure("not-found"));
      await Bun.sleep(20);
      expect(called("create_preview_attachment")).toHaveLength(pending ? 3 : 2);
      releaseAttach();
      while (
        called("release_preview_attachment").length < (pending ? 2 : 1) &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      expect(called("release_preview_attachment").map((entry) => entry.args)).toEqual([
        { attachmentId: "att_1" },
        ...(pending ? [{ attachmentId: "att_2" }] : []),
      ]);
      expect(manager.transportState(descriptor.serviceKey)).toEqual({
        mode: "desktop-tunnel",
        state: "ready",
      });
      await manager.disposeAll();
      expect(called("record_preview_client_metrics")[0]!.args.report).toEqual({
        counters: [
          { name: "desktop.reconnect", category: "generation-changed", count: pending ? 2 : 1 },
        ],
        histograms: {},
      });
    });
  }

  test("a failed renewal reattach counts its trigger and failure once", async () => {
    let attaches = 0;
    let renewals = 0;
    const { manager, invoked } = setup({
      attach: async () => {
        if (++attaches > 1) throw previewFailure("capacity-exceeded");
        return attachment();
      },
      renew: async () => {
        if (++renewals === 1) throw previewFailure("generation-changed");
        return new Promise(() => {});
      },
    });
    try {
      const descriptor = await manager.acquire(target, "tab-1");
      const deadline = Date.now() + 2_000;
      while (
        manager.transportState(descriptor.serviceKey)?.state !== "unavailable" &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      expect(manager.transportState(descriptor.serviceKey)).toMatchObject({
        state: "unavailable",
        failure: "capacity-exceeded",
      });
    } finally {
      await manager.disposeAll();
    }
    const reports = invoked.filter((entry) => entry.command === "record_preview_client_metrics");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.args.report).toEqual({
      counters: [
        { name: "desktop.reconnect", category: "generation-changed", count: 1 },
        { name: "desktop.reconnect_failed", category: "capacity-exceeded", count: 1 },
      ],
      histograms: {},
    });
  });

  test("disposal while binding closes the listener and never starts renewal", async () => {
    let manager!: PreviewTransportManager;
    const context = setup({ onListen: () => void manager.disposeAll() });
    manager = context.manager;
    const error = await manager.acquire(target, "tab-1").catch((failure: unknown) => failure);
    expect(String(error)).toContain("backend-unavailable");
    await Bun.sleep(30);
    expect(context.ports).toHaveLength(1);
    expect(await refused(context.ports[0]!)).toBe(true);
    const commands = context.invoked.map((entry) => entry.command);
    expect(commands.filter((command) => command === "release_preview_attachment")).toHaveLength(1);
    expect(commands).not.toContain("renew_preview_attachment");
    expect(context.sessions.size).toBe(0);
  });

  describe("remote previews", () => {
    async function hooked(lookupHost?: (hostname: string) => Promise<string[]>) {
      const context = setup(lookupHost ? { lookupHost } : {});
      const descriptor = await context.manager.acquire(target, "tab-1");
      const session = context.sessions.get(descriptor.partition)!;
      return { ...context, descriptor, session };
    }

    test("local-network IP literals are blocked however they are spelled", async () => {
      const { manager, session, descriptor } = await hooked(async () => ["93.184.216.34"]);
      for (const url of [
        "http://[::ffff:127.0.0.1]:3000/",
        "http://[::ffff:7f00:1]/",
        "http://[0:0:0:0:0:ffff:c0a8:0101]/",
        "http://[::]:8080/",
        "http://[::1]/",
        "http://0.0.0.0:3000/",
        "http://0.1.2.3/",
        "http://2130706433/",
        "http://100.64.0.1/",
        "http://100.127.255.254/",
        "http://10.1.2.3/",
        "http://172.20.0.1/",
        "http://169.254.169.254/",
        "http://[fd12:3456::1]/",
        "http://[fe80::1]/",
        "ws://localhost./",
        "http://app.localhost/",
      ]) {
        expect({ url, cancelled: await session.cancels(url) }).toEqual({ url, cancelled: true });
      }
      for (const url of [
        "http://93.184.216.34/",
        "http://100.128.0.1/",
        "http://[2606:4700::1111]/",
        "http://[::ffff:5db8:d822]/",
      ]) {
        expect({ url, cancelled: await session.cancels(url) }).toEqual({ url, cancelled: false });
      }
      expect(await session.cancels(`${descriptor.origin}/app`)).toBe(false);
      await manager.disposeAll();
    });

    test("names that resolve to this machine or its network are blocked", async () => {
      const lookups: string[] = [];
      const answers: Record<string, string[]> = {
        "127.0.0.1.nip.io": ["127.0.0.1"],
        "localtest.me": ["::1"],
        "mixed.example": ["93.184.216.34", "::ffff:192.168.1.10"],
        "cdn.example.com": ["93.184.216.34"],
      };
      const { manager, session } = await hooked(async (hostname) => {
        lookups.push(hostname);
        const answer = answers[hostname];
        if (!answer) throw new Error("ENOTFOUND");
        return answer;
      });
      expect(await session.cancels("http://127.0.0.1.nip.io:3000/")).toBe(true);
      expect(await session.cancels("ws://localtest.me/socket")).toBe(true);
      expect(await session.cancels("https://mixed.example/")).toBe(true);
      expect(await session.cancels("https://cdn.example.com/lib.js")).toBe(false);
      expect(await session.cancels("https://cdn.example.com/other.js")).toBe(false);
      // Resolution failures fail open: Chromium's own lookup fails too.
      expect(await session.cancels("https://unresolvable.example/")).toBe(false);
      expect(lookups.filter((host) => host === "cdn.example.com")).toHaveLength(1);
      await manager.disposeAll();
    });

    test("a local-network check that throws still answers, by cancelling (7060)", async () => {
      const throwingRemote = setup({
        isRemote: () => {
          throw new Error("The requesting window is no longer available.");
        },
      });
      const descriptor = await throwingRemote.manager.acquire(target, "tab-1");
      const session = throwingRemote.sessions.get(descriptor.partition)!;
      expect(await session.cancels("http://93.184.216.34/")).toBe(true);
      // The service's own origin needs no check and is still admitted.
      expect(await session.cancels(`${descriptor.origin}/app`)).toBe(false);
      await throwingRemote.manager.disposeAll();

      const { manager, session: lookupSession } = await hooked(((_hostname: string) => {
        throw new Error("resolver unavailable");
      }) as (hostname: string) => Promise<string[]>);
      expect(await lookupSession.cancels("https://cdn.example.com/lib.js")).toBe(true);
      await manager.disposeAll();
    });

    test("a header hook that throws still answers, without the ingress credential (7060)", async () => {
      const { manager, session, descriptor } = await hooked(async () => ["93.184.216.34"]);
      let reads = 0;
      const requestHeaders: Record<string, string> = { Accept: "*/*" };
      requestHeaders["X-Orkestrator-Preview-Ingress"] = "forged";
      Object.defineProperty(requestHeaders, "X-Flaky", {
        enumerable: true,
        get() {
          reads += 1;
          if (reads === 1) throw new Error("The requesting window is no longer available.");
          return "1";
        },
      });
      const headers = await session.headersFor(`${descriptor.origin}/app`, requestHeaders);
      expect(reads).toBe(2);
      expect(headers).toEqual({ Accept: "*/*", "X-Flaky": "1" });
      await manager.disposeAll();
    });

    test("local previews are unaffected and never resolve names", async () => {
      const lookups: string[] = [];
      const { manager, session, setRemote } = await hooked(async (hostname) => {
        lookups.push(hostname);
        return ["127.0.0.1"];
      });
      setRemote(false);
      expect(await session.cancels("http://localhost:3000/")).toBe(false);
      expect(await session.cancels("http://[::ffff:127.0.0.1]/")).toBe(false);
      expect(await session.cancels("http://127.0.0.1.nip.io/")).toBe(false);
      expect(lookups).toEqual([]);
      await manager.disposeAll();
    });
  });
});
