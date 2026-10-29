/**
 * MCP Configuration Service
 *
 * Loads MCP server configurations from:
 * 1. ~/.claude.json (global configuration)
 * 2. <project>/.mcp.json (project-specific configuration)
 *
 * Project-specific configs override global configs for servers with the same name.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { claudeJsonPath } from "./claude-home.js";
import { coordinatorResearchMcpServersFromEnv } from "@orkestrator/protocol/coordinator-web-research";
import {
  nativeAgentAllowsUserMcpServer,
  nativeAgentRestrictsUserMcp,
  nativeAgentUserMcpGrant,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { readJsonSliceCached, readJsonSliceCachedWithDigest } from "./json-file-cache.js";
import { isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";
import {
  ORKESTRATOR_ARTIFACT_MCP_PATH,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";
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

/** Reserved name for Orkestrator's own scoped server; never a project's. */
export const AGENT_MCP_SERVER_NAME = "orkestrator";
const AGENT_MCP_URL_ENV = "ORKESTRATOR_AGENT_MCP_URL";
const AGENT_MCP_TOKEN_ENV = "ORKESTRATOR_AGENT_MCP_TOKEN";

export type AgentMcpConnection = {
  url: string;
  token: string;
  design?: boolean;
  /**
   * A backend workflow turn's artifact-only connection: an
   * `orkestrator-artifacts` server at this connection's origin, authenticated
   * by the turn's artifact grant (never the workflow-result credential).
   */
  artifacts?: { token: string };
};

/** The artifact-only server of a backend workflow turn, when its connection names one. */
export function getOrkestratorArtifactMcpServer(
  connection: AgentMcpConnection | undefined,
): SdkMcpHttpServerConfig | null {
  const token = connection?.artifacts?.token?.trim();
  const agentServer = getOrkestratorAgentMcpServerFromConnection(connection);
  if (!token || Buffer.byteLength(token, "utf8") > 1024 || !agentServer) return null;
  return {
    ...agentServer,
    url: new URL(ORKESTRATOR_ARTIFACT_MCP_PATH, agentServer.url).toString(),
    headers: { Authorization: `Bearer ${token}` },
  };
}

export function getOrkestratorAgentMcpServerFromConnection(
  connection: AgentMcpConnection | undefined,
): SdkMcpHttpServerConfig | null {
  if (!connection?.url?.trim() || !connection.token?.trim()) return null;
  return getOrkestratorAgentMcpServer({
    [AGENT_MCP_URL_ENV]: connection.url,
    [AGENT_MCP_TOKEN_ENV]: connection.token,
  });
}

export function getOrkestratorAgentMcpServer(
  env: NodeJS.ProcessEnv = process.env,
): SdkMcpHttpServerConfig | null {
  const rawUrl = env[AGENT_MCP_URL_ENV]?.trim();
  const token = env[AGENT_MCP_TOKEN_ENV]?.trim();
  if (!rawUrl || !token || Buffer.byteLength(token, "utf8") > 1024) return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
      url.pathname !== "/mcp" ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return {
      type: "http",
      url: url.toString(),
      headers: { Authorization: `Bearer ${token}` },
    };
  } catch {
    return null;
  }
}

/**
 * Load global MCP server configurations from ~/.claude.json
 *
 * Reads through a stat-validated slice cache: this file is consulted several
 * times per prompt, changes rarely, and is mostly project history the bridge
 * has no use for — so only the `mcpServers` record is retained.
 */
export async function loadGlobalMcpServers(): Promise<McpServersConfig> {
  const servers = await readJsonSliceCached<ClaudeJsonConfig, McpServersConfig>(
    claudeJsonPath(),
    "mcpServers",
    (config) => config?.mcpServers,
  );

  return servers ?? {};
}

/**
 * Load project-specific MCP server configurations from <cwd>/.mcp.json
 */
export async function loadProjectMcpServers(cwd: string): Promise<McpServersConfig> {
  const servers = await readJsonSliceCached<McpJsonConfig, McpServersConfig>(
    join(cwd, ".mcp.json"),
    "mcpServers",
    (config) => config?.mcpServers,
  );

  return servers ?? {};
}

/**
 * Also check for project-specific overrides in ~/.claude.json projects section
 *
 * The slice key carries `cwd` because the selector closes over it — two
 * projects must not serve each other's overrides from the same entry.
 */
export async function loadProjectOverridesFromGlobal(cwd: string): Promise<McpServersConfig> {
  const servers = await readJsonSliceCached<ClaudeJsonConfig, McpServersConfig>(
    claudeJsonPath(),
    `projects:${cwd}:mcpServers`,
    (config) => config?.projects?.[cwd]?.mcpServers,
  );

  return servers ?? {};
}

/**
 * Determine if a server config is HTTP type
 */
function isHttpConfig(
  config: McpServerConfig,
): config is { type: "http"; url: string; headers?: Record<string, string> } {
  return config.type === "http" && "url" in config;
}

/**
 * Determine if a server config is stdio type
 */
function isStdioConfig(config: McpServerConfig): config is {
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
export function configToSdkFormat(config: McpServerConfig): SdkMcpServerConfig | null {
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
export async function getMergedMcpServers(cwd: string): Promise<McpServersConfig> {
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
 * Translate a merged config record into the SDK's `mcpServers` shape, dropping
 * (and reporting) any entry whose transport we do not recognise.
 */
function toSdkServers(configs: McpServersConfig): SdkMcpServersConfig {
  const servers: SdkMcpServersConfig = {};

  for (const [name, config] of Object.entries(configs)) {
    const sdkConfig = configToSdkFormat(config);
    if (sdkConfig) {
      servers[name] = sdkConfig;
    } else {
      console.warn("[mcp-config] Ignoring unsupported MCP server configuration");
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
 * Which configured MCP sources a query may load.
 *
 * - `all`: user, private local (`projects[cwd]`) and project `.mcp.json`.
 * - `user`: the user's own servers only. A session without project resources
 *   must not run a program a cloned repository declares, but the user's own
 *   servers are theirs to run.
 * - `none`: no configured server at all, only the injected Orkestrator
 *   server(s). A coordinator's boundary excludes every program it did not
 *   choose, and a user-scope stdio server is still a program — the CLI itself
 *   loads nothing for a coordinator (`settingSources: []`), so the inline set
 *   is the only way one could arrive.
 */
export type McpSourceScope = "all" | "user" | "none";

/** Content-free identity of one MCP source a query read. */
export type McpSourceDigest = string | "absent" | "excluded";

/**
 * Which saved MCP configuration a query started with.
 *
 * Digests are sha256 (base64url) of the exact file bytes the bridge parsed for
 * that query, so a caller that knows what it wrote can tell whether a query has
 * picked it up by hashing the same bytes. Never a path, never a server body:
 * the files hold headers and env values.
 */
export interface McpConfigRevision {
  /** One opaque value over every source below; changes when any of them does. */
  fingerprint: string;
  sources: {
    /** `~/.claude.json` — holds both user and private-local entries. */
    user: McpSourceDigest;
    /** `<cwd>/.mcp.json`. */
    project: McpSourceDigest;
  };
  scope: McpSourceScope;
}

function sourceDigest(digest: string | null): McpSourceDigest {
  return digest === null ? "absent" : `sha256:${digest}`;
}

/** Map the legacy boolean form onto a scope, keeping `true` as the default. */
function normalizeScope(scope: McpSourceScope | boolean): McpSourceScope {
  if (scope === true) return "all";
  if (scope === false) return "user";
  return scope;
}

/**
 * The MCP source scope a turn under `policy` is allowed to load.
 *
 * Kept beside `claudeSettingSources` in spirit: a coordinator loads nothing,
 * a session without project resources loads only the user's own.
 */
export function mcpSourceScopeForPolicy(
  policy: NativeAgentExecutionPolicy | undefined,
): McpSourceScope {
  if (isCoordinatorReadOnlyPolicy(policy)) {
    // A read-only turn of a graph node that was granted user servers (item
    // 404) reads the user's own file for them, and only them
    // (`userMcpServerFilter`). A coordinator's policy never carries a grant,
    // and a coordinator process replaces whatever policy a request names.
    return (nativeAgentUserMcpGrant(policy)?.length ?? 0) > 0 ? "user" : "none";
  }
  if (policy?.projectResources === false) return "user";
  return "all";
}

/**
 * The configured servers a turn under `policy` may load, as a filter over
 * server names (item 404): the policy's `userMcpServers` selection minus its
 * `mcp:<server>` denials. `undefined` when the policy narrows nothing, so an
 * ordinary session loads every configured server as before.
 */
export function userMcpServerFilter(
  policy: NativeAgentExecutionPolicy | undefined,
): ((name: string) => boolean) | undefined {
  if (!nativeAgentRestrictsUserMcp(policy)) return undefined;
  return (name) => nativeAgentAllowsUserMcpServer(policy, name);
}

/**
 * The granted user servers (item 404) this turn actually loaded, whose tools
 * the turn approves up front. Empty for a policy without a selection.
 */
export function claudeGrantedMcpServerNames(
  policy: NativeAgentExecutionPolicy | undefined,
  loaded: ReadonlySet<string>,
): string[] {
  return (nativeAgentUserMcpGrant(policy) ?? []).filter((name) => loaded.has(name));
}

/**
 * Query options for a policy that selects user MCP servers (item 404).
 *
 * The CLI loads the servers of every enabled settings source itself, so an
 * inline set filtered to the grant would not keep the others out.
 * `strictMcpConfig` makes the inline set the only one: no user, project or
 * plugin MCP file is read. Plugin servers therefore never load for such a
 * session, which is right: they cannot be named in a grant. A policy that
 * selects nothing keeps today's behaviour (plugin servers load).
 */
export function claudeUserMcpQueryOptions(policy: NativeAgentExecutionPolicy | undefined): {
  strictMcpConfig?: true;
} {
  return nativeAgentUserMcpGrant(policy) !== undefined ? { strictMcpConfig: true } : {};
}

async function loadScopedMcpServers(
  cwd: string,
  scope: McpSourceScope,
): Promise<{ configs: McpServersConfig; revision: McpConfigRevision }> {
  if (scope === "none") {
    const sources = { user: "excluded", project: "excluded" } as const;
    return { configs: {}, revision: { fingerprint: revisionFingerprint(sources), sources, scope } };
  }
  const path = claudeJsonPath();
  const [global, projectGlobal, projectLocal] = await Promise.all([
    readJsonSliceCachedWithDigest<ClaudeJsonConfig, McpServersConfig>(
      path,
      "mcpServers",
      (config) => config?.mcpServers,
    ),
    scope === "all"
      ? readJsonSliceCachedWithDigest<ClaudeJsonConfig, McpServersConfig>(
          path,
          `projects:${cwd}:mcpServers`,
          (config) => config?.projects?.[cwd]?.mcpServers,
        )
      : null,
    scope === "all"
      ? readJsonSliceCachedWithDigest<McpJsonConfig, McpServersConfig>(
          join(cwd, ".mcp.json"),
          "mcpServers",
          (config) => config?.mcpServers,
        )
      : null,
  ]);
  // Same precedence as `getMergedMcpServers`: local > projectGlobal > global.
  const configs: McpServersConfig = {
    ...global.value,
    ...projectGlobal?.value,
    ...projectLocal?.value,
  };
  const sources = {
    user: sourceDigest(global.digest),
    project: projectLocal ? sourceDigest(projectLocal.digest) : "excluded",
  };
  return { configs, revision: { fingerprint: revisionFingerprint(sources), sources, scope } };
}

function revisionFingerprint(sources: McpConfigRevision["sources"]): string {
  return createHash("sha256")
    .update(`user=${sources.user}\u0000project=${sources.project}`)
    .digest("base64url");
}

/**
 * Everything `sendPrompt` needs from MCP config, resolved from a single merge.
 *
 * This replaced a pair of calls (`getMcpServersForSdk` + `getMcpServerNames`)
 * that merged the same three config sources twice per prompt — and each merge
 * reads `~/.claude.json` twice, so the file was touched four times for one
 * turn. It is the only entry point into this module that `sendPrompt` uses;
 * keep the translation in `toSdkServers` so there is exactly one copy of it.
 *
 * `sources` accepts the older boolean (`true` = all, `false` = user only) so
 * existing callers keep their meaning; pass `"none"` for a coordinator.
 */
export async function getMcpRuntimeConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  connection?: AgentMcpConnection,
  sources: McpSourceScope | boolean = "all",
  /** Which configured servers may load (`userMcpServerFilter`); all when absent. */
  allowConfigured?: (name: string) => boolean,
): Promise<{
  servers: SdkMcpServersConfig;
  names: Set<string>;
  revision: McpConfigRevision;
}> {
  const scoped = await loadScopedMcpServers(cwd, normalizeScope(sources));
  const { revision } = scoped;
  // A configured server outside the session's selection is never loaded and
  // never named: with `strictMcpConfig` the CLI starts only this inline set.
  const configs = allowConfigured
    ? Object.fromEntries(Object.entries(scoped.configs).filter(([name]) => allowConfigured(name)))
    : scoped.configs;
  const agentServer =
    getOrkestratorAgentMcpServerFromConnection(connection) ?? getOrkestratorAgentMcpServer(env);
  const servers = toSdkServers(configs);
  // Backend-provided credentials are authoritative for this reserved name.
  // A project-local config must not be able to redirect the trusted ticket
  // tools (or capture their bearer token) by claiming the same server name.
  if (agentServer) {
    servers[AGENT_MCP_SERVER_NAME] = agentServer;
    if (connection?.design)
      servers["orkestrator-design"] = {
        ...agentServer,
        url: new URL("/design-mcp", agentServer.url).toString(),
      };
  }
  // Reserved like the agent server: a configured server of this name never
  // receives the grant or stands in for the backend's artifact tools.
  const artifactServer = getOrkestratorArtifactMcpServer(connection);
  if (artifactServer) servers[ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME] = artifactServer;
  else delete servers[ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME];
  // A coordinator loads no configured servers (`none`), only the remote
  // research servers its launcher named as process authority. They come from
  // the environment, never from a file the checkout could edit.
  const research =
    normalizeScope(sources) === "none" ? coordinatorResearchMcpServersFromEnv(env) : [];
  for (const server of research) servers[server.name] = { type: "http", url: server.url };

  // Names come from the merged config, not from `servers`: a server whose
  // config shape we can't translate is still an MCP server as far as tool-name
  // parsing is concerned, and dropping it would misattribute its tools.
  return {
    servers,
    names: new Set([
      // A configured server under the reserved artifact name is never loaded.
      ...Object.keys(configs).filter((name) => name !== ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME),
      ...(agentServer
        ? [AGENT_MCP_SERVER_NAME, ...(connection?.design ? ["orkestrator-design"] : [])]
        : []),
      ...(artifactServer ? [ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME] : []),
      ...research.map((server) => server.name),
    ]),
    revision,
  };
}
