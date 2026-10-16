import type { NativeAgentCapability, NativeAgentExecutionPolicy } from "./native-agent.js";

/**
 * How much of the web a coordinator may use for research.
 *
 * A coordinator never reaches the internet from this machine: commands run
 * with the network off, and hosted page fetches stay off because a fetched URL
 * can carry data out to whoever owns the page. What this setting opens is
 * narrower:
 *
 * - `search`: the provider's hosted web search, which sends a query to the
 *   vendor's search service and returns results from it.
 * - `search-and-mcp`: search, plus the remote research MCP servers the user
 *   lists (Context7 by default). Only HTTPS servers; a local (stdio) server is
 *   a program running on the user's machine outside every sandbox.
 * - `off`: neither.
 */
export const COORDINATOR_WEB_RESEARCH_MODES = ["off", "search", "search-and-mcp"] as const;
export type CoordinatorWebResearch = (typeof COORDINATOR_WEB_RESEARCH_MODES)[number];

export const DEFAULT_COORDINATOR_WEB_RESEARCH: CoordinatorWebResearch = "search-and-mcp";

/** A remote MCP server a coordinator may call for research. */
export interface CoordinatorResearchMcpServer {
  /** Server name the agent sees in tool names, e.g. `context7`. */
  name: string;
  /** HTTPS endpoint. */
  url: string;
}

export const DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS: readonly CoordinatorResearchMcpServer[] =
  Object.freeze([{ name: "context7", url: "https://mcp.context7.com/mcp" }]);

export const MAX_COORDINATOR_RESEARCH_MCP_SERVERS = 8;

/**
 * Launch-time process authority, like `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`.
 *
 * A coordinator bridge reads these once, so a request body cannot widen what
 * it runs under. Absent means `off`: an older launcher, or a read-only review
 * in an ordinary bridge, keeps search off.
 */
export const COORDINATOR_WEB_RESEARCH_ENV = "ORKESTRATOR_COORDINATOR_WEB_RESEARCH";
export const COORDINATOR_RESEARCH_MCP_ENV = "ORKESTRATOR_COORDINATOR_RESEARCH_MCP";

/**
 * Names the coordinator's own tools already use, and so may not be reused.
 *
 * A research server named `orkestrator` would receive the approvals and tool
 * prefixes reserved for Orkestrator's scoped control server.
 */
const RESERVED_SERVER_NAME = /^orkestrator/;
// Letters, digits and hyphens only: providers join server and tool names with
// underscores (`mcp__<server>__<tool>`, `<server>_<tool>`), so an underscore
// in a server name could make one server's tools look like another's.
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isCoordinatorWebResearch(value: unknown): value is CoordinatorWebResearch {
  return (
    typeof value === "string" &&
    (COORDINATOR_WEB_RESEARCH_MODES as readonly string[]).includes(value)
  );
}

/** A stored or requested mode, with anything malformed failing closed to `off`. */
export function coordinatorWebResearchSetting(value: unknown): CoordinatorWebResearch {
  if (value === undefined) return DEFAULT_COORDINATOR_WEB_RESEARCH;
  return isCoordinatorWebResearch(value) ? value : "off";
}

/** Why a research server entry is refused, or `undefined` when it is acceptable. */
export function coordinatorResearchMcpServerProblem(
  server: CoordinatorResearchMcpServer,
): string | undefined {
  if (!SERVER_NAME.test(server.name)) {
    return "Use 1 to 32 lowercase letters, digits or hyphens for the name.";
  }
  if (RESERVED_SERVER_NAME.test(server.name))
    return "Names starting with orkestrator are reserved.";
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return "The URL is not valid.";
  }
  if (url.protocol !== "https:") return "Only https:// research servers are allowed.";
  if (url.username || url.password) return "Credentials in the URL are not allowed.";
  return undefined;
}

/**
 * Keep only acceptable, uniquely named servers, up to the limit.
 *
 * Anything else is dropped rather than repaired: a coordinator should call
 * exactly the servers the user listed, or none.
 */
export function normalizeCoordinatorResearchMcpServers(
  value: unknown,
): CoordinatorResearchMcpServer[] {
  if (value === undefined) return DEFAULT_COORDINATOR_RESEARCH_MCP_SERVERS.map((s) => ({ ...s }));
  if (!Array.isArray(value)) return [];
  const servers: CoordinatorResearchMcpServer[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (servers.length >= MAX_COORDINATOR_RESEARCH_MCP_SERVERS) break;
    if (!entry || typeof entry !== "object") continue;
    const { name, url } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof url !== "string") continue;
    const server = { name: name.trim(), url: url.trim() };
    if (coordinatorResearchMcpServerProblem(server) || names.has(server.name)) continue;
    names.add(server.name);
    servers.push(server);
  }
  return servers;
}

/** The research mode a coordinator process was launched with. */
export function coordinatorWebResearchFromEnv(env: NodeJS.ProcessEnv): CoordinatorWebResearch {
  const value = env[COORDINATOR_WEB_RESEARCH_ENV];
  return isCoordinatorWebResearch(value) ? value : "off";
}

/** The research servers a coordinator process may call; none unless the mode includes them. */
export function coordinatorResearchMcpServersFromEnv(
  env: NodeJS.ProcessEnv,
): CoordinatorResearchMcpServer[] {
  if (coordinatorWebResearchFromEnv(env) !== "search-and-mcp") return [];
  const raw = env[COORDINATOR_RESEARCH_MCP_ENV];
  if (!raw) return [];
  try {
    return normalizeCoordinatorResearchMcpServers(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** The launch environment a coordinator bridge receives for a research setting. */
export function coordinatorWebResearchEnv(
  mode: CoordinatorWebResearch,
  servers: readonly CoordinatorResearchMcpServer[],
): Record<string, string> {
  return {
    [COORDINATOR_WEB_RESEARCH_ENV]: mode,
    ...(mode === "search-and-mcp" && servers.length > 0
      ? { [COORDINATOR_RESEARCH_MCP_ENV]: JSON.stringify(servers) }
      : {}),
  };
}

const COORDINATOR_DENIED: readonly NativeAgentCapability[] = Object.freeze([
  "file.write",
  "file.patch",
  "shell.mutate",
  "network",
]);

/**
 * The coordinator's capability policy for a research mode.
 *
 * The denial list is the same in every mode; research only ever adds the
 * `web.search` exception, so a policy without it (older records, older
 * bridges, review turns) keeps search off.
 */
export function coordinatorCapabilityPolicy(
  mode: CoordinatorWebResearch,
): NonNullable<NativeAgentExecutionPolicy["capabilityPolicy"]> {
  return {
    deny: [...COORDINATOR_DENIED],
    ...(mode === "off" ? {} : { allow: ["web.search"] }),
  };
}
