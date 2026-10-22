import { describe, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  BACKEND_CAPABILITIES,
  BACKEND_HELLO_PATH,
  CLIENT_API_VERSION,
  parseBackendHello,
} from "@orkestrator/protocol/backend-profile";
import type { BackendHelloIdentity } from "../src/gateway";
import {
  auxiliaryServers,
  createLogger,
  openTerminalSocket,
  requestUrl,
  startGateway,
} from "./gateway-test-harness.js";

const identity: BackendHelloIdentity = {
  installationId: "bk_test-installation",
  generation: "generation-1",
  appVersion: "9.9.9-test",
  profile: {
    revision: 3,
    displayName: "Build box",
    colorToken: "teal",
    updatedAt: "2026-10-21T00:00:00.000Z",
  },
};

function helloUrl(base: string): string {
  return new URL(BACKEND_HELLO_PATH, base).toString();
}

function controlRoutes() {
  return {
    webClientControl: {
      getStatus: mock(() => ({ enabled: false, running: false, url: null, error: null })),
      setEnabled: mock(async () => ({ enabled: true, running: true, url: null, error: null })),
      resetServe: mock(async () => ({ enabled: true, running: true, url: null, error: null })),
    },
    hostUpdaterControl: {
      snapshot: mock(async () => ({ revision: 1 }) as never),
      report: mock(() => ({ revision: 1 }) as never),
    },
  };
}

describe("authenticated hello handshake", () => {
  test("requires the gateway token and reports the answering listener's role", async () => {
    const backendHello = mock(async () => identity);
    const { info, dataDir } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      backendHello,
    });
    const headers = { authorization: `Bearer ${info.token}` };

    for (const base of [info.url, info.browserUrl!]) {
      expect((await requestUrl(helloUrl(base))).status).toBe(401);
      expect(
        (await requestUrl(helloUrl(base), { headers: { authorization: "Bearer wrong-token" } }))
          .status,
      ).toBe(401);
    }

    const browser = await requestUrl(helloUrl(info.browserUrl!), { headers });
    expect(browser.status).toBe(200);
    expect(browser.headers["cache-control"]).toBe("no-store");
    const browserHello = parseBackendHello(browser.json());
    expect(browserHello).toEqual({
      schemaVersion: 1,
      installationId: identity.installationId as never,
      generation: identity.generation,
      appVersion: identity.appVersion,
      clientApi: { minVersion: 1, maxVersion: CLIENT_API_VERSION },
      capabilities: {
        [BACKEND_CAPABILITIES.backendProfile]: 1,
        [BACKEND_CAPABILITIES.summaryReads]: 1,
      },
      profile: identity.profile,
      endpointRole: "client",
    });

    const control = await requestUrl(helloUrl(info.url), { headers });
    expect(control.status).toBe(200);
    expect(parseBackendHello(control.json()).endpointRole).toBe("control");

    // Safe metadata only: no paths, credential file or credential.
    for (const response of [browser, control]) {
      const body = response.body;
      expect(body).not.toContain(info.token);
      expect(body).not.toContain(dataDir);
      expect(body).not.toContain("authFile");
      expect(body).not.toContain("dataDir");
      expect(body).not.toContain("pid");
    }

    const post = await requestUrl(helloUrl(info.browserUrl!), { method: "POST", headers });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET");
    expect(backendHello).toHaveBeenCalledTimes(2);
  });

  test("answers CORS preflight like the other API routes", async () => {
    const { info } = await startGateway({
      backendHello: async () => identity,
      allowedOrigins: ["https://orkestrator.dev"],
    });
    const preflight = await requestUrl(helloUrl(info.url), {
      method: "OPTIONS",
      headers: {
        origin: "https://orkestrator.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://orkestrator.dev");

    const hello = await requestUrl(helloUrl(info.url), {
      headers: { origin: "https://orkestrator.dev", authorization: `Bearer ${info.token}` },
    });
    expect(hello.status).toBe(200);
    expect(hello.headers["access-control-allow-origin"]).toBe("https://orkestrator.dev");

    const foreign = await requestUrl(helloUrl(info.url), {
      headers: { origin: "https://evil.example", authorization: `Bearer ${info.token}` },
    });
    expect(foreign.status).toBe(403);
  });

  test("is absent when the gateway fronts no backend identity", async () => {
    const { info } = await startGateway();
    const response = await requestUrl(helloUrl(info.url), {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("loopback client gateway", () => {
  test("binds 127.0.0.1, serves client routes and never the control-only ones (SH-08, SH-09)", async () => {
    const routes = controlRoutes();
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      loopbackClientPort: 0,
      backendHello: async () => identity,
      ...routes,
    });
    const loopbackUrl = info.loopbackClientUrl!;
    expect(loopbackUrl).toBeTruthy();
    expect(new URL(loopbackUrl).hostname).toBe("127.0.0.1");
    expect(loopbackUrl).not.toBe(info.url);
    expect(loopbackUrl).not.toBe(info.browserUrl);
    expect(info.controlUrl).toBe(info.url);
    expect(info.loopbackClientError).toBeUndefined();
    const headers = { authorization: `Bearer ${info.token}` };

    // SH-08: SSH reaching the port never bypasses gateway authentication.
    expect((await requestUrl(helloUrl(loopbackUrl))).status).toBe(401);
    expect(
      (
        await requestUrl(helloUrl(loopbackUrl), {
          headers: { authorization: "Bearer not-the-token" },
        })
      ).status,
    ).toBe(401);

    const hello = await requestUrl(helloUrl(loopbackUrl), { headers });
    expect(hello.status).toBe(200);
    const parsed = parseBackendHello(hello.json());
    expect(parsed.endpointRole).toBe("client");
    expect(parsed.capabilities[BACKEND_CAPABILITIES.loopbackClientGateway]).toBe(1);
    expect(
      (await requestUrl(new URL("__orkestrator/status", loopbackUrl).toString(), { headers }))
        .status,
    ).toBe(200);

    // The terminal WebSocket upgrades here exactly as on the browser listener.
    const terminal = await openTerminalSocket({ url: loopbackUrl, token: info.token });
    terminal.socket.close();

    // SH-09: the maintenance routes exist on the control listener only.
    for (const route of ["__orkestrator/host-updater", "__orkestrator/web-client-access"]) {
      expect((await requestUrl(new URL(route, info.url).toString(), { headers })).status).toBe(200);
      expect((await requestUrl(new URL(route, loopbackUrl).toString(), { headers })).status).toBe(
        404,
      );
      expect(
        (await requestUrl(new URL(route, info.browserUrl!).toString(), { headers })).status,
      ).toBe(404);
    }
    expect(routes.hostUpdaterControl.snapshot).toHaveBeenCalledTimes(1);
    expect(routes.webClientControl.getStatus).toHaveBeenCalledTimes(1);
  });

  test("a busy port fails only that listener and keeps the gateway serving", async () => {
    const occupied: Server = createServer();
    auxiliaryServers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    const busyPort = typeof address === "object" && address ? address.port : 0;
    const logger = createLogger();

    const { info } = await startGateway({
      loopbackClientPort: busyPort,
      backendHello: async () => identity,
      logger,
    });
    expect(info.loopbackClientUrl).toBeUndefined();
    expect(info.loopbackClientError).toBeTruthy();
    expect(
      (logger.error.mock.calls as unknown[][]).some((call) =>
        String(call[0]).includes("Loopback client gateway unavailable"),
      ),
    ).toBe(true);

    const hello = await requestUrl(helloUrl(info.url), {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(hello.status).toBe(200);
    expect(
      parseBackendHello(hello.json()).capabilities[BACKEND_CAPABILITIES.loopbackClientGateway],
    ).toBeUndefined();
  });
});
