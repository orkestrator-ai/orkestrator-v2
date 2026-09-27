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
 * Legacy, display-only command list for clients that predate the enhanced
 * session catalogue (`GET /session/:id/commands`, catalogue version 1).
 *
 * It is a filesystem scan plus a fixed list, not SDK discovery: it has no
 * session scope, cannot see skills, MCP prompts or the session's settings
 * sources, and its rows carry no execution identity. It is therefore never
 * merged into a session's catalogue and never used to validate a selected
 * command. Kept in its legacy `{ commands: string[] }` shape because the
 * backend still falls back to it for a bridge whose session route is absent,
 * and replacing it with SDK discovery would spawn a CLI per request.
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
