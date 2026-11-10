import { claudeModelCatalogUpdatedEvent } from "@orkestrator/protocol/contract/domains/events";
import {
  cacheOpencodeModelCatalogCommand,
  getClaudeModelCatalogCommand,
  getClaudeServerLogCommand,
  getClaudeServerStatusCommand,
  getCodexServerLogCommand,
  getCodexServerStatusCommand,
  getCursorServerLogCommand,
  getCursorServerStatusCommand,
  getGrokServerLogCommand,
  getGrokServerStatusCommand,
  getOpencodeModelCatalogCacheCommand,
  getOpencodeModelPreferencesCommand,
  getOpencodeServerLogCommand,
  getOpencodeServerStatusCommand,
  getPiServerLogCommand,
  getPiServerStatusCommand,
  startClaudeServerCommand,
  startCodexServerCommand,
  startCursorServerCommand,
  startGrokServerCommand,
  startOpencodeServerCommand,
  startPiServerCommand,
  stopClaudeServerCommand,
  stopCodexServerCommand,
  stopCursorServerCommand,
  stopGrokServerCommand,
  stopOpencodeServerCommand,
  stopPiServerCommand,
} from "@orkestrator/protocol/contract/domains/agent-servers";
import { bridgeDebugEnvValue } from "@orkestrator/protocol/log-policy";
import { containerBridgeOperationId } from "./container-bridge-operations.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type { LocalServerKind } from "./local-server-runtime.js";
import {
  boundedTailCommand,
  boundDiagnosticTail,
  bridgeLogEnvironmentExports,
  keepPreviousLogCommand,
  previousContainerLogFile,
} from "./container-log-bounds.js";
import { persistentStateExports } from "./container-state-layout.js";
import type {
  CommandRegistrar,
  CommandTarget,
  RegistryDependencies,
} from "./commands-registry-types.js";
import { registerTarget } from "./commands-registry-contracts.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  APP_SLUG,
  APP_VERSION,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  GROK_ACP_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  PI_BRIDGE_PORT,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";
import { ORKESTRATOR_AGENT_MCP_TOKEN_ENV, ORKESTRATOR_AGENT_MCP_URL_ENV } from "./agent-tools.js";
import { homePath, pathExists } from "./shell.js";
import {
  isSelectableOpenCodeProvider,
  normalizeOpenCodeModelProviders,
} from "@orkestrator/protocol/native-agent";
import type { ClaudeModelCatalogSnapshot } from "./models.js";
import {
  CONTAINER_CURSOR_SDK_AUTH_FILE,
  cursorSdkStoredApiKey,
  syncContainerCursorSdkCredentials,
} from "./cursor-sdk-bridge.js";
import {
  CONTAINER_CURSOR_API_KEY_FILE,
  CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE,
  CONTAINER_CURSOR_CREDENTIAL_DIR,
  asString,
  resolveCursorApiKey,
  cursorApiKeyFingerprint,
  asNonBlankString,
  asOpenCodeModelCatalog,
  quoteShell,
  getHostPort,
  dockerExec,
  resolveContainerAgentToolConnection,
  checkHttpHealth,
  waitForUnhealthy,
  enqueueContainerBridgeOperation,
  openCodeHealthHeaders,
  claudeBridgeAuthHeaders,
  agentToolConnectionFingerprint,
  syncContainerCursorApiKey,
  startContainerServer,
  startContainerOpenCodeServer,
  startContainerClaudeServer,
  isFreshClaudeModelCatalog,
  conciseError,
  refreshClaudeModelCatalog,
} from "./commands-helpers.js";
import { containerCredentialMode, containerOpenCodeMode } from "./container-credential-mode.js";
import {
  CONTAINER_TOKEN_FILES,
  containerBridgeLaunch,
  readContainerBridgeToken,
  removeContainerBridgeCredential,
  stopContainerBridgeProcess,
} from "./container-bridge-credential.js";
import {
  reconcileContainerAgentAccount,
  syncContainerClaudeLoginUnlocked,
  syncContainerLoginUnlocked,
  type ContainerBridgeControl,
} from "./agent-accounts-containers.js";

/**
 * Health and stop for one in-container bridge, as the account reconciliation
 * needs them. The bracketed pattern keeps pkill from matching its own shell.
 */
function containerBridgeControl(
  containerId: string,
  port: number,
  processPattern: string,
): ContainerBridgeControl {
  return {
    isRunning: async () => {
      const hostPort = await getHostPort(containerId, port);
      return Boolean(hostPort && (await checkHttpHealth(hostPort)));
    },
    stop: async () => {
      const hostPort = await getHostPort(containerId, port);
      await dockerExec(containerId, `pkill -f '${processPattern}' || true`);
      if (hostPort) await waitForUnhealthy(hostPort);
    },
  };
}

/** A stopped bridge's token is dead; if this fails, the next start overwrites it. */
function forgetContainerBridgeCredential(
  containerId: string,
  kind: LocalServerKind,
): Promise<void> {
  return removeContainerBridgeCredential(containerId, kind).catch(() => undefined);
}

/** Whether the environment that owns `containerId` has a turn of `agent` in flight. */
async function containerAgentHasLiveWork(
  context: CommandContext,
  containerId: string,
  agent: "cursor",
): Promise<boolean> {
  if (!context.nativeAgents) return false;
  const id = containerId.trim();
  const environment = (await context.storage.loadEnvironments()).find((candidate) => {
    const known = candidate.containerId?.trim();
    return Boolean(known && id && (known === id || known.startsWith(id) || id.startsWith(known)));
  });
  return environment
    ? (await context.nativeAgents.hasObservedLiveWork(environment.id, agent)) === true
    : false;
}

/**
 * Registers a command that starts a container bridge, or finds it running, and
 * resends the logging settings to it: its `ORKESTRATOR_BRIDGE_DEBUG` is only the
 * startup default, and it may have missed a change while it was down.
 */
export function containerBridgeStartRegistrar(register: CommandRegistrar) {
  return (target: CommandTarget, agent: LocalServerKind, handler: CommandHandler): void => {
    registerTarget(register, target, async (args, context, invocation) => {
      const started = (await handler(args, context, invocation)) as {
        hostPort?: number;
        authToken?: string;
      };
      if (started?.hostPort && started.authToken) {
        context.runtime.logPolicy?.bridgeStarted({
          agent,
          baseUrl: `http://127.0.0.1:${started.hostPort}`,
          authToken: started.authToken,
        });
      }
      return started;
    });
  };
}

/** The Cursor and Grok bridge commands, registered by one loop. */
const ACP_SERVER_COMMANDS = {
  cursor: {
    start: startCursorServerCommand,
    stop: stopCursorServerCommand,
    status: getCursorServerStatusCommand,
    log: getCursorServerLogCommand,
  },
  grok: {
    start: startGrokServerCommand,
    stop: stopGrokServerCommand,
    status: getGrokServerStatusCommand,
    log: getGrokServerLogCommand,
  },
} as const;

export function registerServerCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const registerBridgeStart = containerBridgeStartRegistrar(register);
  const { claudeModelCatalogRefreshes, validatedClaudeModelCatalogs, commands } = dependencies;
  register(startOpencodeServerCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const operationId = await containerBridgeOperationId(context, id);
    return enqueueContainerBridgeOperation(context, "opencode", operationId, async () => {
      await syncContainerLoginUnlocked(context, "opencode", id);
      const started = await startContainerOpenCodeServer(id, () =>
        containerOpenCodeMode(context, id),
      );
      const connection = await resolveContainerAgentToolConnection(context, id);
      if (connection) {
        context.runtime.localServers.openCodeAgentTools.schedule(
          `container:${id}`,
          started.hostPort,
          started.authToken,
          connection,
          "/workspace",
        );
      }
      return started;
    });
  });
  register(stopOpencodeServerCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const operationId = await containerBridgeOperationId(context, id);
    return enqueueContainerBridgeOperation(context, "opencode", operationId, () => {
      context.runtime.localServers.openCodeAgentTools.cancel(`container:${id}`);
      // Bracketing avoids matching the `bash -lc` shell carrying this command.
      return dockerExec(
        id,
        `pkill -f '[o]pencode serve' || true; rm -f ${CONTAINER_TOKEN_FILES.opencode}`,
      ).then(() => forgetContainerBridgeCredential(id, "opencode"));
    });
  });
  register(getOpencodeServerStatusCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, OPENCODE_SERVER_PORT);
    const authToken = hostPort ? await readContainerBridgeToken(id, "opencode") : null;
    const running =
      !!hostPort &&
      !!authToken &&
      (await checkHttpHealth(hostPort, "/global/health", openCodeHealthHeaders(authToken)));
    if (running && context.agentTools) {
      const connection = await resolveContainerAgentToolConnection(context, id);
      if (connection && hostPort && authToken) {
        context.runtime.localServers.openCodeAgentTools.schedule(
          `container:${id}`,
          hostPort,
          authToken,
          connection,
          "/workspace",
        );
      }
    }
    return {
      running,
      hostPort,
      ...(running ? { authToken } : {}),
      ...(running && context.agentTools
        ? { agentTools: context.runtime.localServers.openCodeAgentTools.state(`container:${id}`) }
        : {}),
    };
  });
  register(getOpencodeServerLogCommand, serverLogCommand("/tmp/opencode-serve.log"));
  register(getOpencodeModelPreferencesCommand, async (_args, context) => {
    if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("opencode")) {
      return { recent: [], favorite: [], variant: {} };
    }
    const modelPath = path.join(
      process.env.XDG_STATE_HOME?.trim() || homePath(".local", "state"),
      "opencode",
      "model.json",
    );
    if (!(await pathExists(modelPath))) return { recent: [], favorite: [], variant: {} };
    return JSON.parse(await fs.readFile(modelPath, "utf8"));
  });
  register(getOpencodeModelCatalogCacheCommand, async (args, { storage }) => {
    const snapshot = await storage.getOpenCodeModelCatalog(
      asNonBlankString(args.projectId, "projectId"),
    );
    if (!snapshot) return snapshot;
    // A cache written before the allowlist changed still holds the providers
    // the user has since excluded. Filter on read so the launch dialogs get
    // the same catalogue as the chat picker.
    const allowedProviders = normalizeOpenCodeModelProviders(
      (await storage.loadConfig()).global.openCodeModelProviders,
    );
    // The persisted connectivity can be stale, so a disconnected provider is
    // marked for the launch dialogs rather than hidden from them.
    const connected = snapshot.connectedProviderIds;
    return {
      ...snapshot,
      models: snapshot.models
        .filter((model) => isSelectableOpenCodeProvider(model.provider, allowedProviders))
        .map((model) =>
          connected && !connected.includes(model.provider) ? { ...model, connected: false } : model,
        ),
    };
  });
  register(cacheOpencodeModelCatalogCommand, (args, { storage }) => {
    return storage.cacheOpenCodeModelCatalog(
      asNonBlankString(args.projectId, "projectId"),
      asOpenCodeModelCatalog(args.models),
    );
  });
  registerBridgeStart(startClaudeServerCommand, "claude", async ({ containerId }, context) => {
    const id = await containerBridgeOperationId(context, asString(containerId, "containerId"));
    return enqueueContainerBridgeOperation(context, "claude", id, async () => {
      await reconcileContainerAgentAccount(
        context,
        id,
        "claude",
        containerBridgeControl(id, CLAUDE_BRIDGE_PORT, "[c]laude-bridge/dist/index.js"),
      );
      // The container's copy cannot refresh: hand it the host's current token.
      await syncContainerClaudeLoginUnlocked(context, id, { restrictWhenUnusable: true });
      const connection = await resolveContainerAgentToolConnection(context, id);
      const { global } = await context.storage.loadConfig();
      return startContainerClaudeServer(
        id,
        connection,
        bridgeDebugEnvValue(global) === "1",
        global.claudeBackgroundCommandLimitHours,
        () => containerCredentialMode(context, id),
      );
    });
  });
  register(stopClaudeServerCommand, ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation(context, "claude", id, () =>
      // The bracketed pattern keeps pkill from matching the `bash -lc` shell that
      // carries it, which would kill the shell before `rm -f` runs.
      dockerExec(
        id,
        "pkill -f '[c]laude-bridge/dist/index.js' || true; rm -f /tmp/claude-bridge-token /tmp/claude-agent-tools-fingerprint",
      ).then(() => forgetContainerBridgeCredential(id, "claude")),
    );
  });
  register(getClaudeServerStatusCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, CLAUDE_BRIDGE_PORT);
    const running = hostPort ? await checkHttpHealth(hostPort) : false;
    const persistedToken = running ? await readContainerBridgeToken(id, "claude") : null;
    const authToken =
      running &&
      persistedToken &&
      (await checkHttpHealth(
        hostPort!,
        "/global/auth-check",
        claudeBridgeAuthHeaders(persistedToken),
      ))
        ? persistedToken
        : "";
    if (running && authToken && context.agentTools) {
      const start = commands.get("start_claude_server");
      const reconciled = (await start?.({ containerId: id }, context)) as
        { hostPort: number; authToken: string } | undefined;
      if (reconciled) {
        return {
          running: true,
          hostPort: reconciled.hostPort,
          authToken: reconciled.authToken,
        };
      }
    }
    return {
      running,
      hostPort,
      ...(authToken ? { authToken } : {}),
    };
  });
  register(getClaudeServerLogCommand, serverLogCommand("/tmp/claude-bridge.log"));
  register(getClaudeModelCatalogCommand, async ({ environmentId, forceRefresh }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    const cached = environment.claudeModelCatalog;
    if (
      cached &&
      forceRefresh !== true &&
      validatedClaudeModelCatalogs.has(id) &&
      isFreshClaudeModelCatalog(cached)
    ) {
      return cached;
    }

    const existingRefresh = claudeModelCatalogRefreshes.get(id);
    if (existingRefresh) return existingRefresh;

    const refresh = refreshClaudeModelCatalog(id, context, undefined, forceRefresh === true)
      .then((snapshot) => {
        validatedClaudeModelCatalogs.add(id);
        return snapshot;
      })
      .catch(async (error): Promise<ClaudeModelCatalogSnapshot> => {
        if (!cached?.models.length) throw error;
        const stale: ClaudeModelCatalogSnapshot = {
          ...cached,
          source: "last-known-good",
          stale: true,
          error: conciseError(error),
        };
        await context.storage.updateEnvironment(id, {
          claudeModelCatalog: stale,
        });
        context.emit(claudeModelCatalogUpdatedEvent, stale);
        validatedClaudeModelCatalogs.add(id);
        return stale;
      })
      .finally(() => {
        if (claudeModelCatalogRefreshes.get(id) === refresh) {
          claudeModelCatalogRefreshes.delete(id);
        }
      });
    claudeModelCatalogRefreshes.set(id, refresh);
    return refresh;
  });
  registerBridgeStart(startCodexServerCommand, "codex", ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation(context, "codex", id, async () => {
      await reconcileContainerAgentAccount(
        context,
        id,
        "codex",
        containerBridgeControl(id, CODEX_BRIDGE_PORT, "[c]odex-bridge/dist/index.js"),
      );
      const config = await context.storage.loadConfig();
      const maxConcurrentThreads = resolveCodexMaxConcurrentThreads(
        config.global.codexMaxConcurrentThreads,
      );
      const agentToolConnection = await resolveContainerAgentToolConnection(context, id);
      const expectedAgentToolsFingerprint = agentToolConnection
        ? agentToolConnectionFingerprint(agentToolConnection)
        : null;
      const readPersistedToken = () => readContainerBridgeToken(id, "codex");
      const hasCurrentAgentTools = async (): Promise<boolean> => {
        if (!expectedAgentToolsFingerprint) return true;
        const persisted = (
          await dockerExec(id, "cat /tmp/codex-agent-tools-fingerprint 2>/dev/null || true")
        ).trim();
        return persisted === expectedAgentToolsFingerprint;
      };
      const replaceRunningBridge = async (port: number): Promise<void> => {
        await dockerExec(id, "pkill -f '[c]odex-bridge/dist/index.js' || true");
        await stopContainerBridgeProcess(id, "codex");
        await waitForUnhealthy(port);
      };
      const startWithFreshToken = async (): Promise<{
        hostPort: number;
        wasRunning: boolean;
        authToken: string;
      }> => {
        const credential = containerBridgeLaunch(
          "codex",
          await containerCredentialMode(context, id),
        );
        const authToken = credential.token;
        const started = await startContainerServer(
          id,
          CODEX_BRIDGE_PORT,
          "codex",
          `
          cd /workspace
          ${keepPreviousLogCommand("/tmp/codex-bridge.log")}
          mkdir -p /tmp/${APP_SLUG}
          umask 077
          ${credential.script}
          ${
            expectedAgentToolsFingerprint
              ? `printf '%s' ${quoteShell(expectedAgentToolsFingerprint)} > /tmp/codex-agent-tools-fingerprint`
              : "rm -f /tmp/codex-agent-tools-fingerprint"
          }
          source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
          orkestrator_source_runtime_env 2>/dev/null || true
          export PORT=${CODEX_BRIDGE_PORT}
          export HOSTNAME=0.0.0.0
          export CWD=/workspace
          export CODEX_PATH="$(command -v codex 2>/dev/null || echo codex)"
          export ORKESTRATOR_BRIDGE_DEBUG=${bridgeDebugEnvValue(config.global)}
          ${bridgeLogEnvironmentExports()}
          ${
            agentToolConnection
              ? `export ${ORKESTRATOR_AGENT_MCP_URL_ENV}=${quoteShell(agentToolConnection.url)}`
              : ""
          }
          export ${CODEX_MAX_CONCURRENT_THREADS_ENV}=${maxConcurrentThreads}
          export ORKESTRATOR_VERSION="${APP_VERSION}"
          ${persistentStateExports("codex")}
          ${credential.start("/opt/codex-bridge/dist/index.js", "/tmp/codex-bridge.log")}
        `,
          {
            ...credential.launch,
            secrets: {
              ...credential.launch.secrets,
              [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: agentToolConnection?.token,
            },
          },
        );
        return { ...started, authToken };
      };

      const hostPort = await getHostPort(id, CODEX_BRIDGE_PORT);
      if (hostPort && (await checkHttpHealth(hostPort))) {
        const persistedToken = await readPersistedToken();
        if (persistedToken && (await hasCurrentAgentTools())) {
          return { hostPort, wasRunning: true, authToken: persistedToken };
        }
        // A bridge from before per-process authentication cannot safely serve the
        // renderer. Replace it once, then persist the new token for later starts.
        await replaceRunningBridge(hostPort);
      }

      const started = await startWithFreshToken();
      if (!started.wasRunning) return started;
      // A bridge came up between the health check above and startContainerServer's
      // internal recheck (e.g. a prior start whose health wait timed out but whose
      // bridge arrived late). The fresh token was never written, so return the
      // token that bridge actually holds — or replace the bridge if it has none.
      const persistedToken = await readPersistedToken();
      if (persistedToken && (await hasCurrentAgentTools())) {
        return { ...started, authToken: persistedToken };
      }
      await replaceRunningBridge(started.hostPort);
      return startWithFreshToken();
    });
  });
  register(stopCodexServerCommand, ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation(context, "codex", id, () =>
      // The bracketed pattern keeps pkill from matching the `bash -lc` shell that
      // carries it, which would kill the shell before `rm -f` runs.
      dockerExec(
        id,
        "pkill -f '[c]odex-bridge/dist/index.js' || true; rm -f /tmp/codex-bridge-token /tmp/codex-agent-tools-fingerprint",
      ).then(() => forgetContainerBridgeCredential(id, "codex")),
    );
  });
  register(getCodexServerStatusCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, CODEX_BRIDGE_PORT);
    const running = hostPort ? await checkHttpHealth(hostPort) : false;
    const authToken = running ? await readContainerBridgeToken(id, "codex") : null;
    if (running && authToken && context.agentTools) {
      const start = commands.get("start_codex_server");
      const reconciled = (await start?.({ containerId: id }, context)) as
        { hostPort: number; authToken: string } | undefined;
      if (reconciled) {
        return {
          running: true,
          hostPort: reconciled.hostPort,
          authToken: reconciled.authToken,
        };
      }
    }
    return {
      running,
      hostPort,
      ...(authToken ? { authToken } : {}),
    };
  });
  register(getCodexServerLogCommand, serverLogCommand("/tmp/codex-bridge.log"));

  for (const provider of ["cursor", "grok"] as const) {
    const containerPort = provider === "cursor" ? CURSOR_BRIDGE_PORT : GROK_ACP_BRIDGE_PORT;
    const tokenFile =
      provider === "cursor" ? "/tmp/cursor-bridge-token" : "/tmp/grok-acp-bridge-token";
    const logFile = provider === "cursor" ? "/tmp/cursor-bridge.log" : "/tmp/grok-acp-bridge.log";
    const bridgePattern =
      provider === "cursor"
        ? "[c]ursor-bridge/dist/index.js"
        : "[a]cp-bridge/dist/index.js --provider=grok";
    registerBridgeStart(
      ACP_SERVER_COMMANDS[provider].start,
      provider,
      async ({ containerId }, context) => {
        const id = asString(containerId, "containerId");
        probeContainerAgentTools(context, id);
        const operationId =
          provider === "grok" ? await containerBridgeOperationId(context, id) : id;
        return enqueueContainerBridgeOperation(context, provider, operationId, async () => {
          const bridgeConfig = await context.storage.loadConfig();
          const cursorApiKey =
            provider === "cursor" ? resolveCursorApiKey(bridgeConfig.global).apiKey : undefined;
          const useCursorSdk = provider === "cursor";
          const expectedCredentialFingerprint =
            provider === "cursor" ? `sdk:${cursorApiKeyFingerprint(cursorApiKey)}` : undefined;
          if (provider === "cursor") {
            await syncContainerCursorApiKey(id, cursorApiKey);
            await syncContainerCursorSdkCredentials(id, await cursorSdkStoredApiKey(context));
          }
          if (provider === "grok") await syncContainerLoginUnlocked(context, "grok", id);
          const hostPort = await getHostPort(id, containerPort);
          if (hostPort && (await checkHttpHealth(hostPort))) {
            const credentialFingerprint =
              provider === "cursor"
                ? (
                    await dockerExec(
                      id,
                      `cat ${CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE} 2>/dev/null || true`,
                    )
                  ).trim()
                : undefined;
            const existingToken = await readContainerBridgeToken(id, provider);
            if (
              existingToken &&
              (provider !== "cursor" ||
                credentialFingerprint === expectedCredentialFingerprint ||
                // A changed key restarts the bridge, which would end a running
                // turn. A busy bridge keeps the key it started with, as a busy
                // Claude or Codex bridge keeps its account; the first start
                // after it goes idle applies the new one.
                (await containerAgentHasLiveWork(context, id, "cursor")))
            ) {
              return { hostPort, wasRunning: true, authToken: existingToken };
            }
            await dockerExec(id, `pkill -f '${bridgePattern}' || true`);
            await stopContainerBridgeProcess(id, provider);
            await waitForUnhealthy(hostPort);
          }
          const credential = containerBridgeLaunch(
            provider,
            await containerCredentialMode(context, id),
          );
          const token = credential.token;
          const started = await startContainerServer(
            id,
            containerPort,
            provider,
            `
          cd /workspace
          ${keepPreviousLogCommand(logFile)}
          umask 077
          ${credential.script}
          source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
          orkestrator_source_runtime_env 2>/dev/null || true
          export PORT=${containerPort}
          export HOSTNAME=0.0.0.0
          export CWD=/workspace
          export ORKESTRATOR_BRIDGE_DEBUG=${bridgeDebugEnvValue(bridgeConfig.global)}
          ${bridgeLogEnvironmentExports()}
          ${
            useCursorSdk
              ? `export CURSOR_BRIDGE_STATE_DIR=/tmp/orkestrator-cursor-sdk-state
          export CURSOR_BRIDGE_AUTH_FILE=${CONTAINER_CURSOR_SDK_AUTH_FILE}`
              : `if [ -s "$HOME/.grok/xai-api-key" ]; then export XAI_API_KEY="$(cat "$HOME/.grok/xai-api-key")"; else unset XAI_API_KEY; fi
          export ACP_PROVIDER=grok
          export ACP_STATE_DIR=/tmp/orkestrator-acp-state/grok
          export ACP_AGENT_PATH="$(command -v grok 2>/dev/null || echo grok)"
          export ACP_PROVIDER_CONFIG='{"id":"grok","name":"Grok","executable":"grok","argv":["--always-approve","agent","{{model}}","{{effort}}","stdio"],"env":{},"requiresAuthenticate":true,"authMethodEnv":"GROK_AUTH_METHOD_ID","modeMap":{"agent":"build","build":"build","plan":"plan","ask":"plan"},"extensionPrefixes":["x.ai/","_x.ai/"],"acknowledgedExtensionMethods":[],"modelUpdateMethods":["x.ai/models/update","_x.ai/models/update"],"sessionUpdateMethods":["x.ai/session/update","_x.ai/session/update"]}'`
          }
          ${
            provider === "cursor"
              ? `mkdir -p ${quoteShell(CONTAINER_CURSOR_CREDENTIAL_DIR)}
          if [ -s ${CONTAINER_CURSOR_API_KEY_FILE} ]; then export CURSOR_API_KEY="$(cat ${CONTAINER_CURSOR_API_KEY_FILE})"; else unset CURSOR_API_KEY; fi
          printf '%s' ${quoteShell(expectedCredentialFingerprint!)} > ${CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE}`
              : ""
          }
          ${
            useCursorSdk
              ? credential.start("/opt/cursor-bridge/dist/index.js", logFile)
              : credential.start("/opt/acp-bridge/dist/index.js --provider=grok", logFile)
          }
        `,
            credential.launch,
          );
          return { ...started, authToken: token };
        });
      },
    );
    register(ACP_SERVER_COMMANDS[provider].stop, async ({ containerId }, context) => {
      const id = asString(containerId, "containerId");
      const operationId = provider === "grok" ? await containerBridgeOperationId(context, id) : id;
      return enqueueContainerBridgeOperation(context, provider, operationId, () =>
        dockerExec(
          id,
          `pkill -f '${bridgePattern}' || true; rm -f ${tokenFile}` +
            (provider === "cursor"
              ? ` ${CONTAINER_CURSOR_API_KEY_FILE} ${CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE}` +
                ` ${CONTAINER_CURSOR_SDK_AUTH_FILE}`
              : ""),
        ).then(() => forgetContainerBridgeCredential(id, provider)),
      );
    });
    register(ACP_SERVER_COMMANDS[provider].status, async ({ containerId }) => {
      const id = asString(containerId, "containerId");
      const hostPort = await getHostPort(id, containerPort);
      const authToken = hostPort ? await readContainerBridgeToken(id, provider) : null;
      const running =
        !!hostPort && !!authToken && (await checkHttpHealth(hostPort, "/global/health"));
      return {
        running,
        hostPort,
        ...(running ? { authToken } : {}),
      };
    });
    register(ACP_SERVER_COMMANDS[provider].log, serverLogCommand(logFile));
  }

  registerPiServerCommands(register);
}

/**
 * A container server's log tail. `previous: true` reads the run before the last
 * relaunch instead, under the same bounds and redaction, and is empty when there
 * has been no relaunch.
 */
function serverLogCommand(
  logFile: string,
): (args: { readonly containerId: string; readonly previous?: unknown }) => Promise<string> {
  return ({ containerId, previous }) =>
    dockerExec(
      asString(containerId, "containerId"),
      boundedTailCommand(previous === true ? previousContainerLogFile(logFile) : logFile),
    ).then(boundDiagnosticTail);
}

/**
 * Cursor, Grok and Pi receive the agent tools connection per session rather
 * than at bridge start, so nothing on their start path repairs the container's
 * host alias or network policy or proves the tools server reachable. Do both
 * in the background: a blocked path is logged and raised in the app (the probe
 * re-runs the host check) without delaying or failing the bridge start.
 */
function probeContainerAgentTools(context: CommandContext, containerId: string): void {
  void context.containerHostReachability
    ?.checkEnvironmentContainer(containerId, { prepare: true, reason: "bridge-start" })
    .catch(() => undefined);
}

/**
 * The container-side Pi bridge.
 *
 * Structurally the same as the ACP bridges above — one prebuilt bridge under
 * `/opt`, a token file the backend reads back, a log file — but it is not part
 * of that loop because nothing about it is per-provider: Pi is one platform
 * with one executable. Its credentials are the user's own provider logins in
 * `~/.pi/agent/auth.json`, staged with the rest of `~/.pi` and pushed again,
 * access-only, before every start (`syncContainerLoginUnlocked`).
 */
function registerPiServerCommands(register: CommandRegistrar): void {
  const registerBridgeStart = containerBridgeStartRegistrar(register);
  const tokenFile = "/tmp/pi-bridge-token";
  const logFile = "/tmp/pi-bridge.log";
  const processPattern = "[p]i-bridge/dist/index.js";

  registerBridgeStart(startPiServerCommand, "pi", async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    probeContainerAgentTools(context, id);
    const operationId = await containerBridgeOperationId(context, id);
    return enqueueContainerBridgeOperation(context, "pi", operationId, async () => {
      await syncContainerLoginUnlocked(context, "pi", id);
      const config = await context.storage.loadConfig();
      const hostPort = await getHostPort(id, PI_BRIDGE_PORT);
      if (hostPort && (await checkHttpHealth(hostPort))) {
        const existingToken = await readContainerBridgeToken(id, "pi");
        if (existingToken) {
          return { hostPort, wasRunning: true, authToken: existingToken };
        }
        await dockerExec(id, `pkill -f '${processPattern}' || true`);
        await stopContainerBridgeProcess(id, "pi");
        await waitForUnhealthy(hostPort);
      }
      const credential = containerBridgeLaunch("pi", await containerCredentialMode(context, id));
      const token = credential.token;
      const started = await startContainerServer(
        id,
        PI_BRIDGE_PORT,
        "pi",
        `
          cd /workspace
          ${keepPreviousLogCommand(logFile)}
          umask 077
          ${credential.script}
          source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
          orkestrator_source_runtime_env 2>/dev/null || true
          export PORT=${PI_BRIDGE_PORT}
          export HOSTNAME=0.0.0.0
          export CWD=/workspace
          export PI_AGENT_DIR=/home/node/.pi/agent
          export PI_SESSION_DIR=/home/node/.pi/agent/sessions
          export PI_BRIDGE_STATE_DIR=/tmp/orkestrator-pi-state
          export ORKESTRATOR_BRIDGE_DEBUG=${bridgeDebugEnvValue(config.global)}
          ${bridgeLogEnvironmentExports()}
          ${credential.start("/opt/pi-bridge/dist/index.js", logFile)}
        `,
        credential.launch,
      );
      return { ...started, authToken: token };
    });
  });

  register(stopPiServerCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const operationId = await containerBridgeOperationId(context, id);
    return enqueueContainerBridgeOperation(context, "pi", operationId, () =>
      dockerExec(id, `pkill -f '${processPattern}' || true; rm -f ${tokenFile}`).then(() =>
        forgetContainerBridgeCredential(id, "pi"),
      ),
    );
  });

  register(getPiServerStatusCommand, async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, PI_BRIDGE_PORT);
    const authToken = hostPort ? await readContainerBridgeToken(id, "pi") : null;
    const running =
      !!hostPort && !!authToken && (await checkHttpHealth(hostPort, "/global/health"));
    return { running, hostPort, ...(running ? { authToken } : {}) };
  });

  register(getPiServerLogCommand, serverLogCommand(logFile));
}
