import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "./agent-tools.js";
import {
  AgentToolsPeerFilter,
  type AgentToolsPeerGate,
  type PeerVerdict,
} from "./agent-tools-peer-filter.js";
import { reportDockerNetworkChange } from "./docker-network-changes.js";
import { StorageService } from "./storage.js";

/**
 * Sends one raw HTTP request and returns every byte the server wrote before
 * the connection closed. A refused peer must get nothing at all: no 405, no
 * 404, no 401, so it cannot tell a route from a closed door.
 */
function exchange(host: string, port: number, request: string): Promise<string> {
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
    // A reset is how a refused peer sees the close; the bytes are the evidence.
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

const GET_MCP = "GET /mcp HTTP/1.1\r\nHost: agent-tools\r\nConnection: close\r\n\r\n";
const GET_UNKNOWN = "GET /nothing-here HTTP/1.1\r\nHost: agent-tools\r\nConnection: close\r\n\r\n";
const POST_MCP =
  "POST /mcp HTTP/1.1\r\nHost: agent-tools\r\nAuthorization: Bearer nope\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";

function scriptedGate(verdict: PeerVerdict, admits: boolean) {
  const seen: { verdicts: string[]; admits: string[]; refusals: string[]; follows: number } = {
    verdicts: [],
    admits: [],
    refusals: [],
    follows: 0,
  };
  let unfollowed = 0;
  const gate: AgentToolsPeerGate = {
    verdict: (address) => {
      seen.verdicts.push(String(address));
      return verdict;
    },
    admits: async (address) => {
      seen.admits.push(String(address));
      return admits;
    },
    recordRefusal: (address) => {
      seen.refusals.push(String(address));
    },
    followNetworkChanges: () => {
      seen.follows += 1;
      return () => {
        unfollowed += 1;
      };
    },
  };
  return { gate, seen, unfollowed: () => unfollowed };
}

/** A non-loopback IPv4 address of this host, or null when it has none. */
function hostInterfaceAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

describe("agent-tools peer gate", () => {
  let dataDir: string;
  let storage: StorageService;
  let server: AgentToolsServer | null = null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-agent-tools-peers-"));
    storage = new StorageService(dataDir);
    await storage.init();
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await rm(dataDir, { recursive: true, force: true });
  });

  async function startWith(gate: AgentToolsPeerGate | undefined, bind = "127.0.0.1") {
    server = new AgentToolsServer(storage, bind, undefined, undefined, gate);
    await server.start();
    return server.servicePort()!;
  }

  test("a peer refused on accept gets no bytes, whatever it asks for", async () => {
    const { gate, seen } = scriptedGate("refuse", false);
    const port = await startWith(gate);
    for (const request of [GET_MCP, GET_UNKNOWN, POST_MCP]) {
      expect(await exchange("127.0.0.1", port, request)).toBe("");
    }
    expect(seen.refusals.length).toBe(3);
    // Refused at accept: the request is never read, so never routed.
    expect(seen.admits).toEqual([]);
  });

  test("a peer refused after a reload is closed before routing: no 405, 404 or 401", async () => {
    const { gate, seen } = scriptedGate("reload", false);
    const port = await startWith(gate);
    for (const request of [GET_MCP, GET_UNKNOWN, POST_MCP]) {
      expect(await exchange("127.0.0.1", port, request)).toBe("");
    }
    expect(seen.admits.length).toBe(3);
    expect(seen.refusals.length).toBe(3);
  });

  test("undecided peers get no parser or Expect replies while admission is pending", async () => {
    const pending: Array<(admitted: boolean) => void> = [];
    const { gate } = scriptedGate("reload", false);
    gate.admits = () => new Promise<boolean>((resolve) => pending.push(resolve));
    const port = await startWith(gate);
    const requests = [
      "INVALID HTTP\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: agent-tools\r\nOversized: " + "x".repeat(100_000) + "\r\n\r\n",
      POST_MCP.replace("Content-Length: 2", "Expect: 100-continue\r\nContent-Length: 2"),
      POST_MCP.replace("Content-Length: 2", "Expect: unsupported\r\nContent-Length: 2"),
    ];
    for (const request of requests) {
      const reply = exchange("127.0.0.1", port, request);
      // Keep admission unresolved while the parser receives the entire input.
      await new Promise((resolve) => setTimeout(resolve, 25));
      for (const resolve of pending.splice(0)) resolve(false);
      expect(await reply).toBe("");
    }
  });

  test("admitted Expect requests keep their continue and unsupported-expectation responses", async () => {
    const { gate } = scriptedGate("reload", true);
    const port = await startWith(gate);
    const continued = await exchange(
      "127.0.0.1",
      port,
      POST_MCP.replace("Content-Length: 2", "Expect: 100-continue\r\nContent-Length: 2"),
    );
    expect(continued).toStartWith("HTTP/1.1 100 Continue");
    expect(continued).toContain("HTTP/1.1 401");
    expect(
      await exchange(
        "127.0.0.1",
        port,
        POST_MCP.replace("Content-Length: 2", "Expect: unsupported\r\nContent-Length: 2"),
      ),
    ).toStartWith("HTTP/1.1 417");
  });

  test("an admitted peer is routed exactly as before", async () => {
    const { gate } = scriptedGate("reload", true);
    const port = await startWith(gate);
    expect(await exchange("127.0.0.1", port, GET_MCP)).toStartWith("HTTP/1.1 405");
    expect(await exchange("127.0.0.1", port, GET_UNKNOWN)).toStartWith("HTTP/1.1 404");
    expect(await exchange("127.0.0.1", port, POST_MCP)).toStartWith("HTTP/1.1 401");
  });

  test("the server follows network changes while it listens, and stops at stop()", async () => {
    const scripted = scriptedGate("admit", true);
    await startWith(scripted.gate);
    expect(scripted.seen.follows).toBe(1);
    await server!.stop();
    server = null;
    expect(scripted.unfollowed()).toBe(1);
  });

  test("the default filter admits loopback, so the credential-free reachability probe still gets its 405", async () => {
    const port = await startWith(undefined);
    expect(await exchange("127.0.0.1", port, GET_MCP)).toStartWith("HTTP/1.1 405");
  });

  const interfaceAddress = hostInterfaceAddress();
  const withInterface = interfaceAddress ? test : test.skip;

  withInterface(
    "on the wildcard listener, the host's own non-loopback address is refused unless a Docker subnet holds it",
    async () => {
      const address = interfaceAddress!;
      let subnets: string[] = [];
      const filter = new AgentToolsPeerFilter({ loadSubnets: async () => subnets });
      const port = await startWith(filter, "0.0.0.0");
      // The peer address is the interface address, outside loopback: refused.
      expect(await exchange(address, port, GET_MCP)).toBe("");
      expect(await exchange(address, port, POST_MCP)).toBe("");
      // Loopback on the same listener is unaffected.
      expect(await exchange("127.0.0.1", port, GET_MCP)).toStartWith("HTTP/1.1 405");
      // A network that holds the address is created: the change admits it.
      subnets = [`${address}/32`];
      reportDockerNetworkChange();
      expect(await exchange(address, port, GET_MCP)).toStartWith("HTTP/1.1 405");
      // And its removal refuses it again.
      subnets = [];
      reportDockerNetworkChange();
      expect(await exchange(address, port, GET_MCP)).toBe("");
    },
  );
});
