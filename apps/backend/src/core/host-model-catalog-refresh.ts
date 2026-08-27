import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { existsSync, promises as fs } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { normalizeOpenCodeModelProviders } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import {
  resolveBunBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveManagedAcpBinary,
  resolveOpenCodeBinary,
} from "./commands-agent-support.js";
import {
  assertLocalServerStartAllowed,
  allocateLocalPort,
  fetchAcpNormalizedModelsAt,
  getBridgePath,
  HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
  waitForLocalServerStartup,
} from "./commands-servers.js";
import {
  bearerBridgeHeaders,
  claudeBridgeAuthHeaders,
  openCodeHealthHeaders,
} from "./commands-server-health.js";
import {
  isLocalServerShutdownRequested,
  localServerProcesses,
  spawnLocalServerCommandImpl,
  type LocalServerKind,
} from "./commands-runtime-state.js";
import { terminateLocalServerChild } from "./commands-local-server-lifecycle.js";
import { fetchClaudeBridgeModelCatalog } from "./commands-containers.js";
import { cursorSdkBridgeEnabled, cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";
import { discoverHostPiModelCatalog } from "./pi-model-catalog-seeding.js";
import { normalizeOpenCodeComposerCatalog } from "./opencode-model-catalog.js";
import { runCommand } from "./shell.js";
import {
  applyClaudeHostCredentialEnvironment,
  applyCursorHostCredentialEnvironment,
  resolveCursorHostCredentialMaterial,
} from "./host-agent-credentials.js";
import {
  APP_VERSION,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";

type RefreshableAgent = Extract<
  AgentPlatform,
  "claude" | "codex" | "opencode" | "cursor" | "grok" | "pi"
>;

export type HostCatalog =
  | { agent: "claude"; models: Awaited<ReturnType<typeof fetchClaudeBridgeModelCatalog>>["models"] }
  | { agent: "codex"; models: unknown[] }
  | { agent: "opencode"; models: AgentModel[] }
  | { agent: "cursor" | "grok" | "pi"; models: AgentModel[] };

type BridgeProbe = {
  kind: LocalServerKind;
  command: string;
  args: string[] | ((port: number) => string[]);
  cwd: string;
  env: NodeJS.ProcessEnv;
  token: string;
  headers: Record<string, string>;
};

const OPENCODE_PROVIDER_LIST_TIMEOUT_MS = 45_000;

type HostRefreshDependencies = {
  createOpenCodeClient: typeof createOpencodeClient;
  discoverPiModels: typeof discoverHostPiModelCatalog;
  fetchAcpModels: typeof fetchAcpNormalizedModelsAt;
  fetchClaudeCatalog: typeof fetchClaudeBridgeModelCatalog;
  openCodeProviderListTimeoutMs: number;
  runCommand: typeof runCommand;
};

const defaultDependencies: HostRefreshDependencies = {
  createOpenCodeClient: createOpencodeClient,
  discoverPiModels: discoverHostPiModelCatalog,
  fetchAcpModels: fetchAcpNormalizedModelsAt,
  fetchClaudeCatalog: fetchClaudeBridgeModelCatalog,
  openCodeProviderListTimeoutMs: OPENCODE_PROVIDER_LIST_TIMEOUT_MS,
  runCommand,
};

async function withShortLivedBridge<T>(
  probe: BridgeProbe,
  read: (port: number, token: string) => Promise<T>,
): Promise<T> {
  assertLocalServerStartAllowed(`catalog-refresh:${probe.kind}`);
  const port = await allocateLocalPort();
  const key = `${probe.kind}:catalog-refresh:${randomUUID()}`;
  const args = typeof probe.args === "function" ? probe.args(port) : probe.args;
  const child = spawnLocalServerCommandImpl(probe.command, args, {
    cwd: probe.cwd,
    env: { ...probe.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    detached: process.platform !== "win32",
  });
  localServerProcesses.set(key, child);
  child.stdout.resume();
  child.stderr.resume();
  try {
    if (isLocalServerShutdownRequested()) {
      throw new Error("Backend is shutting down; model catalogues cannot be refreshed");
    }
    await waitForLocalServerStartup(child, port, probe.kind, probe.headers);
    return await read(port, probe.token);
  } finally {
    await terminateLocalServerChild(key, child).catch((error: unknown) => {
      console.warn(
        `[ElectronBackend] The ${probe.kind} catalogue probe did not exit cleanly:`,
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }
}

function bridgeEntrypoint(context: CommandContext, name: Parameters<typeof getBridgePath>[1]) {
  const cwd = getBridgePath(context, name);
  const entrypoint = `${cwd}/dist/index.js`;
  if (!existsSync(cwd)) throw new Error(`${name} directory not found: ${cwd}`);
  if (!existsSync(entrypoint)) throw new Error(`${name} entrypoint not found: ${entrypoint}`);
  return { cwd, entrypoint };
}

async function probeWorkingDirectory(context: CommandContext): Promise<string> {
  const directory = path.join(context.storage.getDataDir(), "model-catalog-probe");
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function refreshClaude(
  context: CommandContext,
  dependencies: HostRefreshDependencies,
): Promise<HostCatalog> {
  const { cwd, entrypoint } = bridgeEntrypoint(context, "claude-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = randomBytes(32).toString("base64url");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CWD: workingDirectory,
    CLAUDE_BRIDGE_TOKEN: token,
    CLAUDE_CLI_PATH: resolveClaudeBinary(context),
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  await applyClaudeHostCredentialEnvironment(context, env);
  const catalog = await withShortLivedBridge(
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
  const { cwd, entrypoint } = bridgeEntrypoint(context, "codex-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = randomBytes(32).toString("base64url");
  const config = await context.storage.loadConfig();
  const models = await withShortLivedBridge(
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
  const useCursorSdk = agent === "cursor" && (await cursorSdkBridgeEnabled(context));
  const bridgeName = useCursorSdk ? "cursor-bridge" : "acp-bridge";
  const { cwd, entrypoint } = bridgeEntrypoint(context, bridgeName);
  const workingDirectory = await probeWorkingDirectory(context);
  const token = randomBytes(32).toString("base64url");
  const cursorCredentials =
    agent === "cursor" ? await resolveCursorHostCredentialMaterial(context) : undefined;
  const cursorApiKey = cursorCredentials?.apiKey;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CWD: workingDirectory,
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  if (useCursorSdk) {
    env.CURSOR_BRIDGE_TOKEN = token;
    env.CURSOR_BRIDGE_AUTH_FILE = cursorSdkCredentialPath(context);
    env.CURSOR_BRIDGE_PROJECT_SETTINGS = "0";
    if (cursorApiKey) env.CURSOR_API_KEY = cursorApiKey;
    else delete env.CURSOR_API_KEY;
  } else {
    const executable = resolveManagedAcpBinary(context, agent);
    if (!executable) {
      throw new Error(`${agent === "cursor" ? "Cursor Agent" : "Grok Build"} is not installed yet`);
    }
    env.ACP_BRIDGE_TOKEN = token;
    env.ACP_PROVIDER = agent;
    env.ACP_AGENT_PATH = executable;
    env.ACP_APPROVE_PROJECT_MCPS = "0";
    if (agent === "cursor") {
      await applyCursorHostCredentialEnvironment(context, env, cursorCredentials!);
    }
  }
  const models = await withShortLivedBridge(
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

async function refreshOpenCode(
  context: CommandContext,
  dependencies: HostRefreshDependencies,
): Promise<HostCatalog> {
  const cwd = await probeWorkingDirectory(context);
  const binary = resolveOpenCodeBinary(context);
  await dependencies.runCommand(binary, ["models", "--refresh"], { cwd, timeoutMs: 45_000 });
  const allowedProviders = normalizeOpenCodeModelProviders(
    (await context.storage.loadConfig()).global.openCodeModelProviders,
  );
  const token = randomBytes(32).toString("base64url");
  const headers = openCodeHealthHeaders(token);
  const models = await withShortLivedBridge(
    {
      kind: "opencode",
      command: binary,
      args: (port) => ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      cwd,
      token,
      headers,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: token,
        ORKESTRATOR_PARENT_PID: String(process.pid),
      },
    },
    async (port) => {
      const client = dependencies.createOpenCodeClient({
        baseUrl: `http://127.0.0.1:${port}`,
        directory: cwd,
        headers,
      });
      const response = await client.provider.list(
        {},
        { signal: AbortSignal.timeout(dependencies.openCodeProviderListTimeoutMs) },
      );
      return normalizeOpenCodeComposerCatalog(response.data ?? {}, [], {
        requireConnected: false,
        priorityProviders: allowedProviders,
      }).models;
    },
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
  OPENCODE_PROVIDER_LIST_TIMEOUT_MS,
};
