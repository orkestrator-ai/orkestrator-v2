import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../../apps/backend/src/core/storage";
import {
  BackendHttpClient,
  BackendProcess,
  createBackendProcessEnvironment,
  getBrowserGatewayStatus,
} from "../../../apps/desktop/electron/backend-process";

const directories: string[] = [];
const processes: BackendProcess[] = [];
const browserFetch = globalThis.fetch;

async function waitForWebClientStatus(
  client: BackendHttpClient,
  predicate: (status: Awaited<ReturnType<BackendHttpClient["getWebClientStatus"]>>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let status = await client.getWebClientStatus();
  while (!predicate(status) && Date.now() < deadline) {
    await Bun.sleep(25);
    status = await client.getWebClientStatus();
  }
  return status;
}

afterEach(async () => {
  globalThis.fetch = browserFetch;
  await Promise.all(processes.splice(0).map(async (backend) => {
    const child = (backend as unknown as {
      child: { once(event: "exit", listener: () => void): void } | null;
    }).child;
    const exited = child
      ? new Promise<void>((resolve) => {
          child.once("exit", resolve);
          setTimeout(resolve, 2_000);
        })
      : Promise.resolve();
    backend.stop();
    await exited;
  }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Electron backend process supervisor", () => {
  test("isolates the child from remote gateway and Tailscale Serve shell settings", () => {
    const parent = {
      PATH: "/bin",
      NODE_PATH: "/existing",
      ORKESTRATOR_GATEWAY_HOST: "100.64.0.1",
      ORKESTRATOR_GATEWAY_PORT: "9999",
      ORKESTRATOR_GATEWAY_TOKEN: "not-forwarded",
      ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: "https://untrusted.example",
      ORKESTRATOR_TAILSCALE_SERVE: "1",
      ORKESTRATOR_TAILSCALE_SERVE_PORT: "8443",
      ORKESTRATOR_TAILSCALE_BIN: "/tmp/tailscale",
      ORKESTRATOR_TOOLCHAIN_BIN: "/tmp/untrusted-tools",
    };

    const development = createBackendProcessEnvironment(parent, true, "/resources");
    expect(development).toEqual({
      PATH: "/bin",
      NODE_PATH: "/existing",
      ORKESTRATOR_GATEWAY_DISABLED: "0",
    });
    expect(parent.ORKESTRATOR_GATEWAY_TOKEN).toBe("not-forwarded");

    const production = createBackendProcessEnvironment(parent, false, "/resources");
    expect(production.NODE_PATH).toBe(
      [path.join("/resources", "backend", "vendor"), "/existing"].join(path.delimiter),
    );
  });

  test("reports browser availability independently from the desktop control listener", () => {
    expect(getBrowserGatewayStatus(null)).toEqual({
      enabled: true,
      running: false,
      url: null,
      error: null,
    });
    expect(getBrowserGatewayStatus({
      bindAddress: "127.0.0.1",
      port: 1234,
      url: "http://127.0.0.1:1234/",
      authFile: "/tmp/auth.json",
      browserError: "address unavailable",
    })).toMatchObject({ running: false, url: null, error: "address unavailable" });
    expect(getBrowserGatewayStatus({
      bindAddress: "127.0.0.1",
      port: 1234,
      url: "http://127.0.0.1:1234/",
      authFile: "/tmp/auth.json",
      browserUrl: "http://100.80.1.2:34121/",
    })).toMatchObject({ running: true, url: "http://100.80.1.2:34121/", error: null });
  });

  test("HTTP client covers commands, settings, errors, and event delivery", async () => {
    globalThis.fetch = Bun.fetch;
    const server = createServer(async (request, response) => {
      if (request.url === "/__orkestrator/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(': connected\n\ndata: {"event":"changed","payload":{"ok":true}}\n\n');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      response.setHeader("content-type", "application/json");
      if (request.url === "/__orkestrator/invoke" && body.command === "fail") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "command failed" }));
      } else if (request.url === "/__orkestrator/invoke") {
        response.end(JSON.stringify({ result: body.args }));
      } else if (request.url === "/__orkestrator/gateway-settings") {
        const token = request.method === "PUT"
          ? (body.token as string)
          : "initial-client-token-123456";
        response.end(JSON.stringify({ token, editable: true, source: "file" }));
      } else if (request.url === "/__orkestrator/web-client-access") {
        const enabled = request.method === "DELETE" || (request.method === "PUT" && body.enabled === true);
        response.end(JSON.stringify({
          enabled,
          running: enabled,
          url: enabled ? "https://workstation.example.ts.net/" : null,
          error: null,
        }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = new BackendHttpClient(`http://127.0.0.1:${address.port}/`, "initial-client-token-123456");

    await expect(client.invoke("echo", { value: 1 })).resolves.toEqual({ value: 1 });
    await expect(client.invoke("fail")).rejects.toThrow("command failed");
    await expect(client.getTokenSettings()).resolves.toMatchObject({ token: "initial-client-token-123456" });
    await expect(client.setToken("changed-client-token-123456")).resolves.toMatchObject({
      token: "changed-client-token-123456",
    });
    await expect(client.getWebClientStatus()).resolves.toMatchObject({ enabled: false, running: false });
    await expect(client.setWebClientEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.resetWebClientServe()).resolves.toMatchObject({
      enabled: true,
      running: true,
    });
    const received = new Promise((resolve) => client.listen((event, payload) => resolve({ event, payload })));
    await expect(received).resolves.toEqual({ event: "changed", payload: { ok: true } });
    client.stopListening();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    }));
  });

  test("HTTP client surfaces web access HTTP and malformed-response failures", async () => {
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456");
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: "lifecycle unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    await expect(client.getWebClientStatus()).rejects.toThrow("lifecycle unavailable");

    globalThis.fetch = mock(async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(client.setWebClientEnabled(true)).rejects.toThrow();
  });

  test("launches one service for both the Electron bridge and browser clients", async () => {
    // The shared DOM test setup installs a browser fetch with CORS enforcement;
    // Electron's main process uses the native server-side fetch implementation.
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);

    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    });

    const info = backendProcess.getInfo();
    expect(info?.bindAddress).toBe("127.0.0.1");
    expect(info?.browserUrl).toBeTruthy();
    expect(info?.url).not.toBe(info?.browserUrl);
    await expect(client.invoke("greet", { name: "Electron" })).resolves.toBe(
      "Hello, Electron! You've been greeted from the Orkestrator backend!",
    );

    if (!info) throw new Error("Expected shared backend start information");
    const auth = JSON.parse(await readFile(info.authFile, "utf8")) as { token: string };
    const browserResponse = await Bun.fetch(new URL("/__orkestrator/invoke", info.browserUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "greet", args: { name: "Browser" } }),
    });
    expect(browserResponse.status).toBe(200);
    expect(await browserResponse.json()).toEqual({
      result: "Hello, Browser! You've been greeted from the Orkestrator backend!",
    });
  });

  test("manages hosted web access without stopping the Electron backend", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    await writeFile(executable, `#!/bin/sh
if [ "$*" = "serve status --json" ]; then
  printf '{}\\n'
  exit 0
fi
case " $* " in
  *" off "*) exit 0 ;;
esac
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    expect(backendProcess.getInfo()?.browserUrl).toBeUndefined();
    await expect(waitForWebClientStatus(client, (status) => status.running)).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.resetWebClientServe()).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
      url: null,
    });
    await expect(client.invoke("greet", { name: "Electron" })).resolves.toContain("Hello, Electron!");
  });

  test("reports backend readiness before slow managed Serve initialization finishes", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    await writeFile(executable, `#!/bin/sh
if [ "$*" = "serve status --json" ]; then
  sleep 5
  printf '{}\\n'
  exit 0
fi
case " $* " in
  *" off "*) exit 0 ;;
esac
printf 'Available within your tailnet:\\nhttps://slow.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const startedAt = Date.now();
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await expect(client.invoke("greet", { name: "ready" })).resolves.toContain("Hello, ready!");
    await expect(waitForWebClientStatus(client, (status) => status.running)).resolves.toMatchObject({
      running: true,
      url: "https://slow.example.ts.net/",
    });
  }, 12_000);

  test("honors a persisted disabled setting without invoking Tailscale", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const config = defaultConfig();
    config.global.webClientEnabled = false;
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify(config));
    const executable = path.join(toolsDir, "tailscale");
    const callsPath = path.join(toolsDir, "calls");
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
exit 1
`);
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    await expect(client.setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
      error: null,
    });
    await expect(readFile(callsPath, "utf8")).rejects.toThrow();
  });

  test("keeps backend commands available when managed Serve initialization fails", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: path.join(dataDir, "missing-tailscale"),
      onEvent: () => undefined,
    });

    await expect(waitForWebClientStatus(client, (status) => Boolean(status.error))).resolves.toMatchObject({
      enabled: true,
      running: false,
    });
    await expect(client.invoke("greet", { name: "still-ready" })).resolves.toContain("Hello, still-ready!");
  });

  test("adopts and removes an owned Serve route after an ungraceful backend restart", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    const serveState = path.join(toolsDir, "serve-target");
    await writeFile(executable, `#!/bin/sh
STATE="$(dirname "$0")/serve-target"
if [ "$*" = "serve status --json" ]; then
  if [ -f "$STATE" ]; then
    target="$(cat "$STATE")"
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}\\n' "$target"
  else
    printf '{}\\n'
  fi
  exit 0
fi
case " $* " in
  *" off "*) rm -f "$STATE"; exit 0 ;;
esac
for last do :; done
printf '%s' "$last" > "$STATE"
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const portReservation = createServer();
    await new Promise<void>((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
    const reservedAddress = portReservation.address();
    if (!reservedAddress || typeof reservedAddress === "string") throw new Error("Expected TCP address");
    const gatewayPort = reservedAddress.port;
    await new Promise<void>((resolve) => portReservation.close(() => resolve()));

    const firstProcess = new BackendProcess();
    processes.push(firstProcess);
    const firstClient = await firstProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });
    await expect(waitForWebClientStatus(firstClient, (status) => status.running)).resolves.toMatchObject({
      running: true,
    });
    expect(await readFile(serveState, "utf8")).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const child = (firstProcess as unknown as { child: { kill(signal: string): boolean } }).child;
    child.kill("SIGKILL");
    const stoppedDeadline = Date.now() + 5_000;
    while (firstProcess.getInfo() !== null && Date.now() < stoppedDeadline) await Bun.sleep(10);
    expect(firstProcess.getInfo()).toBeNull();

    const secondProcess = new BackendProcess();
    processes.push(secondProcess);
    const secondClient = await secondProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });
    await expect(waitForWebClientStatus(secondClient, (status) => status.running)).resolves.toMatchObject({
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(secondClient.setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
      error: null,
    });
    await expect(readFile(serveState, "utf8")).rejects.toThrow();
    await expect(readFile(path.join(dataDir, "managed-web-client.json"), "utf8")).rejects.toThrow();
  });

  test("shares concurrent startup and clears stale state when the child exits", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const onUnexpectedExit = mock(() => undefined);
    const options = {
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
      onUnexpectedExit,
    };

    const [first, second] = await Promise.all([
      backendProcess.start(options),
      backendProcess.start(options),
    ]);
    expect(first).toBe(second);

    const child = (backendProcess as unknown as { child: { kill(signal: string): boolean } }).child;
    child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (backendProcess.getInfo() !== null && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(backendProcess.getInfo()).toBeNull();
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  test("rotates the shared HTTP credential without losing command access", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    });

    await expect(client.setToken("replacement-backend-token-123456")).resolves.toMatchObject({
      token: "replacement-backend-token-123456",
    });
    await expect(client.invoke("greet", { name: "rotated" })).resolves.toContain("Hello, rotated!");
  });

  test("cleans up state when the child exits before readiness", async () => {
    globalThis.fetch = Bun.fetch;
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-missing-backend-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(missingRoot, dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);

    await expect(backendProcess.start({
      isDev: true,
      appRoot: missingRoot,
      resourceRoot: missingRoot,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    })).rejects.toThrow("Backend service exited");
    expect(backendProcess.getInfo()).toBeNull();
    expect((backendProcess as unknown as { child: unknown }).child).toBeNull();
  });
});
