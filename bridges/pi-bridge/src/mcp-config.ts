/**
 * Resolve which MCP servers a Pi session may launch.
 *
 * Three scopes, same rule as Claude and Cursor:
 * - `orkestrator` always, from the process env or a per-tab `agentMcp` body.
 *   Wins a name collision. The reserved id is never taken from a file.
 * - `user` always, from `<agentDir>/mcp.json` (`~/.pi/agent` on a host).
 * - `project` only when the execution policy opts into project resources,
 *   from `<cwd>/.pi/mcp.json`. A cloned repo must not spawn stdio on the host.
 *
 * A coordinator process adds a fourth, `research`: the remote HTTPS servers
 * the launcher named as process authority (Settings → Coordinator web
 * research). Reserved like `orkestrator`, so a file entry of the same name
 * cannot stand in for one.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { coordinatorResearchMcpServersFromEnv } from "@orkestrator/protocol/coordinator-web-research";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentMcpServer,
  nativeAgentRestrictsUserMcp,
  nativeAgentUserMcpGrant,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { isObject, nonBlank } from "./state.js";
import {
  ORKESTRATOR_ARTIFACT_MCP_PATH,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";

export const ORKESTRATOR_MCP_SERVER_NAME = "orkestrator";
export const AGENT_MCP_URL_ENV = "ORKESTRATOR_AGENT_MCP_URL";
export const AGENT_MCP_TOKEN_ENV = "ORKESTRATOR_AGENT_MCP_TOKEN";
/** The coordinator process authority; see `agent-session.ts`. */
const BRIDGE_EXECUTION_POLICY_ENV = "ORKESTRATOR_BRIDGE_EXECUTION_POLICY";

const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_NAME_LENGTH = 64;
const MAX_HEADER_ENTRIES = 16;
const MAX_ENV_ENTRIES = 32;
const MAX_ARG_ENTRIES = 32;
const ORKESTRATOR_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);
/**
 * Bridge-process variables no MCP server may receive: not through the stdio
 * environment, and not by naming them in a `${NAME}` reference in `mcp.json`.
 */
export const BRIDGE_SECRET_ENV: ReadonlySet<string> = new Set([
  AGENT_MCP_TOKEN_ENV,
  "PI_BRIDGE_TOKEN",
]);

export type McpScope = "orkestrator" | "research" | "user" | "project";
export type McpTransport = "http" | "stdio";

export interface AgentMcpConnection {
  url: string;
  token: string;
  /**
   * A backend workflow turn's artifact-only connection: an
   * `orkestrator-artifacts` server at this connection's origin
   * (`/artifact-mcp`), authenticated by the turn's artifact grant.
   */
  artifacts?: { token: string };
}

export interface ResolvedMcpServer {
  id: string;
  scope: McpScope;
  transport: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory as written; relative paths resolve against the session's. */
  cwd?: string;
}

export function parseAgentMcpConnection(value: unknown): AgentMcpConnection | undefined {
  if (!isObject(value)) return undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!url || !token || Buffer.byteLength(token, "utf8") > 1024) return undefined;
  const artifacts = isObject(value.artifacts) ? value.artifacts.token : undefined;
  const artifactToken = typeof artifacts === "string" ? artifacts.trim() : "";
  return {
    url,
    token,
    ...(artifactToken && Buffer.byteLength(artifactToken, "utf8") <= 1024
      ? { artifacts: { token: artifactToken } }
      : {}),
  };
}

/**
 * A workflow turn's artifact-only server, beside the attempt's own
 * `orkestrator` server. Same trusted scope: its tools are Orkestrator's.
 */
export function orkestratorArtifactMcpServer(
  connection?: AgentMcpConnection,
): ResolvedMcpServer | undefined {
  const token = connection?.artifacts?.token;
  const agent = token ? orkestratorMcpServer(connection, {}) : undefined;
  if (!token || !agent?.url) return undefined;
  return {
    id: ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
    scope: "orkestrator",
    transport: "http",
    url: new URL(ORKESTRATOR_ARTIFACT_MCP_PATH, agent.url).toString(),
    headers: { Authorization: `Bearer ${token}` },
  };
}

export function orkestratorMcpServer(
  connection?: AgentMcpConnection,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpServer | undefined {
  const url = connection?.url?.trim() || env[AGENT_MCP_URL_ENV]?.trim();
  const token = connection?.token?.trim() || env[AGENT_MCP_TOKEN_ENV]?.trim();
  if (!url || !token || Buffer.byteLength(token, "utf8") > 1024) return undefined;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      !ORKESTRATOR_HOSTS.has(parsed.hostname) ||
      parsed.pathname !== "/mcp" ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return {
      id: ORKESTRATOR_MCP_SERVER_NAME,
      scope: "orkestrator",
      transport: "http",
      url: parsed.toString(),
      headers: { Authorization: `Bearer ${token}` },
    };
  } catch {
    return undefined;
  }
}

/**
 * One `mcp.json` entry before the scopes merge.
 *
 * A `server` entry is one Pi's own loader accepts; `launch` is absent when the
 * bridge cannot start it (an unresolvable value, a blank command, or a Pi
 * provider `auth` the bridge cannot supply), which still lets it shadow a
 * same-named user entry the way Pi's own loader does. An entry Pi rejects is
 * never returned, so it shadows nothing. An `override` entry (project only,
 * since Pi 1.0.1) has no `command`, `url` or `type` and changes only whether
 * the user-level server of the same name is enabled.
 */
type McpConfigEntry =
  | { kind: "server"; id: string; enabled: boolean; hasAuth: boolean; launch?: ResolvedMcpServer }
  | { kind: "override"; id: string; enabled?: boolean };

/** Pi's override keys; an override setting anything else is rejected. */
const MCP_OVERRIDE_KEYS: ReadonlySet<string> = new Set(["enabled", "exposure", "toolExposure"]);

export async function loadMcpConfigFile(
  path: string,
  scope: Exclude<McpScope, "orkestrator">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfigEntry[]> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_MCP_CONFIG_BYTES) return [];
    // Pi strips one leading UTF-8 BOM before parsing (since 1.4.0); without it
    // a Notepad-saved file would drop every server here and none in Pi.
    const text = await fs.readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
    if (!isObject(parsed)) return [];
    const record = isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
    if (!isObject(record)) return [];
    const entries: McpConfigEntry[] = [];
    for (const [name, value] of Object.entries(record)) {
      if (entries.length >= MAX_MCP_SERVERS) break;
      const id = sanitizeMcpName(name);
      if (!id || id === ORKESTRATOR_MCP_SERVER_NAME || !isObject(value)) continue;
      if (value.command === undefined && value.url === undefined && value.type === undefined) {
        // Pi accepts this shape only as a project override, and only when it
        // sets nothing but the override keys; anything else is an invalid entry.
        if (scope !== "project" || Object.keys(value).some((key) => !MCP_OVERRIDE_KEYS.has(key))) {
          continue;
        }
        if (!validSharedFields(value)) continue;
        entries.push({
          kind: "override",
          id,
          ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
        });
        continue;
      }
      const transport = acceptedTransport(value);
      if (!transport) continue;
      const hasAuth = transport === "http" && value.auth !== undefined;
      // Pi refuses `auth` in a project file, so a repository cannot choose
      // where a provider token goes.
      if (scope === "project" && hasAuth) continue;
      entries.push({
        kind: "server",
        id,
        // `disabled: true` is the Claude/Cursor spelling; `enabled: false` is
        // Pi's own (`pi mcp`, the `/mcp` manager), and both files are the same
        // `mcp.json`.
        enabled: value.disabled !== true && value.enabled !== false,
        hasAuth,
        launch: normalizeMcpServer(id, scope, transport, value, env),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Pi's exposures, with the older alias it still accepts. */
const PI_EXPOSURES: ReadonlySet<unknown> = new Set([
  "codemode",
  "deferred",
  "direct",
  "hidden",
  "codemode-deferred",
]);

/**
 * Pi's checks on the keys a server and an override share. Pi rejects an entry
 * that fails them, and does not apply an override that does.
 */
function validSharedFields(value: Record<string, unknown>): boolean {
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.exposure !== undefined && !PI_EXPOSURES.has(value.exposure)) return false;
  return (
    value.toolExposure === undefined ||
    (isObject(value.toolExposure) &&
      Object.values(value.toolExposure).every((exposure) => PI_EXPOSURES.has(exposure)))
  );
}

/**
 * The transport Pi's own validator (`validateMcpServerConfig` in
 * `core/mcp-servers.js`) reads an entry as, or `undefined` when Pi rejects the
 * entry. Two bridge extensions remain: a `transport` key spells the type, and
 * `sse` connects over Streamable HTTP (Pi rejects it). `oauth` is not checked:
 * the bridge never signs in.
 */
function acceptedTransport(value: Record<string, unknown>): McpTransport | undefined {
  if (!validSharedFields(value)) return undefined;
  if (value.description !== undefined && typeof value.description !== "string") return undefined;
  if (value.timeout !== undefined && (typeof value.timeout !== "number" || !(value.timeout > 0))) {
    return undefined;
  }
  const declared = typeof value.transport === "string" ? value.transport : value.type;
  if (
    typeof value.url === "string" &&
    (declared === undefined ||
      declared === "http" ||
      declared === "streamable-http" ||
      declared === "sse")
  ) {
    const url = httpUrl(value.url);
    if (!url) return undefined;
    if (value.headers !== undefined && !isStringRecord(value.headers)) return undefined;
    if (value.auth !== undefined) {
      if (!isObject(value.auth) || !nonEmptyString(value.auth.provider)) return undefined;
      if (url.protocol !== "https:" && !PI_LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    }
    return "http";
  }
  if (typeof value.command === "string" && (declared === undefined || declared === "stdio")) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
    ) {
      return undefined;
    }
    if (value.env !== undefined && !isStringRecord(value.env)) return undefined;
    if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
    return "stdio";
  }
  return undefined;
}

/** Hosts Pi lets `auth` reach over plain HTTP; URL.hostname retains IPv6 brackets. */
const PI_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Pi's MCP namespace: names that differ only in `-` and `_` are one server. */
function mcpNamespace(id: string): string {
  return id.replace(/-/g, "_");
}

/**
 * Merge user and project entries with Pi 1.0's rules (`extensions/mcp/config.js`):
 * a project server replaces the user server of the same name, an override
 * flips only its enabled state, and a server whose name clashes with another
 * in `-`/`_` is rejected. (`auth` in a project file was refused on load.)
 */
function mergeMcpConfigEntries(
  scopes: ReadonlyArray<{ scope: Exclude<McpScope, "orkestrator">; entries: McpConfigEntry[] }>,
): ResolvedMcpServer[] {
  const merged = new Map<string, { enabled: boolean; launch?: ResolvedMcpServer }>();
  for (const { entries } of scopes) {
    for (const entry of entries) {
      if (entry.kind === "override") {
        const base = merged.get(entry.id);
        if (base && entry.enabled !== undefined) base.enabled = entry.enabled;
        continue;
      }
      const namespace = mcpNamespace(entry.id);
      const clash = [...merged.keys()].some(
        (other) => other !== entry.id && mcpNamespace(other) === namespace,
      );
      if (clash) continue;
      // A Pi provider token is not something the bridge holds, so a user entry
      // that asks for one is kept (it can still be overridden) but not launched.
      const launch = entry.hasAuth ? undefined : entry.launch;
      merged.set(entry.id, { enabled: entry.enabled, ...(launch ? { launch } : {}) });
    }
  }
  const servers: ResolvedMcpServer[] = [];
  for (const { enabled, launch } of merged.values()) {
    if (enabled && launch) servers.push(launch);
  }
  return servers;
}

/**
 * Which configured (user or project) servers a session under `policy` may
 * start (graphs item 404): its `userMcpServers` selection minus its
 * `mcp:<server>` denials, matched on the id Pi gives a server (its name
 * sanitized the way `sanitizeMcpName` does, so `my.docs` and `my_docs` are
 * one server here as they are in Pi). `undefined` when the policy narrows
 * nothing, so an ordinary session starts every configured server.
 */
export function piUserMcpServerFilter(
  policy: NativeAgentExecutionPolicy | undefined,
): ((id: string) => boolean) | undefined {
  if (!nativeAgentRestrictsUserMcp(policy)) return undefined;
  const ids = (names: readonly string[]) =>
    new Set(names.map(sanitizeMcpName).filter((id): id is string => id !== undefined));
  const denied = ids(
    nativeAgentDeniedCapabilities(policy)
      .map(nativeAgentMcpServer)
      .filter((name): name is string => name !== undefined),
  );
  const grant = nativeAgentUserMcpGrant(policy);
  const granted = grant ? ids(grant) : undefined;
  return (id) => !denied.has(id) && (granted ? granted.has(id) : true);
}

export async function resolvePiMcpServers(input: {
  agentDir: string;
  cwd: string;
  projectResources: boolean;
  agentMcp?: AgentMcpConnection;
  env?: NodeJS.ProcessEnv;
  /** Which configured servers may start (`piUserMcpServerFilter`); all when absent. */
  allowServer?: (id: string) => boolean;
}): Promise<ResolvedMcpServer[]> {
  const env = input.env ?? process.env;
  const user = await loadMcpConfigFile(join(input.agentDir, "mcp.json"), "user", env);
  const project = input.projectResources
    ? await loadMcpConfigFile(join(input.cwd, ".pi", "mcp.json"), "project", env)
    : [];
  // A server outside the session's selection is never started, so none of
  // its tools is registered through the `orkestrator-mcp` extension.
  const fileServers = mergeMcpConfigEntries([
    { scope: "user", entries: user },
    { scope: "project", entries: project },
  ]).filter((server) => input.allowServer?.(server.id) ?? true);
  const orkestrator = orkestratorMcpServer(input.agentMcp, input.env);
  const artifacts = orkestratorArtifactMcpServer(input.agentMcp);
  const research = researchMcpServers(env);
  // The Orkestrator entries are reserved: they are inserted last so they win a
  // name collision, but the file scopes are truncated first so they are never
  // the entries `slice` discards. Without this, 64 user servers silently
  // disabled agent mail and coordinator delegation.
  const reserved = [orkestrator, artifacts, ...research].filter(
    (server): server is ResolvedMcpServer => server !== undefined,
  );
  const reservedNamespaces = new Set(research.map((server) => mcpNamespace(server.id)));
  const resolved = fileServers
    .filter(
      (server) =>
        server.id !== ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME &&
        !reservedNamespaces.has(mcpNamespace(server.id)),
    )
    .slice(0, MAX_MCP_SERVERS - reserved.length);
  resolved.push(...reserved);
  return resolved;
}

/**
 * The research servers a coordinator process was launched with.
 *
 * Read only under the coordinator's process authority: the launcher clears the
 * research variables for every other bridge, and a worker's read-only review
 * must not gain remote servers if one were inherited anyway.
 */
function researchMcpServers(env: NodeJS.ProcessEnv): ResolvedMcpServer[] {
  if (env[BRIDGE_EXECUTION_POLICY_ENV] !== "coordinator-read-only") return [];
  return coordinatorResearchMcpServersFromEnv(env).map((server) => ({
    id: server.name,
    scope: "research",
    transport: "http",
    url: server.url,
  }));
}

export function sanitizeMcpName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MCP_NAME_LENGTH) return undefined;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(sanitized) ? sanitized : undefined;
}

/**
 * The server the bridge starts for an entry Pi accepts as `transport`, or
 * `undefined` when it cannot start one.
 */
function normalizeMcpServer(
  id: string,
  scope: Exclude<McpScope, "orkestrator">,
  transport: McpTransport,
  value: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): ResolvedMcpServer | undefined {
  if (transport === "http") {
    const url = typeof value.url === "string" ? httpUrl(value.url) : undefined;
    if (!url) return undefined;
    // Keep the accepted entry shadowing, but never launch with its headers dropped.
    if (isStringRecord(value.headers) && Object.keys(value.headers).length > MAX_HEADER_ENTRIES)
      return undefined;
    const headers = isStringRecord(value.headers, MAX_HEADER_ENTRIES)
      ? resolveConfigValues(value.headers, env)
      : undefined;
    // A header that cannot be resolved would be sent as its literal template.
    if (headers === null) return undefined;
    return {
      id,
      scope,
      transport: "http",
      url: url.toString(),
      ...(headers ? { headers } : {}),
    };
  }
  if (!nonBlank(value.command) || typeof value.command !== "string") return undefined;
  if (isStringRecord(value.env) && Object.keys(value.env).length > MAX_ENV_ENTRIES)
    return undefined;
  const serverEnv = isStringRecord(value.env, MAX_ENV_ENTRIES)
    ? resolveConfigValues(value.env, env)
    : undefined;
  if (serverEnv === null) return undefined;
  return {
    id,
    scope,
    transport: "stdio",
    command: expandHome(value.command),
    ...(Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
      ? { args: value.args.slice(0, MAX_ARG_ENTRIES).map(expandHome) }
      : {}),
    ...(serverEnv ? { env: serverEnv } : {}),
    ...(nonBlank(value.cwd) && typeof value.cwd === "string" ? { cwd: expandHome(value.cwd) } : {}),
  };
}

/** `~` and `~/…` name the home directory, as Pi's MCP client reads them. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

const CONFIG_VALUE_REFERENCE =
  /\$(?:(\$)|(!)|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Resolve one `mcp.json` value the way Pi's own config values resolve:
 * `$NAME` and `${NAME}` read the environment, `$$` and `$!` escape a literal
 * `$` and `!`. A leading `!` means "run this shell command"; the bridge does not
 * execute config-supplied commands, so such a value is unresolvable, and so is
 * a variable that is unset or reserved for the bridge itself.
 */
function resolveConfigValue(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value.startsWith("!")) return undefined;
  let unresolved = false;
  const resolved = value.replace(
    CONFIG_VALUE_REFERENCE,
    (_match, dollar?: string, bang?: string, braced?: string, bare?: string) => {
      if (dollar) return "$";
      if (bang) return "!";
      const name = braced ?? bare ?? "";
      const replacement = BRIDGE_SECRET_ENV.has(name) ? undefined : env[name];
      if (replacement === undefined) {
        unresolved = true;
        return "";
      }
      return replacement;
    },
  );
  return unresolved ? undefined : resolved;
}

/** `null` when any value cannot be resolved: Pi skips such an entry and reports it. */
function resolveConfigValues(
  values: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> | null {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const next = resolveConfigValue(value, env);
    if (next === undefined) return null;
    resolved[key] = next;
  }
  return resolved;
}

function isStringRecord(
  value: unknown,
  maxEntries = Number.POSITIVE_INFINITY,
): value is Record<string, string> {
  return (
    isObject(value) &&
    Object.keys(value).length <= maxEntries &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
