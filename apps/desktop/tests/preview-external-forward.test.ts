import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Socket,
} from "node:net";

import { WebSocket as WsClient } from "ws";

import { createCommandRegistry } from "../../backend/src/core/commands";
import type { CommandContext } from "../../backend/src/core/commands-context";
import {
  createPreviewHarness,
  type PreviewHarness,
} from "../../backend/src/core/preview-test-support";
import { upstreamRequestHeaders } from "@orkestrator/protocol/preview-header-policy";

import { PreviewMetrics } from "../../backend/src/preview-metrics";
import { PreviewTunnelServer } from "../../backend/src/preview-tunnel-server";
import {
  externalForwardOrigin,
  externalForwardSiteViolation,
  openServiceInExternalBrowser,
  PreviewExternalForward,
  type ExternalForwardTimers,
  type ExternalForwardUpstream,
} from "../electron/preview-external-forward";
import {
  PreviewTransportManager,
  type PreviewServiceSession,
} from "../electron/preview-transport-manager";
import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server";

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Idle timers the test fires itself, so no test waits on the wall clock. */
class ManualTimers implements ExternalForwardTimers {
  private next = 0;
  readonly pending = new Map<number, () => void>();
  set(callback: () => void): number {
    this.next += 1;
    this.pending.set(this.next, callback);
    return this.next;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(): void {
    const callbacks = Array.from(this.pending.values());
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}

/** Wait for socket events to settle a condition, bounded by attempts rather than a fixed delay. */
async function until(condition: () => boolean, attempts = 2_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Condition was not reached.");
}

function requestWith(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

/** A port that was free a moment ago on both loopback families. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("externalForwardOrigin", () => {
  test("default HTTP authorities are canonical for requests and Origin rewriting", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const authority of [host, `${host}:80`]) {
        const publicOrigin = externalForwardOrigin(authority, 80);
        expect(publicOrigin).toBe(`http://${host}`);
        for (const upgrade of [false, true]) {
          // POST and WebSocket Origin headers use the same canonical mapping.
          const headers = upstreamRequestHeaders(
            [["origin", `http://${host}`]],
            {
              publicOrigin: publicOrigin!,
              privateAuthority: "localhost:3000",
              privateOrigins: ["http://localhost:3000"],
            },
            { upgrade },
          );
          expect(headers).toContainEqual(["origin", "http://localhost:3000"]);
          expect(headers.some(([name]) => name === "x-forwarded-host")).toBe(false);
        }
      }
      expect(externalForwardOrigin(host, 3000)).toBeNull();
      expect(externalForwardOrigin(`${host}:81`, 80)).toBeNull();
    }
    for (const host of [
      "evil.test",
      "localhost.evil.test",
      "localhost@evil.test",
      "localhost/",
      "localhost:99999",
      "127.1",
      undefined,
    ]) {
      expect(externalForwardOrigin(host, 80)).toBeNull();
    }
    expect(externalForwardOrigin("LOCALHOST:3000", 3000)).toBe("http://localhost:3000");
  });
});

describe("externalForwardSiteViolation", () => {
  test("the user's own loopback sites and direct navigations pass", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      expect(
        externalForwardSiteViolation(requestWith("GET", { "sec-fetch-site": site }), false),
      ).toBe(false);
    }
    expect(externalForwardSiteViolation(requestWith("GET", {}), false)).toBe(false);
    expect(
      externalForwardSiteViolation(
        requestWith("POST", { origin: "http://localhost:4000", "sec-fetch-site": "same-site" }),
        false,
      ),
    ).toBe(false);
    expect(
      externalForwardSiteViolation(requestWith("GET", { origin: "http://127.0.0.1:3000" }), true),
    ).toBe(false);
  });

  test("cross-site loopback GETs, HEADs and preflights follow the write allowlist", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (const origin of ["http://127.0.0.1:3000", "http://localhost:4000", "http://[::1]"]) {
        expect(
          externalForwardSiteViolation(
            requestWith(method, {
              origin,
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
              "sec-fetch-dest": "empty",
            }),
            false,
          ),
        ).toBe(false);
      }
    }
  });

  test("another site may only navigate to the forward", () => {
    const crossSite = { "sec-fetch-site": "cross-site" };
    expect(
      externalForwardSiteViolation(
        requestWith("GET", {
          ...crossSite,
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        }),
        false,
      ),
    ).toBe(false);
    const refused: Array<Record<string, string>> = [
      { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
      { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-purpose": "prefetch" },
    ];
    for (const extra of refused) {
      expect(
        externalForwardSiteViolation(requestWith("GET", { ...crossSite, ...extra }), false),
      ).toBe(true);
    }
  });

  test("foreign or opaque origins cannot write or open WebSockets", () => {
    expect(
      externalForwardSiteViolation(requestWith("POST", { origin: "https://evil.example" }), false),
    ).toBe(true);
    expect(externalForwardSiteViolation(requestWith("POST", { origin: "null" }), false)).toBe(true);
    expect(
      externalForwardSiteViolation(requestWith("GET", { origin: "https://evil.example" }), true),
    ).toBe(true);
    expect(
      externalForwardSiteViolation(requestWith("POST", { "sec-fetch-site": "cross-site" }), false),
    ).toBe(true);
    expect(
      externalForwardSiteViolation(requestWith("GET", { origin: "https://evil.example" }), false),
    ).toBe(true);
    expect(
      externalForwardSiteViolation(
        requestWith("GET", { origin: "http://localhost.evil.example" }),
        false,
      ),
    ).toBe(true);
  });
});

describe("PreviewExternalForward", () => {
  const forwards: PreviewExternalForward[] = [];
  const decoys: Server[] = [];
  let seen: Array<{ origin: string; host: string | undefined }>;

  beforeEach(() => {
    seen = [];
  });

  afterEach(async () => {
    await Promise.all(forwards.splice(0).map((forward) => forward.close()));
    await Promise.all(
      decoys.splice(0).map((decoy) => new Promise<void>((resolve) => decoy.close(() => resolve()))),
    );
  });

  function upstream(port: number, available = () => true): ExternalForwardUpstream {
    return {
      applicationPort: () => port,
      available,
      forwardRequest: async (request, response, publicOrigin) => {
        seen.push({ origin: publicOrigin, host: request.headers.host });
        response.end("upstream");
      },
      forwardUpgrade: async (_request, socket) => {
        socket.destroy();
      },
    };
  }

  function forward(
    target: ExternalForwardUpstream,
    options: { timers?: ExternalForwardTimers; onIdle?: () => void } = {},
  ) {
    const created = new PreviewExternalForward(target, {
      timers: options.timers ?? new ManualTimers(),
      onIdle: options.onIdle ?? (() => undefined),
    });
    forwards.push(created);
    return created;
  }

  test("uses one port on both loopback families and prefers the application port only where exclusive", async () => {
    const port = await freePort();
    const created = forward(upstream(port));
    const bound = await created.listen();
    if (process.platform === "darwin" || process.platform === "freebsd")
      expect(bound).not.toBe(port);
    else expect(bound).toBe(port);
    expect((await get(`http://127.0.0.1:${bound}/`, { host: `localhost:${bound}` })).body).toBe(
      "upstream",
    );
    expect((await get(`http://[::1]:${bound}/`, { host: `localhost:${bound}` })).body).toBe(
      "upstream",
    );
    expect(seen).toEqual([
      { origin: `http://localhost:${bound}`, host: `localhost:${bound}` },
      { origin: `http://localhost:${bound}`, host: `localhost:${bound}` },
    ]);
  });

  for (const address of ["127.0.0.1", "::1", "0.0.0.0", "::"]) {
    test(`a local server on ${address} keeps its traffic and port`, async () => {
      const port = await freePort();
      const decoyHits = mock(() => undefined);
      const decoy = createServer((_request, response) => {
        decoyHits();
        response.end("decoy");
      });
      decoys.push(decoy);
      await new Promise<void>((resolve) => decoy.listen(port, address, resolve));

      const created = forward(upstream(port));
      const bound = await created.listen();
      expect(bound).not.toBe(port);
      expect((await get(`http://127.0.0.1:${bound}/`, { host: `localhost:${bound}` })).body).toBe(
        "upstream",
      );
      expect((await get(`http://[::1]:${bound}/`, { host: `localhost:${bound}` })).body).toBe(
        "upstream",
      );
      expect(decoyHits).not.toHaveBeenCalled();
      const decoyHost = address.includes(":") ? "[::1]" : "127.0.0.1";
      expect((await get(`http://${decoyHost}:${port}/`)).body).toBe("decoy");
      expect(decoyHits).toHaveBeenCalledTimes(1);
    });
  }

  test("browser-restricted service ports select a usable HTTP port", async () => {
    for (const preferred of [6000, 6667, 10080]) {
      const created = forward(upstream(preferred));
      const port = await created.listen();
      expect(port).not.toBe(preferred);
      const response = await fetch(`http://localhost:${port}/`);
      expect(await response.text()).toBe("upstream");
    }
  });

  test("refuses a foreign Host, cross-site reads and an unavailable service", async () => {
    let available = true;
    const created = forward(upstream(await freePort(), () => available));
    const port = await created.listen();
    const url = `http://127.0.0.1:${port}/`;
    expect((await get(url, { host: "evil.test" })).status).toBe(403);
    expect((await get(url, { host: `localhost:${port + 1}` })).status).toBe(403);
    expect(
      (
        await get(url, {
          host: `localhost:${port}`,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "script",
        })
      ).status,
    ).toBe(403);
    expect((await get(url, { host: `127.0.0.1:${port}` })).status).toBe(200);
    available = false;
    expect((await get(url, { host: `localhost:${port}` })).status).toBe(502);
    expect(seen).toEqual([{ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }]);
  });

  test("reports idle only once no connection is open, then closes cleanly", async () => {
    const onIdle = mock(() => undefined);
    const timers = new ManualTimers();
    const created = forward(upstream(await freePort()), { timers, onIdle });
    const port = await created.listen();
    expect(timers.pending.size).toBe(1);
    const held = await new Promise<Socket>((resolve) => {
      const socket: Socket = netConnect(port, "127.0.0.1", () => resolve(socket));
    });
    await until(() => timers.pending.size === 0);
    timers.fire();
    expect(onIdle).not.toHaveBeenCalled();
    held.destroy();
    await until(() => timers.pending.size === 1);
    timers.fire();
    expect(onIdle).toHaveBeenCalledTimes(1);
    await created.close();
    await expect(get(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

describe("openServiceInExternalBrowser", () => {
  function routes(remote: boolean, publication: boolean | Error) {
    const calls: string[] = [];
    return {
      calls,
      routes: {
        remote,
        publicationAvailable: async () => {
          if (publication instanceof Error) throw publication;
          return publication;
        },
        publish: async () => {
          calls.push("publish");
        },
        forward: async () => {
          calls.push("forward");
          return "http://localhost:3000/start";
        },
        openExternal: async (url: string) => {
          calls.push(`open ${url}`);
        },
      },
    };
  }

  test("a remote service without a private origin is forwarded to localhost", async () => {
    for (const publication of [false, new Error("older backend")]) {
      const { calls, routes: chosen } = routes(true, publication);
      await openServiceInExternalBrowser(chosen);
      expect(calls).toEqual(["forward", "open http://localhost:3000/start"]);
    }
  });

  test("a failed forward rejects without opening a URL or publishing", async () => {
    const { calls, routes: chosen } = routes(true, false);
    chosen.forward = async () => {
      throw new Error("listen failed");
    };
    await expect(openServiceInExternalBrowser(chosen)).rejects.toThrow("listen failed");
    expect(calls).toEqual([]);
  });

  test("a configured private origin is preferred, and local services keep it", async () => {
    const remote = routes(true, true);
    await openServiceInExternalBrowser(remote.routes);
    expect(remote.calls).toEqual(["publish"]);
    const local = routes(false, false);
    await openServiceInExternalBrowser(local.routes);
    expect(local.calls).toEqual(["publish"]);
  });
});

describe("PreviewTransportManager.forwardExternally (desktop tunnel end to end)", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let gateway: Server;
  let tunnel: PreviewTunnelServer;
  let manager: PreviewTransportManager;
  let serviceId: string;
  let backendInstanceId: string;
  let timers: ManualTimers;

  beforeEach(async () => {
    timers = new ManualTimers();
    fixture = await startPreviewFixture({ marker: "forwarded-app" });
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
    const gatewayPort = (gateway.address() as AddressInfo).port;
    const commands = createCommandRegistry();
    const context = {
      storage: harness.storage,
      previews: harness.runtime,
    } as unknown as CommandContext;
    const session: PreviewServiceSession = {
      webRequest: { onBeforeSendHeaders: () => undefined, onBeforeRequest: () => undefined },
      clearStorageData: async () => undefined,
    };
    manager = new PreviewTransportManager({
      invoke: async <T>(command: string, args: Record<string, unknown>) =>
        (await commands.get(command)!(args, context)) as T,
      tunnelUrl: () => `ws://127.0.0.1:${gatewayPort}/__orkestrator/preview/tunnel`,
      isRemote: () => true,
      partitionFor: (target) => `persist:test-${target.serviceId}`,
      sessionFor: () => session,
      clientKey: "window-test",
      retirementMs: 0,
      externalForwardTimers: timers,
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

  test("serves the remote service at localhost without a credential and reuses the forward", async () => {
    const url = await manager.forwardExternally(target("/app/page?x=1"));
    // The fixture holds its own port on this machine, so the forward moved.
    const port = Number(new URL(url).port);
    expect(port).not.toBe(fixture.port);
    expect(url).toBe(`http://localhost:${port}/app/page?x=1`);

    const page = await get(url);
    expect(page.status).toBe(200);
    expect(page.body).toContain("forwarded-app");
    expect(await manager.forwardExternally(target("/other"))).toBe(
      `http://localhost:${port}/other`,
    );
    expect(manager.stats().services).toBe(1);
  });

  test("the gateway cookie never reaches the service; application cookies do", async () => {
    const url = await manager.forwardExternally(target("/cookies/echo"));
    const echoed = JSON.parse(
      (await get(url, { cookie: "orkestrator_gateway_auth=secret; app=1" })).body,
    ) as { cookie: string | null };
    expect(echoed.cookie).toBe("app=1");
  });

  test("application WebSockets pass for the forward's own origin only", async () => {
    const url = new URL(await manager.forwardExternally(target()));
    const socket = new WsClient(`ws://localhost:${url.port}/ws`, ["fixture.v1"], {
      headers: { origin: url.origin },
    });
    const hello = await new Promise<string>((resolve, reject) => {
      socket.on("message", (data: unknown) => resolve(String(data)));
      socket.on("error", reject);
    });
    expect(JSON.parse(hello)).toEqual({ hello: "forwarded-app", protocol: "fixture.v1" });
    socket.close();

    const foreign = new WsClient(`ws://localhost:${url.port}/ws`, ["fixture.v1"], {
      headers: { origin: "https://evil.example" },
    });
    const status = await new Promise<number>((resolve) => {
      foreign.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      foreign.on("error", () => resolve(-1));
    });
    expect(status).toBe(403);
  });

  test("an idle forward closes and lets the service retire", async () => {
    const url = await manager.forwardExternally(target());
    expect((await get(url)).status).toBe(200);
    // The request's connection has closed once the idle timer is re-armed.
    await until(() => timers.pending.size === 1);
    timers.fire();
    await until(() => manager.stats().services === 0);
    await expect(get(url)).rejects.toThrow();
  });

  test("a click while an idle forward closes keeps the service for the new forward", async () => {
    await manager.forwardExternally(target());
    timers.fire();
    const url = await manager.forwardExternally(target("/health"));
    // A wrongly released holder retires the service on the next timer turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.stats().services).toBe(1);
    expect((await get(url)).status).toBe(200);
  });

  test("concurrent starts share one listener and keep each caller's path", async () => {
    const listen = spyOn(PreviewExternalForward.prototype, "listen");
    try {
      const urls = await Promise.all([
        manager.forwardExternally(target("/one")),
        manager.forwardExternally(target("/two")),
      ]);
      expect(new URL(urls[0]!).origin).toBe(new URL(urls[1]!).origin);
      expect(urls.map((url) => new URL(url).pathname)).toEqual(["/one", "/two"]);
      expect(listen).toHaveBeenCalledTimes(1);
      expect((await get(new URL("/health", urls[0]!).href)).status).toBe(200);
    } finally {
      listen.mockRestore();
    }
  });

  test("a listen failure releases the holder and a later click can retry", async () => {
    const original = PreviewExternalForward.prototype.listen;
    let failedUrl = "";
    const listen = spyOn(PreviewExternalForward.prototype, "listen").mockImplementationOnce(
      async function (this: PreviewExternalForward) {
        // Fail after acquiring real listeners, exercising partial-start cleanup.
        const port = await original.call(this);
        failedUrl = `http://localhost:${port}/`;
        throw new Error("listen failed");
      },
    );
    const close = spyOn(PreviewExternalForward.prototype, "close");
    try {
      await expect(manager.forwardExternally(target())).rejects.toThrow("listen failed");
      expect(close).toHaveBeenCalled();
      await expect(get(failedUrl)).rejects.toThrow();
      await until(() => manager.stats().services === 0);
      const url = await manager.forwardExternally(target());
      expect((await get(url)).status).toBe(200);
      expect(manager.stats().services).toBe(1);
    } finally {
      listen.mockRestore();
      close.mockRestore();
    }
  });

  test("disposal during listener startup closes late listeners and rejects the opener", async () => {
    const original = PreviewExternalForward.prototype.listen;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let url = "";
    const listen = spyOn(PreviewExternalForward.prototype, "listen").mockImplementationOnce(
      async function (this: PreviewExternalForward) {
        const port = await original.call(this);
        url = `http://localhost:${port}/`;
        entered();
        await blocked;
        return port;
      },
    );
    const opening = manager.forwardExternally(target()).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await started;
      await manager.disposeAll();
      resume();
      expect(await opening).toMatchObject({ preview: { category: "backend-unavailable" } });
      expect(manager.stats().services).toBe(0);
      await expect(get(url)).rejects.toThrow();
      await expect(manager.forwardExternally(target())).rejects.toMatchObject({
        preview: { category: "backend-unavailable" },
      });
    } finally {
      resume();
      listen.mockRestore();
    }
  });

  test("disposal closes the forward", async () => {
    const url = await manager.forwardExternally(target());
    await manager.disposeAll();
    await expect(get(url)).rejects.toThrow();
  });
});
