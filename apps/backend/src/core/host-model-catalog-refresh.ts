import { bridgeDebugEnvValue } from "@orkestrator/protocol/log-policy";
import { CLAUDE_PINNED_RUNTIME_ENV } from "@orkestrator/protocol/terminal-agent-launch";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { normalizeOpenCodeModelProviders } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import {
  resolveBunBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveManagedAcpBinary,
} from "./commands-agent-support.js";
import {
  allocateLocalPort,
  fetchAcpNormalizedModelsAt,
  type BridgeName,
  HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
  prepareBridgePath,
  waitForLocalServerStartup,
} from "./commands-servers.js";
import { bearerBridgeHeaders, claudeBridgeAuthHeaders } from "./commands-server-health.js";
import type { LocalServerKind, LocalServerRuntime } from "./local-server-runtime.js";
import { fetchClaudeBridgeModelCatalog } from "./commands-containers.js";
import { cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";
import { discoverHostPiModelCatalog } from "./pi-model-catalog-seeding.js";
import { readOpenCode2ModelCatalogue } from "./opencode2/index.js";
import {
  probeWorkingDirectory,
  withOpenCode2HostDatabaseServer,
} from "./opencode2-host-database-server.js";
import {
  applyClaudeHostCredentialEnvironment,
  resolveCursorHostCredentialMaterial,
} from "./host-agent-credentials.js";
import {
  APP_VERSION,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("models");

type RefreshableAgent = Extract<
  AgentPlatform,
  "claude" | "codex" | "opencode" | "cursor" | "grok" | "pi"
>;

export type HostCatalog =
  | { agent: "claude"; models: Awaited<ReturnType<typeof fetchClaudeBridgeModelCatalog>>["models"] }
  | { agent: "codex"; models: unknown[] }
  | { agent: "opencode"; models: AgentModel[] }
  | { agent: "cursor" | "grok" | "pi"; models: AgentModel[] };

export type BridgeProbe = {
  kind: LocalServerKind;
  command: string;
  args: string[] | ((port: number) => string[]);
  cwd: string;
  env: NodeJS.ProcessEnv;
  token: string;
  headers: Record<string, string>;
};

const OPENCODE_MODEL_LIST_TIMEOUT_MS = 45_000;

type HostRefreshDependencies = {
  discoverPiModels: typeof discoverHostPiModelCatalog;
  fetchAcpModels: typeof fetchAcpNormalizedModelsAt;
  fetchClaudeCatalog: typeof fetchClaudeBridgeModelCatalog;
  openCodeModelListTimeoutMs: number;
  /** A 2.x server on the host OpenCode 2.x database (`opencode2-host-database-server.ts`). */
  withOpenCode2Server: typeof withOpenCode2HostDatabaseServer;
};

const defaultDependencies: HostRefreshDependencies = {
  discoverPiModels: discoverHostPiModelCatalog,
  fetchAcpModels: fetchAcpNormalizedModelsAt,
  fetchClaudeCatalog: fetchClaudeBridgeModelCatalog,
  openCodeModelListTimeoutMs: OPENCODE_MODEL_LIST_TIMEOUT_MS,
  withOpenCode2Server: withOpenCode2HostDatabaseServer,
};

/** A probe key is never an environment id, so only the shutdown gate applies. */
function assertProbeStartAllowed(localServers: LocalServerRuntime): void {
  if (localServers.isShuttingDown()) {
    throw new Error("Backend is shutting down; local servers cannot be started");
  }
}

export async function withShortLivedBridge<T>(
  localServers: LocalServerRuntime,
  probe: BridgeProbe,
  read: (port: number, token: string) => Promise<T>,
): Promise<T> {
  assertProbeStartAllowed(localServers);
  const port = await allocateLocalPort();
  const key = `${probe.kind}:catalog-refresh:${randomUUID()}`;
  const args = typeof probe.args === "function" ? probe.args(port) : probe.args;
  // Shutdown may have begun while a port was found.
  assertProbeStartAllowed(localServers);
  const child = localServers.spawn(probe.command, args, {
    cwd: probe.cwd,
    env: { ...probe.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    detached: process.platform !== "win32",
  });
  localServers.adoptProcess(key, child);
  child.stdout.resume();
  child.stderr.resume();
  try {
    if (localServers.isShuttingDown()) {
      throw new Error("Backend is shutting down; model catalogues cannot be refreshed");
    }
    await waitForLocalServerStartup(child, port, probe.kind, probe.headers);
    return await read(port, probe.token);
  } finally {
    await localServers.terminate(key, child).catch((error: unknown) => {
      log.warn("probe.exit-unclean", { kind: probe.kind, error: formatLogError(error) });
    });
  }
}

export async function bridgeEntrypoint(context: CommandContext, name: BridgeName) {
  const cwd = await prepareBridgePath(context, name);
  const entrypoint = `${cwd}/dist/index.js`;
  if (!existsSync(cwd)) throw new Error(`${name} directory not found: ${cwd}`);
  if (!existsSync(entrypoint)) throw new Error(`${name} entrypoint not found: ${entrypoint}`);
  return { cwd, entrypoint };
}

export { probeWorkingDirectory };

async function refreshClaude(
  context: CommandContext,
  dependencies: HostRefreshDependencies,
): Promise<HostCatalog> {
  const { cwd, entrypoint } = await bridgeEntrypoint(context, "claude-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = mintBridgeToken();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CWD: workingDirectory,
    CLAUDE_BRIDGE_TOKEN: token,
    CLAUDE_CLI_PATH: resolveClaudeBinary(context),
    ...(resolveClaudeBinary(context) !== "claude" ? CLAUDE_PINNED_RUNTIME_ENV : {}),
    ORKESTRATOR_PARENT_PID: String(process.pid),
    ORKESTRATOR_BRIDGE_DEBUG: bridgeDebugEnvValue((await context.storage.loadConfig()).global),
  };
  await applyClaudeHostCredentialEnvironment(context, env);
  const catalog = await withShortLivedBridge(
    context.runtime.localServers,
    {
      kind: "claude",
      command: resolveBunBinary(context),
      args: [entrypoint],
      cwd,
      token,
      headers: claudeBridgeAuthHeaders(token),
      env,
    },
    (port, authToken) => dependencies.fetchClaudeCatalog(port, authToken),
  );
  if (catalog.source !== "sdk") {
    throw new Error("Claude model discovery fell back to its bundled catalogue");
  }
  return { agent: "claude", models: catalog.models };
}

async function refreshCodex(context: CommandContext): Promise<HostCatalog> {
  const { cwd, entrypoint } = await bridgeEntrypoint(context, "codex-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = mintBridgeToken();
  const config = await context.storage.loadConfig();
  const models = await withShortLivedBridge(
    context.runtime.localServers,
    {
      kind: "codex",
      command: resolveBunBinary(context),
      args: [entrypoint],
      cwd,
      token,
      headers: bearerBridgeHeaders(token),
      env: {
        ...process.env,
        CWD: workingDirectory,
        CODEX_BRIDGE_TOKEN: token,
        CODEX_PATH: resolveCodexBinary(context),
        [CODEX_MAX_CONCURRENT_THREADS_ENV]: String(
          resolveCodexMaxConcurrentThreads(config.global.codexMaxConcurrentThreads),
        ),
        ORKESTRATOR_VERSION: APP_VERSION,
        ORKESTRATOR_PARENT_PID: String(process.pid),
        ORKESTRATOR_BRIDGE_DEBUG: bridgeDebugEnvValue((await context.storage.loadConfig()).global),
      },
    },
    async (port, authToken) => {
      const response = await fetch(`http://127.0.0.1:${port}/global/models`, {
        headers: bearerBridgeHeaders(authToken),
        signal: AbortSignal.timeout(35_000),
      });
      if (!response.ok)
        throw new Error(`Codex model discovery failed with HTTP ${response.status}`);
      const body = (await response.json()) as { models?: unknown; source?: unknown };
      if (!Array.isArray(body.models) || body.models.length === 0) {
        throw new Error("Codex returned an empty model catalogue");
      }
      if (body.source !== "app-server") {
        throw new Error("Codex model discovery did not return a live app-server catalogue");
      }
      return body.models;
    },
  );
  return { agent: "codex", models };
}

async function refreshAcp(
  context: CommandContext,
  agent: "cursor" | "grok",
  dependencies: HostRefreshDependencies,
): Promise<HostCatalog> {
  const useCursorSdk = agent === "cursor";
  const bridgeName = useCursorSdk ? "cursor-bridge" : "acp-bridge";
  const { cwd, entrypoint } = await bridgeEntrypoint(context, bridgeName);
  const workingDirectory = await probeWorkingDirectory(context);
  const token = mintBridgeToken();
  const cursorCredentials =
    agent === "cursor" ? await resolveCursorHostCredentialMaterial(context) : undefined;
  const cursorApiKey = cursorCredentials?.apiKey;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CWD: workingDirectory,
    ORKESTRATOR_PARENT_PID: String(process.pid),
    ORKESTRATOR_BRIDGE_DEBUG: bridgeDebugEnvValue((await context.storage.loadConfig()).global),
  };
  if (useCursorSdk) {
    env.CURSOR_BRIDGE_TOKEN = token;
    env.CURSOR_BRIDGE_AUTH_FILE = cursorSdkCredentialPath(context);
    if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
    else delete env.CURSOR_API_KEY;
  } else {
    const executable = resolveManagedAcpBinary(context, "grok");
    if (!executable) {
      throw new Error("Grok Build is not installed yet");
    }
    env.ACP_BRIDGE_TOKEN = token;
    env.ACP_PROVIDER = agent;
    env.ACP_AGENT_PATH = executable;
    env.ACP_PROVIDER_CONFIG = JSON.stringify({
      id: agent,
      name: "Grok",
      executable,
      argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
      env: {},
      requiresAuthenticate: true,
      authMethodEnv: "GROK_AUTH_METHOD_ID",
      modeMap: { agent: "build", build: "build", plan: "plan", ask: "plan" },
      extensionPrefixes: ["x.ai/", "_x.ai/"],
      acknowledgedExtensionMethods: [],
      modelUpdateMethods: ["x.ai/models/update", "_x.ai/models/update"],
      sessionUpdateMethods: ["x.ai/session/update", "_x.ai/session/update"],
    });
  }
  const models = await withShortLivedBridge(
    context.runtime.localServers,
    {
      kind: agent,
      command: resolveBunBinary(context),
      args: [entrypoint],
      cwd,
      token,
      headers: bearerBridgeHeaders(token),
      env,
    },
    (port, authToken) =>
      dependencies.fetchAcpModels(
        port,
        authToken,
        agent,
        HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
        HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
      ),
  );
  if (models.length === 0) throw new Error(`${agent} returned an empty model catalogue`);
  return { agent, models };
}

/**
 * The host OpenCode catalogue, from a 2.x server on the host 2.x database
 * (a running host server, else a private one): every model of every provider
 * the host is signed in to (2.x lists no other). It is not narrowed by the
 * allowlist, so a later allowlist change is served from it, but the
 * allowlisted providers are listed first so none is crowded out by the cap.
 */
async function refreshOpenCode(
  context: CommandContext,
  dependencies: HostRefreshDependencies,
): Promise<HostCatalog> {
  const allowedProviders = normalizeOpenCodeModelProviders(
    (await context.storage.loadConfig()).global.openCodeModelProviders,
  );
  const { models } = await dependencies.withOpenCode2Server(context, (client) =>
    readOpenCode2ModelCatalogue(
      client,
      [],
      AbortSignal.timeout(dependencies.openCodeModelListTimeoutMs),
      { priorityProviders: allowedProviders },
    ),
  );
  if (models.length === 0) throw new Error("OpenCode returned an empty model catalogue");
  return { agent: "opencode", models };
}

export type HostModelCatalogRefresher = (
  context: CommandContext,
  agent: RefreshableAgent,
) => Promise<HostCatalog>;

function createHostModelCatalogRefresher(
  overrides: Partial<HostRefreshDependencies> = {},
): HostModelCatalogRefresher {
  const dependencies = { ...defaultDependencies, ...overrides };
  const flights = new Map<RefreshableAgent, Promise<HostCatalog>>();
  return (context, agent) => {
    const existing = flights.get(agent);
    if (existing) return existing;
    const refresh = (async () => {
      if (agent === "claude") return refreshClaude(context, dependencies);
      if (agent === "codex") return refreshCodex(context);
      if (agent === "cursor" || agent === "grok") {
        return refreshAcp(context, agent, dependencies);
      }
      if (agent === "pi") {
        const models = await dependencies.discoverPiModels(context, true);
        if (models.length === 0) throw new Error("Pi returned an empty model catalogue");
        return { agent, models };
      }
      return refreshOpenCode(context, dependencies);
    })().finally(() => {
      if (flights.get(agent) === refresh) flights.delete(agent);
    });
    flights.set(agent, refresh);
    return refresh;
  };
}

export const refreshHostModelCatalog = createHostModelCatalogRefresher();

export const __testing = {
  createHostModelCatalogRefresher,
  OPENCODE_MODEL_LIST_TIMEOUT_MS,
};
