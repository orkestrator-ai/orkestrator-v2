import {
  coordinatorWebResearchSetting,
  normalizeCoordinatorResearchMcpServers,
  type CoordinatorResearchMcpServer,
  type CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import type { AppConfig } from "./models.js";

export interface CoordinatorResearch {
  mode: CoordinatorWebResearch;
  servers: CoordinatorResearchMcpServer[];
}

/**
 * The coordinator research setting, failing closed to `off`.
 *
 * Unreadable configuration must not widen a coordinator, so any failure to
 * load it reads as research off rather than the product default.
 */
export async function loadCoordinatorResearch(storage: {
  loadConfig?: () => Promise<AppConfig>;
}): Promise<CoordinatorResearch> {
  try {
    if (typeof storage.loadConfig !== "function") return { mode: "off", servers: [] };
    const { global } = await storage.loadConfig();
    return {
      mode: coordinatorWebResearchSetting(global.coordinatorWebResearch),
      servers: normalizeCoordinatorResearchMcpServers(global.coordinatorResearchMcpServers),
    };
  } catch {
    return { mode: "off", servers: [] };
  }
}

/**
 * The coordinator context line that says what research is available.
 *
 * Search and research servers are described as "if your tools include it":
 * Grok and Pi have no hosted search a coordinator may use, Grok loads no
 * research servers, and a server that did not connect is simply absent, so
 * the agent has to check rather than be promised a tool it does not have.
 */
export function coordinatorResearchLine(research: CoordinatorResearch): string {
  const base =
    "Network: commands you run have no network access, and fetching live web pages is off.";
  if (research.mode === "off") {
    return `${base} Web search and research servers are also off in this installation.\n`;
  }
  const servers =
    research.mode === "search-and-mcp" && research.servers.length > 0
      ? ` and the research MCP servers ${research.servers.map((server) => server.name).join(", ")}`
      : "";
  return `${base} For research you may use your web search tool${servers}, if your tools include them; use them for documentation and facts, not as a substitute for delegating work.\n`;
}
