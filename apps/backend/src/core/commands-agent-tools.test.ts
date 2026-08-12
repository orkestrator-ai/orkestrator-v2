import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  type AgentToolConnection,
} from "./agent-tools.js";
import { __testing } from "./commands.js";

const servers: http.Server[] = [];

afterEach(async () => {
  __testing.cancelOpenCodeAgentToolsConfiguration("test");
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    )
  ));
});

async function serveMcpResponse(
  responseFactory: (
    request: http.IncomingMessage,
    body: string,
  ) => Promise<{
    status?: number;
    headers?: Record<string, string>;
    body: string;
  }> | {
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

    await expect(__testing.configureOpenCodeAgentTools(
      server.port,
      "o".repeat(43),
      connection,
      "/workspace with spaces",
    )).resolves.toBeUndefined();

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

    expect(__testing.scheduleOpenCodeAgentToolsConfiguration(
      "test",
      server.port,
      "o".repeat(43),
      connection,
      "/workspace",
    )).toBeUndefined();
    expect(__testing.openCodeAgentToolsConfigurationCount()).toBe(1);
    expect(__testing.configuredOpenCodeAgentToolsCount()).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(__testing.openCodeAgentToolsConfigurationCount()).toBe(0);
    expect(__testing.configuredOpenCodeAgentToolsCount()).toBe(1);
    expect(server.requests).toHaveLength(1);

    __testing.scheduleOpenCodeAgentToolsConfiguration(
      "test",
      server.port,
      "o".repeat(43),
      connection,
      "/workspace",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(server.requests).toHaveLength(1);
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
    await expect(__testing.configureOpenCodeAgentTools(
      server.port,
      "o".repeat(43),
      connection,
      "/workspace",
    )).rejects.toThrow(/invalid|omitted/);
  });

  test("rejects oversized fixed-length and streamed responses", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const fixed = await serveMcpResponse(() => ({
      headers: { "content-length": String(Buffer.byteLength(oversized)) },
      body: oversized,
    }));
    await expect(__testing.configureOpenCodeAgentTools(
      fixed.port,
      "o".repeat(43),
      connection,
      "/workspace",
    )).rejects.toThrow("too large");

    const streamed = await serveMcpResponse(() => ({
      body: oversized,
    }));
    await expect(__testing.configureOpenCodeAgentTools(
      streamed.port,
      "o".repeat(43),
      connection,
      "/workspace",
    )).rejects.toThrow("too large");
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
