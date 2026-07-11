import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  isTailscaleAddress,
  loadOrCreateGatewayToken,
  OrkestratorGateway,
  selectTailscaleBindAddress,
} from "../../../electron/gateway";

const tempDirs: string[] = [];
const gateways: OrkestratorGateway[] = [];

async function requestUrl(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? "GET",
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body,
          headers: response.headers,
          json: () => JSON.parse(body) as unknown,
        });
      });
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function createLogger() {
  return {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createRendererRoot(dataDir: string, index = "<div id=\"root\"></div>"): Promise<string> {
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), index);
  return rendererRoot;
}

async function startGateway(options: Partial<ConstructorParameters<typeof OrkestratorGateway>[0]> = {}) {
  const dataDir = options.dataDir ?? await createTempDir("ork-gateway-");
  const rendererRoot = options.rendererRoot ?? await createRendererRoot(dataDir);
  const gateway = new OrkestratorGateway({
    backend: { invoke: mock(async () => null) },
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
    logger: createLogger(),
    unsafeAllowNonTailscaleBind: true,
    ...options,
  });
  gateways.push(gateway);
  const info = await gateway.start();
  if (!info) throw new Error("Gateway did not start");
  return { gateway, info, dataDir, rendererRoot };
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("remote gateway", () => {
  test("detects Tailscale addresses and prefers IPv4 bind candidates", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("192.168.1.20")).toBe(false);
    expect(isTailscaleAddress("fd7a:115c:a1e0:abcd::1")).toBe(true);

    expect(selectTailscaleBindAddress({
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "00:00:00:00:00:00" }],
      utun5: [
        { address: "fd7a:115c:a1e0:abcd::1", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", cidr: null, mac: "00:00:00:00:00:00", scopeid: 0 },
        { address: "100.88.12.3", family: "IPv4", internal: false, netmask: "255.192.0.0", cidr: null, mac: "00:00:00:00:00:00" },
      ],
    })).toBe("100.88.12.3");
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

  test("honors startup guardrails for disabled, missing, invalid, and unsafe binds", async () => {
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

    const unsafeBind = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    await expect(unsafeBind.start()).rejects.toThrow("Refusing to bind gateway to non-Tailscale address");

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
      unsafeAllowNonTailscaleBind: true,
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

    const malformedJson = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformedJson.status).toBe(500);

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

  test("returns client errors for malformed, non-object, oversized, and incomplete settings bodies", async () => {
    const { info } = await startGateway({ env: {} });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };

    const malformed = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const nonObject = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "[]",
    });
    expect(nonObject.status).toBe(400);

    const incomplete = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "{}",
    });
    expect(incomplete.status).toBe(400);

    const oversized = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ token: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const wrongMethod = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "POST",
      headers,
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, PUT");
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

  test("surfaces persistence failures without reporting a successful rotation", async () => {
    const root = await createTempDir("ork-gateway-write-failure-");
    const fileInsteadOfDirectory = path.join(root, "not-a-directory");
    await writeFile(fileInsteadOfDirectory, "blocked");
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: path.join(fileInsteadOfDirectory, "child"),
      rendererRoot: root,
      env: {},
      logger: createLogger(),
    });

    await expect(gateway.setToken("replacement-token-123456")).rejects.toThrow();
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

  test("serves static renderer files and blocks traversal outside the renderer root", async () => {
    const dataDir = await createTempDir("ork-gateway-static-");
    const rendererRoot = await createRendererRoot(dataDir, "<main>app</main>");
    await writeFile(path.join(rendererRoot, "asset.js"), "console.log('asset');");
    const { info } = await startGateway({ dataDir, rendererRoot });

    const index = await requestUrl(`${info.url}`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(index.status).toBe(200);
    expect(index.body).toBe("<main>app</main>");

    const asset = await requestUrl(`${info.url}asset.js`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");

    const spaFallback = await requestUrl(`${info.url}settings/repositories`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(spaFallback.status).toBe(200);
    expect(spaFallback.body).toBe("<main>app</main>");

    const traversal = await requestUrl(`${info.url}%2e%2e%2fpackage.json`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(traversal.status).toBe(403);
  });

  test("delivers backend events to authenticated event streams", async () => {
    const { gateway, info } = await startGateway();

    const eventBody = await new Promise<string>((resolve, reject) => {
      const parsed = new URL(`${info.url}__orkestrator/events`);
      const request = httpRequest({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: { authorization: `Bearer ${info.token}` },
      }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (body.includes("\"event\":\"menu-zoom\"")) {
            response.destroy();
            resolve(body);
          }
        });
      });
      request.on("error", reject);
      request.end();

      setTimeout(() => {
        gateway.emit("menu-zoom", "in");
      }, 10);
    });

    expect(eventBody).toContain(": connected");
    expect(eventBody).toContain("menu-zoom");
  });

  test("proxies authenticated loopback requests without leaking gateway credentials", async () => {
    const targetRequests: { authorization?: string; cookie?: string }[] = [];
    const target = createServer((request, response) => {
      targetRequests.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, url: request.url }));
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
      unsafeAllowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();

    try {
      const response = await requestUrl(`${info!.url}__orkestrator/proxy/loopback/${targetAddress.port}/hello?x=1`, {
        headers: {
          authorization: `Bearer ${info!.token}`,
          cookie: "orkestrator_gateway_auth=test-token-123456; app_session=abc123",
        },
      });
      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ ok: true, url: "/hello?x=1" });
      expect(targetRequests).toEqual([{ authorization: undefined, cookie: "app_session=abc123" }]);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  test("rewrites loopback proxy redirects and target cookies into the proxy namespace", async () => {
    const target = createServer((request, response) => {
      if (request.url === "/relative") {
        response.writeHead(302, { location: "/next" });
        response.end();
        return;
      }
      if (request.url === "/absolute") {
        const address = target.address();
        if (!address || typeof address !== "object") throw new Error("Target server did not bind");
        response.writeHead(302, { location: `http://127.0.0.1:${address.port}/next?x=1` });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [
          "app_session=abc123; Path=/; HttpOnly",
          "orkestrator_gateway_auth=evil; Path=/",
        ],
      });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const proxyPrefix = `/__orkestrator/proxy/loopback/${targetAddress.port}`;

    try {
      const cookieResponse = await requestUrl(`${info.url}${proxyPrefix}/cookies`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(cookieResponse.status).toBe(200);
      expect(cookieResponse.headers["set-cookie"]).toEqual([
        `app_session=abc123; Path=${proxyPrefix}/; HttpOnly`,
      ]);

      const relativeRedirect = await requestUrl(`${info.url}${proxyPrefix}/relative`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(relativeRedirect.status).toBe(302);
      expect(relativeRedirect.headers.location).toBe(`${proxyPrefix}/next`);

      const absoluteRedirect = await requestUrl(`${info.url}${proxyPrefix}/absolute`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(absoluteRedirect.status).toBe(302);
      expect(absoluteRedirect.headers.location).toBe(`${proxyPrefix}/next?x=1`);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  test("serves renderer requests through a configured dev server proxy", async () => {
    const devServer = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`dev:${request.url}`);
    });
    await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
    const devAddress = devServer.address();
    if (!devAddress || typeof devAddress !== "object") throw new Error("Dev server did not bind");

    const dataDir = await createTempDir("ork-gateway-dev-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);

    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      rendererDevServerUrl: `http://127.0.0.1:${devAddress.port}`,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      unsafeAllowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();

    try {
      const response = await requestUrl(`${info!.url}src/main.tsx?dev=1`, {
        headers: { authorization: `Bearer ${info!.token}` },
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe("dev:/src/main.tsx?dev=1");
    } finally {
      await new Promise<void>((resolve) => devServer.close(() => resolve()));
    }
  });

  test("stops promptly and disconnects an active streaming proxy response", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("streaming");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { gateway, info } = await startGateway();
    const request = httpRequest(`${info.url}__orkestrator/proxy/loopback/${targetAddress.port}/stream`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    let resolveResponseClosed: () => void = () => undefined;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const responseStarted = new Promise<void>((resolve, reject) => {
      request.once("response", (response) => {
        response.once("close", resolveResponseClosed);
        response.once("data", () => resolve());
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    request.end();

    try {
      await responseStarted;
      await Promise.race([
        gateway.stop(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Gateway stop timed out")), 1_000)),
      ]);
      await expect(responseClosed).resolves.toBeUndefined();
    } finally {
      request.destroy();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
