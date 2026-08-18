// MCP (Model Context Protocol) routes
import { Hono } from "hono";
import { getMcpServerInfo } from "../services/mcp-config.js";

const mcp = new Hono();

/**
 * Get list of configured MCP servers
 * Returns server info including name, type, and source (global/project)
 */
mcp.get("/servers", async (c) => {
  try {
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    const cwd = process.env.CWD || process.cwd();
    const servers = await getMcpServerInfo(cwd);

    return c.json({
      servers,
      cwd,
    });
  } catch (error) {
    console.error("[mcp] Error getting MCP servers:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to get MCP servers" },
      500,
    );
  }
});

export default mcp;
