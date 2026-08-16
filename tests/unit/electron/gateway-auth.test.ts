import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { appendVary, loadOrCreateGatewayToken, OrkestratorGateway } from "../../../apps/backend/src/gateway";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import {
  createLogger,
  createRendererRoot,
  createTempDir,
  decodeResponseBody,
  eventClients,
  gateways,
  readGatewayMetrics,
  requestUrl,
  startGateway,
} from "./gateway-test-harness.js";


describe("remote gateway", () => {



  test("keeps the control listener identity and merges Origin with Accept-Encoding remotely", async () => {
    const dataDir = await createTempDir("ork-dynamic-control-");
    const rendererRoot = await createRendererRoot(dataDir);
    const payload = "private state ".repeat(512);
    const { gateway, info } = await startGateway({
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      compression: "body",
      allowedOrigins: ["https://client.example"],
      backend: { invoke: mock(async () => payload) },
    });
    expect(info.browserUrl).toBeDefined();
    const invoke = (baseUrl: string, origin?: string) => requestUrl(
      `${baseUrl}__orkestrator/invoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${info.token}`,
          "content-type": "application/json",
          "accept-encoding": "gzip",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ command: "large_response", args: {} }),
      },
    );

    const control = await invoke(info.url);
    expect(control.headers["content-encoding"]).toBeUndefined();
    expect(control.headers.vary).toBeUndefined();

    const browser = await invoke(info.browserUrl!, "https://client.example");
    expect(browser.headers["content-encoding"]).toBe("gzip");
    expect(browser.headers.vary?.toLowerCase().split(/,\s*/).sort()).toEqual([
      "accept-encoding",
      "origin",
    ]);
    expect(browser.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(decodeResponseBody(browser))).toEqual({ result: payload });
    expect(eventClients(gateway).size).toBe(0);
  });



  test("merges Vary values without clobbering Origin", () => {
    expect(appendVary("Origin", "Accept-Encoding")).toBe("Origin, Accept-Encoding");
    expect(appendVary("origin, accept-encoding", "Accept-Encoding")).toBe("origin, accept-encoding");
  });



  test("authenticates metrics routes and validates, sanitizes, and evicts client reports", async () => {
    const { info } = await startGateway();
    const metricsUrl = `${info.url}__orkestrator/metrics`;
    const clientMetricsUrl = `${info.url}__orkestrator/client-metrics`;
    const authorization = { authorization: `Bearer ${info.token}` };

    expect((await requestUrl(metricsUrl)).status).toBe(401);
    const wrongMetricsMethod = await requestUrl(metricsUrl, {
      method: "POST",
      headers: authorization,
    });
    expect(wrongMetricsMethod.status).toBe(405);
    expect(wrongMetricsMethod.headers.allow).toBe("GET");

    expect((await requestUrl(clientMetricsUrl, { method: "POST" })).status).toBe(401);
    const wrongClientMethod = await requestUrl(clientMetricsUrl, { headers: authorization });
    expect(wrongClientMethod.status).toBe(405);
    expect(wrongClientMethod.headers.allow).toBe("POST");

    const headers = {
      ...authorization,
      "content-type": "application/json",
    };
    const malformed = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json()).toEqual({ error: "Malformed JSON request body" });

    const nonObject = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: "[]",
    });
    expect(nonObject.status).toBe(400);
    expect(nonObject.json()).toEqual({ error: "Expected JSON object body" });

    const oversized = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ padding: "x".repeat(64 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.json()).toEqual({ error: "Request body is too large" });

    const sanitized = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        platform: "not-a-platform",
        navigationType: "not-navigation",
        nextHopProtocol: "💣".repeat(100),
        resourceCount: -1,
        loadEventMs: 700_000,
      }),
    });
    expect(sanitized.status).toBe(202);
    const sanitizedMetrics = await readGatewayMetrics(info);
    expect(sanitizedMetrics.recentClientBootReports.at(-1)).toMatchObject({
      platform: "unknown",
      navigationType: "unknown",
      nextHopProtocol: "other",
      resourceCount: null,
      loadEventMs: null,
    });

    for (let resourceCount = 0; resourceCount < 40; resourceCount += 1) {
      const response = await requestUrl(clientMetricsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          platform: "desktop-browser",
          navigationType: "navigate",
          nextHopProtocol: resourceCount === 39 ? "AValidLookingSecretToken" : "h2",
          resourceCount,
        }),
      });
      expect(response.status).toBe(202);
    }

    const metrics = await readGatewayMetrics(info);
    expect(metrics.recentRouteSamples).toHaveLength(32);
    expect(metrics.recentClientBootReports).toHaveLength(32);
    expect(metrics.recentClientBootReports[0]?.resourceCount).toBe(8);
    expect(metrics.recentClientBootReports.at(-1)?.resourceCount).toBe(39);
    expect(metrics.recentClientBootReports[0]?.nextHopProtocol).toBe("h2");
    expect(metrics.recentClientBootReports.at(-1)?.nextHopProtocol).toBe("other");
    expect(metrics.recentClientBootReports.every((report) => (
      report.platform === "desktop-browser"
      && report.navigationType === "navigate"
    ))).toBe(true);
    expect(metrics.routes["client-metrics"]).toMatchObject({
      requests: 46,
      statusCodes: {
        "202": 41,
        "400": 2,
        "405": 1,
        "413": 1,
      },
    });
    expect(metrics.routes["client-metrics"]!.requestBytes).toBeGreaterThan(0);
    expect(metrics.routes["client-metrics"]!.responseBytes).toBeGreaterThan(0);
  });



  test("persists a generated auth token and honors an explicit environment token", async () => {
    const dataDir = await createTempDir("ork-gateway-auth-");
    const generated = await loadOrCreateGatewayToken(dataDir, {});
    expect(generated.token.length).toBeGreaterThanOrEqual(16);
    expect((await stat(generated.authFile)).mode & 0o777).toBe(0o600);

    const loaded = await loadOrCreateGatewayToken(dataDir, {});
    expect(loaded.token).toBe(generated.token);

    const explicit = await loadOrCreateGatewayToken(dataDir, {
      ORKESTRATOR_GATEWAY_TOKEN: "explicit-token-value",
    });
    expect(explicit.token).toBe("explicit-token-value");
    expect(explicit).toMatchObject({ editable: false, source: "environment" });

    await expect(loadOrCreateGatewayToken(dataDir, {
      ORKESTRATOR_GATEWAY_TOKEN: "short",
    })).rejects.toThrow("Invalid ORKESTRATOR_GATEWAY_TOKEN");

    await writeFile(generated.authFile, JSON.stringify({ token: "invalid" }));
    const repaired = await loadOrCreateGatewayToken(dataDir, {});
    expect(repaired.token).not.toBe("invalid");
    expect(JSON.parse(await readFile(generated.authFile, "utf8"))).toEqual({ token: repaired.token });
  });



  test("honors startup guardrails for disabled, missing, invalid, and non-Tailscale binds", async () => {
    const dataDir = await createTempDir("ork-gateway-guard-");
    const rendererRoot = await createRendererRoot(dataDir);
    const logger = createLogger();

    const disabled = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_DISABLED: "1" },
      logger,
    });
    expect(await disabled.start()).toBeNull();

    const noTailscale = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      interfaces: { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "00:00:00:00:00:00" }] },
      env: {},
      logger,
    });
    expect(await noTailscale.start()).toBeNull();

    const loopbackFallback = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      fallbackBindAddress: "127.0.0.1",
      port: 0,
      interfaces: { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "00:00:00:00:00:00" }] },
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    gateways.push(loopbackFallback);
    await expect(loopbackFallback.start()).resolves.toMatchObject({ bindAddress: "127.0.0.1" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to 127.0.0.1"));

    const nonTailscaleFallback = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      fallbackBindAddress: "0.0.0.0",
      interfaces: {},
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    await expect(nonTailscaleFallback.start()).rejects.toThrow("Refusing to bind gateway to non-Tailscale address");

    const nonTailscaleBind = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    await expect(nonTailscaleBind.start()).rejects.toThrow("Refusing to bind gateway to non-Tailscale address");

    const invalidPort = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "100.88.12.3",
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456", ORKESTRATOR_GATEWAY_PORT: "nope" },
      logger,
    });
    await expect(invalidPort.start()).rejects.toThrow("Invalid gateway port");
  });



  test("keeps a loopback control listener separate from the browser listener", async () => {
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
    });

    expect(info.browserUrl).toBeTruthy();
    expect(info.url).not.toBe(info.browserUrl);
    const headers = { authorization: `Bearer ${info.token}` };
    const controlResponse = await requestUrl(info.url, { headers });
    const browserResponse = await requestUrl(info.browserUrl!, { headers });
    expect(controlResponse.status).toBe(200);
    expect(browserResponse.status).toBe(200);
  });



  test("allows only the authenticated control listener to manage Electron web access", async () => {
    const getStatus = mock(() => ({ enabled: false, running: false, url: null, error: null }));
    const setEnabled = mock(async (enabled: boolean) => ({
      enabled,
      running: enabled,
      url: enabled ? "https://workstation.example.ts.net/" : null,
      error: null,
    }));
    const resetServe = mock(async () => ({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
    }));
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      webClientControl: { getStatus, setEnabled, resetServe },
    });
    const path = "__orkestrator/web-client-access";
    const headers = { authorization: `Bearer ${info.token}` };

    const initial = await requestUrl(`${info.url}${path}`, { headers });
    expect(initial.status).toBe(200);
    expect(initial.json()).toMatchObject({ enabled: false, running: false });

    const enabled = await requestUrl(`${info.url}${path}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, running: true });
    expect(setEnabled).toHaveBeenCalledWith(true);

    const reset = await requestUrl(`${info.url}${path}`, { method: "DELETE", headers });
    expect(reset.status).toBe(200);
    expect(reset.json()).toMatchObject({ running: true });
    expect(resetServe).toHaveBeenCalledTimes(1);

    const browserAttempt = await requestUrl(`${info.browserUrl}${path}`, { headers });
    expect(browserAttempt.status).toBe(404);
    const unauthenticated = await requestUrl(`${info.url}${path}`);
    expect(unauthenticated.status).toBe(401);
  });



  test("validates web access methods and request bodies", async () => {
    const setEnabled = mock(async (enabled: boolean) => ({
      enabled,
      running: enabled,
      url: null,
      error: null,
    }));
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      webClientControl: {
        getStatus: () => ({ enabled: false, running: false, url: null, error: null }),
        setEnabled,
        resetServe: async () => ({ enabled: true, running: true, url: null, error: null }),
      },
    });
    const endpoint = `${info.url}__orkestrator/web-client-access`;
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };

    const wrongMethod = await requestUrl(endpoint, { method: "POST", headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, PUT, DELETE");

    for (const body of ["{", "[]", "{}", JSON.stringify({ enabled: "yes" })]) {
      const response = await requestUrl(endpoint, { method: "PUT", headers, body });
      expect(response.status).toBe(400);
    }

    const oversized = await requestUrl(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, padding: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(setEnabled).not.toHaveBeenCalled();
  });



  test("surfaces web access controller failures without affecting other control requests", async () => {
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      webClientControl: {
        getStatus: () => ({ enabled: true, running: false, url: null, error: null }),
        setEnabled: async () => { throw new Error("lifecycle unavailable"); },
        resetServe: async () => { throw new Error("reset unavailable"); },
      },
    });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };
    const failed = await requestUrl(`${info.url}__orkestrator/web-client-access`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(failed.status).toBe(500);
    expect(failed.json()).toEqual({ error: "lifecycle unavailable" });

    const resetFailed = await requestUrl(`${info.url}__orkestrator/web-client-access`, {
      method: "DELETE",
      headers,
    });
    expect(resetFailed.status).toBe(500);
    expect(resetFailed.json()).toEqual({ error: "reset unavailable" });

    const status = await requestUrl(`${info.url}__orkestrator/status`, { headers });
    expect(status.status).toBe(200);
  });



  test("rejects a non-loopback control listener", async () => {
    await expect(startGateway({ controlBindAddress: "0.0.0.0" })).rejects.toThrow(
      "Control listener must use a loopback address",
    );
  });



  test("requires authentication before invoking backend commands", async () => {
    const dataDir = await createTempDir("ork-gateway-server-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);
    await writeFile(path.join(rendererRoot, "index.html"), "<div id=\"root\"></div>");

    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => ({ command, args })),
    };
    const gateway = new OrkestratorGateway({
      backend,
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();
    expect(info).not.toBeNull();

    const unauthenticated = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "get_projects" }),
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "get_projects", args: { projectId: "project-1" } }),
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.json()).toEqual({
      result: { command: "get_projects", args: { projectId: "project-1" } },
    });
    expect(backend.invoke).toHaveBeenCalledWith("get_projects", { projectId: "project-1" });

    const badCommand = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: 123 }),
    });
    expect(badCommand.status).toBe(400);

    // A body the caller can correct is a 4xx. Before, both of these escaped to
    // the generic server catch and reported 500, which reads as a backend fault.
    const malformedJson = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.json()).toEqual({ error: "Malformed JSON request body" });

    backend.invoke.mockImplementationOnce(async () => {
      throw new Error("backend failed");
    });
    const backendError = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "explode" }),
    });
    expect(backendError.status).toBe(500);
    expect(backendError.json()).toEqual({ error: "backend failed" });
  });



  test("supports allow-all and trailing-slash origin rules", async () => {
    const wildcard = await startGateway({ allowedOrigins: ["*"] });
    const anyOrigin = await requestUrl(`${wildcard.info.url}__orkestrator/status`, {
      headers: {
        origin: "https://anything.example",
        authorization: `Bearer ${wildcard.info.token}`,
      },
    });
    expect(anyOrigin.status).toBe(200);
    expect(anyOrigin.headers["access-control-allow-origin"]).toBe("https://anything.example");

    const trailing = await startGateway({ allowedOrigins: ["https://trailing.example/"] });
    const normalized = await requestUrl(`${trailing.info.url}__orkestrator/status`, {
      headers: {
        origin: "https://trailing.example",
        authorization: `Bearer ${trailing.info.token}`,
      },
    });
    expect(normalized.status).toBe(200);

    const rejected = await requestUrl(`${trailing.info.url}__orkestrator/status`, {
      headers: {
        origin: "https://other.example",
        authorization: `Bearer ${trailing.info.token}`,
      },
    });
    expect(rejected.status).toBe(403);
  });



  test("reads CORS origins from the environment and honors wildcard ports", async () => {
    const { info } = await startGateway({
      env: {
        ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456",
        ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: "https://*.preview.example:8443",
      },
    });
    const endpoint = `${info.url}__orkestrator/status`;

    const allowed = await requestUrl(endpoint, {
      headers: {
        origin: "https://branch.preview.example:8443",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://branch.preview.example:8443");

    for (const origin of [
      "https://preview.example:8443",
      "https://branch.preview.example:9443",
      "http://branch.preview.example:8443",
    ]) {
      const rejected = await requestUrl(endpoint, {
        headers: { origin, authorization: `Bearer ${info.token}` },
      });
      expect(rejected.status).toBe(403);
    }
  });



  test("sets and clears the auth cookie through login and logout", async () => {
    const { info } = await startGateway();

    const loginPage = await requestUrl(`${info.url}__orkestrator/login`, {
      headers: { accept: "text/html" },
    });
    expect(loginPage.status).toBe(200);
    expect(loginPage.body).toContain("Orkestrator Gateway");

    const rejected = await requestUrl(`${info.url}__orkestrator/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wrong-token",
    });
    expect(rejected.status).toBe(401);
    expect(rejected.body).toContain("Invalid gateway token");

    const accepted = await requestUrl(`${info.url}__orkestrator/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(info.token)}`,
    });
    expect(accepted.status).toBe(303);
    expect(accepted.headers["set-cookie"]?.[0]).toContain("orkestrator_gateway_auth=");

    const logout = await requestUrl(`${info.url}__orkestrator/logout`, {
      headers: { cookie: `orkestrator_gateway_auth=${info.token}` },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });



  test("uses a loopback-only single-use exchange for agent-test browser sessions", async () => {
    const { info } = await startGateway({ agentTestMode: true });
    const bootstrapUrl = `${info.url}__orkestrator/agent-test/bootstrap`;

    const unauthenticated = await requestUrl(bootstrapUrl, { method: "POST" });
    expect(unauthenticated.status).toBe(401);

    const minted = await requestUrl(bootstrapUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(minted.status).toBe(201);
    const { code } = minted.json() as { code: string };
    expect(code).toHaveLength(43);

    const exchange = await requestUrl(`${bootstrapUrl}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers["set-cookie"]?.[0];
    expect(cookie).toContain("orkestrator_gateway_auth=");
    expect(cookie).not.toContain(info.token);
    expect(cookie).toContain("Max-Age=900");

    const authenticated = await requestUrl(`${info.url}__orkestrator/status`, {
      headers: { cookie },
    });
    expect(authenticated.status).toBe(200);

    const reused = await requestUrl(`${bootstrapUrl}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(reused.status).toBe(401);
  });



  test("does not store the persistent gateway token in an agent-test login cookie", async () => {
    const { info } = await startGateway({ agentTestMode: true });
    const accepted = await requestUrl(`${info.url}__orkestrator/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(info.token)}`,
    });
    const cookie = accepted.headers["set-cookie"]?.[0];
    expect(accepted.status).toBe(303);
    expect(cookie).toContain("orkestrator_gateway_auth=");
    expect(cookie).not.toContain(info.token);
  });



  test("returns and rotates the persisted token for an authenticated client", async () => {
    const { info, dataDir } = await startGateway({ env: {} });
    const oldCookie = `orkestrator_gateway_auth=${info.token}`;

    const current = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: oldCookie },
    });
    expect(current.status).toBe(200);
    expect(current.json()).toEqual({ token: info.token, editable: true, source: "file" });

    const replacement = "replacement-token-123456";
    const updated = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: {
        cookie: oldCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: replacement }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json()).toEqual({ token: replacement, editable: true, source: "file" });
    expect(updated.headers["set-cookie"]?.[0]).toContain(`orkestrator_gateway_auth=${replacement}`);

    const rejectedOldToken = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: oldCookie },
    });
    expect(rejectedOldToken.status).toBe(401);

    const acceptedNewToken = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: `orkestrator_gateway_auth=${replacement}` },
    });
    expect(acceptedNewToken.status).toBe(200);
    expect((await loadOrCreateGatewayToken(dataDir, {})).token).toBe(replacement);
  });



  test("rejects invalid token boundaries before changing the active credential", async () => {
    const { info } = await startGateway({ env: {} });
    const oldCookie = `orkestrator_gateway_auth=${info.token}`;
    const invalidTokens = [
      "short",
      "a".repeat(1025),
      "\ud800".repeat(16),
      "😀".repeat(512),
    ];

    for (const token of invalidTokens) {
      const response = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
        method: "PUT",
        headers: { cookie: oldCookie, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(response.status).toBe(400);
    }

    const stillAuthenticated = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: oldCookie },
    });
    expect(stillAuthenticated.status).toBe(200);
    expect(stillAuthenticated.json()).toMatchObject({ token: info.token });
  });



  test("normalizes valid token whitespace before persistence and cookie issuance", async () => {
    const { info, dataDir } = await startGateway({ env: {} });
    const response = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: {
        cookie: `orkestrator_gateway_auth=${info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "  replacement-token-123456  " }),
    });

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ token: "replacement-token-123456" });
    expect(response.headers["set-cookie"]?.[0]).toContain("replacement-token-123456");
    expect((await loadOrCreateGatewayToken(dataDir, {})).token).toBe("replacement-token-123456");
  });



  test("serializes concurrent rotations and leaves disk and memory on the last queued token", async () => {
    const { gateway, dataDir } = await startGateway({ env: {} });
    const firstToken = `first-${"a".repeat(64)}`;
    const secondToken = `second-${"b".repeat(900)}`;

    await Promise.all([
      gateway.setToken(firstToken),
      gateway.setToken(secondToken),
    ]);

    expect(await gateway.getTokenSettings()).toMatchObject({ token: secondToken });
    expect((await loadOrCreateGatewayToken(dataDir, {})).token).toBe(secondToken);
  });



  test("returns 500 for persistence failures and keeps the previous active token", async () => {
    const { info, dataDir } = await startGateway({ env: {} });
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, "not a directory");
    const oldAuthorization = { authorization: `Bearer ${info.token}` };

    const rotation = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: { ...oldAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ token: "replacement-token-123456" }),
    });
    expect(rotation.status).toBe(500);
    expect(rotation.json()).toEqual({ error: "Unable to persist gateway token" });

    const oldTokenStillWorks = await requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: { ...oldAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ command: "get_projects" }),
    });
    expect(oldTokenStillWorks.status).toBe(200);
  });



  test("rejects edits when the token is managed by the environment", async () => {
    const { info } = await startGateway();
    const response = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "replacement-token-123456" }),
    });

    expect(response.status).toBe(400);
    expect(response.json()).toEqual({
      error: "Gateway token is managed by ORKESTRATOR_GATEWAY_TOKEN and cannot be changed here",
    });
  });



  test("proxies authenticated loopback POSTs without leaking gateway credentials or browser origin", async () => {
    const targetRequests: Array<{
      authorization?: string;
      proxyAuthorization?: string;
      codexToken?: string;
      acpToken?: string;
      openCodeToken?: string;
      cookie?: string;
      origin?: string;
      method?: string;
      body: string;
    }> = [];
    const target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        targetRequests.push({
          authorization: request.headers.authorization,
          proxyAuthorization: request.headers["proxy-authorization"],
          codexToken: request.headers["x-orkestrator-codex-token"] as string | undefined,
          acpToken: request.headers["x-orkestrator-acp-token"] as string | undefined,
          openCodeToken: request.headers["x-orkestrator-opencode-token"] as string | undefined,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
          method: request.method,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, url: request.url }));
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const dataDir = await createTempDir("ork-gateway-proxy-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);
    await writeFile(path.join(rendererRoot, "index.html"), "<div id=\"root\"></div>");

    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();

    try {
      const response = await requestUrl(`${info!.url}__orkestrator/proxy/loopback/${targetAddress.port}/hello?x=1`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${info!.token}`,
          "proxy-authorization": "Basic must-not-reach-upstream",
          cookie: "orkestrator_gateway_auth=test-token-123456; app_session=abc123",
          origin: new URL(info!.url).origin,
          "content-type": "application/json",
          "x-orkestrator-codex-token": "codex-bridge-token",
          "x-orkestrator-opencode-token": "opencode-password",
          "x-orkestrator-acp-token": "acp-bridge-token",
        },
        body: JSON.stringify({ prompt: "review" }),
      });
      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ ok: true, url: "/hello?x=1" });
      expect(targetRequests).toEqual([{
        authorization: `Basic ${Buffer.from("opencode:opencode-password").toString("base64")}`,
        proxyAuthorization: undefined,
        codexToken: "codex-bridge-token",
        acpToken: "acp-bridge-token",
        openCodeToken: undefined,
        cookie: "app_session=abc123",
        origin: undefined,
        method: "POST",
        body: JSON.stringify({ prompt: "review" }),
      }]);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

});
