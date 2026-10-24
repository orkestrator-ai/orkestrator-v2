// Plugins routes
import { Hono } from "hono";
import { getPluginInfo } from "../services/plugin-config.js";

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

export default plugins;
