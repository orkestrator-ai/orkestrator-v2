import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const fakeAgent = resolve(import.meta.dir, "fake-agent.ts");

function sendSessionRequest(method: "session/new" | "session/load", mcpServers: unknown) {
  const result = spawnSync(process.execPath, [fakeAgent], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { mcpServers } })}\n`,
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("fake ACP agent MCP server validation", () => {
  const malformedServers = [
    {
      name: "legacy map headers",
      value: [
        {
          name: "orkestrator",
          type: "http",
          url: "http://127.0.0.1/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
    },
    {
      name: "HTTP server without headers",
      value: [{ name: "orkestrator", type: "http", url: "http://127.0.0.1/mcp" }],
    },
    {
      name: "SSE server without headers",
      value: [{ name: "orkestrator", type: "sse", url: "http://127.0.0.1/mcp" }],
    },
    {
      name: "legacy map of MCP servers",
      value: { orkestrator: { type: "http", url: "http://127.0.0.1/mcp" } },
    },
  ];

  for (const method of ["session/new", "session/load"] as const) {
    for (const malformed of malformedServers) {
      test(`${method} rejects ${malformed.name}`, () => {
        expect(sendSessionRequest(method, malformed.value)).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32602,
              message: "Invalid params",
              data: "data did not match any variant of untagged enum McpServer",
            },
          },
        ]);
      });
    }

    test(`${method} accepts array-form remote headers`, () => {
      expect(
        sendSessionRequest(method, [
          {
            name: "orkestrator",
            type: "http",
            url: "http://127.0.0.1/mcp",
            headers: [{ name: "Authorization", value: "Bearer token" }],
          },
        ])[0],
      ).toMatchObject({ jsonrpc: "2.0", id: 1, result: { sessionId: "fake-session" } });
    });
  }
});
