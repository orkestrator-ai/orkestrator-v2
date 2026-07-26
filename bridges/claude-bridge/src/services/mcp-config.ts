/**
 * MCP Configuration Service
 *
 * Loads MCP server configurations from:
 * 1. ~/.claude.json (global configuration)
 * 2. <project>/.mcp.json (project-specific configuration)
 *
 * Project-specific configs override global configs for servers with the same name.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readJsonFileCached } from "./json-file-cache.js";
import type {
  ClaudeJsonConfig,
  McpJsonConfig,
  McpServerConfig,
  McpServersConfig,
  McpServerInfo,
} from "../types/mcp.js";

/**
 * SDK MCP server config types - matching the SDK's expected format
 * The SDK expects mcpServers as Record<string, McpServerConfig> in query options
 */
type SdkMcpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type SdkMcpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

type SdkMcpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

type SdkMcpServerConfig = SdkMcpStdioServerConfig | SdkMcpSSEServerConfig | SdkMcpHttpServerConfig;

/**
 * SDK mcpServers format: Record<serverName, config>
 */
export type SdkMcpServersConfig = Record<string, SdkMcpServerConfig>;

/**
 * Read and parse a JSON file, returning null if it doesn't exist or is invalid.
 * Backed by a stat-validated cache: these files are read several times per
 * prompt and change rarely.
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  return readJsonFileCached<T>(filePath);
}

/**
 * Load global MCP server configurations from ~/.claude.json
 */
export async function loadGlobalMcpServers(): Promise<McpServersConfig> {
  const claudeJsonPath = join(homedir(), ".claude.json");
  const config = await readJsonFile<ClaudeJsonConfig>(claudeJsonPath);

  if (!config?.mcpServers) {
    return {};
  }

  return config.mcpServers;
}

/**
 * Load project-specific MCP server configurations from <cwd>/.mcp.json
 */
export async function loadProjectMcpServers(
  cwd: string
): Promise<McpServersConfig> {
  const mcpJsonPath = join(cwd, ".mcp.json");
  const config = await readJsonFile<McpJsonConfig>(mcpJsonPath);

  if (!config?.mcpServers) {
    return {};
  }

  return config.mcpServers;
}

/**
 * Also check for project-specific overrides in ~/.claude.json projects section
 */
export async function loadProjectOverridesFromGlobal(
  cwd: string
): Promise<McpServersConfig> {
  const claudeJsonPath = join(homedir(), ".claude.json");
  const config = await readJsonFile<ClaudeJsonConfig>(claudeJsonPath);

  if (!config?.projects) {
    return {};
  }

  // Check for project entry matching the cwd
  const projectConfig = config.projects[cwd];
  if (!projectConfig?.mcpServers) {
    return {};
  }

  return projectConfig.mcpServers;
}

/**
 * Determine if a server config is HTTP type
 */
function isHttpConfig(
  config: McpServerConfig
): config is { type: "http"; url: string; headers?: Record<string, string> } {
  return config.type === "http" && "url" in config;
}

/**
 * Determine if a server config is stdio type
 */
function isStdioConfig(
  config: McpServerConfig
): config is {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
} {
  return (config.type === "stdio" || !config.type) && "command" in config;
}

/**
 * Convert a single MCP server config to SDK format
 */
export function configToSdkFormat(
  config: McpServerConfig
): SdkMcpServerConfig | null {
  if (isHttpConfig(config)) {
    // Remote MCP servers use HTTP transport. The SDK also supports "sse" transport,
    // but our config schema uses "http" for all URL-based servers.
    return {
      type: "http" as const,
      url: config.url,
      headers: config.headers,
    };
  }

  if (isStdioConfig(config)) {
    return {
      type: "stdio" as const,
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }

  return null;
}

/**
 * Get merged MCP servers for a project.
 * Priority (highest to lowest):
 * 1. Project .mcp.json
 * 2. Project entry in ~/.claude.json
 * 3. Global mcpServers in ~/.claude.json
 */
export async function getMergedMcpServers(
  cwd: string
): Promise<McpServersConfig> {
  const [global, projectGlobal, projectLocal] = await Promise.all([
    loadGlobalMcpServers(),
    loadProjectOverridesFromGlobal(cwd),
    loadProjectMcpServers(cwd),
  ]);

  // Merge with priority: local > projectGlobal > global
  return {
    ...global,
    ...projectGlobal,
    ...projectLocal,
  };
}

/**
 * Convert merged configs to SDK-compatible MCP server config record
 * Returns Record<serverName, config>
 */
export async function getMcpServersForSdk(
  cwd: string
): Promise<SdkMcpServersConfig> {
  const configs = await getMergedMcpServers(cwd);
  const servers: SdkMcpServersConfig = {};

  for (const [name, config] of Object.entries(configs)) {
    const sdkConfig = configToSdkFormat(config);
    if (sdkConfig) {
      servers[name] = sdkConfig;
    } else {
      console.warn(`Unknown MCP server config type for "${name}":`, config);
    }
  }

  return servers;
}

/**
 * Get MCP server info for frontend display
 */
export async function getMcpServerInfo(cwd: string): Promise<McpServerInfo[]> {
  // Load all config sources in parallel (single call for each source)
  const [global, projectGlobal, projectLocal] = await Promise.all([
    loadGlobalMcpServers(),
    loadProjectOverridesFromGlobal(cwd),
    loadProjectMcpServers(cwd),
  ]);

  // Merge with priority: local > projectGlobal > global
  const merged = {
    ...global,
    ...projectGlobal,
    ...projectLocal,
  };
  const result: McpServerInfo[] = [];

  for (const [name, config] of Object.entries(merged)) {
    // Determine source
    let source: "global" | "project" = "global";
    if (name in projectLocal || name in projectGlobal) {
      source = "project";
    }

    if (isHttpConfig(config)) {
      result.push({
        name,
        type: "http",
        url: config.url,
        source,
      });
    } else if (isStdioConfig(config)) {
      result.push({
        name,
        type: "stdio",
        command: config.command,
        source,
      });
    }
  }

  return result;
}

/**
 * Get list of MCP server names for tracking which tools are MCP tools
 */
export async function getMcpServerNames(cwd: string): Promise<Set<string>> {
  const configs = await getMergedMcpServers(cwd);
  return new Set(Object.keys(configs));
}

/**
 * Everything `sendPrompt` needs from MCP config, resolved from a single merge.
 *
 * Calling `getMcpServersForSdk` and `getMcpServerNames` separately merged the
 * same three config sources twice per prompt — and each merge reads
 * `~/.claude.json` twice, so the file was touched four times for one turn.
 */
export async function getMcpRuntimeConfig(cwd: string): Promise<{
  servers: SdkMcpServersConfig;
  names: Set<string>;
}> {
  const configs = await getMergedMcpServers(cwd);
  const servers: SdkMcpServersConfig = {};

  for (const [name, config] of Object.entries(configs)) {
    const sdkConfig = configToSdkFormat(config);
    if (sdkConfig) {
      servers[name] = sdkConfig;
    } else {
      console.warn(`Unknown MCP server config type for "${name}":`, config);
    }
  }

  // Names come from the merged config, not from `servers`: a server whose
  // config shape we can't translate is still an MCP server as far as tool-name
  // parsing is concerned, and dropping it would misattribute its tools.
  return { servers, names: new Set(Object.keys(configs)) };
}
