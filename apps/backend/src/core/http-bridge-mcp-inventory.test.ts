import { describe, expect, test } from "bun:test";

import { mcpScope } from "../../../../bridges/claude-bridge/src/services/mcp-runtime-status.js";
import { claudeConnection, codexConnection, httpProvider } from "./agent-provider-test-support.js";

/** The live MCP inventory relayed from every HTTP bridge to the agent panel. */
describe("HTTP bridge MCP inventory", () => {
  test("preserves Claude local, project and user identities from the bridge", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          servers: ["local", "project", "user"].map((scope) => ({
            id: "docs",
            name: "Documentation",
            status: "connected",
            actions: [],
            scope: mcpScope(scope, "docs"),
          })),
        }),
      claudeConnection,
    );
    const servers = await provider.mcpServers!("session-1");
    expect(servers.map((server) => server.scope)).toEqual(["local", "project", "user"]);
    expect(servers.every((server) => server.id === "docs" && server.name === "Documentation")).toBe(
      true,
    );
  });

  test("redacts a server's error text before bounding it, whatever the bridge sent", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyz0123";
    const { provider } = httpProvider(
      () =>
        Response.json({
          servers: [
            {
              id: "docs",
              name: "docs",
              status: "failed",
              actions: ["reconnect"],
              error: `connect https://mcp.example.test/?access_token=${secret} failed: Authorization: Bearer ${secret} ${"x".repeat(3_000)}`,
            },
          ],
        }),
      codexConnection,
    );
    const [server] = await provider.mcpServers!("session-1");
    expect(server?.error).toContain("connect https://mcp.example.test/");
    expect(server?.error).not.toContain(secret);
    expect(server?.error?.length).toBeLessThanOrEqual(2_000);
  });
});
