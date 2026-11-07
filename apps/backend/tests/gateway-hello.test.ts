import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  BACKEND_CAPABILITIES,
  BACKEND_HELLO_PATH,
  CLIENT_API_VERSION,
  domainRange,
  isPreContract,
  parseBackendHello,
} from "@orkestrator/protocol/backend-profile";
import { defineCommand } from "@orkestrator/protocol/contract/command";
import { defineDomain } from "@orkestrator/protocol/contract/domain";
import * as Schema from "effect/Schema";
import {
  CommandRegistry,
  createRegistryRegistrar,
} from "../src/core/commands-registry-contracts.js";
import { GatewayLifecycle } from "../src/gateway-lifecycle.js";
import type { BackendHelloIdentity } from "../src/gateway";
import {
  auxiliaryServers,
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
  test("carries the build commit only when this build has one", async () => {
    for (const [buildCommit, expected] of [
      ["abc1234", "abc1234"],
      [null, undefined],
      [undefined, undefined],
    ] as const) {
      const { info } = await startGateway({
        backendHello: async () => ({ ...identity, buildCommit }),
      });
      const response = await requestUrl(helloUrl(info.url), {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(response.status).toBe(200);
      expect((response.json() as { buildCommit?: unknown }).buildCommit).toBe(expected);
      expect(parseBackendHello(response.json()).buildCommit).toBe(expected);
    }
  });

  for (const nodeMode of ["leaf", "command"] as const) {
    test(`${nodeMode} mode advertises remote mail steering on both listeners`, async () => {
      const { info } = await startGateway({
        controlBindAddress: "127.0.0.1",
        controlPort: 0,
        backendHello: async () => ({ ...identity, nodeMode }),
      });
      for (const base of [info.url, info.browserUrl!]) {
        const response = await requestUrl(helloUrl(base), {
          headers: { authorization: `Bearer ${info.token}` },
        });
        expect(response.status).toBe(200);
        const hello = parseBackendHello(response.json());
        expect(hello.nodeMode).toBe(nodeMode);
        expect(hello.capabilities[BACKEND_CAPABILITIES.nodeMailSteer]).toBe(1);
        expect(hello.capabilities[BACKEND_CAPABILITIES.nodeCoordinatorMail]).toBe(1);
        expect(hello.capabilities[BACKEND_CAPABILITIES.nodeCoordinatorBuildOrigin]).toBe(1);
        expect(hello.capabilities[BACKEND_CAPABILITIES.nodeMailAttachments]).toBe(1);
        expect(hello.capabilities[BACKEND_CAPABILITIES.ticketSync]).toBe(1);
      }
    });
  }

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
      domains: {},
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

  test("advertises the registry's domain ranges at the top level, never as capabilities", async () => {
    // The registry's ranges for a defined command (plan items 1003 and 1004):
    // max is the domain's version, min the oldest declared next to it.
    const system = defineDomain({ name: "system", version: 3, min: 2 });
    const probe = defineCommand({
      domain: system,
      name: "hello_domains_probe",
      since: 1,
      access: "workspace",
      read: true,
      args: Schema.Struct({}),
      result: Schema.Struct({}),
      critical: [],
    });
    const registry = new CommandRegistry();
    createRegistryRegistrar(registry, { validateResults: true })(probe, () => ({}));
    expect(registry.helloDomains()).toEqual({ system: { min: 2, max: 3 } });

    for (const [domains, expected] of [
      [registry.helloDomains(), { system: { min: 2, max: 3 } }],
      // A contract-aware backend with no defined commands still says so.
      [undefined, {}],
    ] as const) {
      const { info } = await startGateway({
        backendHello: async () => ({
          ...identity,
          nodeMode: "leaf",
          ...(domains ? { domains } : {}),
        }),
      });
      const response = await requestUrl(helloUrl(info.url), {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(response.status).toBe(200);
      const raw = response.json() as Record<string, unknown>;
      expect(raw.schemaVersion).toBe(1);
      expect(raw.domains).toEqual(expected);
      const parsed = parseBackendHello(raw);
      expect(parsed.domains).toEqual(expected);
      expect(isPreContract(parsed)).toBe(false);
      expect(domainRange(parsed, "system")).toEqual(
        "system" in expected ? { min: 2, max: 3 } : undefined,
      );
      for (const name of Object.keys(parsed.capabilities)) {
        expect(name in expected).toBe(false);
      }
    }
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
    const logs = captureLogs();

    const { info } = await startGateway({
      loopbackClientPort: busyPort,
      backendHello: async () => identity,
    });
    expect(info.loopbackClientUrl).toBeUndefined();
    expect(info.loopbackClientError).toBeTruthy();
    try {
      const failure = logs.records().find((record) => record.event === "loopback.unavailable");
      expect(failure).toMatchObject({
        area: "gateway",
        level: "error",
        fields: {
          address: "127.0.0.1",
          port: busyPort,
          error: { name: "Error", code: "EADDRINUSE" },
        },
      });
      expect(failure?.fields).not.toHaveProperty("detail");
    } finally {
      logs.restore();
    }

    const hello = await requestUrl(helloUrl(info.url), {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(hello.status).toBe(200);
    expect(
      parseBackendHello(hello.json()).capabilities[BACKEND_CAPABILITIES.loopbackClientGateway],
    ).toBeUndefined();
  });
});

describe("gateway startup diagnostics", () => {
  test("browser bind failure has structured error fields while loopback starts", async () => {
    const error = Object.assign(new Error("browser bind failed"), { code: "EADDRNOTAVAIL" });
    const bind = spyOn(GatewayLifecycle.prototype, "listenWithPortFallback").mockRejectedValue(
      error,
    );
    const logs = captureLogs();
    try {
      const { info } = await startGateway({ loopbackClientPort: 0 });
      expect(info.browserUrl).toBeUndefined();
      expect(info.loopbackClientUrl).toBeTruthy();
      const failure = logs.records().find((record) => record.event === "browser.unavailable");
      expect(failure).toMatchObject({
        area: "gateway",
        level: "error",
        fields: { error: { name: "Error", code: "EADDRNOTAVAIL", message: "browser bind failed" } },
      });
      expect(failure?.fields).not.toHaveProperty("detail");
    } finally {
      bind.mockRestore();
      logs.restore();
    }
  });

  test("missing Tailscale address logs a fixed reason before starting loopback", async () => {
    const logs = captureLogs();
    try {
      const { info } = await startGateway({
        bindAddress: undefined,
        interfaces: {},
        loopbackClientPort: 0,
      });
      expect(info.browserUrl).toBeUndefined();
      expect(info.loopbackClientUrl).toBeTruthy();
      const failure = logs
        .records()
        .find((record) => record.event === "browser.unavailable-degraded");
      expect(failure).toMatchObject({
        area: "gateway",
        level: "warn",
        fields: { reason: "no-tailscale-address", remaining: "loopback-client" },
      });
      expect(failure?.fields).not.toHaveProperty("detail");
    } finally {
      logs.restore();
    }
  });
});
