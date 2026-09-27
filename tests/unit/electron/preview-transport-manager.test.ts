import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";

import {
  PREVIEW_INGRESS_HEADER,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import { previewFailure } from "@orkestrator/protocol/preview-services";
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
  let failAttach: Error | null;
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
    failAttach = null;
    invoked.length = 0;
    sessions.clear();
    manager = new PreviewTransportManager({
      invoke: async <T>(command: string, args: Record<string, unknown>) => {
        invoked.push(command);
        if (failAttach && command === "create_preview_attachment") throw failAttach;
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
      onListen?: () => void;
      lookupHost?: (hostname: string) => Promise<string[]>;
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
        return undefined as T;
      },
      tunnelUrl: () => null,
      isRemote: () => remote,
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
