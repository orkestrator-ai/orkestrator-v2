import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  AGENT_TOOLS_LOOPBACK_HOST,
  AgentToolsLoopbackTakenError,
  bindListener,
  closeListeners,
  listenAgentTools,
  loopbackOverlapsWildcard,
  type BindListener,
} from "./agent-tools-listen.js";

/**
 * These tests bind only OS-chosen ports. A stray loopback listener is placed
 * on a port first reserved with a wildcard bind, so it can never land on a
 * port another backend on this host (production included) is serving.
 */

const opened: Server[] = [];

afterEach(async () => {
  await closeListeners(opened.splice(0));
});

function track(server: Server): Server {
  opened.push(server);
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return address.port;
}

/** Another process's loopback-only listener; records every request it gets. */
interface Stray {
  server: Server;
  port: number;
  requests: IncomingMessage[];
  connections: number;
}

async function startStray(bind: BindListener = bindListener): Promise<Stray> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const reservation = createServer();
    await bindListener(reservation, 0, "0.0.0.0");
    const port = portOf(reservation);
    await closeListeners([reservation]);
    const requests: IncomingMessage[] = [];
    const server = createServer((request, response) => {
      requests.push(request);
      response.writeHead(401).end();
    });
    const stray: Stray = { server, port, requests, connections: 0 };
    server.on("connection", () => {
      stray.connections += 1;
    });
    try {
      await bind(server, port, AGENT_TOOLS_LOOPBACK_HOST);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EADDRINUSE") continue;
      throw error;
    }
    track(server);
    return stray;
  }
  throw new Error("Could not place a stray loopback listener");
}

function ours(): Server {
  return track(createServer((_request, response) => response.writeHead(200).end("ours")));
}

/** Requests `/` on loopback the way a host agent would, bearer token included. */
async function hostAgentCall(port: number): Promise<number> {
  const response = await fetch(`http://${AGENT_TOOLS_LOOPBACK_HOST}:${port}/`, {
    headers: { Authorization: "Bearer agent-tools-token" },
  });
  await response.arrayBuffer();
  return response.status;
}

/**
 * Linux's bind rules, applied before the real bind: a listener on a port
 * refuses any other listener on that port when either side is the wildcard
 * or both name the same address, whichever comes first.
 */
function linuxBindRules(): BindListener {
  const bound = new Map<Server, { host: string; port: number }>();
  return async (server, port, host) => {
    const wildcard = (address: string) => address === "0.0.0.0" || address === "::";
    for (const existing of Array.from(bound.values())) {
      if (
        port !== 0 &&
        existing.port === port &&
        (wildcard(existing.host) || wildcard(host) || existing.host === host)
      ) {
        throw Object.assign(new Error(`listen EADDRINUSE: ${host}:${port}`), {
          code: "EADDRINUSE",
        });
      }
    }
    await bindListener(server, port, host);
    bound.set(server, { host, port: portOf(server) });
    server.once("close", () => bound.delete(server));
  };
}

describe("listenAgentTools", () => {
  test("never serves a saved port whose loopback address another process holds", async () => {
    const stray = await startStray();
    const listeners = await listenAgentTools({
      create: ours,
      bindAddress: "0.0.0.0",
      preferredPort: stray.port,
      exact: false,
    });
    expect(listeners.port).not.toBe(stray.port);
    expect(await hostAgentCall(listeners.port)).toBe(200);
    expect(stray.requests).toHaveLength(0);
  });

  test("reports the port it gave up", async () => {
    const stray = await startStray();
    const taken: number[] = [];
    await listenAgentTools({
      create: ours,
      bindAddress: "0.0.0.0",
      preferredPort: stray.port,
      exact: false,
      onLoopbackTaken: (port) => taken.push(port),
    });
    // Linux refuses the wildcard bind itself, so nothing is given up there.
    expect(taken).toEqual(process.platform === "linux" ? [] : [stray.port]);
  });

  test("an exact port whose loopback another process holds fails instead of moving", async () => {
    const stray = await startStray();
    const attempt = listenAgentTools({
      create: ours,
      bindAddress: "0.0.0.0",
      preferredPort: stray.port,
      exact: true,
    });
    await expect(attempt).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(stray.requests).toHaveLength(0);
  });

  test("keeps a free saved port and leaves no loopback address for anyone else", async () => {
    const reservation = createServer();
    await bindListener(reservation, 0, "0.0.0.0");
    const saved = portOf(reservation);
    await closeListeners([reservation]);

    const listeners = await listenAgentTools({
      create: ours,
      bindAddress: "0.0.0.0",
      preferredPort: saved,
      exact: false,
    });
    expect(listeners.port).toBe(saved);
    // macOS needs its own loopback listener; Linux's wildcard bind already
    // excludes everyone else from 127.0.0.1:<port>.
    expect(listeners.servers).toHaveLength(process.platform === "linux" ? 1 : 2);

    const late = createServer();
    await expect(bindListener(late, saved, AGENT_TOOLS_LOOPBACK_HOST)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(await hostAgentCall(saved)).toBe(200);
  });

  test("a loopback bind address needs no second listener", async () => {
    const listeners = await listenAgentTools({
      create: ours,
      bindAddress: AGENT_TOOLS_LOOPBACK_HOST,
      preferredPort: 0,
      exact: false,
    });
    expect(listeners.servers).toHaveLength(1);
    expect(await hostAgentCall(listeners.port)).toBe(200);
  });
});

describe("listenAgentTools under Linux bind rules", () => {
  test("a refused loopback bind beside its own wildcard keeps the port", async () => {
    const bind = linuxBindRules();
    const reservation = createServer();
    await bindListener(reservation, 0, "0.0.0.0");
    const saved = portOf(reservation);
    await closeListeners([reservation]);

    const taken: number[] = [];
    const listeners = await listenAgentTools({
      create: ours,
      bindAddress: "0.0.0.0",
      preferredPort: saved,
      exact: false,
      bind,
      onLoopbackTaken: (port) => taken.push(port),
    });
    expect(listeners.port).toBe(saved);
    expect(listeners.servers).toHaveLength(1);
    expect(taken).toEqual([]);
    expect(await hostAgentCall(saved)).toBe(200);
  });

  test("a stray loopback listener makes the wildcard bind fail and the server move", async () => {
    const bind = linuxBindRules();
    const stray = await startStray(bind);
    const listeners = await listenAgentTools({
      create: ours,
      bindAddress: "0.0.0.0",
      preferredPort: stray.port,
      exact: false,
      bind,
    });
    expect(listeners.port).not.toBe(stray.port);
    expect(await hostAgentCall(listeners.port)).toBe(200);
    expect(stray.requests).toHaveLength(0);
  });
});

describe("loopbackOverlapsWildcard", () => {
  test("matches this platform's bind rules", async () => {
    // macOS (BSD) lets a loopback listener sit beside a wildcard one on the
    // same port; Linux refuses it.
    expect(await loopbackOverlapsWildcard()).toBe(process.platform !== "linux");
  });

  test("is false under Linux bind rules", async () => {
    expect(await loopbackOverlapsWildcard(linuxBindRules())).toBe(false);
  });
});

test("AgentToolsLoopbackTakenError carries EADDRINUSE so exact-port callers retry", () => {
  const error = new AgentToolsLoopbackTakenError(4242);
  expect(error.code).toBe("EADDRINUSE");
  expect(error.message).toContain("4242");
});
