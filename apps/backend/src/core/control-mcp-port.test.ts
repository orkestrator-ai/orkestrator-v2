import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rpc } from "./control-mcp-test-support.js";
import { ControlMcpServer, controlMcpPortOverride } from "./control-mcp-server.js";

describe("controlMcpPortOverride", () => {
  test("only the installed app's backends take the fixed port", () => {
    const app = { NODE_ENV: "production" };
    expect(controlMcpPortOverride("production", app)).toBeUndefined();
    expect(controlMcpPortOverride(undefined, app)).toBeUndefined();
    expect(controlMcpPortOverride("development", app)).toBeUndefined();
    // A qualification service or headless agent-test backend left running
    // must never hold the port the desktop needs.
    expect(controlMcpPortOverride("agent-test", app)).toBe(0);
    expect(controlMcpPortOverride("production", { NODE_ENV: "test" })).toBe(0);
  });

  test("a backend of another data directory takes an ephemeral port", () => {
    const app = { NODE_ENV: "production" };
    // A second service, `serve`, or `mise run dev` (orkestrator-v2-dev).
    expect(controlMcpPortOverride("production", app, false)).toBe(0);
    expect(controlMcpPortOverride("development", app, false)).toBe(0);
    expect(controlMcpPortOverride(undefined, app, false)).toBe(0);
    expect(controlMcpPortOverride("production", app, true)).toBeUndefined();
  });

  test("an explicit port still applies outside the test runner", () => {
    const env = { NODE_ENV: "production", ORKESTRATOR_CONTROL_MCP_PORT: "45000" };
    expect(controlMcpPortOverride("agent-test", env)).toBeUndefined();
    expect(controlMcpPortOverride("production", env, false)).toBeUndefined();
    expect(controlMcpPortOverride("agent-test", { ORKESTRATOR_CONTROL_MCP_PORT: " " })).toBe(0);
    expect(controlMcpPortOverride("production", { ORKESTRATOR_CONTROL_MCP_PORT: " " }, false)).toBe(
      0,
    );
    expect(controlMcpPortOverride("production", { ...env, NODE_ENV: "test" }, true)).toBe(0);
  });
});

/** Hold a loopback port the OS assigns, standing in for another backend's listener. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const holder: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", () => resolve());
  });
  const address = holder.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a fixed Control MCP port held by another process", () => {
  let dataDir: string;
  let held: { port: number; release: () => Promise<void> } | null;
  let server: ControlMcpServer | null;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "control-mcp-port-"));
    held = await holdPort();
    server = null;
  });

  afterEach(async () => {
    await server?.stop();
    await held?.release();
    await rm(dataDir, { recursive: true, force: true });
  });

  function create(port: number): ControlMcpServer {
    server = new ControlMcpServer(
      dataDir,
      async <T>(command: string) => {
        if (command === "get_config") return { global: {} } as T;
        throw new Error(`Unexpected command: ${command}`);
      },
      { port, retry: { initialDelayMs: 20, maxDelayMs: 80 } },
    );
    return server;
  }

  test("is retried until it frees, then serves and republishes", async () => {
    const port = held!.port;
    const mcp = create(port);
    const changes: Array<boolean | undefined> = [];
    mcp.onStateChange(() => changes.push(mcp.getEndpointState()?.running));

    await expect(mcp.start()).rejects.toThrow();
    const failed = mcp.getSettings();
    expect(failed.running).toBe(false);
    expect(failed.error).toContain(`Port ${port} is in use by another process`);
    // A client still learns the URL the backend is waiting for.
    expect(mcp.getEndpointState()).toEqual({
      running: false,
      url: `http://127.0.0.1:${port}/mcp`,
    });

    // Several retries fail while the port stays taken; none surfaces as a rejection.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mcp.getSettings().running).toBe(false);

    await held!.release();
    held = null;
    // `running` turns true before the credential flush; the notification follows it.
    await waitFor(() => changes.at(-1) === true);
    expect(mcp.getSettings().error).toBeNull();
    expect(mcp.getEndpointState()).toEqual({
      running: true,
      url: `http://127.0.0.1:${port}/mcp`,
    });
    expect(changes.at(0)).toBe(false);
    expect(changes.at(-1)).toBe(true);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  test.each([false, true])(
    "recovery preserves and authenticates credentials; existing=%s",
    async (existing) => {
      let storedToken: string | undefined;
      if (existing) {
        const seed = create(0);
        await seed.start();
        storedToken = seed.getSettings().token;
        await seed.stop();
      }
      const mcp = create(held!.port);
      let notifications = 0;
      mcp.onStateChange(() => notifications++);
      await expect(mcp.start()).rejects.toThrow();
      const token = mcp.getSettings().token;
      expect(token.length).toBeGreaterThan(20);
      if (existing) expect(token).toBe(storedToken!);
      await waitFor(() => notifications >= 3);
      expect(mcp.getSettings().token).toBe(token);
      await held!.release();
      held = null;
      await waitFor(() => mcp.getSettings().running);
      expect(mcp.getSettings().token).toBe(token);
      const { response, body } = await rpc(mcp.getInfo()!.url, token, "tools/list");
      expect(response.status).toBe(200);
      expect(body.result?.tools?.length).toBeGreaterThan(0);
      // The initialized credential is also the one persisted for the next start.
      await mcp.stop();
      const restarted = create(0);
      await restarted.start();
      expect(restarted.getSettings().token).toBe(token);
    },
  );

  test("stop() cancels the retry", async () => {
    const mcp = create(held!.port);
    await expect(mcp.start()).rejects.toThrow();
    await mcp.stop();
    await held!.release();
    held = null;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mcp.getSettings().running).toBe(false);
  });

  test("an ephemeral port is never retried and publishes the bound URL", async () => {
    const mcp = create(0);
    expect(mcp.getEndpointState()).toEqual({ running: false });
    await mcp.start();
    const state = mcp.getEndpointState();
    expect(state?.running).toBe(true);
    expect(state?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(state?.url).not.toBe("http://127.0.0.1:0/mcp");
  });
});
