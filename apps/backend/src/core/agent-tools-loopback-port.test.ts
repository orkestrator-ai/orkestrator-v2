import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "./agent-tools.js";
import { bindListener, closeListeners } from "./agent-tools-listen.js";
import { AgentToolsPeerFilter, type AgentToolsPeerGate } from "./agent-tools-peer-filter.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

/**
 * Todo 7220: a restarted backend asks for the agent tools port it saved last
 * time. On macOS a wildcard bind of that port succeeds beside another
 * process's 127.0.0.1 listener, which then receives every host agent's
 * request and bearer token. Ports here are OS-chosen, and a stray is placed
 * only on a port first reserved with a wildcard bind, so it cannot shadow a
 * port another backend on this host is serving.
 */

interface Stray {
  server: Server;
  port: number;
  /** Authorization headers the stray was sent. */
  authorizations: string[];
}

async function startStray(): Promise<Stray> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const reservation = createServer();
    await bindListener(reservation, 0, "0.0.0.0");
    const address = reservation.address();
    await closeListeners([reservation]);
    if (!address || typeof address === "string") throw new Error("not listening");
    const authorizations: string[] = [];
    const server = createServer((request: IncomingMessage, response) => {
      authorizations.push(String(request.headers.authorization ?? ""));
      response.writeHead(401).end();
    });
    try {
      await bindListener(server, address.port, "127.0.0.1");
    } catch (error) {
      if ((error as { code?: unknown }).code === "EADDRINUSE") continue;
      throw error;
    }
    return { server, port: address.port, authorizations };
  }
  throw new Error("Could not place a stray loopback listener");
}

async function toolsList(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await response.arrayBuffer();
  return response.status;
}

/** Every byte a raw loopback connection receives before it closes. */
function exchange(
  port: number,
  host = "127.0.0.1",
  request = "GET /mcp HTTP/1.1\r\nHost: agent-tools\r\nConnection: close\r\n\r\n",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The server neither answered nor closed the connection"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.on("connect", () => {
      socket.write(request);
    });
  });
}

describe("agent tools port held on loopback by another process", () => {
  let dataDir: string;
  let storage: StorageService;
  let workflowResults: WorkflowResultService;
  let server: AgentToolsServer | null = null;
  let stray: Stray | null = null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-agent-tools-loopback-"));
    storage = new StorageService(dataDir);
    await storage.init();
    workflowResults = new WorkflowResultService(dataDir);
    await workflowResults.initializeCapabilityIdentity();
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    if (stray) await closeListeners([stray.server]);
    stray = null;
    workflowResults.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  function agentTools(gate: AgentToolsPeerGate = AgentToolsPeerFilter.loopbackOnly()) {
    server = new AgentToolsServer(storage, "0.0.0.0", workflowResults, undefined, gate);
    return server;
  }

  test("a restart moves off a saved port whose 127.0.0.1 another process holds", async () => {
    stray = await startStray();
    await workflowResults.recordCapabilityPort(stray.port);

    const tools = agentTools();
    await tools.start();

    const port = tools.servicePort()!;
    expect(port).not.toBe(stray.port);
    // The new port is saved, so capabilities and container firewalls follow it.
    expect(workflowResults.capabilityPort()).toBe(port);

    const host = tools.connection("env-1", "project-1", "host");
    expect(host.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(await toolsList(host.url, host.token)).toBe(200);
    const result = tools.workflowResultConnection("env-1", "project-1", "host", "result-1");
    expect(result.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(stray.authorizations).toEqual([]);

    // Container reach is unchanged: the same port, through host.docker.internal.
    const container = tools.connection("env-1", "project-1", "container");
    expect(container.url).toBe(`http://host.docker.internal:${port}/mcp`);
  });

  test("a free saved port is kept, and no process can take its loopback address later", async () => {
    const reservation = createServer();
    await bindListener(reservation, 0, "0.0.0.0");
    const saved = (reservation.address() as { port: number }).port;
    await closeListeners([reservation]);
    await workflowResults.recordCapabilityPort(saved);

    const tools = agentTools();
    await tools.start();
    expect(tools.servicePort()).toBe(saved);

    const late = createServer();
    await expect(bindListener(late, saved, "127.0.0.1")).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    const host = tools.connection("env-1", "project-1", "host");
    expect(await toolsList(host.url, host.token)).toBe(200);

    // Stopping releases every listener, the loopback one included.
    await tools.stop();
    const after = createServer();
    await bindListener(after, saved, "127.0.0.1");
    await closeListeners([after]);
  });

  test("an explicit port whose 127.0.0.1 another process holds is refused, not moved", async () => {
    stray = await startStray();
    const tools = agentTools();
    await expect(tools.start(stray.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(tools.servicePort()).toBeNull();
    expect(stray.authorizations).toEqual([]);
  });

  test("failed port persistence releases every listener and startup recovers", async () => {
    const tools = agentTools();
    let attemptedPort = 0;
    const record = spyOn(workflowResults, "recordCapabilityPort").mockImplementationOnce(
      async (port) => {
        attemptedPort = port;
        // Persistence runs after ownership has been acquired. On macOS both
        // addresses are served by distinct listeners; on Linux one owns both.
        for (const host of ["0.0.0.0", "127.0.0.1"]) {
          const competing = createServer();
          try {
            await expect(bindListener(competing, port, host)).rejects.toMatchObject({
              code: "EADDRINUSE",
            });
          } finally {
            await closeListeners([competing]);
          }
        }
        throw new Error("injected persistence failure");
      },
    );
    try {
      await expect(tools.start()).rejects.toThrow("injected persistence failure");
      expect(attemptedPort).toBeGreaterThan(0);
      expect(tools.servicePort()).toBeNull();
      // Test each address independently so Linux's exclusivity does not
      // disguise a listener leaked by failed startup.
      for (const host of ["0.0.0.0", "127.0.0.1"]) {
        const released = createServer();
        try {
          await bindListener(released, attemptedPort, host);
        } finally {
          await closeListeners([released]);
        }
      }
    } finally {
      record.mockRestore();
    }
    await tools.start(attemptedPort);
    expect(tools.servicePort()).toBe(attemptedPort);
    expect(workflowResults.capabilityPort()).toBe(attemptedPort);
    const host = tools.connection("env-1", "project-1", "host");
    expect(await toolsList(host.url, host.token)).toBe(200);
  });

  test("both wildcard and loopback listeners suppress automatic replies and enforce peer admission", async () => {
    const refusals: string[] = [];
    let verdict: "reload" | "refuse" = "refuse";
    const gate: AgentToolsPeerGate = {
      verdict: () => verdict,
      admits: async () => false,
      recordRefusal: (address) => {
        refusals.push(String(address));
      },
      followNetworkChanges: () => () => undefined,
    };
    const tools = agentTools(gate);
    await tools.start();
    const port = tools.servicePort()!;
    const wildcardHost =
      Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ?? "127.0.0.2";
    // Confirm the non-127.0.0.1 connection reaches the primary listener,
    // including on macOS where the second listener owns 127.0.0.1.
    let wildcardAccepts = 0;
    tools["listeners"][0]!.on("connection", () => {
      wildcardAccepts += 1;
    });
    const requests = [
      "GET /mcp HTTP/1.1\r\nHost: agent-tools\r\nConnection: close\r\n\r\n",
      "INVALID HTTP\r\n\r\n",
      "POST /mcp HTTP/1.1\r\nHost: agent-tools\r\nExpect: 100-continue\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
      "POST /mcp HTTP/1.1\r\nHost: agent-tools\r\nExpect: unsupported\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    ];
    for (const decision of ["refuse", "reload"] as const) {
      verdict = decision;
      for (const host of ["127.0.0.1", wildcardHost]) {
        for (const request of requests) {
          expect(await exchange(port, host, request)).toBe("");
        }
      }
    }
    expect(wildcardAccepts).toBeGreaterThanOrEqual(8);
    // Malformed HTTP is destroyed by clientError before request admission
    // when the accept-time verdict is reload: two of the sixteen calls.
    expect(refusals).toHaveLength(14);
  });
});
