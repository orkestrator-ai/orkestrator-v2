import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { PREVIEW_INGRESS_HEADER } from "@orkestrator/protocol/preview-access";
import { WebSocket as WsClient } from "ws";

import { createCommandRegistry } from "../../../apps/backend/src/core/commands";
import type { CommandContext } from "../../../apps/backend/src/core/commands-context";
import {
  createPreviewHarness,
  type PreviewHarness,
} from "../../../apps/backend/src/core/preview-test-support";
import { PreviewMetrics } from "../../../apps/backend/src/preview-metrics";
import { PreviewTunnelServer } from "../../../apps/backend/src/preview-tunnel-server";
import {
  PreviewTransportManager,
  type PreviewServiceSession,
} from "../../../apps/desktop/electron/preview-transport-manager";
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
      logger: { debug: () => undefined, warn: () => undefined },
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
    invoked.length = 0;
    sessions.clear();
    manager = new PreviewTransportManager({
      invoke: async <T>(command: string, args: Record<string, unknown>) => {
        invoked.push(command);
        return (await commands.get(command)!(args, context)) as T;
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

  test("application websockets pass through the ingress with subprotocols", async () => {
    const descriptor = await manager.acquire(target(), "tab-1");
    const headers = await sessions.get(descriptor.partition)!.headersFor(`${descriptor.origin}/ws`);
    const socket = new WsClient(`${descriptor.origin.replace("http:", "ws:")}/ws`, ["fixture.v1"], {
      headers,
    });
    const hello = await new Promise<string>((resolve, reject) => {
      socket.on("message", (data) => resolve(String(data)));
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
    await Bun.sleep(120);
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
});
