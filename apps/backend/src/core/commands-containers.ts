import { os, path, randomBytes, CLAUDE_BRIDGE_PORT, CODEX_BRIDGE_PORT, CURSOR_ACP_BRIDGE_PORT, DOCKER_IMAGE, DOCKER_LABEL_APP, DOCKER_LABEL_APP_VALUE, DOCKER_LABEL_ENVIRONMENT_ID, DOCKER_LABEL_ENVIRONMENT_NAME, DOCKER_LABEL_OWNER, DOCKER_LABEL_PROJECT_ID, GROK_ACP_BRIDGE_PORT, OPENCODE_SERVER_PORT, requiredAgentNetworkDomains, dockerContainerRuntimeName, dockerOwnerNamespace, defaultRepositoryConfig, ORKESTRATOR_AGENT_MCP_TOKEN_ENV, ORKESTRATOR_AGENT_MCP_URL_ENV, pathExists, runCommand } from "./commands-dependencies.js";
import type { Environment, ClaudeEffortLevel, ClaudeModelCatalogEntry, ClaudeModelCatalogSnapshot, AgentToolConnection } from "./commands-dependencies.js";
import { BRIDGE_TOKEN_PATTERN, retryableBridgeStartupError, CLAUDE_MODEL_CATALOG_TTL_MS, CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS, CONTAINER_GITHUB_CREDENTIAL_FILE, CLAUDE_GITHUB_CREDENTIAL_FILE_ENV, CLAUDE_GITHUB_ENV_FINGERPRINT_FILE, CLAUDE_GITHUB_ENV_FINGERPRINT, OPENCODE_GITHUB_ENV_PLUGIN_PATH, OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE, OPENCODE_GITHUB_ENV_PLUGIN_SOURCE, OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT } from "./commands-runtime-state.js";
import { resolveAnthropicApiKey, resolveCursorApiKey } from "./commands-validation.js";
import { quoteShell } from "./commands-agent-support.js";
import { invalidateDockerContainerStateCache, isContainerRunning, getHostPort, shouldAddDockerHostGatewayAlias } from "./commands-container-exec.js";
import { normalizeConfiguredProjectFiles, stageConfiguredProjectFilesForContainer } from "./commands-project-files.js";
import { dockerExec } from "./commands-container-exec.js";
import { dockerExecDetached, checkHttpHealth, isHttpServerReachable, waitForHealth, waitForLocalServerHealth, waitForHttpServerExit, waitForUnhealthy, openCodeHealthHeaders, claudeBridgeAuthHeaders, agentToolConnectionFingerprint } from "./commands-server-health.js";
import type { LocalServerKind } from "./commands-runtime-state.js";
import type { CommandContext } from "./commands-context.js";

export async function createDockerContainer(environment: Environment, context: CommandContext): Promise<string> {
  const project = await context.storage.getProject(environment.projectId);
  if (!project) throw new Error(`Project not found: ${environment.projectId}`);
  const config = await context.storage.loadConfig();
  const repoConfig = config.repositories[project.id] ?? defaultRepositoryConfig();
  const configuredFilesToCopy = normalizeConfiguredProjectFiles(repoConfig.filesToCopy);
  if (configuredFilesToCopy.length > 0 && !project.localPath) {
    throw new Error("Project has files configured to copy, but no local path is set");
  }
  const dockerOwner = dockerOwnerNamespace(context.storage.getDataDir());
  const args = [
    "create",
    "--name",
    dockerContainerRuntimeName(dockerOwner, environment.id),
    "--label",
    `${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
    "--label",
    `${DOCKER_LABEL_ENVIRONMENT_ID}=${environment.id}`,
    // Creation-time name only: Docker cannot relabel an existing container, so a
    // rename leaves this stale until the container is recreated. Readers resolve
    // the environment id above first and reach for this only for a true orphan.
    "--label",
    `${DOCKER_LABEL_ENVIRONMENT_NAME}=${environment.name}`,
    "--label",
    `${DOCKER_LABEL_OWNER}=${dockerOwner}`,
    "--label",
    `${DOCKER_LABEL_PROJECT_ID}=${project.id}`,
    "--workdir",
    "/workspace",
    "--cap-add",
    "NET_ADMIN",
    // Linux Engine does not provide Docker Desktop's host.docker.internal DNS
    // entry automatically. Do not add this override on macOS/Windows: there it
    // shadows Docker Desktop's working DNS address with the VM bridge gateway.
    ...(shouldAddDockerHostGatewayAlias()
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "-e",
    `GIT_URL=${project.gitUrl}`,
    "-e",
    `GIT_BRANCH=${environment.branch}`,
    "-e",
    `GIT_BASE_BRANCH=${repoConfig.defaultBranch || "main"}`,
    "-e",
    "TERM=xterm-256color",
  ];

  const dockerEnvironment: NodeJS.ProcessEnv = { ...process.env };
  const redactValues: string[] = [];
  const allowClaudeCredentials = context.runtimeFlavor !== "agent-test"
    || context.credentialSources?.has("claude");
  const anthropicApiKey = allowClaudeCredentials
    ? resolveAnthropicApiKey(config.global).apiKey
    : undefined;
  if (anthropicApiKey) {
    dockerEnvironment.ANTHROPIC_API_KEY = anthropicApiKey;
    redactValues.push(anthropicApiKey);
    args.push("-e", "ANTHROPIC_API_KEY");
  }
  // Cursor's macOS login lives in Keychain and cannot be represented by the
  // read-only ~/.cursor import mounted into a Linux container. Cursor Agent's
  // documented headless authentication path is CURSOR_API_KEY.
  //
  // The host-environment fallback inside `resolveCursorApiKey` is deliberate for
  // headless runs, and the same helper reports its `source` to the settings pane
  // so an inherited key is never forwarded invisibly.
  const { apiKey: cursorApiKey } = context.runtimeFlavor === "agent-test"
    && !context.credentialSources?.has("cursor")
    ? { apiKey: undefined }
    : resolveCursorApiKey(config.global);
  if (cursorApiKey) {
    dockerEnvironment.CURSOR_API_KEY = cursorApiKey;
    redactValues.push(cursorApiKey);
    args.push("-e", "CURSOR_API_KEY");
  }
  if (config.global.opencodeModel) args.push("-e", `OPENCODE_MODEL=${config.global.opencodeModel}`);
  if (environment.networkAccessMode === "full") {
    args.push("-e", "NETWORK_MODE=full");
  } else {
    // Only re-add hosts for platforms this install actually enabled. An
    // environment that runs neither Cursor nor Grok keeps exactly the allowlist
    // the user configured; widening it would quietly undo their isolation.
    const domains = [...new Set([
      ...(environment.allowedDomains ?? config.global.allowedDomains),
      ...requiredAgentNetworkDomains(config.global.enabledAgentPlatforms),
    ])];
    args.push("-e", "NETWORK_MODE=restricted", "-e", `ALLOWED_DOMAINS=${domains.join(",")}`);
  }

  const home = os.homedir();
  const agentTestHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  const bindIfExists = async (source: string, target: string, readonly = true) => {
    if (await pathExists(source)) args.push("-v", `${source}:${target}${readonly ? ":ro" : ""}`);
  };
  if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude")) {
    const claudeConfigDir = context.runtimeFlavor === "agent-test"
      ? process.env.CLAUDE_CONFIG_DIR?.trim()
      : path.join(home, ".claude");
    const claudeConfigFile = context.runtimeFlavor === "agent-test" && agentTestHostHome
      ? path.join(agentTestHostHome, ".claude.json")
      : path.join(home, ".claude.json");
    if (claudeConfigDir) await bindIfExists(claudeConfigDir, "/claude-config");
    await bindIfExists(claudeConfigFile, "/claude-config.json");
  }
  if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("codex")) {
    const codexHome = context.runtimeFlavor === "agent-test"
      ? process.env.CODEX_HOME?.trim()
      : path.join(home, ".codex");
    if (codexHome) await bindIfExists(codexHome, "/codex-home");
  }
  // Agent homes must remain writable. Cursor creates project/session state and
  // Grok creates session databases during ACP startup, so mounting the host
  // directories directly over their homes makes both bridges fail immediately.
  // Mount portable inputs separately; entrypoint.sh copies a bounded allowlist.
  if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("cursor")) {
    const cursorHome = context.runtimeFlavor === "agent-test" && agentTestHostHome
      ? agentTestHostHome
      : home;
    await bindIfExists(path.join(cursorHome, ".cursor"), "/cursor-config");
  }
  if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("grok")) {
    const grokHome = context.runtimeFlavor === "agent-test" && agentTestHostHome
      ? agentTestHostHome
      : home;
    await bindIfExists(path.join(grokHome, ".grok"), "/grok-home");
    await bindIfExists(path.join(grokHome, ".config", "grok"), "/grok-config");
  }
  if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("opencode")) {
    const configHome = context.runtimeFlavor === "agent-test"
      ? process.env.XDG_CONFIG_HOME?.trim()
      : path.join(home, ".config");
    const dataHome = context.runtimeFlavor === "agent-test"
      ? process.env.XDG_DATA_HOME?.trim()
      : path.join(home, ".local", "share");
    const stateHome = context.runtimeFlavor === "agent-test"
      ? process.env.XDG_STATE_HOME?.trim()
      : path.join(home, ".local", "state");
    if (configHome) await bindIfExists(path.join(configHome, "opencode"), "/opencode-config");
    if (dataHome) await bindIfExists(path.join(dataHome, "opencode"), "/opencode-data");
    if (stateHome) {
      await bindIfExists(
        path.join(stateHome, "opencode", "model.json"),
        "/opencode-state/model.json",
      );
    }
  }
  if (context.runtimeFlavor !== "agent-test") {
    await bindIfExists(path.join(home, ".gitconfig"), "/tmp/gitconfig");
  }

  if (project.localPath) {
    await bindIfExists(path.join(project.localPath, ".env"), "/project-env/.env");
    await bindIfExists(path.join(project.localPath, ".env.local"), "/project-env/.env.local");
    await bindIfExists(path.join(project.localPath, "opencode.json"), "/opencode-project-json");
  }

  for (const mapping of environment.portMappings ?? []) {
    args.push("-p", `127.0.0.1:${mapping.hostPort}:${mapping.containerPort}/${mapping.protocol ?? "tcp"}`);
  }
  args.push("-p", `127.0.0.1::${OPENCODE_SERVER_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CLAUDE_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CODEX_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CURSOR_ACP_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${GROK_ACP_BRIDGE_PORT}/tcp`);
  if (repoConfig.entryPort) args.push("-p", `127.0.0.1::${repoConfig.entryPort}/tcp`);
  args.push(context.dockerImage ?? DOCKER_IMAGE);

  const { stdout } = await runCommand("docker", args, {
    env: dockerEnvironment,
    timeoutMs: 120_000,
    redactValues,
  });
  const containerId = stdout.trim();
  invalidateDockerContainerStateCache();
  try {
    if (project.localPath) {
      await stageConfiguredProjectFilesForContainer(containerId, project.localPath, configuredFilesToCopy);
    }
  } catch (error) {
    await runCommand("docker", ["rm", "-f", containerId], { timeoutMs: 60_000 }).catch(() => undefined);
    throw error;
  }
  return containerId;
}

export async function startContainerServer(
  containerId: string,
  port: number,
  processName: LocalServerKind,
  command: string,
  redactValues?: ReadonlyArray<string | null | undefined>,
): Promise<{ hostPort: number; wasRunning: boolean }> {
  if (!await isContainerRunning(containerId)) {
    throw retryableBridgeStartupError("Container is not running");
  }
  const hostPort = await getHostPort(containerId, port);
  if (!hostPort) throw new Error(`Container port ${port} is not mapped`);
  if (await checkHttpHealth(hostPort)) return { hostPort, wasRunning: true };
  await dockerExecDetached(containerId, command, redactValues);
  await waitForLocalServerHealth(hostPort, processName).catch(async (error) => {
    const logFile = processName === "opencode"
      ? "/tmp/opencode-serve.log"
      : processName === "claude"
        ? "/tmp/claude-bridge.log"
        : processName === "codex"
          ? "/tmp/codex-bridge.log"
          : `/tmp/${processName}-acp-bridge.log`;
    const log = await dockerExec(containerId, `cat ${logFile} 2>/dev/null || true`, undefined, redactValues).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.trim()}` : ""}`);
  });
  return { hostPort, wasRunning: false };
}

/**
 * Start OpenCode behind its supported HTTP Basic authentication.
 *
 * The password is persisted inside the container with owner-only permissions,
 * matching the bridge-token lifecycle used by Claude and Codex. A healthy
 * passwordless process from an older build is replaced before its port is
 * handed to the renderer.
 */
export async function startContainerOpenCodeServer(
  containerId: string,
): Promise<{ hostPort: number; wasRunning: boolean; authToken: string }> {
  if (!await isContainerRunning(containerId)) {
    throw retryableBridgeStartupError("Container is not running");
  }
  const hostPort = await getHostPort(containerId, OPENCODE_SERVER_PORT);
  if (!hostPort) throw new Error(`Container port ${OPENCODE_SERVER_PORT} is not mapped`);

  const readPersistedPassword = async (): Promise<string | null> => {
    const password = (
      await dockerExec(containerId, "cat /tmp/opencode-server-password 2>/dev/null || true")
    ).trim();
    return BRIDGE_TOKEN_PATTERN.test(password) ? password : null;
  };
  const hasCurrentGitHubEnvironmentPlugin = async (): Promise<boolean> => {
    const fingerprint = (
      await dockerExec(
        containerId,
        `cat ${OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE} 2>/dev/null || true`,
      )
    ).trim();
    return fingerprint === OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT;
  };
  const replaceRunningServer = async (): Promise<void> => {
    await dockerExec(
      containerId,
      `pkill -f '[o]pencode serve' || true; rm -f /tmp/opencode-server-password ${OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE}`,
    );
    await waitForHttpServerExit(hostPort);
  };

  const persistedPassword = await readPersistedPassword();
  if (
    persistedPassword
    && await checkHttpHealth(
      hostPort,
      "/global/health",
      openCodeHealthHeaders(persistedPassword),
    )
    && await hasCurrentGitHubEnvironmentPlugin()
  ) {
    return { hostPort, wasRunning: true, authToken: persistedPassword };
  }

  // A reachable server without our persisted credential predates authentication.
  // A persisted credential that no longer authenticates belongs to a stale
  // process. Replace either one before binding the new server.
  if (persistedPassword || await isHttpServerReachable(hostPort)) {
    await replaceRunningServer();
  }

  const authToken = randomBytes(32).toString("base64url");
  await dockerExecDetached(containerId, `
    set -e
    cd /workspace
    rm -f /tmp/opencode-serve.log
    umask 077
    mkdir -p /home/node/.config/opencode/plugins /tmp/orkestrator-ai
    printf '%s' ${quoteShell(OPENCODE_GITHUB_ENV_PLUGIN_SOURCE)} > ${OPENCODE_GITHUB_ENV_PLUGIN_PATH}
    chmod 600 ${OPENCODE_GITHUB_ENV_PLUGIN_PATH}
    printf '%s' ${quoteShell(OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT)} > ${OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE}
    printf '%s' ${quoteShell(authToken)} > /tmp/opencode-server-password
    source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
    orkestrator_source_runtime_env 2>/dev/null || true
    unset GITHUB_TOKEN GH_TOKEN
    export OPENCODE_SERVER_USERNAME=opencode
    export OPENCODE_SERVER_PASSWORD=${quoteShell(authToken)}
    setsid opencode serve --port ${OPENCODE_SERVER_PORT} --hostname 0.0.0.0 > /tmp/opencode-serve.log 2>&1 &
  `, [authToken]);
  await waitForHealth(
    hostPort,
    "/global/health",
    75,
    openCodeHealthHeaders(authToken),
  ).catch(async (error) => {
    const log = await dockerExec(
      containerId,
      "cat /tmp/opencode-serve.log 2>/dev/null || true",
      undefined,
      [authToken],
    ).catch(() => "");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.trim()}` : ""}`,
    );
  });
  return { hostPort, wasRunning: false, authToken };
}

/**
 * Starts the in-container Claude bridge behind a per-container auth token, with
 * the same persistence and recovery contract as `start_codex_server`: the token
 * lives in `/tmp/claude-bridge-token` so later starts can return it, and a
 * healthy bridge without a readable token (from before per-process
 * authentication) is replaced rather than served unauthenticated.
 */
export async function startContainerClaudeServer(
  containerId: string,
  agentToolConnection?: AgentToolConnection,
): Promise<{ hostPort: number; wasRunning: boolean; authToken: string }> {
  const expectedAgentToolsFingerprint = agentToolConnection
    ? agentToolConnectionFingerprint(agentToolConnection)
    : null;
  const readPersistedToken = async (): Promise<string | null> => {
    const persistedToken = (
      await dockerExec(containerId, "cat /tmp/claude-bridge-token 2>/dev/null || true")
    ).trim();
    return BRIDGE_TOKEN_PATTERN.test(persistedToken) ? persistedToken : null;
  };
  const hasCurrentAgentTools = async (): Promise<boolean> => {
    if (!expectedAgentToolsFingerprint) return true;
    const persisted = (
      await dockerExec(
        containerId,
        "cat /tmp/claude-agent-tools-fingerprint 2>/dev/null || true",
      )
    ).trim();
    return persisted === expectedAgentToolsFingerprint;
  };
  const hasCurrentGitHubEnvironment = async (): Promise<boolean> => {
    const persisted = (
      await dockerExec(
        containerId,
        `cat ${CLAUDE_GITHUB_ENV_FINGERPRINT_FILE} 2>/dev/null || true`,
      )
    ).trim();
    return persisted === CLAUDE_GITHUB_ENV_FINGERPRINT;
  };
  const replaceRunningBridge = async (port: number): Promise<void> => {
    await dockerExec(
      containerId,
      `pkill -f '[c]laude-bridge/dist/index.js' || true; rm -f ${CLAUDE_GITHUB_ENV_FINGERPRINT_FILE}`,
    );
    await waitForUnhealthy(port);
  };
  const startWithFreshToken = async (): Promise<{ hostPort: number; wasRunning: boolean; authToken: string }> => {
    const authToken = randomBytes(32).toString("base64url");
    const started = await startContainerServer(containerId, CLAUDE_BRIDGE_PORT, "claude", `
      cd /workspace
      rm -f /tmp/claude-bridge.log
      umask 077
      mkdir -p /tmp/orkestrator-ai
      printf '%s' ${quoteShell(authToken)} > /tmp/claude-bridge-token
      printf '%s' ${quoteShell(CLAUDE_GITHUB_ENV_FINGERPRINT)} > ${CLAUDE_GITHUB_ENV_FINGERPRINT_FILE}
      ${expectedAgentToolsFingerprint
        ? `printf '%s' ${quoteShell(expectedAgentToolsFingerprint)} > /tmp/claude-agent-tools-fingerprint`
        : "rm -f /tmp/claude-agent-tools-fingerprint"}
      source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
      orkestrator_source_runtime_env 2>/dev/null || true
      export ${CLAUDE_GITHUB_CREDENTIAL_FILE_ENV}=${quoteShell(CONTAINER_GITHUB_CREDENTIAL_FILE)}
      unset GITHUB_TOKEN GH_TOKEN
      export PORT=${CLAUDE_BRIDGE_PORT}
      export HOSTNAME=0.0.0.0
      export CLAUDE_BRIDGE_TOKEN=${quoteShell(authToken)}
      ${agentToolConnection
        ? `export ${ORKESTRATOR_AGENT_MCP_URL_ENV}=${quoteShell(agentToolConnection.url)}
      export ${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}=${quoteShell(agentToolConnection.token)}`
        : ""}
      setsid bun /opt/claude-bridge/dist/index.js > /tmp/claude-bridge.log 2>&1 &
    `, [authToken, agentToolConnection?.token]);
    if (!started.wasRunning) {
      await waitForHealth(
        started.hostPort,
        "/global/auth-check",
        75,
        claudeBridgeAuthHeaders(authToken),
      );
    }
    return { ...started, authToken };
  };

  const hostPort = await getHostPort(containerId, CLAUDE_BRIDGE_PORT);
  if (hostPort && await checkHttpHealth(hostPort)) {
    const persistedToken = await readPersistedToken();
    if (
      persistedToken
      && await hasCurrentAgentTools()
      && await hasCurrentGitHubEnvironment()
      && await checkHttpHealth(
        hostPort,
        "/global/auth-check",
        claudeBridgeAuthHeaders(persistedToken),
      )
    ) {
      return { hostPort, wasRunning: true, authToken: persistedToken };
    }
    // A bridge from before per-process authentication, or one whose live token
    // differs from the persisted file, cannot safely serve the renderer.
    await replaceRunningBridge(hostPort);
  }

  const started = await startWithFreshToken();
  if (!started.wasRunning) return started;
  // A bridge came up between the health check above and startContainerServer's
  // internal recheck (e.g. a prior start whose health wait timed out but whose
  // bridge arrived late). The fresh token was never written, so return the
  // token that bridge actually holds — or replace the bridge if it has none.
  const persistedToken = await readPersistedToken();
  if (
    persistedToken
    && await hasCurrentAgentTools()
    && await hasCurrentGitHubEnvironment()
    && await checkHttpHealth(
      started.hostPort,
      "/global/auth-check",
      claudeBridgeAuthHeaders(persistedToken),
    )
  ) {
    return { ...started, authToken: persistedToken };
  }
  await replaceRunningBridge(started.hostPort);
  return startWithFreshToken();
}

export type ClaudeBridgeModelCatalogResponse = {
  models: ClaudeModelCatalogEntry[];
  source: "sdk" | "fallback";
  fetchedAt: string;
  sdkVersion?: string;
  cliVersion?: string;
};

export function optionalCatalogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function optionalCatalogBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseClaudeBridgeModelCatalog(value: unknown): ClaudeBridgeModelCatalogResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude bridge returned an invalid model catalog");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.models) || (record.source !== "sdk" && record.source !== "fallback")) {
    throw new Error("Claude bridge returned an invalid model catalog");
  }

  const allowedEffortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
  const models = record.models.map((candidate): ClaudeModelCatalogEntry => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Claude bridge returned an invalid model entry");
    }
    const model = candidate as Record<string, unknown>;
    const id = optionalCatalogString(model.id);
    const name = optionalCatalogString(model.name);
    if (!id || !name) throw new Error("Claude bridge returned a model without an id or name");
    const supportedEffortLevels = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter(
          (level): level is ClaudeEffortLevel =>
            typeof level === "string" && allowedEffortLevels.has(level),
        )
      : undefined;
    return {
      id,
      resolvedModel: optionalCatalogString(model.resolvedModel),
      name,
      description: optionalCatalogString(model.description),
      supportsFastMode: optionalCatalogBoolean(model.supportsFastMode),
      supportsEffort: optionalCatalogBoolean(model.supportsEffort),
      supportedEffortLevels,
      supportsAdaptiveThinking: optionalCatalogBoolean(model.supportsAdaptiveThinking),
      supportsAutoMode: optionalCatalogBoolean(model.supportsAutoMode),
    };
  });
  if (models.length === 0) throw new Error("Claude bridge returned an empty model catalog");

  return {
    models,
    source: record.source,
    fetchedAt: optionalCatalogString(record.fetchedAt) ?? new Date().toISOString(),
    sdkVersion: optionalCatalogString(record.sdkVersion),
    cliVersion: optionalCatalogString(record.cliVersion),
  };
}

export async function fetchClaudeBridgeModelCatalog(
  port: number,
  authToken?: string,
): Promise<ClaudeBridgeModelCatalogResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/config/models`, {
    signal: AbortSignal.timeout(CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS),
    ...(authToken ? { headers: { "X-Orkestrator-Claude-Token": authToken } } : {}),
  });
  if (!response.ok) {
    throw new Error(`Claude bridge model discovery failed with HTTP ${response.status}`);
  }
  return parseClaudeBridgeModelCatalog(await response.json());
}

export function isFreshClaudeModelCatalog(snapshot: ClaudeModelCatalogSnapshot | undefined): boolean {
  if (!snapshot || snapshot.models.length === 0) return false;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < CLAUDE_MODEL_CATALOG_TTL_MS;
}

