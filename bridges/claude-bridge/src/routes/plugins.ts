// Plugins routes
import { Hono } from "hono";
import { getPluginInfo } from "../services/plugin-config.js";
import { discoverSlashCommands } from "../services/slash-commands.js";

const plugins = new Hono();

/**
 * Get list of configured plugins
 * Returns plugin info including name, path, source (global/project/cli), and enabled status
 */
plugins.get("/", async (c) => {
  try {
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    const cwd = process.env.CWD || process.cwd();
    const pluginList = await getPluginInfo(cwd);

    return c.json({
      plugins: pluginList,
      cwd,
    });
  } catch (error) {
    console.error("[plugins] Error getting plugins:", error);
    return c.json({ error: error instanceof Error ? error.message : "Failed to get plugins" }, 500);
  }
});

/**
 * Get available slash commands from plugins, project, and built-ins.
 * This endpoint allows the frontend to discover commands before the first
 * SDK query (which is when session.init normally provides them).
 */
plugins.get("/commands", async (c) => {
  try {
    const cwd = process.env.CWD || process.cwd();
    const commands = await discoverSlashCommands(cwd);
    return c.json({ commands });
  } catch (error) {
    console.error("[plugins] Error discovering slash commands:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to discover slash commands" },
      500,
    );
  }
});

export default plugins;
