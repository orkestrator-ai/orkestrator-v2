import { describe, expect, test } from "bun:test";

import { codexConnection, httpProvider } from "./agent-provider-test-support.js";

/** Session-free MCP configuration reload used by MCP management apply. */
describe("HTTP bridge MCP configuration reload", () => {
  test("posts the global route, never a session route", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ reloaded: true, generation: 2 }),
      codexConnection,
    );
    await expect(provider.reloadMcpConfiguration!()).resolves.toBe("reloaded");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toEndWith("/global/mcp/reload");
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.url).not.toContain("/session/");
  });

  test("nothing running is an answer, not a failure", async () => {
    const { provider } = httpProvider(
      () => Response.json({ reloaded: false, reason: "not-running" }),
      codexConnection,
    );
    await expect(provider.reloadMcpConfiguration!()).resolves.toBe("not-running");
  });

  test("a bridge that predates the route is reported as unsupported", async () => {
    const { provider } = httpProvider(() => new Response(null, { status: 404 }), codexConnection);
    await expect(provider.reloadMcpConfiguration!()).resolves.toBe("unsupported");
  });

  test("a bridge failure rejects so the apply is reported as failed", async () => {
    const { provider } = httpProvider(
      () => Response.json({ error: "MCP configuration reload failed" }, { status: 502 }),
      codexConnection,
    );
    await expect(provider.reloadMcpConfiguration!()).rejects.toThrow();
  });
});
