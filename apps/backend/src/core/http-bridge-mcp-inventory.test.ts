import { describe, expect, test } from "bun:test";

import { codexConnection, httpProvider } from "./agent-provider-test-support.js";

/** The live MCP inventory relayed from every HTTP bridge to the agent panel. */
describe("HTTP bridge MCP inventory", () => {
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
