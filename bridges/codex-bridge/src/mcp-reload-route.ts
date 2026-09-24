import type { Hono } from "hono";

import type { EngineGeneration } from "./engine/types.js";

export interface McpReloadRuntime {
  reloadMcpConfigurationIfRunning(): Promise<{
    reloaded: boolean;
    generation?: EngineGeneration;
  }>;
}

/**
 * `POST /global/mcp/reload` — the backend's MCP management apply path.
 *
 * Deliberately not a session route: the backend must be able to reload after
 * this bridge restarted and forgot every session, and it must not touch a
 * session's liveness, hydrate a transcript or re-attach an idle thread. It
 * never cold-starts app-server either — `{ reloaded: false }` means nothing is
 * running, and the next process reads the saved configuration when it starts.
 */
export function registerMcpReloadRoute(app: Hono, runtime: McpReloadRuntime): void {
  app.post("/global/mcp/reload", async (c) => {
    try {
      const outcome = await runtime.reloadMcpConfigurationIfRunning();
      return c.json(
        outcome.reloaded
          ? { reloaded: true, generation: outcome.generation }
          : { reloaded: false, reason: "not-running" },
      );
    } catch {
      // Provider text can carry paths or server output; the caller only needs
      // to know the reload did not happen.
      return c.json({ error: "MCP configuration reload failed" }, 502);
    }
  });
}
