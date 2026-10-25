import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME, type AgentToolConnection } from "./agent-tools.js";
import { BackendRuntime } from "./backend-runtime.js";
import { __testing } from "./commands.js";
import type { OpenCodeAgentToolsTuning } from "./opencode-agent-tools.js";

const servers: http.Server[] = [];
/** The backend whose reconciler is under test; production tuning unless a test replaces it. */
let runtime: BackendRuntime;

/** Replaces the backend under test with one whose reconciler uses `tuning`. */
function useRuntime(tuning: OpenCodeAgentToolsTuning = {}): void {
  runtime?.shutdown();
  runtime = new BackendRuntime({
    emit: () => undefined,
    localServers: { openCodeAgentTools: tuning },
  });
}

function agentTools() {
  return runtime.localServers.openCodeAgentTools;
}

beforeEach(() => {
  useRuntime();
});

afterEach(async () => {
  for (const key of ["test", "test-alt"]) {
    agentTools().cancel(key);
  }
  runtime.shutdown();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function serveMcpResponse(
  responseFactory: (
    request: http.IncomingMessage,
    body: string,
  ) =>
    | Promise<{
        status?: number;
        headers?: Record<string, string>;
        body: string;
      }>
    | {
        status?: number;
        headers?: Record<string, string>;
        body: string;
      },
): Promise<{
  port: number;
  requests: Array<{
    method?: string;
    url?: string;
    body: string;
    authorization?: string;
  }>;
}> {
  const requests: Array<{
    method?: string;
    url?: string;
    body: string;
    authorization?: string;
  }> = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      body,
      authorization: request.headers.authorization,
    });
    const result = await responseFactory(request, body);
    response.writeHead(result.status ?? 200, {
      "content-type": "application/json",
      ...result.headers,
    });
    response.end(result.body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    requests,
  };
}

const connection: AgentToolConnection = {
  url: "http://127.0.0.1:43210/mcp",
  token: "sensitive-agent-token",
};

const PASSWORD = "o".repeat(43);
const CONNECTED_BODY = JSON.stringify({
  [ORKESTRATOR_AGENT_MCP_SERVER_NAME]: { status: "connected" },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls instead of sleeping a fixed span: the reconciler's timing is tuned
 * per-test, so a fixed wait would either be flaky or needlessly slow.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

function schedule(key: string, port: number): void {
  void agentTools().schedule(key, port, PASSWORD, connection, "/workspace");
}

describe("OpenCode agent-tool configuration", () => {
  test("posts the authoritative config instead of trusting status-only identity", async () => {
    const server = await serveMcpResponse(() => ({
      // GET cannot identify the configured URL or credential. Even when it
      // would report this reserved name as connected, reconciliation must POST
      // the backend-owned configuration rather than trusting that collision.
      body: JSON.stringify({
        [ORKESTRATOR_AGENT_MCP_SERVER_NAME]: { status: "connected" },
      }),
    }));

    await expect(
      __testing.configureOpenCodeAgentTools(
        server.port,
        "o".repeat(43),
        connection,
        "/workspace with spaces",
      ),
    ).resolves.toBeUndefined();

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("directory=%2Fworkspace+with+spaces");
    expect(request.authorization).toStartWith("Basic ");
    expect(JSON.parse(request.body)).toEqual({
      name: ORKESTRATOR_AGENT_MCP_SERVER_NAME,
      config: {
        type: "remote",
        url: connection.url,
        enabled: true,
        oauth: false,
        timeout: 3_000,
        headers: { Authorization: `Bearer ${connection.token}` },
      },
    });
  });

  test("reconciles in the background and memoizes a healthy generation", async () => {
    const server = await serveMcpResponse(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return {
        body: JSON.stringify({
          [ORKESTRATOR_AGENT_MCP_SERVER_NAME]: { status: "connected" },
        }),
      };
    });

    // Returns at once with the outcome to come: an ordinary chat never waits
    // on it, and only a coordinator's startup awaits it.
    const outcome = agentTools().schedule(
      "test",
      server.port,
      "o".repeat(43),
      connection,
      "/workspace",
    );
    expect(agentTools().configurationCount()).toBe(1);
    expect(agentTools().outcomeCount()).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(agentTools().configurationCount()).toBe(0);
    expect(agentTools().outcomeCount()).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(await outcome).toBe("connected");

    agentTools().schedule("test", server.port, "o".repeat(43), connection, "/workspace");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(server.requests).toHaveLength(1);
    expect(agentTools().state("test")).toBe("connected");
  });

  test("retries a transient failure until the entry connects", async () => {
    useRuntime({ retryDelaysMs: [5, 5, 5, 5, 5] });
    let attempts = 0;
    const server = await serveMcpResponse(() => {
      attempts += 1;
      return attempts <= 2
        ? { status: 503, body: JSON.stringify({ error: "still starting" }) }
        : { body: CONNECTED_BODY };
    });

    schedule("test", server.port);
    expect(agentTools().state("test")).toBe("pending");

    await waitFor(() => agentTools().state("test") === "connected", "a connected outcome");
    expect(server.requests).toHaveLength(3);
    await waitFor(() => agentTools().configurationCount() === 0, "the generation to retire");
  });

  test("records an unavailable outcome after exhausting every retry", async () => {
    useRuntime({
      retryDelaysMs: [5, 5, 5, 5, 5],
      connectedTtlMs: 60_000,
      unavailableCooldownMs: 60_000,
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = await serveMcpResponse(() => ({
        status: 500,
        body: JSON.stringify({ error: `secret echoed: ${connection.token}` }),
      }));

      schedule("test", server.port);
      await waitFor(() => agentTools().state("test") === "unavailable", "an unavailable outcome");
      // The initial attempt plus one per configured backoff step.
      expect(server.requests).toHaveLength(6);
      expect(agentTools().configurationCount()).toBe(0);

      // The warning must not carry the credential the response echoed back.
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(connection.token);

      // A status read inside the cooldown must not restart the retry cycle.
      schedule("test", server.port);
      expect(agentTools().configurationCount()).toBe(0);
      expect(server.requests).toHaveLength(6);
      expect(agentTools().state("test")).toBe("unavailable");
    } finally {
      warn.mockRestore();
    }
  });

  test("retries again once the unavailable cooldown expires", async () => {
    useRuntime({
      retryDelaysMs: [5],
      connectedTtlMs: 60_000,
      unavailableCooldownMs: 0,
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let healthy = false;
      const server = await serveMcpResponse(() =>
        healthy ? { body: CONNECTED_BODY } : { status: 500, body: "{}" },
      );

      schedule("test", server.port);
      await waitFor(() => agentTools().state("test") === "unavailable", "an unavailable outcome");
      expect(server.requests).toHaveLength(2);

      healthy = true;
      schedule("test", server.port);
      await waitFor(
        () => agentTools().state("test") === "connected",
        "recovery after the cooldown",
      );
      expect(server.requests).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("re-verifies a connected generation once its memo expires", async () => {
    // OpenCode can drop the entry while the port and password stay identical,
    // so an expired memo must re-POST rather than trust the fingerprint.
    useRuntime({ connectedTtlMs: 0, unavailableCooldownMs: 0 });
    const server = await serveMcpResponse(() => ({ body: CONNECTED_BODY }));

    schedule("test", server.port);
    await waitFor(() => agentTools().state("test") === "connected", "the first connected outcome");
    expect(server.requests).toHaveLength(1);

    schedule("test", server.port);
    await waitFor(() => server.requests.length === 2, "the re-verification POST");
    await waitFor(() => agentTools().configurationCount() === 0, "the re-verification to retire");
    expect(agentTools().state("test")).toBe("connected");
  });

  test("forget after disposal replaces an in-flight POST even with the same fingerprint", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await serveMcpResponse(async () => {
      if (server.requests.length === 1) await gate;
      return { body: CONNECTED_BODY };
    });
    try {
      schedule("test", server.port);
      await waitFor(() => server.requests.length === 1, "pre-disposal POST");
      agentTools().recordLaunchConnection("test", connection);
      agentTools().forget("test");
      schedule("test", server.port);
      await agentTools().settled("test");
      expect(server.requests).toHaveLength(2);
      expect(agentTools().state("test")).toBe("connected");
      expect(agentTools().launchConnection("test")).toEqual(connection);
    } finally {
      release();
    }
  });

  test("cancellation aborts an in-flight generation without recording an outcome", async () => {
    const server = await serveMcpResponse(async () => {
      await sleep(150);
      return { body: CONNECTED_BODY };
    });

    schedule("test", server.port);
    expect(agentTools().configurationCount()).toBe(1);
    expect(agentTools().state("test")).toBe("pending");

    agentTools().cancel("test");
    expect(agentTools().configurationCount()).toBe(0);

    // The abort must not later resolve into a memoized success.
    await sleep(250);
    expect(agentTools().outcomeCount()).toBe(0);
    expect(agentTools().state("test")).toBe("pending");
  });

  test("cancellation during a retry backoff stops the cycle", async () => {
    useRuntime({ retryDelaysMs: [200, 200, 200, 200, 200] });
    const server = await serveMcpResponse(() => ({ status: 500, body: "{}" }));

    schedule("test", server.port);
    await waitFor(() => server.requests.length === 1, "the first attempt");

    // Cancel while the task is parked in `waitForOpenCodeAgentToolsRetry`,
    // which resolves on abort instead of throwing.
    agentTools().cancel("test");
    await sleep(300);
    expect(server.requests).toHaveLength(1);
    expect(agentTools().configurationCount()).toBe(0);
    expect(agentTools().outcomeCount()).toBe(0);
  });

  test("a new fingerprint supersedes the in-flight generation", async () => {
    const slow = await serveMcpResponse(async () => {
      await sleep(200);
      return { body: CONNECTED_BODY };
    });
    const fast = await serveMcpResponse(() => ({ body: CONNECTED_BODY }));

    schedule("test", slow.port);
    expect(agentTools().configurationCount()).toBe(1);

    // A different port is a different generation; the first must be abandoned.
    schedule("test", fast.port);
    await waitFor(() => agentTools().state("test") === "connected", "the winning generation");
    expect(fast.requests).toHaveLength(1);

    // The superseded generation must not overwrite the winner when it lands.
    await sleep(300);
    expect(agentTools().state("test")).toBe("connected");
    expect(agentTools().outcomeCount()).toBe(1);
  });

  test("a fingerprint change drops the previous generation's outcome", async () => {
    const first = await serveMcpResponse(() => ({ body: CONNECTED_BODY }));
    schedule("test", first.port);
    await waitFor(() => agentTools().state("test") === "connected", "the first connected outcome");

    const second = await serveMcpResponse(async () => {
      await sleep(150);
      return { body: CONNECTED_BODY };
    });
    schedule("test", second.port);
    // Reporting the retired generation's verdict would advertise ticket tools
    // for a port and credential that were never reconciled.
    expect(agentTools().state("test")).toBe("pending");

    await waitFor(() => agentTools().state("test") === "connected", "the replacement generation");
    expect(second.requests).toHaveLength(1);
  });

  test("closing local server admission drains every generation", async () => {
    const server = await serveMcpResponse(async () => {
      await sleep(200);
      return { body: CONNECTED_BODY };
    });

    schedule("test", server.port);
    schedule("test-alt", server.port);
    expect(agentTools().configurationCount()).toBe(2);

    runtime.localServers.closeAdmission();
    expect(agentTools().configurationCount()).toBe(0);

    await sleep(300);
    expect(agentTools().outcomeCount()).toBe(0);
    expect(agentTools().state("test")).toBe("pending");
    expect(agentTools().state("test-alt")).toBe("pending");
  });

  test.each(["failed", "pending", "connecting", "disabled"])(
    "rejects a non-connected %s status without exposing the remote error",
    async (status) => {
      const server = await serveMcpResponse(() => ({
        body: JSON.stringify({
          [ORKESTRATOR_AGENT_MCP_SERVER_NAME]: {
            status,
            error: `secret echoed: ${connection.token}`,
          },
        }),
      }));

      const promise = __testing.configureOpenCodeAgentTools(
        server.port,
        "o".repeat(43),
        connection,
        "/workspace",
      );
      await expect(promise).rejects.toThrow(`(${status})`);
      await expect(promise).rejects.not.toThrow(connection.token);
    },
  );

  test.each([
    ["missing entry", JSON.stringify({})],
    ["missing status", JSON.stringify({ orkestrator: {} })],
    ["invalid JSON", "not-json"],
  ])("rejects a malformed response: %s", async (_label, body) => {
    const server = await serveMcpResponse(() => ({ body }));
    await expect(
      __testing.configureOpenCodeAgentTools(server.port, "o".repeat(43), connection, "/workspace"),
    ).rejects.toThrow(/invalid|omitted/);
  });

  test("rejects oversized fixed-length and streamed responses", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const fixed = await serveMcpResponse(() => ({
      headers: { "content-length": String(Buffer.byteLength(oversized)) },
      body: oversized,
    }));
    await expect(
      __testing.configureOpenCodeAgentTools(fixed.port, "o".repeat(43), connection, "/workspace"),
    ).rejects.toThrow("too large");

    const streamed = await serveMcpResponse(() => ({
      body: oversized,
    }));
    await expect(
      __testing.configureOpenCodeAgentTools(
        streamed.port,
        "o".repeat(43),
        connection,
        "/workspace",
      ),
    ).rejects.toThrow("too large");
  });

  test("rejects non-2xx responses without reading credential-bearing bodies", async () => {
    const server = await serveMcpResponse(() => ({
      status: 503,
      body: JSON.stringify({ echoedToken: connection.token }),
    }));
    const promise = __testing.configureOpenCodeAgentTools(
      server.port,
      "o".repeat(43),
      connection,
      "/workspace",
    );
    await expect(promise).rejects.toThrow("(503)");
    await expect(promise).rejects.not.toThrow(connection.token);
  });
});
