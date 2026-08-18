import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  fs,
  randomBytes,
  APP_SLUG,
  APP_VERSION,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_ACP_BRIDGE_PORT,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  GROK_ACP_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  resolveCodexMaxConcurrentThreads,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  homePath,
  pathExists,
  isSelectableOpenCodeProvider,
  normalizeOpenCodeModelProviders,
} from "./commands-dependencies.js";
import type { ClaudeModelCatalogSnapshot } from "./commands-dependencies.js";
import {
  BRIDGE_TOKEN_PATTERN,
  CONTAINER_CURSOR_API_KEY_FILE,
  CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE,
  CONTAINER_CURSOR_CREDENTIAL_DIR,
  asString,
  assertOnlyKeys,
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
  openCodeAgentToolsState,
  scheduleOpenCodeAgentToolsConfiguration,
  cancelOpenCodeAgentToolsConfiguration,
  syncContainerCursorApiKey,
  startContainerServer,
  startContainerOpenCodeServer,
  startContainerClaudeServer,
  isFreshClaudeModelCatalog,
  conciseError,
  refreshClaudeModelCatalog,
} from "./commands-helpers.js";

export function registerServerCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { claudeModelCatalogRefreshes, validatedClaudeModelCatalogs, commands } = dependencies;
  register("start_opencode_server", ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation("opencode", id, async () => {
      const started = await startContainerOpenCodeServer(id);
      const connection = await resolveContainerAgentToolConnection(context, id);
      if (connection) {
        scheduleOpenCodeAgentToolsConfiguration(
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
  register("stop_opencode_server", ({ containerId }) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation("opencode", id, () => {
      cancelOpenCodeAgentToolsConfiguration(`container:${id}`);
      // Bracketing avoids matching the `bash -lc` shell carrying this command.
      return dockerExec(
        id,
        "pkill -f '[o]pencode serve' || true; rm -f /tmp/opencode-server-password",
      ).then(() => undefined);
    });
  });
  register("get_opencode_server_status", async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, OPENCODE_SERVER_PORT);
    const authToken = hostPort
      ? (await dockerExec(id, "cat /tmp/opencode-server-password 2>/dev/null || true")).trim()
      : "";
    const running =
      !!hostPort &&
      BRIDGE_TOKEN_PATTERN.test(authToken) &&
      (await checkHttpHealth(hostPort, "/global/health", openCodeHealthHeaders(authToken)));
    if (running && context.agentTools) {
      const connection = await resolveContainerAgentToolConnection(context, id);
      if (connection && hostPort) {
        scheduleOpenCodeAgentToolsConfiguration(
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
        ? { agentTools: openCodeAgentToolsState(`container:${id}`) }
        : {}),
    };
  });
  register("get_opencode_server_log", ({ containerId }) =>
    dockerExec(
      asString(containerId, "containerId"),
      "cat /tmp/opencode-serve.log 2>/dev/null || true",
    ),
  );
  register("get_opencode_model_preferences", async (_args, context) => {
    if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("opencode")) {
      return { recent: [], favorite: [], variant: {} };
    }
    const modelPath = homePath(".local", "state", "opencode", "model.json");
    if (!(await pathExists(modelPath))) return { recent: [], favorite: [], variant: {} };
    return JSON.parse(await fs.readFile(modelPath, "utf8"));
  });
  register("get_opencode_model_catalog_cache", async (args, { storage }) => {
    assertOnlyKeys(args, ["projectId"], "arguments");
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
    return {
      ...snapshot,
      models: snapshot.models.filter((model) =>
        isSelectableOpenCodeProvider(model.provider, allowedProviders),
      ),
    };
  });
  register("cache_opencode_model_catalog", (args, { storage }) => {
    assertOnlyKeys(args, ["projectId", "models"], "arguments");
    return storage.cacheOpenCodeModelCatalog(
      asNonBlankString(args.projectId, "projectId"),
      asOpenCodeModelCatalog(args.models),
    );
  });
  register("start_claude_server", ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation("claude", id, async () => {
      const connection = await resolveContainerAgentToolConnection(context, id);
      return startContainerClaudeServer(id, connection);
    });
  });
  register("stop_claude_server", ({ containerId }) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation("claude", id, () =>
      // The bracketed pattern keeps pkill from matching the `bash -lc` shell that
      // carries it, which would kill the shell before `rm -f` runs.
      dockerExec(
        id,
        "pkill -f '[c]laude-bridge/dist/index.js' || true; rm -f /tmp/claude-bridge-token /tmp/claude-agent-tools-fingerprint",
      ).then(() => undefined),
    );
  });
  register("get_claude_server_status", async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, CLAUDE_BRIDGE_PORT);
    const running = hostPort ? await checkHttpHealth(hostPort) : false;
    const persistedToken = running
      ? (await dockerExec(id, "cat /tmp/claude-bridge-token 2>/dev/null || true")).trim()
      : "";
    const authToken =
      running &&
      BRIDGE_TOKEN_PATTERN.test(persistedToken) &&
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
        | { hostPort: number; authToken: string }
        | undefined;
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
  register("get_claude_server_log", ({ containerId }) =>
    dockerExec(
      asString(containerId, "containerId"),
      "cat /tmp/claude-bridge.log 2>/dev/null || true",
    ),
  );
  register("get_claude_model_catalog", async ({ environmentId, forceRefresh }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    const cached = environment.claudeModelCatalog;
    if (
      forceRefresh !== true &&
      validatedClaudeModelCatalogs.has(id) &&
      isFreshClaudeModelCatalog(cached)
    ) {
      return cached;
    }

    const existingRefresh = claudeModelCatalogRefreshes.get(id);
    if (existingRefresh) return existingRefresh;

    const refresh = refreshClaudeModelCatalog(id, context)
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
        context.emit("claude-model-catalog-updated", stale);
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
  register("start_codex_server", ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation("codex", id, async () => {
      const config = await context.storage.loadConfig();
      const maxConcurrentThreads = resolveCodexMaxConcurrentThreads(
        config.global.codexMaxConcurrentThreads,
      );
      const agentToolConnection = await resolveContainerAgentToolConnection(context, id);
      const expectedAgentToolsFingerprint = agentToolConnection
        ? agentToolConnectionFingerprint(agentToolConnection)
        : null;
      const readPersistedToken = async (): Promise<string | null> => {
        const persistedToken = (
          await dockerExec(id, "cat /tmp/codex-bridge-token 2>/dev/null || true")
        ).trim();
        return BRIDGE_TOKEN_PATTERN.test(persistedToken) ? persistedToken : null;
      };
      const hasCurrentAgentTools = async (): Promise<boolean> => {
        if (!expectedAgentToolsFingerprint) return true;
        const persisted = (
          await dockerExec(id, "cat /tmp/codex-agent-tools-fingerprint 2>/dev/null || true")
        ).trim();
        return persisted === expectedAgentToolsFingerprint;
      };
      const replaceRunningBridge = async (port: number): Promise<void> => {
        await dockerExec(id, "pkill -f '[c]odex-bridge/dist/index.js' || true");
        await waitForUnhealthy(port);
      };
      const startWithFreshToken = async (): Promise<{
        hostPort: number;
        wasRunning: boolean;
        authToken: string;
      }> => {
        const authToken = randomBytes(32).toString("base64url");
        const started = await startContainerServer(
          id,
          CODEX_BRIDGE_PORT,
          "codex",
          `
          cd /workspace
          rm -f /tmp/codex-bridge.log
          mkdir -p /tmp/${APP_SLUG}
          umask 077
          printf '%s' ${quoteShell(authToken)} > /tmp/codex-bridge-token
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
          export CODEX_BRIDGE_TOKEN=${quoteShell(authToken)}
          ${
            agentToolConnection
              ? `export ${ORKESTRATOR_AGENT_MCP_URL_ENV}=${quoteShell(agentToolConnection.url)}
          export ${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}=${quoteShell(agentToolConnection.token)}`
              : ""
          }
          export ${CODEX_MAX_CONCURRENT_THREADS_ENV}=${maxConcurrentThreads}
          export ORKESTRATOR_VERSION="${APP_VERSION}"
          setsid bun /opt/codex-bridge/dist/index.js > /tmp/codex-bridge.log 2>&1 &
        `,
          [authToken, agentToolConnection?.token],
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
  register("stop_codex_server", ({ containerId }) => {
    const id = asString(containerId, "containerId");
    return enqueueContainerBridgeOperation("codex", id, () =>
      // The bracketed pattern keeps pkill from matching the `bash -lc` shell that
      // carries it, which would kill the shell before `rm -f` runs.
      dockerExec(
        id,
        "pkill -f '[c]odex-bridge/dist/index.js' || true; rm -f /tmp/codex-bridge-token /tmp/codex-agent-tools-fingerprint",
      ).then(() => undefined),
    );
  });
  register("get_codex_server_status", async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, CODEX_BRIDGE_PORT);
    const running = hostPort ? await checkHttpHealth(hostPort) : false;
    const authToken = running
      ? (await dockerExec(id, "cat /tmp/codex-bridge-token 2>/dev/null || true")).trim()
      : "";
    if (running && BRIDGE_TOKEN_PATTERN.test(authToken) && context.agentTools) {
      const start = commands.get("start_codex_server");
      const reconciled = (await start?.({ containerId: id }, context)) as
        | { hostPort: number; authToken: string }
        | undefined;
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
      ...(BRIDGE_TOKEN_PATTERN.test(authToken) ? { authToken } : {}),
    };
  });
  register("get_codex_server_log", ({ containerId }) =>
    dockerExec(
      asString(containerId, "containerId"),
      "cat /tmp/codex-bridge.log 2>/dev/null || true",
    ),
  );

  for (const acpProvider of ["cursor", "grok"] as const) {
    const containerPort = acpProvider === "cursor" ? CURSOR_ACP_BRIDGE_PORT : GROK_ACP_BRIDGE_PORT;
    const acpExecutable = acpProvider === "cursor" ? "cursor-agent" : "grok";
    const tokenFile = `/tmp/${acpProvider}-acp-bridge-token`;
    const logFile = `/tmp/${acpProvider}-acp-bridge.log`;
    register(`start_${acpProvider}_server`, ({ containerId }, context) => {
      const id = asString(containerId, "containerId");
      return enqueueContainerBridgeOperation(acpProvider, id, async () => {
        const cursorApiKey =
          acpProvider === "cursor"
            ? resolveCursorApiKey((await context.storage.loadConfig()).global).apiKey
            : undefined;
        const expectedCredentialFingerprint =
          acpProvider === "cursor" ? cursorApiKeyFingerprint(cursorApiKey) : undefined;
        if (acpProvider === "cursor") {
          await syncContainerCursorApiKey(id, cursorApiKey);
        }
        const hostPort = await getHostPort(id, containerPort);
        if (hostPort && (await checkHttpHealth(hostPort))) {
          const credentialFingerprint =
            acpProvider === "cursor"
              ? (
                  await dockerExec(
                    id,
                    `cat ${CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE} 2>/dev/null || true`,
                  )
                ).trim()
              : undefined;
          const existingToken = (
            await dockerExec(id, `cat ${tokenFile} 2>/dev/null || true`)
          ).trim();
          if (
            BRIDGE_TOKEN_PATTERN.test(existingToken) &&
            (acpProvider !== "cursor" || credentialFingerprint === expectedCredentialFingerprint)
          ) {
            return { hostPort, wasRunning: true, authToken: existingToken };
          }
          await dockerExec(
            id,
            `pkill -f '[a]cp-bridge/dist/index.js --provider=${acpProvider}' || true`,
          );
          await waitForUnhealthy(hostPort);
        }
        const token = randomBytes(32).toString("base64url");
        const started = await startContainerServer(
          id,
          containerPort,
          acpProvider,
          `
          cd /workspace
          rm -f ${logFile}
          umask 077
          printf '%s' ${quoteShell(token)} > ${tokenFile}
          source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
          orkestrator_source_runtime_env 2>/dev/null || true
          export PORT=${containerPort}
          export HOSTNAME=0.0.0.0
          export CWD=/workspace
          export ACP_PROVIDER=${acpProvider}
          export ACP_STATE_DIR=/tmp/orkestrator-acp-state/${acpProvider}
          ${acpProvider === "cursor" ? "export ACP_APPROVE_PROJECT_MCPS=1" : ""}
          export ACP_AGENT_PATH="$(command -v ${acpExecutable} 2>/dev/null || echo ${acpExecutable})"
          export ACP_BRIDGE_TOKEN=${quoteShell(token)}
          ${
            acpProvider === "cursor"
              ? `mkdir -p ${quoteShell(CONTAINER_CURSOR_CREDENTIAL_DIR)}
          if [ -s ${CONTAINER_CURSOR_API_KEY_FILE} ]; then export CURSOR_API_KEY="$(cat ${CONTAINER_CURSOR_API_KEY_FILE})"; else unset CURSOR_API_KEY; fi
          printf '%s' ${quoteShell(expectedCredentialFingerprint!)} > ${CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE}`
              : ""
          }
          setsid bun /opt/acp-bridge/dist/index.js --provider=${acpProvider} > ${logFile} 2>&1 &
        `,
          [token],
        );
        return { ...started, authToken: token };
      });
    });
    register(`stop_${acpProvider}_server`, ({ containerId }) => {
      const id = asString(containerId, "containerId");
      return enqueueContainerBridgeOperation(acpProvider, id, () =>
        dockerExec(
          id,
          `pkill -f '[a]cp-bridge/dist/index.js --provider=${acpProvider}' || true; rm -f ${tokenFile}` +
            (acpProvider === "cursor"
              ? ` ${CONTAINER_CURSOR_API_KEY_FILE} ${CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE}`
              : ""),
        ).then(() => undefined),
      );
    });
    register(`get_${acpProvider}_server_status`, async ({ containerId }) => {
      const id = asString(containerId, "containerId");
      const hostPort = await getHostPort(id, containerPort);
      const authToken = hostPort
        ? (await dockerExec(id, `cat ${tokenFile} 2>/dev/null || true`)).trim()
        : "";
      const running =
        !!hostPort &&
        BRIDGE_TOKEN_PATTERN.test(authToken) &&
        (await checkHttpHealth(hostPort, "/global/health"));
      return {
        running,
        hostPort,
        ...(running ? { authToken } : {}),
      };
    });
    register(`get_${acpProvider}_server_log`, ({ containerId }) =>
      dockerExec(asString(containerId, "containerId"), `cat ${logFile} 2>/dev/null || true`),
    );
  }
}
