import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONTROL_MCP_PORT, DEFAULT_GATEWAY_PORT } from "../src/fixed-ports.js";
import { GatewayContext } from "../src/gateway-context.js";
import { GatewayLifecycle } from "../src/gateway-lifecycle.js";

const directories: string[] = [];
const servers: Server[] = [];
const lifecycles: GatewayLifecycle[] = [];
afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.stop()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createLifecycle(
  options: { env?: NodeJS.ProcessEnv; loopbackClientPort?: number; strictPort?: boolean } = {},
) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-gateway-port-fallback-"));
  directories.push(dataDir);
  const context = new GatewayContext(
    {
      dataDir,
      rendererRoot: dataDir,
      backend: { invoke: async () => null },
      env: options.env ?? {},
      loopbackClientPort: options.loopbackClientPort,
      strictPort: options.strictPort,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    {
      gatewayCredentialMatches: () => false,
      gatewayCredentialExpiresAt: () => null,
      isOriginAllowed: () => false,
    },
  );
  const lifecycle = new GatewayLifecycle(context, { handle: async () => {} });
  lifecycles.push(lifecycle);
  return lifecycle;
}

/**
 * The ports the fallback tries when `taken` are in use. `listen` is replaced, so
 * walking through the real fixed ports never binds them.
 */
async function walk(
  preferredPort: number,
  taken: (port: number) => boolean,
  options: Parameters<typeof createLifecycle>[0] = {},
) {
  const lifecycle = await createLifecycle(options);
  const attempts: number[] = [];
  const listen = spyOn(lifecycle, "listen").mockImplementation(async (bindAddress, port) => {
    attempts.push(port);
    if (taken(port)) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    return { bindAddress, port, url: `http://${bindAddress}:${port}/` };
  });
  try {
    const listener = await lifecycle.listenWithPortFallback("127.0.0.1", preferredPort);
    return { attempts, port: listener.port };
  } finally {
    listen.mockRestore();
  }
}

async function holdFreePort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as { port: number }).port;
}

describe("gateway port fallback", () => {
  test("the desktop's gateway walks past the Control MCP port even when it is free", async () => {
    const { attempts, port } = await walk(
      DEFAULT_GATEWAY_PORT,
      (candidate) => candidate === DEFAULT_GATEWAY_PORT,
    );
    expect(attempts).toEqual([DEFAULT_GATEWAY_PORT, DEFAULT_GATEWAY_PORT + 2]);
    expect(port).toBe(DEFAULT_GATEWAY_PORT + 2);
  });

  test("a backend walking up from below leaves both fixed ports alone", async () => {
    const { attempts } = await walk(
      DEFAULT_GATEWAY_PORT - 1,
      (candidate) => candidate === DEFAULT_GATEWAY_PORT - 1,
    );
    expect(attempts).toEqual([DEFAULT_GATEWAY_PORT - 1, DEFAULT_CONTROL_MCP_PORT + 1]);
  });

  test("a fixed port asked for by name is still tried", async () => {
    const { attempts } = await walk(DEFAULT_CONTROL_MCP_PORT, () => false);
    expect(attempts).toEqual([DEFAULT_CONTROL_MCP_PORT]);
  });

  test("keeps off the configured Control MCP and loopback client ports", async () => {
    const { attempts } = await walk(40_000, (candidate) => candidate === 40_000, {
      env: { ORKESTRATOR_CONTROL_MCP_PORT: "40001" },
      loopbackClientPort: 40_002,
    });
    expect(attempts).toEqual([40_000, 40_003]);
  });

  test.each(["0", "", "nope"])(
    "an ORKESTRATOR_CONTROL_MCP_PORT of %p reserves nothing",
    async (value) => {
      const { attempts } = await walk(40_000, (candidate) => candidate === 40_000, {
        env: { ORKESTRATOR_CONTROL_MCP_PORT: value },
      });
      expect(attempts).toEqual([40_000, 40_001]);
    },
  );

  test("an ephemeral loopback client port reserves nothing", async () => {
    const { attempts } = await walk(40_000, (candidate) => candidate === 40_000, {
      loopbackClientPort: 0,
    });
    expect(attempts).toEqual([40_000, 40_001]);
  });

  test("still ends on an ephemeral port when every nearby port is taken", async () => {
    const { attempts, port } = await walk(40_000, (candidate) => candidate !== 0);
    expect(attempts.at(-1)).toBe(0);
    expect(port).toBe(0);
  });

  test("a strict port never walks", async () => {
    const lifecycle = await createLifecycle({ strictPort: true });
    const held = await holdFreePort();
    await expect(lifecycle.listenWithPortFallback("127.0.0.1", held)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  test("real sockets: a taken port moves the gateway, and not onto the reserved one", async () => {
    const held = await holdFreePort();
    const lifecycle = await createLifecycle({ loopbackClientPort: held + 1 });
    const listener = await lifecycle.listenWithPortFallback("127.0.0.1", held);
    expect(listener.port).not.toBe(held);
    expect(listener.port).not.toBe(held + 1);
  });
});
