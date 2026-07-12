import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { BackendHttpClient, BackendProcess } from "../../../apps/desktop/electron/backend-process";

const directories: string[] = [];
const processes: BackendProcess[] = [];
const browserFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = browserFetch;
  for (const backend of processes.splice(0)) backend.stop();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Electron backend process supervisor", () => {
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
    const received = new Promise((resolve) => client.listen((event, payload) => resolve({ event, payload })));
    await expect(received).resolves.toEqual({ event: "changed", payload: { ok: true } });
    client.stopListening();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    }));
  });

  test("launches the standalone service and invokes it through HTTP", async () => {
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
      onEvent: () => undefined,
    });

    expect(backendProcess.getInfo()?.bindAddress).toBe("127.0.0.1");
    await expect(client.invoke("greet", { name: "Electron" })).resolves.toBe(
      "Hello, Electron! You've been greeted from the Orkestrator backend!",
    );
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

  test("rotates the private HTTP credential without losing command access", async () => {
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
      onEvent: () => undefined,
    })).rejects.toThrow("Backend service exited");
    expect(backendProcess.getInfo()).toBeNull();
    expect((backendProcess as unknown as { child: unknown }).child).toBeNull();
  });
});
