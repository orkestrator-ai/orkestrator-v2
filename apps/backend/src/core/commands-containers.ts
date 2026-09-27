import {
  boundedBackgroundLaunch,
  boundedTailCommand,
  boundDiagnosticTail,
} from "./container-log-bounds.js";
import { persistentStateExports } from "./container-state-layout.js";
import {
  os,
  path,
  randomBytes,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  DOCKER_IMAGE,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_ENVIRONMENT_NAME,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_PROJECT_ID,
  DOCKER_LABEL_OPERATION_ID,
  DOCKER_LABEL_INPUTS_REVISION,
  DOCKER_LABEL_NETWORK_POLICY,
  DOCKER_LABEL_RUNTIME_GENERATION,
  GROK_ACP_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  PI_BRIDGE_PORT,
  dockerContainerRuntimeName,
  dockerOwnerNamespace,
  defaultRepositoryConfig,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  pathExists,
  runCommand,
} from "./commands-dependencies.js";
import type {
  Environment,
  ClaudeEffortLevel,
  ClaudeModelCatalogEntry,
  ClaudeModelCatalogSnapshot,
  AgentToolConnection,
} from "./commands-dependencies.js";
import {
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  BRIDGE_TOKEN_PATTERN,
  retryableBridgeStartupError,
  CLAUDE_MODEL_CATALOG_TTL_MS,
  CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS,
  CONTAINER_GITHUB_CREDENTIAL_FILE,
  CLAUDE_GITHUB_CREDENTIAL_FILE_ENV,
  CLAUDE_GITHUB_ENV_FINGERPRINT_FILE,
  CLAUDE_GITHUB_ENV_FINGERPRINT,
  OPENCODE_GITHUB_ENV_PLUGIN_PATH,
  OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE,
  OPENCODE_GITHUB_ENV_PLUGIN_SOURCE,
  OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT,
} from "./commands-runtime-state.js";
import { resolveAnthropicApiKey, resolveCursorApiKey } from "./commands-validation.js";
import { quoteShell } from "./commands-agent-support.js";
import {
  invalidateDockerContainerStateCache,
  isContainerRunning,
  getHostPort,
  shouldAddDockerHostGatewayAlias,
} from "./commands-container-exec.js";
import {
  normalizeConfiguredProjectFiles,
  stageConfiguredProjectFilesForContainer,
} from "./commands-project-files.js";
import { dockerExec } from "./commands-container-exec.js";
import {
  dockerExecDetached,
  checkHttpHealth,
  isHttpServerReachable,
  waitForHealth,
  waitForLocalServerHealth,
  waitForHttpServerExit,
  waitForUnhealthy,
  openCodeHealthHeaders,
  claudeBridgeAuthHeaders,
  agentToolConnectionFingerprint,
} from "./commands-server-health.js";
import type { LocalServerKind } from "./commands-runtime-state.js";
import type { CommandContext } from "./commands-context.js";
import { ContainerLifecycleError, findOperationContainers } from "./container-lifecycle-service.js";
import { detectDockerTopology, imageCapabilities } from "./docker-image.js";
import { storageMountArguments } from "./container-storage.js";
import {
  configuredAllowedDomains,
  ensureEnvironmentNetwork,
  ingressPorts,
} from "./container-network.js";
import { githubRangesSeed } from "./github-ranges-cache.js";
import {
  dockerCapacity,
  logDriverArguments,
  resolveResourceLimits,
  resourceArguments,
} from "./container-resources.js";
import {
  defaultInputSourceRoots,
  stagePortableInputs,
  stagedInputMountArguments,
} from "./portable-inputs.js";
import { pruneEnvironmentInputRevisions, selectedInputProviders } from "./portable-input-status.js";
import type { ContainerStorageIdentity } from "@orkestrator/protocol/container-lifecycle";
import { assertContainerNotDraining, ensureCurrentBootReady } from "./container-readiness.js";

const AGENT_TEST_LOCAL_GIT_REMOTE_PATH = "/orkestrator-agent-test-origin.git";

/**
 * `-p` arguments for user mappings and the entry port. Everything binds to
 * host loopback. Automatic mappings let Docker choose the host port. When a
 * TCP mapping already publishes the entry port, that explicit mapping wins and
 * the entry port is not published a second time.
 */
export function publishedPortArguments(
  mappings: readonly import("./models.js").PortMapping[],
  entryPort: number | undefined,
): string[] {
  const args: string[] = [];
  for (const mapping of mappings) {
    const protocol = mapping.protocol ?? "tcp";
    const host = mapping.hostPortMode === "auto" ? "" : String(mapping.hostPort);
    args.push("-p", `127.0.0.1:${host}:${mapping.containerPort}/${protocol}`);
  }
  const entryMapped = mappings.some(
    (mapping) => mapping.containerPort === entryPort && (mapping.protocol ?? "tcp") === "tcp",
  );
  if (entryPort && !entryMapped) args.push("-p", `127.0.0.1::${entryPort}/tcp`);
  return args;
}

export interface CreateContainerIdentity {
  /**
   * Immutable image id resolved when the operation was admitted. Creating from
   * the id means re-tagging the image mid-operation cannot switch it.
   */
  imageId?: string;
  /** Lifecycle operation creating this runtime; labelled for reconciliation. */
  operationId?: string;
  /** Runtime generation of the new container; `>1` gets a distinct name. */
  runtimeGeneration?: number;
  /** Persistent storage set to mount; absent keeps the legacy writable layer. */
  storage?: ContainerStorageIdentity;
}

/**
 * Thrown when Docker's answer to a create is unknown and no exact labelled
 * candidate can be found yet (for example the daemon became unreachable). The
 * operation stays current so the next admission reconciles it by identity
 * instead of creating a second container.
 */
export class AmbiguousContainerCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousContainerCreateError";
  }
}

export async function createDockerContainer(
  environment: Environment,
  context: CommandContext,
  identity: CreateContainerIdentity = {},
): Promise<string> {
  const project = await context.storage.getProject(environment.projectId);
  if (!project) throw new Error(`Project not found: ${environment.projectId}`);
  const config = await context.storage.loadConfig();
  const repoConfig = config.repositories[project.id] ?? defaultRepositoryConfig();
  const configuredFilesToCopy = normalizeConfiguredProjectFiles(repoConfig.filesToCopy);
  if (configuredFilesToCopy.length > 0 && !project.localPath) {
    throw new Error("Project has files configured to copy, but no local path is set");
  }
  // Agent-test fixtures use a deterministic bare repository on the host. A host
  // absolute path is not meaningful inside a container, so expose that one
  // verified test-only remote at a fixed path and clone from there. Keep it
  // writable because fixture branches exercise the normal commit-and-push path.
  // Production repositories and non-local test URLs keep their original value.
  const expectedAgentTestGitRemote = path.join(
    path.dirname(context.storage.getDataDir()),
    "fixtures",
    "origin.git",
  );
  const agentTestLocalGitRemote =
    context.runtimeFlavor === "agent-test" &&
    path.isAbsolute(project.gitUrl) &&
    path.resolve(project.gitUrl) === path.resolve(expectedAgentTestGitRemote) &&
    (await pathExists(project.gitUrl))
      ? project.gitUrl
      : null;
  const containerGitUrl = agentTestLocalGitRemote
    ? AGENT_TEST_LOCAL_GIT_REMOTE_PATH
    : project.gitUrl;
  const dockerOwner = dockerOwnerNamespace(context.storage.getDataDir());
  // Bind mounts name backend-host paths and bridges are reached on backend
  // loopback ports; neither exists on a remote daemon.
  const topology = await detectDockerTopology();
  if (topology.kind === "remote") {
    throw new ContainerLifecycleError(
      "unsupported-topology",
      topology.remediation ?? "The Docker daemon is not local to this backend.",
    );
  }
  const runtimeGeneration = identity.runtimeGeneration ?? 1;
  const args = [
    "create",
    "--name",
    dockerContainerRuntimeName(dockerOwner, environment.id, runtimeGeneration),
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
    "--label",
    `${DOCKER_LABEL_RUNTIME_GENERATION}=${runtimeGeneration}`,
    ...(identity.operationId
      ? ["--label", `${DOCKER_LABEL_OPERATION_ID}=${identity.operationId}`]
      : []),
    "--workdir",
    "/workspace",
    // An image that implements the drain contract runs under Docker's init,
    // which forwards signals and reaps orphaned exec descendants.
    ...(identity.imageId &&
    (await imageCapabilities(identity.imageId, context))?.["graceful-shutdown"]
      ? ["--init"]
      : []),
    "--cap-add",
    "NET_ADMIN",
    // The image ships Chromium for Playwright, and Chromium puts its renderer
    // shared memory in /dev/shm. Docker's 64MB default is far below what a real
    // page needs, and the failure mode is a renderer crash mid-run ("Target
    // page, context or browser has been closed") rather than a launch error, so
    // it does not show up until an agent loads something non-trivial. Raise the
    // mount instead of `--ipc=host`, which would also work but shares the host
    // IPC namespace and weakens the container boundary.
    "--shm-size",
    "1g",
    // Opt-in budget (environment override, else global default); none means
    // unrestricted, as before. Read back from inspect, never assumed.
    ...resourceArguments(resolveResourceLimits(environment, config.global).limits),
    // Bounded container stdout/stderr (10 MiB × 3) where the daemon offers
    // the local driver.
    ...logDriverArguments((await dockerCapacity()).logDrivers),
    ...(agentTestLocalGitRemote
      ? ["-v", `${agentTestLocalGitRemote}:${AGENT_TEST_LOCAL_GIT_REMOTE_PATH}`]
      : []),
    // Linux Engine does not provide Docker Desktop's host.docker.internal DNS
    // entry automatically. Do not add this override on macOS/Windows: there it
    // shadows Docker Desktop's working DNS address with the VM bridge gateway.
    ...(shouldAddDockerHostGatewayAlias(process.platform, topology.kind)
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    ...(identity.storage?.format === "volume-v1"
      ? [
          ...storageMountArguments(identity.storage),
          "-e",
          "ORKESTRATOR_WORKSPACE_STORAGE=volume-v1",
          "-e",
          `ORKESTRATOR_ENVIRONMENT_ID=${environment.id}`,
        ]
      : []),
    "-e",
    `GIT_URL=${containerGitUrl}`,
    "-e",
    `GIT_BRANCH=${environment.branch}`,
    "-e",
    `GIT_BASE_BRANCH=${repoConfig.defaultBranch || "main"}`,
    "-e",
    "TERM=xterm-256color",
  ];

  // A staged-inputs image never needs the Cursor key in its immutable
  // creation environment: the bridge launch reads the owner-only file the
  // backend syncs, and nothing else in the container uses it.
  const stagedInputCapable = Boolean(
    identity.imageId && (await imageCapabilities(identity.imageId, context))?.["staged-inputs"],
  );
  const dockerEnvironment: NodeJS.ProcessEnv = { ...process.env };
  const redactValues: string[] = [];
  const allowClaudeCredentials =
    context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude");
  const anthropicApiKey = allowClaudeCredentials
    ? resolveAnthropicApiKey(config.global).apiKey
    : undefined;
  if (anthropicApiKey) {
    dockerEnvironment.ANTHROPIC_API_KEY = anthropicApiKey;
    redactValues.push(anthropicApiKey);
    args.push("-e", "ANTHROPIC_API_KEY");
  }
  // Cursor's SDK accepts a headless API key in containers. The host-environment
  // fallback inside `resolveCursorApiKey` is deliberate for headless runs, and
  // the same helper reports its `source` to Settings so an inherited key is
  // never forwarded invisibly.
  const { apiKey: cursorApiKey } =
    context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("cursor")
      ? { apiKey: undefined }
      : resolveCursorApiKey(config.global);
  if (cursorApiKey && !stagedInputCapable) {
    dockerEnvironment.CURSOR_API_KEY = cursorApiKey;
    redactValues.push(cursorApiKey);
    args.push("-e", "CURSOR_API_KEY");
  }
  const opencodeModel = config.global.agentSettings?.platforms?.opencode?.model;
  if (opencodeModel) args.push("-e", `OPENCODE_MODEL=${opencodeModel}`);
  if (environment.networkAccessMode === "full") {
    args.push("-e", "NETWORK_MODE=full");
  } else {
    // Only re-add hosts for platforms this install actually enabled. An
    // environment that runs neither Cursor nor Grok keeps exactly the allowlist
    // the user configured; widening it would quietly undo their isolation.
    const domains = configuredAllowedDomains(environment, config);
    args.push("-e", "NETWORK_MODE=restricted", "-e", `ALLOWED_DOMAINS=${domains.join(",")}`);
  }

  const bindIfExists = async (source: string, target: string, readonly = true) => {
    if (await pathExists(source)) args.push("-v", `${source}:${target}${readonly ? ":ro" : ""}`);
  };
  // Portable agent inputs. A staged-inputs image gets only the allowlisted
  // files of enabled providers, copied into a private per-environment
  // revision; older images keep the read-only home mounts their entrypoint
  // expects. A running legacy container keeps its mounts until it is rebuilt.
  const stagedInputs =
    identity.imageId &&
    process.env.ORKESTRATOR_PORTABLE_INPUTS !== "host-mounts" &&
    (await imageCapabilities(identity.imageId, context))?.["staged-inputs"]
      ? await stagePortableInputs(
          context.storage.getDataDir(),
          environment.id,
          selectedInputProviders(context, config.global.enabledAgentPlatforms),
          defaultInputSourceRoots(context.runtimeFlavor, AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV),
        )
      : null;
  if (stagedInputs) {
    args.push(
      ...stagedInputMountArguments(stagedInputs),
      "--label",
      `${DOCKER_LABEL_INPUTS_REVISION}=${stagedInputs.revision}`,
    );
  } else {
    const home = os.homedir();
    const agentTestHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude")) {
      const claudeConfigDir =
        context.runtimeFlavor === "agent-test"
          ? process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]?.trim()
          : path.join(home, ".claude");
      const claudeConfigFile =
        context.runtimeFlavor === "agent-test" && agentTestHostHome
          ? path.join(agentTestHostHome, ".claude.json")
          : path.join(home, ".claude.json");
      if (claudeConfigDir) await bindIfExists(claudeConfigDir, "/claude-config");
      await bindIfExists(claudeConfigFile, "/claude-config.json");
    }
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("codex")) {
      const codexHome =
        context.runtimeFlavor === "agent-test"
          ? process.env.CODEX_HOME?.trim()
          : path.join(home, ".codex");
      if (codexHome) await bindIfExists(codexHome, "/codex-home");
    }
    // Grok writes session databases during startup, so its host directory cannot
    // replace the writable container home. Mount portable inputs separately;
    // entrypoint.sh copies a bounded allowlist.
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("grok")) {
      const grokHome =
        context.runtimeFlavor === "agent-test" && agentTestHostHome ? agentTestHostHome : home;
      await bindIfExists(path.join(grokHome, ".grok"), "/grok-home");
      await bindIfExists(path.join(grokHome, ".config", "grok"), "/grok-config");
    }
    // Pi has no vendor account: its credentials are the user's own provider keys
    // in `~/.pi/agent/auth.json`, alongside the model cache and settings. The
    // whole directory is mounted as a portable input rather than over the home,
    // because the bridge writes session transcripts back into it — entrypoint.sh
    // copies the bounded allowlist, exactly as it does for Cursor and Grok.
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("pi")) {
      const piHome =
        context.runtimeFlavor === "agent-test" && agentTestHostHome ? agentTestHostHome : home;
      await bindIfExists(path.join(piHome, ".pi"), "/pi-config");
    }
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("opencode")) {
      const configHome =
        context.runtimeFlavor === "agent-test"
          ? process.env.XDG_CONFIG_HOME?.trim()
          : path.join(home, ".config");
      const dataHome =
        context.runtimeFlavor === "agent-test"
          ? process.env.XDG_DATA_HOME?.trim()
          : path.join(home, ".local", "share");
      const stateHome =
        context.runtimeFlavor === "agent-test"
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
  }

  if (project.localPath) {
    await bindIfExists(path.join(project.localPath, ".env"), "/project-env/.env");
    await bindIfExists(path.join(project.localPath, ".env.local"), "/project-env/.env.local");
    await bindIfExists(path.join(project.localPath, "opencode.json"), "/opencode-project-json");
  }

  const publishStart = args.length;
  args.push(...publishedPortArguments(environment.portMappings ?? [], repoConfig.entryPort));
  args.push("-p", `127.0.0.1::${OPENCODE_SERVER_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CLAUDE_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CODEX_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CURSOR_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${GROK_ACP_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${PI_BRIDGE_PORT}/tcp`);
  // Network policy 2: the environment's own network, IPv6 disabled, and a
  // firewall that allows the host only on the backend's service port and
  // inbound connections only on the published ports. Never the shared
  // default bridge when the environment network cannot be created.
  if (
    identity.imageId &&
    process.env.ORKESTRATOR_NETWORK_POLICY !== "1" &&
    ((await imageCapabilities(identity.imageId, context))?.["network-policy"] ?? 0) >= 2
  ) {
    const network = await ensureEnvironmentNetwork(context, environment.id);
    const servicePort = context.agentTools?.servicePort?.() ?? null;
    // GitHub's ranges, fetched at most hourly by the backend, so restricted
    // boots and restarts do not each call GitHub's rate-limited endpoint.
    const githubSeed =
      environment.networkAccessMode === "full"
        ? null
        : await githubRangesSeed(context.storage.getDataDir());
    if (githubSeed) {
      args.push(
        "--mount",
        `type=bind,src=${githubSeed},dst=/etc/orkestrator-seed/github-ranges,readonly`,
      );
    }
    args.push(
      "--network",
      network,
      "--sysctl",
      "net.ipv6.conf.all.disable_ipv6=1",
      "--label",
      `${DOCKER_LABEL_NETWORK_POLICY}=2`,
      "-e",
      "ORKESTRATOR_NETWORK_POLICY=2",
      "-e",
      `ORKESTRATOR_HOST_SERVICE_PORTS=${servicePort ? String(servicePort) : ""}`,
      "-e",
      `ORKESTRATOR_INGRESS_PORTS=${ingressPorts(args.slice(publishStart)).join(",")}`,
    );
  }
  args.push(identity.imageId ?? context.dockerImage ?? DOCKER_IMAGE);

  let containerId: string;
  try {
    const { stdout } = await runCommand("docker", args, {
      env: dockerEnvironment,
      timeoutMs: 120_000,
      redactValues,
    });
    containerId = stdout.trim();
  } catch (error) {
    invalidateDockerContainerStateCache();
    if (!identity.operationId) throw error;
    // A timeout or dropped connection does not say whether Docker created the
    // container. Resolve it by exact label identity before reporting failure,
    // so a retry never creates a second container behind the first.
    const search = await findOperationContainers(context, identity.operationId);
    if (search.kind === "one") {
      containerId = search.containerId;
    } else if (search.kind === "none") {
      throw error;
    } else if (search.kind === "many") {
      throw new ContainerLifecycleError(
        "needs-attention",
        "Docker reported more than one container for this operation. They were kept for review.",
      );
    } else {
      throw new AmbiguousContainerCreateError(
        "Docker could not confirm whether the container was created. It will be reconciled when Docker is reachable.",
      );
    }
  }
  invalidateDockerContainerStateCache();
  if (stagedInputs) {
    // Earlier revisions no container binds any more (recovery copies keep
    // theirs) are removed. Best effort: a failure only leaves a revision for
    // the next creation or the environment's deletion to remove.
    void pruneEnvironmentInputRevisions(environment.id, context).catch(() => undefined);
  }
  try {
    if (project.localPath) {
      await stageConfiguredProjectFilesForContainer(
        containerId,
        project.localPath,
        configuredFilesToCopy,
      );
    }
  } catch (error) {
    await runCommand("docker", ["rm", "-f", containerId], { timeoutMs: 60_000 }).catch(
      () => undefined,
    );
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
  assertContainerNotDraining(containerId);
  if (!(await isContainerRunning(containerId))) {
    throw retryableBridgeStartupError("Container is not running");
  }
  const hostPort = await getHostPort(containerId, port);
  if (!hostPort) throw new Error(`Container port ${port} is not mapped`);
  if (await checkHttpHealth(hostPort)) return { hostPort, wasRunning: true };
  // Launching into a container Docker restarted since readiness was checked
  // would start the bridge before this boot's configuration exists.
  await ensureCurrentBootReady(containerId);
  await dockerExecDetached(containerId, command, redactValues);
  await waitForLocalServerHealth(hostPort, processName).catch(async (error) => {
    const logFile = containerServerLogFile(processName);
    const log = await dockerExec(
      containerId,
      boundedTailCommand(logFile),
      undefined,
      redactValues,
    ).then(boundDiagnosticTail, () => "");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.trim()}` : ""}`,
    );
  });
  return { hostPort, wasRunning: false };
}

export function containerServerLogFile(processName: LocalServerKind): string {
  switch (processName) {
    case "opencode":
      return "/tmp/opencode-serve.log";
    case "claude":
      return "/tmp/claude-bridge.log";
    case "codex":
      return "/tmp/codex-bridge.log";
    case "cursor":
      return "/tmp/cursor-bridge.log";
    case "pi":
      return "/tmp/pi-bridge.log";
    default:
      return `/tmp/${processName}-acp-bridge.log`;
  }
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
  assertContainerNotDraining(containerId);
  if (!(await isContainerRunning(containerId))) {
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
    persistedPassword &&
    (await checkHttpHealth(hostPort, "/global/health", openCodeHealthHeaders(persistedPassword))) &&
    (await hasCurrentGitHubEnvironmentPlugin())
  ) {
    return { hostPort, wasRunning: true, authToken: persistedPassword };
  }

  // A reachable server without our persisted credential predates authentication.
  // A persisted credential that no longer authenticates belongs to a stale
  // process. Replace either one before binding the new server.
  if (persistedPassword || (await isHttpServerReachable(hostPort))) {
    await replaceRunningServer();
  }

  await ensureCurrentBootReady(containerId);
  const authToken = randomBytes(32).toString("base64url");
  await dockerExecDetached(
    containerId,
    `
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
    unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN
    export OPENCODE_SERVER_USERNAME=opencode
    export OPENCODE_SERVER_PASSWORD=${quoteShell(authToken)}
    ${persistentStateExports("opencode")}
    ${boundedBackgroundLaunch(`opencode serve --port ${OPENCODE_SERVER_PORT} --hostname 0.0.0.0`, "/tmp/opencode-serve.log")}
  `,
    [authToken],
  );
  await waitForHealth(hostPort, "/global/health", 75, openCodeHealthHeaders(authToken)).catch(
    async (error) => {
      const log = await dockerExec(
        containerId,
        boundedTailCommand("/tmp/opencode-serve.log"),
        undefined,
        [authToken],
      ).then(boundDiagnosticTail, () => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.trim()}` : ""}`,
      );
    },
  );
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
  debugLogging = false,
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
      await dockerExec(containerId, "cat /tmp/claude-agent-tools-fingerprint 2>/dev/null || true")
    ).trim();
    return persisted === expectedAgentToolsFingerprint;
  };
  const hasCurrentGitHubEnvironment = async (): Promise<boolean> => {
    const persisted = (
      await dockerExec(containerId, `cat ${CLAUDE_GITHUB_ENV_FINGERPRINT_FILE} 2>/dev/null || true`)
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
  const startWithFreshToken = async (): Promise<{
    hostPort: number;
    wasRunning: boolean;
    authToken: string;
  }> => {
    const authToken = randomBytes(32).toString("base64url");
    const started = await startContainerServer(
      containerId,
      CLAUDE_BRIDGE_PORT,
      "claude",
      `
      cd /workspace
      rm -f /tmp/claude-bridge.log
      umask 077
      mkdir -p /tmp/orkestrator-ai
      printf '%s' ${quoteShell(authToken)} > /tmp/claude-bridge-token
      printf '%s' ${quoteShell(CLAUDE_GITHUB_ENV_FINGERPRINT)} > ${CLAUDE_GITHUB_ENV_FINGERPRINT_FILE}
      ${
        expectedAgentToolsFingerprint
          ? `printf '%s' ${quoteShell(expectedAgentToolsFingerprint)} > /tmp/claude-agent-tools-fingerprint`
          : "rm -f /tmp/claude-agent-tools-fingerprint"
      }
      source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
      orkestrator_source_runtime_env 2>/dev/null || true
      export ${CLAUDE_GITHUB_CREDENTIAL_FILE_ENV}=${quoteShell(CONTAINER_GITHUB_CREDENTIAL_FILE)}
      unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN
      export PORT=${CLAUDE_BRIDGE_PORT}
      export HOSTNAME=0.0.0.0
      export CLAUDE_BRIDGE_TOKEN=${quoteShell(authToken)}
      export ORKESTRATOR_BRIDGE_DEBUG=${debugLogging ? "1" : "0"}
      ${
        agentToolConnection
          ? `export ${ORKESTRATOR_AGENT_MCP_URL_ENV}=${quoteShell(agentToolConnection.url)}
      export ${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}=${quoteShell(agentToolConnection.token)}`
          : ""
      }
      ${boundedBackgroundLaunch("bun /opt/claude-bridge/dist/index.js", "/tmp/claude-bridge.log")}
    `,
      [authToken, agentToolConnection?.token],
    );
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
  if (hostPort && (await checkHttpHealth(hostPort))) {
    const persistedToken = await readPersistedToken();
    if (
      persistedToken &&
      (await hasCurrentAgentTools()) &&
      (await hasCurrentGitHubEnvironment()) &&
      (await checkHttpHealth(
        hostPort,
        "/global/auth-check",
        claudeBridgeAuthHeaders(persistedToken),
      ))
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
    persistedToken &&
    (await hasCurrentAgentTools()) &&
    (await hasCurrentGitHubEnvironment()) &&
    (await checkHttpHealth(
      started.hostPort,
      "/global/auth-check",
      claudeBridgeAuthHeaders(persistedToken),
    ))
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

export function isFreshClaudeModelCatalog(
  snapshot: ClaudeModelCatalogSnapshot | undefined,
): boolean {
  if (!snapshot || snapshot.models.length === 0) return false;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < CLAUDE_MODEL_CATALOG_TTL_MS;
}
