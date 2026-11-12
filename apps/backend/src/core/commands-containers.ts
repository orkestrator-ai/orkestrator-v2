import {
  boundedTailCommand,
  boundDiagnosticTail,
  keepPreviousLogCommand,
  bridgeLogEnvironmentExports,
} from "./container-log-bounds.js";
import { bridgeRestarts } from "./bridge-restarts.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_ENVIRONMENT_NAME,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_PROJECT_ID,
  DOCKER_LABEL_OPERATION_ID,
  DOCKER_LABEL_INPUTS_REVISION,
  DOCKER_LABEL_NETWORK_POLICY,
  DOCKER_LABEL_PROJECT_SEED_REFUSED,
  DOCKER_LABEL_RUNTIME_GENERATION,
  GROK_ACP_BRIDGE_PORT,
  OPENCODE2_SERVER_PORT,
  PI_BRIDGE_PORT,
} from "./constants.js";
import { dockerContainerRuntimeName, dockerOwnerNamespace } from "./docker-ownership.js";
import { defaultRepositoryConfig } from "./storage.js";
import { ORKESTRATOR_AGENT_MCP_TOKEN_ENV, ORKESTRATOR_AGENT_MCP_URL_ENV } from "./agent-tools.js";
import { pathExists, runCommand } from "./shell.js";
import {
  copyProjectSeedFilesIntoContainer,
  PROJECT_SEED_FILES,
  projectSeedRefusalLabel,
  readProjectSeedFiles,
} from "./container-project-seed-files.js";
import type {
  Environment,
  ClaudeEffortLevel,
  ClaudeModelCatalogEntry,
  ClaudeModelCatalogSnapshot,
} from "./models.js";
import type { AgentToolConnection } from "./agent-tools.js";
import {
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  CONTAINER_GITHUB_CREDENTIAL_FILE,
  CLAUDE_GITHUB_CREDENTIAL_FILE_ENV,
  CLAUDE_GITHUB_ENV_FINGERPRINT_FILE,
  CLAUDE_GITHUB_ENV_FINGERPRINT,
} from "./agent-credential-files.js";
import { retryableBridgeStartupError } from "./local-server-runtime.js";
import {
  containerBridgeLaunch,
  launchContainerScript,
  isContainerBridgeKind,
  readContainerBridgeToken,
  recordLaunchedContainerBridge,
  stopContainerBridgeProcess,
  type ContainerCredentialMode,
  type ContainerScriptLaunch,
} from "./container-bridge-credential.js";
import { OPENCODE2_CONTAINER_LOG } from "./opencode2/index.js";
import { resolveAnthropicApiKey } from "./commands-validation.js";
import { imageWithoutStagedInputsMessage, imageUnreadableMessage } from "./commands-error-text.js";
import { quoteShell } from "./commands-agent-support.js";
import {
  CLAUDE_BASH_MAX_TIMEOUT_ENV,
  claudeBashMaxTimeoutEnvValue,
} from "@orkestrator/protocol/claude-background-commands";
import {
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
  checkHttpHealth,
  waitForHealth,
  waitForLocalServerHealth,
  waitForUnhealthy,
  claudeBridgeAuthHeaders,
  agentToolConnectionFingerprint,
} from "./commands-server-health.js";
import type { LocalServerKind } from "./local-server-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { ContainerLifecycleError, findOperationContainers } from "./container-lifecycle-service.js";
import {
  configuredImageRef,
  detectDockerTopology,
  imageStateFormats,
  imageWritesVolumeStorage,
  readImageManifest,
} from "./docker-image.js";
import { storageMountArguments } from "./container-storage.js";
import { readSeedManifest, seedFilesDir } from "./nodes/index.js";
import {
  gitMirrorContainerArguments,
  restrictedContainerReachesGitRemote,
  scheduleProjectGitMirrorRefresh,
} from "./project-git-mirror.js";
import { resolveGitMirrorAccess } from "./project-git-mirror-access.js";
import {
  allowedDomainsArgument,
  containerAllowedDomains,
  containerNetworkPolicy,
  ensureEnvironmentNetwork,
  ingressPorts,
} from "./container-network.js";
import { copyGithubRangesSeed, githubRangesSeed } from "./github-ranges-cache.js";
import { rememberNetworkOwner } from "./container-network-owner.js";
import {
  DOCKER_LABEL_EGRESS_GATEWAY,
  createEgressGateway,
  egressEnforcement,
  egressFilterEnvironment,
  egressGatewayName,
  removeRuntimeContainer,
} from "./egress-gateway.js";
import {
  dockerAdmissionCapacity,
  logDriverArguments,
  refuseUnenforceableLimits,
  resolveResourceLimits,
  resourceArguments,
  sharedMemoryMiB,
} from "./container-resources.js";
import {
  STAGED_INPUT_RELAY_DIR,
  defaultInputSourceRoots,
  stagePortableInputs,
  stagedInputMountArguments,
  withSharedSkillsInput,
} from "./portable-inputs.js";
import { pruneEnvironmentInputRevisions, selectedInputProviders } from "./portable-input-status.js";
import type { ContainerStorageIdentity } from "@orkestrator/protocol/container-lifecycle";
import {
  imageCopiesCursorMcpConfig,
  imageCopiesSharedSkills,
  imageDeclaresStagedInputs,
  imageRelaysStagedInputs,
  type ImageManifest,
} from "@orkestrator/protocol/image-manifest";
import { assertContainerNotDraining, ensureCurrentBootReady } from "./container-readiness.js";
import { activeAgentAccountInputRoots } from "./agent-accounts-containers.js";
import { isGitRemoteUrl } from "@orkestrator/protocol/git-remote-url";
import { createLogger } from "@orkestrator/protocol/logger";
import {
  backendHostPortLabelArguments,
  chooseBackendHostPorts,
  listOwnedBackendHostPorts,
} from "./container-host-ports.js";

const dockerLog = createLogger("docker");

export const CLAUDE_MODEL_CATALOG_TTL_MS = 5 * 60_000;
export const CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS = 30_000;

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

/**
 * The ports other containers of this owner were given by the backend. A
 * listing Docker cannot answer is logged and treated as none: the create
 * itself then reports the daemon, and this process's own recent choices are
 * still refused.
 */
async function ownedBackendHostPorts(owner: string): Promise<number[]> {
  try {
    return await listOwnedBackendHostPorts(owner, runCommand);
  } catch {
    dockerLog.warn("host-ports.owned-list-failed", {});
    return [];
  }
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
  /** The storage already holds a checkout, so this runtime never clones. */
  reusesWorkspace?: boolean;
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

/**
 * The image a new container is created from, once it is known to take staged
 * inputs. Older images expected whole host agent homes bound into them, and no
 * new container gets those: refused before anything is created. An existing
 * runtime never comes through here, so it keeps its mounts until it is rebuilt.
 */
async function requireStagedInputsImage(
  imageId: string | undefined,
  context: CommandContext,
): Promise<{ imageId: string; capabilities: ImageManifest["capabilities"] }> {
  const named = imageId
    ? `${configuredImageRef(context)} (${imageId.replace(/^sha256:/, "").slice(0, 12)})`
    : configuredImageRef(context);
  const read = imageId ? await readImageManifest(imageId, context) : null;
  if (!imageId || !read || read.kind === "unavailable") {
    throw new ContainerLifecycleError("daemon-unavailable", imageUnreadableMessage(named));
  }
  if (read.kind === "invalid") {
    throw new ContainerLifecycleError(
      "capability-unavailable",
      `The environment image ${named} has a manifest that cannot be used by this Orkestrator version. Nothing was created. Update Orkestrator or rebuild the image with a supported manifest, then retry.`,
    );
  }
  const capabilities = read.kind === "manifest" ? read.manifest.capabilities : null;
  if (!capabilities || !imageDeclaresStagedInputs(capabilities)) {
    throw new ContainerLifecycleError(
      "capability-unavailable",
      imageWithoutStagedInputsMessage(named),
    );
  }
  return { imageId, capabilities };
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
  const seedRoot = seedFilesDir(context.storage.getDataDir(), environment.id);
  const seededFiles = await readSeedManifest(seedRoot);
  const allFilesToCopy = normalizeConfiguredProjectFiles([
    ...(repoConfig.filesToCopy ?? []),
    ...seededFiles,
  ]);
  const seedNames = new Set<string>(PROJECT_SEED_FILES.map((file) => file.name));
  const configuredFilesToCopy = allFilesToCopy.filter((name) => !seedNames.has(name));
  if (allFilesToCopy.length > 0 && !project.localPath) {
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
  // An explicit budget the daemon cannot enforce is refused, never passed
  // through: a rootless daemon without cgroups records it and enforces
  // nothing. The built-in default leaves such an axis off instead. The
  // topology probe's rootless flag survives a failed capacity probe.
  const capacity = await dockerAdmissionCapacity(topology);
  const resourceLimits = resolveResourceLimits(environment, config.global, capacity).limits;
  refuseUnenforceableLimits(resourceLimits, capacity, "Nothing was created.");
  const { imageId, capabilities: imageCapabilitySet } = await requireStagedInputsImage(
    identity.imageId,
    context,
  );
  // Persistent storage is mounted read-write only into an image that declares
  // it writes that format; an older image could corrupt newer state.
  if (
    identity.storage?.format === "volume-v1" &&
    !imageWritesVolumeStorage(await imageStateFormats(imageId, context))
  ) {
    throw new ContainerLifecycleError(
      "unsupported-format",
      "This image cannot write the environment's persistent storage format. Nothing was created; use the image the environment was built with or a newer one.",
    );
  }
  const runtimeGeneration = identity.runtimeGeneration ?? 1;
  const runtimeName = dockerContainerRuntimeName(dockerOwner, environment.id, runtimeGeneration);
  const networkPolicy = containerNetworkPolicy(
    imageCapabilitySet["network-policy"] ?? 0,
    process.env.ORKESTRATOR_NETWORK_POLICY,
  );
  // A runtime that will clone reads the project's Git mirror, read-only, when
  // its image knows how; an older image never sees the mount or the variable.
  // A stored local path is no remote a container could clone from, and a
  // restricted container whose firewall would stop it reaching the remote does
  // not get to read what the remote serves through the mount instead.
  const mirrorRemoteReachable =
    agentTestLocalGitRemote ||
    (isGitRemoteUrl(project.gitUrl) &&
      (environment.networkAccessMode === "full" ||
        restrictedContainerReachesGitRemote(
          project.gitUrl,
          containerAllowedDomains(environment, config, networkPolicy),
          networkPolicy,
        )));
  const mirrorEligible = !identity.reusesWorkspace && (imageCapabilitySet["git-mirror"] ?? 0) >= 1;
  if (mirrorEligible && !mirrorRemoteReachable && isGitRemoteUrl(project.gitUrl)) {
    dockerLog.info("git-mirror.mount-withheld", {
      projectId: project.id,
      reason: "remote-unreachable",
    });
  }
  // The container reads only the mirror of the access it is given itself: the
  // same GitHub token or none, so the mount never holds a branch its own
  // credential could not fetch (container-lifecycle.md#project-git-mirror).
  const resolvedMirrorAccess =
    mirrorEligible && mirrorRemoteReachable
      ? await resolveGitMirrorAccess({
          gitUrl: project.gitUrl,
          global: config.global,
          gitHubCli: context.runtime.gitHubCli,
          localRemote: Boolean(agentTestLocalGitRemote),
          // Agent-test profiles never sync a GitHub credential into containers.
          containersGetGitHubCredential: context.runtimeFlavor !== "agent-test",
        })
      : null;
  // Authenticated generations cannot be reused at startup. Do not download a
  // private cache after its only reader has already cloned. Anonymous mirrors
  // remain safe even if credential synchronization observes a newer setting.
  const gitMirrorAccess = resolvedMirrorAccess?.kind === "anonymous" ? resolvedMirrorAccess : null;
  const gitMirrorArguments = gitMirrorAccess
    ? await gitMirrorContainerArguments(
        context.storage.getDataDir(),
        project,
        gitMirrorAccess.kind,
        gitMirrorAccess.generation,
      )
    : [];
  // Where the firewall runs: in an egress gateway that owns the namespace
  // (the workload gets no capability), in the workload itself (NET_ADMIN), or
  // nowhere in full mode.
  const enforcement = egressEnforcement({
    networkMode: environment.networkAccessMode === "full" ? "full" : "restricted",
    networkPolicy,
    imageGatewayVersion: imageCapabilitySet["egress-gateway"] ?? 0,
  });
  const addHostGatewayAlias = shouldAddDockerHostGatewayAlias(process.platform, topology.kind);
  // Rootless: host-gateway is inside RootlessKit's namespace. Name its host
  // loopback address instead once the reachability check proved it answers.
  const hostAliasTarget =
    (addHostGatewayAlias && topology.rootless
      ? await context.containerHostReachability?.resolveContainerHostAddress?.()
      : null) ?? "host-gateway";
  const args = [
    "create",
    "--name",
    runtimeName,
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
    ...(imageCapabilitySet["graceful-shutdown"] ? ["--init"] : []),
    // An in-container firewall needs NET_ADMIN. Full access never runs one,
    // and with an egress gateway the gateway holds the capability instead, so
    // nothing in the workload, root included, can change its rules.
    ...(enforcement === "container" ? ["--cap-add", "NET_ADMIN"] : []),
    // Packet sockets bypass namespace OUTPUT filtering, even without NET_ADMIN.
    ...(enforcement === "gateway" ? ["--cap-drop", "NET_RAW"] : []),
    // The image ships Chromium for Playwright, and Chromium puts its renderer
    // shared memory in /dev/shm. Docker's 64MB default is far below what a real
    // page needs, and the failure mode is a renderer crash mid-run ("Target
    // page, context or browser has been closed") rather than a launch error, so
    // it does not show up until an agent loads something non-trivial. Raise the
    // mount instead of `--ipc=host`, which would also work but shares the host
    // IPC namespace and weakens the container boundary.
    // Shared memory is charged to the memory limit, so under a budget it is
    // at most half of it.
    "--shm-size",
    `${sharedMemoryMiB(resourceLimits)}m`,
    // Environment override, else the Settings budget, else the built-in
    // default for this daemon. Read back from inspect, never assumed.
    ...resourceArguments(resourceLimits),
    // Bounded container stdout/stderr (10 MiB × 3) where the daemon offers
    // the local driver.
    ...logDriverArguments(capacity.logDrivers),
    // The bind-mounted fixture keeps its host owner, which the container's
    // user often is not, so Git refuses it as dubiously owned. Git reads
    // safe.directory only from global or system config, so workspace setup
    // trusts this one fixed path when told to; production containers are not.
    ...(agentTestLocalGitRemote
      ? [
          "-v",
          `${agentTestLocalGitRemote}:${AGENT_TEST_LOCAL_GIT_REMOTE_PATH}`,
          "-e",
          `ORKESTRATOR_AGENT_TEST_GIT_REMOTE=${AGENT_TEST_LOCAL_GIT_REMOTE_PATH}`,
        ]
      : []),
    ...gitMirrorArguments,
    // Linux Engine does not provide Docker Desktop's host.docker.internal DNS
    // entry automatically. Do not add this override on macOS/Windows: there it
    // shadows Docker Desktop's working DNS address with the VM bridge gateway.
    // A gateway owns /etc/hosts for the namespace it shares, so it gets the
    // alias instead (Docker refuses one on a joined namespace).
    ...(addHostGatewayAlias && enforcement !== "gateway"
      ? ["--add-host", `host.docker.internal:${hostAliasTarget}`]
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

  // Credentials go only to providers that are enabled, authorized for
  // agent-test profiles and not revoked for this environment.
  const inputProviders = selectedInputProviders(
    context,
    config.global.enabledAgentPlatforms,
    environment.revokedInputProviders ?? [],
  );
  const allowClaudeCredentials =
    inputProviders.has("claude") && config.global.useHostClaudeCredentials !== false;
  const anthropicApiKey = allowClaudeCredentials
    ? resolveAnthropicApiKey(config.global).apiKey
    : undefined;
  const opencodeModel = config.global.agentSettings?.platforms?.opencode?.model;
  if (opencodeModel) args.push("-e", `OPENCODE_MODEL=${opencodeModel}`);
  let allowedDomainsValue = "";
  if (environment.networkAccessMode === "full") {
    args.push("-e", "NETWORK_MODE=full");
  } else {
    // Only re-add hosts for platforms this install actually enabled. An
    // environment that runs neither Cursor nor Grok keeps exactly the allowlist
    // the user configured; widening it would quietly undo their isolation.
    const domains = containerAllowedDomains(environment, config, networkPolicy);
    const explicitNone = Boolean(imageCapabilitySet["network-refresh"]);
    allowedDomainsValue = allowedDomainsArgument(domains, explicitNone);
    args.push("-e", "NETWORK_MODE=restricted", "-e", `ALLOWED_DOMAINS=${allowedDomainsValue}`);
  }

  // Portable agent inputs: only the allowlisted files of enabled providers,
  // copied into a private per-environment revision. Credentials never go in the
  // container's immutable environment, where `docker inspect` would show them;
  // the Cursor key reaches the bridge through the owner-only file the backend
  // syncs.
  // An entrypoint older than Cursor's copy would ignore `/cursor-config`, and
  // staging it anyway would report Cursor's MCP servers as delivered.
  // Likewise an entrypoint older than the shared-skills copy would ignore
  // `/agents-skills`.
  const stagedProviders = withSharedSkillsInput(
    imageCopiesCursorMcpConfig(imageCapabilitySet)
      ? inputProviders
      : new Set([...inputProviders].filter((provider) => provider !== "cursor")),
    imageCopiesSharedSkills(imageCapabilitySet),
  );
  const stagedInputs = await stagePortableInputs(
    context.storage.getDataDir(),
    environment.id,
    stagedProviders,
    {
      ...defaultInputSourceRoots(context.runtimeFlavor, AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV),
      ...(await activeAgentAccountInputRoots(context)),
      includeClaudeCredentials: allowClaudeCredentials,
    },
  );
  if (topology.rootless && !imageRelaysStagedInputs(imageCapabilitySet)) {
    dockerLog.warn("portable-inputs.relay-missing", { imageId: imageId.slice(0, 19) });
  }
  if (anthropicApiKey) {
    const keyDir = path.join(stagedInputs.directory, "claude-config");
    await mkdir(keyDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(keyDir, ".orkestrator-anthropic-key"), anthropicApiKey, {
      mode: 0o600,
    });
    if (!stagedInputs.mounts.some((mount) => mount.target === "/claude-config")) {
      stagedInputs.mounts.push({ source: keyDir, target: "/claude-config" });
    }
  }
  args.push(
    ...stagedInputMountArguments(stagedInputs),
    "--label",
    `${DOCKER_LABEL_INPUTS_REVISION}=${stagedInputs.revision}`,
  );

  // The project's own `.env`, `.env.local` and `opencode.json` are read and
  // checked now and copied into the stopped container below, never bound: a
  // bind source is resolved by the daemon on the host, so a committed link
  // could mount any host path. A refused file is skipped and recorded on the
  // container for the setup terminal. Command-node fallback seeds go through
  // the same reader; generic configured-file staging cannot reread these names.
  const projectSeedFiles = project.localPath
    ? await readProjectSeedFiles(project.localPath, seedRoot, allFilesToCopy)
    : { accepted: [], refused: [] };
  for (const { name, reason } of projectSeedFiles.refused) {
    dockerLog.warn("project-seed.refused", { environmentId: environment.id, file: name, reason });
  }
  if (projectSeedFiles.refused.length > 0) {
    args.push(
      "--label",
      `${DOCKER_LABEL_PROJECT_SEED_REFUSED}=${projectSeedRefusalLabel(projectSeedFiles.refused)}`,
    );
  }

  const requestedPublishArgs = [
    ...publishedPortArguments(environment.portMappings ?? [], repoConfig.entryPort),
    ...[
      CLAUDE_BRIDGE_PORT,
      CODEX_BRIDGE_PORT,
      CURSOR_BRIDGE_PORT,
      GROK_ACP_BRIDGE_PORT,
      PI_BRIDGE_PORT,
      OPENCODE2_SERVER_PORT,
    ].flatMap((port) => ["-p", `127.0.0.1::${port}/tcp`]),
  ];
  // Rootless Docker draws automatic ports in its own namespace, blind to the
  // host's sockets, so the backend chooses them on the host instead and
  // labels them for the start path (to-do 7549 task 4). The label travels
  // with the `-p` arguments to whichever container owns the namespace. A
  // stopped container's chosen ports hold no host socket, so the ports every
  // owned container is labelled with are refused as well.
  const backendHostPorts = topology.rootless
    ? await chooseBackendHostPorts(requestedPublishArgs, {
        reserved: await ownedBackendHostPorts(dockerOwner),
      })
    : { publishArguments: requestedPublishArgs, chosen: [] };
  const publishArgs = [
    ...backendHostPorts.publishArguments,
    ...backendHostPortLabelArguments(backendHostPorts.chosen),
  ];
  // The namespace owner publishes: the gateway when there is one.
  if (enforcement !== "gateway") args.push(...publishArgs);
  let gatewayId: string | null = null;
  let inContainerGithubSeed: string | null = null;
  // Network policy 2: the environment's own network, IPv6 disabled, and a
  // firewall that allows the host only on the backend's service port and
  // inbound connections only on the published ports. Never the shared
  // default bridge when the environment network cannot be created. Policy 3
  // also narrows allowed domains to address, protocol and port tuples.
  if (networkPolicy >= 2) {
    const network = await ensureEnvironmentNetwork(context, environment.id);
    const servicePort = context.agentTools?.servicePort?.() ?? null;
    // GitHub's ranges, fetched at most hourly by the backend, so restricted
    // boots and restarts do not each call GitHub's rate-limited endpoint.
    const githubSeed =
      environment.networkAccessMode === "full"
        ? null
        : await githubRangesSeed(context.storage.getDataDir());
    const policyEnvironment = {
      ORKESTRATOR_NETWORK_POLICY: String(networkPolicy),
      ORKESTRATOR_HOST_SERVICE_PORTS: servicePort ? String(servicePort) : "",
      ORKESTRATOR_INGRESS_PORTS: ingressPorts(publishArgs).join(","),
    };
    if (enforcement === "gateway") {
      // The gateway owns the namespace: network, IPv6 setting, published
      // ports, host alias and the firewall with its GitHub seed. It is
      // created first; the workload references it by id.
      const gatewayName = egressGatewayName(runtimeName);
      gatewayId = await createEgressGateway({
        name: gatewayName,
        workloadName: runtimeName,
        environmentId: environment.id,
        owner: dockerOwner,
        image: imageId,
        network,
        publishArguments: publishArgs,
        addHostGateway: addHostGatewayAlias,
        hostAliasTarget,
        githubSeed,
        policyEnvironment: {
          NETWORK_MODE: "restricted",
          ALLOWED_DOMAINS: allowedDomainsValue,
          ...policyEnvironment,
          ...egressFilterEnvironment(),
        },
        limits: {
          memory: capacity.support.memoryLimit === true,
          pids: capacity.support.pidsLimit === true,
        },
        logArguments: logDriverArguments(capacity.logDrivers),
      });
      args.push(
        "--network",
        `container:${gatewayId}`,
        "--label",
        `${DOCKER_LABEL_EGRESS_GATEWAY}=${gatewayName}`,
        "-e",
        "ORKESTRATOR_EGRESS=gateway",
      );
    } else {
      // Copied in once the container exists (`copyGithubRangesSeed`), never bound.
      inContainerGithubSeed = githubSeed;
      args.push("--network", network, "--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
    }
    args.push(
      "--label",
      `${DOCKER_LABEL_NETWORK_POLICY}=${networkPolicy}`,
      ...Object.entries(policyEnvironment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    );
  }
  args.push(imageId);

  let containerId: string;
  try {
    const { stdout } = await runCommand("docker", args, { timeoutMs: 120_000 });
    containerId = stdout.trim();
  } catch (error) {
    context.runtime.containerStates.invalidate();
    // A gateway whose workload was certainly not created is removed now; one
    // that may still gain its workload stays for reconciliation or the
    // orphan sweep.
    const removeGateway = async () => {
      if (gatewayId) {
        await runCommand("docker", ["rm", "-f", gatewayId], { timeoutMs: 60_000 }).catch(
          () => undefined,
        );
      }
    };
    if (!identity.operationId) {
      await removeGateway();
      throw error;
    }
    // A timeout or dropped connection does not say whether Docker created the
    // container. Resolve it by exact label identity before reporting failure,
    // so a retry never creates a second container behind the first.
    const search = await findOperationContainers(context, identity.operationId);
    if (search.kind === "one") {
      containerId = search.containerId;
    } else if (search.kind === "none") {
      await removeGateway();
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
  rememberNetworkOwner(containerId, gatewayId);
  context.runtime.containerStates.invalidate();
  // In the background: a clone only pays the remote for what the mirror lacks,
  // so this launch does not wait for it.
  if (gitMirrorAccess && gitMirrorArguments.length > 0) {
    scheduleProjectGitMirrorRefresh(context, project, gitMirrorAccess);
  }
  if (inContainerGithubSeed) await copyGithubRangesSeed(containerId, inContainerGithubSeed);
  // Earlier revisions no container binds any more (recovery copies keep
  // theirs) are removed. Best effort: a failure only leaves a revision for
  // the next creation or the environment's deletion to remove.
  void pruneEnvironmentInputRevisions(environment.id, context).catch(() => undefined);
  try {
    await copyProjectSeedFilesIntoContainer(containerId, projectSeedFiles.accepted);
    if (project.localPath) {
      await stageConfiguredProjectFilesForContainer(
        containerId,
        project.localPath,
        configuredFilesToCopy,
        (await pathExists(seedRoot)) ? seedRoot : undefined,
      );
    }
  } catch (error) {
    await removeRuntimeContainer(containerId, dockerOwner).catch(() => undefined);
    throw error;
  } finally {
    await rm(seedRoot, { recursive: true, force: true });
  }
  return containerId;
}

export async function startContainerServer(
  containerId: string,
  port: number,
  processName: LocalServerKind,
  command: string,
  launch?: ContainerScriptLaunch,
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
  const launched = await launchContainerScript(containerId, command, launch);
  dockerLog.info("bridge.launched", { provider: processName, containerPort: port });
  bridgeRestarts.containerLaunched(processName);
  await waitForLocalServerHealth(hostPort, processName).catch(async (error) => {
    const logFile = containerServerLogFile(processName);
    const log = await dockerExec(containerId, boundedTailCommand(logFile), undefined, [
      ...Object.values(launch?.secrets ?? {}),
      launch?.rootCredential?.token,
    ]).then(boundDiagnosticTail, () => "");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.trim()}` : ""}`,
    );
  });
  // A token in root's file is handed out only to the socket recorded here.
  if (launch?.rootCredential && isContainerBridgeKind(processName)) {
    await recordLaunchedContainerBridge(containerId, processName, launched.session);
  }
  return { hostPort, wasRunning: false };
}

export function containerServerLogFile(processName: LocalServerKind): string {
  switch (processName) {
    case "opencode":
      return OPENCODE2_CONTAINER_LOG;
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
 * Starts the in-container Claude bridge behind a per-container auth token, with
 * the same persistence and recovery contract as `start_codex_server`: the token
 * stays in the container (`container-bridge-credential.ts`) so later starts can
 * return it, and a healthy bridge without a readable token (from before
 * per-process authentication) is replaced rather than served unauthenticated.
 *
 * `backgroundCommandLimitHours` only reaches a bridge this call starts: a
 * running bridge is not replaced for it, since that would stop the background
 * commands the setting exists to keep alive.
 */
export async function startContainerClaudeServer(
  containerId: string,
  agentToolConnection?: AgentToolConnection,
  debugLogging = false,
  backgroundCommandLimitHours?: number,
  credentialMode: ContainerCredentialMode | (() => Promise<ContainerCredentialMode>) = "token-file",
): Promise<{ hostPort: number; wasRunning: boolean; authToken: string }> {
  const bashMaxTimeout = claudeBashMaxTimeoutEnvValue(backgroundCommandLimitHours);
  const expectedAgentToolsFingerprint = agentToolConnection
    ? agentToolConnectionFingerprint(agentToolConnection)
    : null;
  const readPersistedToken = () => readContainerBridgeToken(containerId, "claude");
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
    await stopContainerBridgeProcess(containerId, "claude");
    await waitForUnhealthy(port);
  };
  const startWithFreshToken = async (): Promise<{
    hostPort: number;
    wasRunning: boolean;
    authToken: string;
  }> => {
    const credential = containerBridgeLaunch(
      "claude",
      typeof credentialMode === "function" ? await credentialMode() : credentialMode,
    );
    const authToken = credential.token;
    const started = await startContainerServer(
      containerId,
      CLAUDE_BRIDGE_PORT,
      "claude",
      `
      cd /workspace
      ${keepPreviousLogCommand("/tmp/claude-bridge.log")}
      umask 077
      mkdir -p /tmp/orkestrator-ai
      ${credential.script}
      printf '%s' ${quoteShell(CLAUDE_GITHUB_ENV_FINGERPRINT)} > ${CLAUDE_GITHUB_ENV_FINGERPRINT_FILE}
      ${
        expectedAgentToolsFingerprint
          ? `printf '%s' ${quoteShell(expectedAgentToolsFingerprint)} > /tmp/claude-agent-tools-fingerprint`
          : "rm -f /tmp/claude-agent-tools-fingerprint"
      }
      source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
      orkestrator_source_runtime_env 2>/dev/null || true
      for key_file in /claude-config/.orkestrator-anthropic-key ${STAGED_INPUT_RELAY_DIR}/claude-config/.orkestrator-anthropic-key; do
        if [ -r "$key_file" ]; then
          export ANTHROPIC_API_KEY="$(cat "$key_file")"
          break
        fi
      done
      export ${CLAUDE_GITHUB_CREDENTIAL_FILE_ENV}=${quoteShell(CONTAINER_GITHUB_CREDENTIAL_FILE)}
      unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN
      export PORT=${CLAUDE_BRIDGE_PORT}
      export HOSTNAME=0.0.0.0
      export ORKESTRATOR_BRIDGE_DEBUG=${debugLogging ? "1" : "0"}
      ${bridgeLogEnvironmentExports()}
      ${bashMaxTimeout ? `export ${CLAUDE_BASH_MAX_TIMEOUT_ENV}=${quoteShell(bashMaxTimeout)}` : ""}
      ${
        agentToolConnection
          ? `export ${ORKESTRATOR_AGENT_MCP_URL_ENV}=${quoteShell(agentToolConnection.url)}`
          : ""
      }
      ${credential.start("/opt/claude-bridge/dist/index.js", "/tmp/claude-bridge.log")}
    `,
      {
        ...credential.launch,
        secrets: {
          ...credential.launch.secrets,
          [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: agentToolConnection?.token,
        },
      },
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
  forceRefresh = false,
): Promise<ClaudeBridgeModelCatalogResponse> {
  const response = await fetch(
    `http://127.0.0.1:${port}/config/models${forceRefresh ? "?forceRefresh=true" : ""}`,
    {
      signal: AbortSignal.timeout(CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS),
      ...(authToken ? { headers: { "X-Orkestrator-Claude-Token": authToken } } : {}),
    },
  );
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
