import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerMcpReloadRoute, type McpReloadRuntime } from "./mcp-reload-route.js";

function app(runtime: McpReloadRuntime) {
  const hono = new Hono();
  registerMcpReloadRoute(hono, runtime);
  return hono;
}

describe("POST /global/mcp/reload", () => {
  test("reports a reload served by the running generation", async () => {
    const response = await app({
      reloadMcpConfigurationIfRunning: async () => ({ reloaded: true, generation: 3 }),
    }).request("/global/mcp/reload", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reloaded: true, generation: 3 });
  });

  test("reports not-running instead of starting app-server", async () => {
    const response = await app({
      reloadMcpConfigurationIfRunning: async () => ({ reloaded: false }),
    }).request("/global/mcp/reload", { method: "POST" });
    expect(await response.json()).toEqual({ reloaded: false, reason: "not-running" });
  });

  test("a failed reload is a bounded 502 without provider text", async () => {
    const response = await app({
      reloadMcpConfigurationIfRunning: async () => {
        throw new Error("/home/user/.codex/config.toml: secret-ish detail");
      },
    }).request("/global/mcp/reload", { method: "POST" });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("config.toml");
  });
});
