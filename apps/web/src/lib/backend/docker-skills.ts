import { asWebModel, nativeSessions } from "@/lib/node-scope/domains/native-sessions";
import type { DockerAvailability } from "@orkestrator/protocol/docker-availability";
import type { ContainerHostReachability } from "@orkestrator/protocol/container-host-reachability";
import type { DockerTopology, ImageStatus } from "@orkestrator/protocol/image-manifest";
import type {
  CleanupExecuteResult,
  CleanupPreview,
} from "@orkestrator/protocol/container-recovery";
import type {
  ContainerResourceLimits,
  ContainerUsageSnapshot,
  DockerCapacity,
} from "@orkestrator/protocol/container-resources";
import type {
  Environment,
  EnvironmentStatus,
  DomainTestResult,
  PreferredEditor,
  ClaudeModelCatalogSnapshot,
} from "@/types";
import { systemApi } from "@/lib/node-scope/domains/system";
import { type AccountMachine } from "./agent-accounts";
import type { AgentExtensionCatalog } from "./files-sessions";
import { agentServersClient } from "@orkestrator/protocol/contract/domains/agent-servers";
import { dockerClient } from "@orkestrator/protocol/contract/domains/docker";
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import {
  commandBackendClient,
  type BackendClient,
  machineBackendClient,
  withArgumentsObject,
} from "./client";
import { projects as projectsDomain } from "@/lib/node-scope/domains/projects";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
/** PR detection result containing URL, state, and merge conflict status */

/** Docker system statistics */
/** Every figure Docker would not report is `null`, never zero. */
export interface DockerSystemStats {
  /** Memory used by this installation's running containers (bytes). */
  memoryUsed: number | null;
  /** Memory available to Docker (bytes; on Docker Desktop, its VM). */
  memoryTotal: number | null;
  /** CPUs available to Docker. */
  cpus: number | null;
  /** This installation's CPU use as a share of Docker's CPUs (0–100). */
  cpuUsagePercent: number | null;
  /** Disk used by all of Docker (bytes). */
  diskUsed: number | null;
  /** Docker does not report a disk limit; always null. */
  diskTotal: number | null;
  /** Number of running containers */
  containersRunning: number;
  /** Total number of containers */
  containersTotal: number;
  /** Total number of images */
  imagesTotal: number | null;
  /** When the usage figures were sampled; absent from older backends. */
  sampledAt?: string | null;
  stale?: boolean;
  /** Cores in use by this installation's containers (unnormalized). */
  cpuCoresUsed?: number | null;
  memoryTotalKnown?: boolean;
  diskKnown?: boolean;
}

/** Container info for display */
export interface ContainerInfo {
  /** Container ID */
  id: string;
  /** Container name */
  name: string;
  /** Container status (running, exited, etc.) */
  status: string;
  /** Container state */
  state: string;
  /** Image name */
  image: string;
  /** Creation timestamp (Unix seconds), when Docker reported it. */
  created: number | null;
  /** Environment ID label (if set) */
  environmentId: string | null;
  /** Project ID label (if set) */
  projectId: string | null;
  /** Whether this container is assigned to a known environment */
  isAssigned: boolean;
  /**
   * Why cleanup would refuse to remove this container (for example
   * `live-environment-label` for an interrupted create of a live environment).
   * `null` means nothing claims it. Absent from older backends.
   */
  cleanupExclusion?: string | null;
  /** Memory in use, when measured. */
  memoryBytes?: number | null;
  /** The last exit was an out-of-memory kill, when known. */
  oomKilled?: boolean | null;
  /** Out-of-memory kills of any process in it since the backend started following. */
  oomEvents?: number | null;
  /** CPU usage percentage (per core, may exceed 100), null if not measured */
  cpuPercent: number | null;
}

export interface ContainerLogRecord {
  seq: number;
  text: string;
}

export type ContainerLogRead =
  | {
      kind: "records";
      sourceId: string;
      records: ContainerLogRecord[];
      cursor: number;
      ended: boolean;
    }
  | {
      kind: "gap";
      sourceId: string;
      records: ContainerLogRecord[];
      cursor: number;
      ended: boolean;
    };

/** Result of applying GitHub credentials to running containers. */
export interface PropagateTokenResult {
  /** Environment IDs where token was successfully updated */
  updated: string[];
  /** Failed updates: [environment_id, error_message] */
  failed: [string, string][];
}

// --- OpenCode Server Commands ---

export type OpenCodeModelRef =
  | string
  | {
      providerID: string;
      modelID: string;
    };

export interface OpenCodeModelPreferences {
  recent: OpenCodeModelRef[];
  favorite: OpenCodeModelRef[];
  variant: Record<string, string>;
}

export interface CachedOpenCodeModel {
  id: string;
  name: string;
  provider: string;
  variants?: string[];
  inputCost?: number;
  outputCost?: number;
  contextWindow?: number;
  supportsImageInput?: boolean;
  /** False when the persisted connectivity report omits this model's provider. */
  connected?: boolean;
}

export interface OpenCodeModelCatalogSnapshot {
  schemaVersion: 2;
  projectId: string;
  catalogVersion: string;
  updatedAt: string;
  models: CachedOpenCodeModel[];
}

/** Every container server with a `get_<provider>_server_log` command. */
export type ContainerServerLogProvider = "opencode" | "claude" | "codex" | "cursor" | "grok" | "pi";

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Project a model onto exactly the fields the cache command accepts.
 *
 * The catalogue is assembled from whatever a provider reports, so this drops
 * `NaN`/`Infinity` costs that `typeof x === "number"` lets through upstream and
 * makes the wire contract explicit: a field added to `OpenCodeModel` later
 * cannot start failing the command's strict key check.
 */
function toCachedOpenCodeModel(model: CachedOpenCodeModel): CachedOpenCodeModel {
  const variants = Array.isArray(model.variants)
    ? model.variants.filter((variant) => typeof variant === "string" && variant.trim().length > 0)
    : undefined;
  const inputCost = finiteNumber(model.inputCost);
  const outputCost = finiteNumber(model.outputCost);
  const contextWindow = finiteNumber(model.contextWindow);
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    ...(variants?.length ? { variants } : {}),
    ...(inputCost === undefined ? {} : { inputCost }),
    ...(outputCost === undefined ? {} : { outputCost }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(typeof model.supportsImageInput === "boolean"
      ? { supportsImageInput: model.supportsImageInput }
      : {}),
  };
}

// --- Claude Bridge Server Commands ---

// --- Credential Commands ---

export interface CredentialStatus {
  available: boolean;
  expiresAt: number | null;
}

export interface GitHubCredentialStatus {
  source: "none" | "host-cli" | "pat";
  available: boolean;
}

// --- CLI Detection and Onboarding Commands ---

// --- Agent Skills ---

export const AGENT_SKILL_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
] as const;
export type AgentSkillProvider = (typeof AGENT_SKILL_PROVIDERS)[number];
export type AgentSkillScope = "project" | "admin" | "user" | "shared" | "system" | "plugin";

export interface AgentSkillRoot {
  path: string;
  label: string;
  scope: AgentSkillScope;
  plugin?: string;
  exists: boolean;
  /** How many of this root's skills the scan listed, after dedupe and capping. */
  skillCount: number;
  /**
   * The root held more entries than the scan was willing to read. Optional
   * because this is a wire shape: a backend older than the field simply omits
   * it, and an absent flag means the same thing as `false`.
   */
  truncated?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  location: string;
  scope: AgentSkillScope;
  plugin?: string;
  /** A higher-precedence root exposes the same skill name. */
  shadowed: boolean;
}

export interface AgentSkillScan {
  provider: AgentSkillProvider;
  roots: AgentSkillRoot[];
  /** Already sorted by name; the backend owns the ordering. */
  skills: AgentSkill[];
  errors: Array<{ path: string; message: string }>;
}

export interface AgentSkillFile {
  path: string;
  content: string;
  truncated: boolean;
}

export type AgentPluginCatalog = Pick<AgentExtensionCatalog, "agent" | "plugins" | "pluginError">;

export interface GitHubCliStatus {
  installed: boolean;
  /** `gh` holds a login for github.com. */
  authenticated: boolean;
  /** This backend may sign `gh` in. False in isolated test profiles. */
  canSignIn: boolean;
  /** The user turned off the startup reminder to set `gh` up. */
  reminderDismissed: boolean;
}

export type GitHubCliOperationState = "idle" | "pending" | "succeeded" | "failed";

export interface GitHubCliLoginProgress {
  state: GitHubCliOperationState;
  operationId?: string;
  url?: string;
  userCode?: string;
  error?: string;
}

// --- Utility Commands ---

// --- Network Commands ---

// --- Editor Commands ---

// --- File Commands ---

/** Represents a file changed in git */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createDockerSkillsApi(client: BackendClient) {
  // Git remote checks (`projects` domain, plan item 7005).
  const gitRemotes = projectsDomain(client);
  const native = () => nativeSessions(client);
  // The machine-aware `native-sessions` call (`test_domain_resolution`, plan
  // item 7001): typed and decoded like the rest of the domain, sent to the
  // chosen machine, always with an arguments object.
  const nativeOn = (machine: AccountMachine) =>
    machine === undefined
      ? nativeSessions(withArgumentsObject(client))
      : nativeSessions(machineBackendClient(client, machine));
  // The `agent-servers` domain (plan item 7009): bridges, CLI checks,
  // catalogues, skills and the GitHub CLI sign-in.
  const agentServers = () => domainApi(client, agentServersClient);
  const ownMachineAgentServers = () => domainApi(withArgumentsObject(client), agentServersClient);
  const agentServersOn = (machine: AccountMachine) =>
    machine === undefined
      ? ownMachineAgentServers()
      : domainApi(machineBackendClient(client, machine), agentServersClient);
  // The `docker` domain (plan item 7003): typed, decoded results.
  const docker = () => domainApi(client, dockerClient);
  // The machine-aware functions were sent through `machineInvoker`, which
  // always passes an arguments object; their calls keep that shape.
  const ownMachineDocker = () => domainApi(withArgumentsObject(client), dockerClient);
  const dockerOn = (machine: AccountMachine) =>
    machine === undefined
      ? ownMachineDocker()
      : domainApi(machineBackendClient(client, machine), dockerClient);
  // The `environments` domain's commands here (plan item 7003).
  const environments = () => domainApi(client, environmentsClient);
  const ownMachineEnvironments = () => domainApi(withArgumentsObject(client), environmentsClient);
  const environmentsOn = (machine: AccountMachine) =>
    machine === undefined
      ? ownMachineEnvironments()
      : domainApi(machineBackendClient(client, machine), environmentsClient);

  async function checkDocker(machine?: AccountMachine): Promise<DockerAvailability> {
    return dockerOn(machine).checkDocker();
  }

  /** The latest "can containers reach the agent tools server?" result. */
  async function getContainerHostReachability(): Promise<ContainerHostReachability> {
    return docker().hostReachability();
  }

  /** Runs the container connectivity check now and returns its result. */
  async function checkContainerHostReachability(): Promise<ContainerHostReachability> {
    return docker().checkHostReachability();
  }

  async function dockerVersion(): Promise<string> {
    return docker().dockerVersion();
  }

  /** The environment's container id; `null` when the create left none. */
  async function provisionEnvironment(environmentId: string): Promise<string | null> {
    return docker().provisionEnvironment({ environmentId });
  }

  async function dockerStartContainer(containerId: string): Promise<void> {
    return docker().startContainer({ containerId });
  }

  async function dockerStopContainer(containerId: string, machine?: AccountMachine): Promise<void> {
    return dockerOn(machine).stopContainer({ containerId });
  }

  async function dockerRemoveContainer(
    containerId: string,
    machine?: AccountMachine,
  ): Promise<void> {
    return dockerOn(machine).removeContainer({ containerId });
  }

  async function dockerContainerStatus(containerId: string): Promise<EnvironmentStatus> {
    return docker().containerStatus({ containerId });
  }

  async function listDockerContainers(): Promise<[string, string][]> {
    return docker().listContainers();
  }

  async function checkBaseImage(): Promise<boolean> {
    return docker().checkBaseImage();
  }

  /** Get Docker system statistics (memory, CPU, disk usage) */
  async function getDockerSystemStats(machine?: AccountMachine): Promise<DockerSystemStats> {
    return dockerOn(machine).systemStats();
  }

  /** Get all containers using the orkestrator-ai image */
  async function getOrkestratorContainers(machine?: AccountMachine): Promise<ContainerInfo[]> {
    return dockerOn(machine).orkestratorContainers();
  }

  /** Reattach an orphaned container to a project by creating a new environment entry */
  async function reattachContainer(
    projectId: string,
    containerId: string,
    name?: string,
    machine?: AccountMachine,
  ): Promise<Environment> {
    return dockerOn(machine).reattachContainer({
      projectId,
      containerId,
      name,
    });
  }

  /** Get container logs (non-streaming, returns last N lines) */
  async function getContainerLogs(containerId: string, tail?: string): Promise<string> {
    return docker().containerLogs({ containerId, tail });
  }

  /** Follows a container's log: one shared backend follower, a leased subscription. */
  async function openContainerLogs(
    containerId: string,
  ): Promise<{ subscriptionId: string; sourceId: string; cursor: number }> {
    return docker().openContainerLogs({ containerId });
  }

  /** Records after `cursor`; renews the subscription's lease. */
  async function readContainerLogs(
    subscriptionId: string,
    sourceId: string,
    cursor: number,
  ): Promise<ContainerLogRead> {
    return docker().readContainerLogs({ subscriptionId, sourceId, cursor });
  }

  /** Releases the subscription; the container and its processes are untouched. */
  async function closeContainerLogs(subscriptionId: string): Promise<void> {
    return docker().closeContainerLogs({ subscriptionId });
  }

  /**
   * Legacy: opens a leased log subscription. Log lines are not pushed as events;
   * read them with `readContainerLogs`.
   */
  async function streamContainerLogs(containerId: string): Promise<void> {
    await docker().streamContainerLogs({ containerId });
  }

  /** Get the host port mapped to a specific container port */
  async function getContainerHostPort(
    containerId: string,
    containerPort: number,
  ): Promise<number | null> {
    return docker().containerHostPort({ containerId, containerPort });
  }

  /** Apply the selected GitHub credential source to all running containers. */
  async function propagateGithubCredentialsToContainers(
    machine?: AccountMachine,
  ): Promise<PropagateTokenResult> {
    return dockerOn(machine).propagateGithubToken();
  }

  /**
   * A container server's bounded, redacted log tail (for debugging). With
   * `previous`, the log of the run before the last relaunch instead, which is
   * where a crash's evidence is; empty when there has been no relaunch.
   */
  async function getContainerServerLog(
    provider: ContainerServerLogProvider,
    containerId: string,
    options: { previous?: boolean } = {},
  ): Promise<string> {
    const command = `get_${provider}_server_log` as const;
    const args = { containerId, ...(options.previous ? { previous: true } : {}) };
    // A provider this build has no definition for is asked by name, as before.
    const read = agentServers()[command] as ((input: typeof args) => Promise<string>) | undefined;
    return read ? read(args) : client.invokeRaw<string>(command, args);
  }

  /** Get the OpenCode server log from a container (for debugging) */
  async function getOpenCodeServerLog(containerId: string): Promise<string> {
    return getContainerServerLog("opencode", containerId);
  }

  /** Get OpenCode model preferences from ~/.local/state/opencode/model.json */
  async function getOpencodeModelPreferences(): Promise<OpenCodeModelPreferences> {
    return asWebModel<OpenCodeModelPreferences>(agentServers().get_opencode_model_preferences({}));
  }

  /** Load the durable project-scoped catalogue before an OpenCode server is ready. */
  async function getCachedOpenCodeModelCatalog(
    projectId: string,
    machine?: AccountMachine,
  ): Promise<OpenCodeModelCatalogSnapshot | null> {
    return asWebModel<OpenCodeModelCatalogSnapshot | null>(
      agentServersOn(machine).get_opencode_model_catalog_cache({ projectId }),
    );
  }

  /**
   * Store a newly-discovered catalogue. The backend hashes normalized model data
   * and only rewrites the cache when the catalogue version has actually changed.
   */
  async function cacheOpenCodeModelCatalog(
    projectId: string,
    models: CachedOpenCodeModel[],
  ): Promise<OpenCodeModelCatalogSnapshot> {
    return asWebModel<OpenCodeModelCatalogSnapshot>(
      agentServers().cache_opencode_model_catalog({
        projectId,
        // A non-array is a caller bug; forwarding it lets the command reject it
        // with a named error instead of throwing a TypeError in the renderer.
        models: (Array.isArray(models) ? models : []).map(toCachedOpenCodeModel),
      }),
    );
  }

  /** Get the Claude bridge server log from a container (for debugging) */
  async function getClaudeServerLog(containerId: string): Promise<string> {
    return getContainerServerLog("claude", containerId);
  }

  /** Read or refresh the backend-owned Claude model catalog for an environment. */
  async function getClaudeModelCatalog(
    environmentId: string,
    forceRefresh = false,
  ): Promise<ClaudeModelCatalogSnapshot> {
    return asWebModel<ClaudeModelCatalogSnapshot>(
      agentServers().get_claude_model_catalog({ environmentId, forceRefresh }),
    );
  }

  /** Get the Codex bridge server log from a container (for debugging) */
  async function getCodexServerLog(containerId: string): Promise<string> {
    return getContainerServerLog("codex", containerId);
  }

  async function hasClaudeCredentials(): Promise<boolean> {
    return agentServers().has_claude_credentials({});
  }

  async function getCredentialStatus(): Promise<CredentialStatus> {
    return asWebModel<CredentialStatus>(agentServers().get_credential_status({}));
  }

  /** Report whether the credential source selected for container Git operations is usable. */
  async function getContainerGitHubCredentialStatus(): Promise<GitHubCredentialStatus> {
    return asWebModel<GitHubCredentialStatus>(
      agentServers().get_container_github_credential_status({}),
    );
  }

  /** Check if the Claude CLI binary is installed and available */
  async function checkClaudeCli(): Promise<boolean> {
    return agentServers().check_claude_cli({});
  }

  /** Check if the Claude config file (~/.claude.json) exists (indicates user is logged in) */
  async function checkClaudeConfig(): Promise<boolean> {
    return agentServers().check_claude_config({});
  }

  /** List every skill the given agent can load from its user-level skill roots */
  async function listAgentSkills(
    provider: AgentSkillProvider,
    machine?: AccountMachine,
  ): Promise<AgentSkillScan> {
    return asWebModel<AgentSkillScan>(agentServersOn(machine).list_agent_skills({ provider }));
  }

  /** List the plugins the given agent's own CLI reports on this machine */
  async function listAgentPlugins(
    provider: AgentSkillProvider,
    machine?: AccountMachine,
  ): Promise<AgentPluginCatalog> {
    return asWebModel<AgentPluginCatalog>(agentServersOn(machine).list_agent_plugins({ provider }));
  }

  /** Read one SKILL.md; the backend rejects paths outside the agent's skill roots */
  async function readAgentSkill(
    provider: AgentSkillProvider,
    filePath: string,
    machine?: AccountMachine,
  ): Promise<AgentSkillFile> {
    return asWebModel<AgentSkillFile>(
      agentServersOn(machine).read_agent_skill({ provider, filePath }),
    );
  }

  /** List the skills the selected agent can load inside one environment. */
  async function listEnvironmentAgentSkills(
    environmentId: string,
    provider: AgentSkillProvider,
  ): Promise<AgentSkillScan> {
    return asWebModel<AgentSkillScan>(
      agentServers().list_environment_agent_skills({ environmentId, provider }),
    );
  }

  /** Read a SKILL.md from the selected environment's validated skill roots. */
  async function readEnvironmentAgentSkill(
    environmentId: string,
    provider: AgentSkillProvider,
    filePath: string,
  ): Promise<AgentSkillFile> {
    return asWebModel<AgentSkillFile>(
      agentServers().read_environment_agent_skill({ environmentId, provider, filePath }),
    );
  }

  /** Check if the GitHub CLI (gh) binary is installed and available */
  async function checkGithubCli(): Promise<boolean> {
    return agentServers().check_github_cli({});
  }

  /**
   * Whether the backend host's GitHub CLI is available and signed in. Each
   * machine has its own `gh`; `machine` names another node, through the command
   * node.
   */
  async function getGitHubCliStatus(machine?: AccountMachine): Promise<GitHubCliStatus> {
    return agentServersOn(machine).get_github_cli_status({});
  }

  /** Start `gh auth login` with GitHub's device flow; poll with `getGitHubCliLogin`. */
  async function startGitHubCliLogin(machine?: AccountMachine): Promise<GitHubCliLoginProgress> {
    return asWebModel<GitHubCliLoginProgress>(agentServersOn(machine).start_github_cli_login({}));
  }

  async function getGitHubCliLogin(machine?: AccountMachine): Promise<GitHubCliLoginProgress> {
    return asWebModel<GitHubCliLoginProgress>(agentServersOn(machine).get_github_cli_login({}));
  }

  /** Cancel a pending GitHub sign-in, or dismiss a finished one. */
  async function cancelGitHubCliLogin(
    operationId?: string,
    machine?: AccountMachine,
  ): Promise<GitHubCliLoginProgress> {
    return asWebModel<GitHubCliLoginProgress>(
      agentServersOn(machine).cancel_github_cli_login(operationId ? { operationId } : {}),
    );
  }

  /** Check if any AI CLI (Claude or OpenCode) is available for name generation */
  async function checkAnyAiCli(): Promise<boolean> {
    return agentServers().check_any_ai_cli({});
  }

  /** Get the name of the available AI CLI ("claude", "opencode", or null if none) */
  async function getAvailableAiCli(): Promise<string | null> {
    return agentServers().get_available_ai_cli({});
  }

  async function greet(name: string): Promise<string> {
    return systemApi(client).greet({ name });
  }

  async function validateGitUrl(url: string): Promise<boolean> {
    return gitRemotes().validate_git_url({ url });
  }

  async function getGitRemoteUrl(path: string): Promise<string | null> {
    return gitRemotes().get_git_remote_url({ path });
  }

  async function testDomainResolution(
    domains: string[],
    machine?: AccountMachine,
  ): Promise<DomainTestResult[]> {
    return asWebModel<DomainTestResult[]>(nativeOn(machine).test_domain_resolution({ domains }));
  }

  async function validateDomains(domains: string[]): Promise<DomainTestResult[]> {
    return asWebModel<DomainTestResult[]>(native().validate_domains({ domains }));
  }

  async function addEnvironmentDomains(environmentId: string, domains: string[]): Promise<string> {
    return environments().addEnvironmentDomains({ environmentId, domains });
  }

  async function removeEnvironmentDomains(
    environmentId: string,
    domains: string[],
  ): Promise<string> {
    return environments().removeEnvironmentDomains({ environmentId, domains });
  }

  async function updateEnvironmentAllowedDomains(
    environmentId: string,
    domains: string[],
  ): Promise<Environment> {
    return environments().updateEnvironmentAllowedDomains({ environmentId, domains });
  }

  /** Open an editor (VS Code or Cursor) attached to a running container */
  async function openInEditor(containerId: string, editor: PreferredEditor): Promise<void> {
    return asWebModel(native().open_in_editor({ containerId, editor }));
  }

  /** Open an editor (VS Code or Cursor) for a local directory path */
  async function openLocalInEditor(path: string, editor: PreferredEditor): Promise<void> {
    return asWebModel(native().open_local_in_editor({ path, editor }));
  }

  /** Configured environment image: identity and container-contract compatibility. */
  async function getDockerImageStatus(machine?: AccountMachine): Promise<ImageStatus> {
    return dockerOn(machine).imageStatus();
  }

  /** Effective Docker daemon topology (endpoint kind, rootless, versions). */
  async function getDockerTopology(
    refresh = false,
    machine?: AccountMachine,
  ): Promise<DockerTopology> {
    return dockerOn(machine).topology({ refresh });
  }

  /**
   * Reviewed cleanup: lists this installation's containers and volumes with why
   * each is kept, and binds the removable ones to a short-lived token.
   */
  async function previewDockerCleanup(machine?: AccountMachine): Promise<CleanupPreview> {
    return dockerOn(machine).cleanupPreview();
  }

  /** Removes only the selected resources of one preview; the token is consumed. */
  async function executeDockerCleanup(
    selection: {
      selectionToken: string;
      containerIds: string[];
      volumeNames: string[];
      networkNames?: string[];
    },
    machine?: AccountMachine,
  ): Promise<CleanupExecuteResult> {
    return dockerOn(machine).cleanupExecute(selection);
  }

  /** The Docker daemon's capacity (on Docker Desktop, its VM) and disk use. */
  async function getDockerCapacity(
    refresh = false,
    machine?: AccountMachine,
  ): Promise<DockerCapacity> {
    return dockerOn(machine).capacity({ refresh });
  }

  /** One shared, bounded usage sample of this installation's containers. */
  async function getContainerUsage(): Promise<ContainerUsageSnapshot> {
    return docker().containerUsage();
  }

  /** `null` clears the stored budget and selects the built-in default; all-null limits are unrestricted. */
  async function setContainerResourceLimits(
    limits: ContainerResourceLimits | null,
    machine?: AccountMachine,
  ): Promise<{
    limits: ContainerResourceLimits | null;
    /** Saved, but this backend's Docker cannot enforce these axes (older backends omit it). */
    unenforceable?: Array<keyof ContainerResourceLimits>;
  }> {
    return environmentsOn(machine).setContainerResourceLimits({ limits });
  }

  return {
    checkDocker,
    getContainerHostReachability,
    checkContainerHostReachability,
    dockerVersion,
    provisionEnvironment,
    dockerStartContainer,
    dockerStopContainer,
    dockerRemoveContainer,
    dockerContainerStatus,
    listDockerContainers,
    checkBaseImage,
    getDockerSystemStats,
    getOrkestratorContainers,
    reattachContainer,
    getContainerLogs,
    openContainerLogs,
    readContainerLogs,
    closeContainerLogs,
    streamContainerLogs,
    getContainerHostPort,
    propagateGithubCredentialsToContainers,
    getContainerServerLog,
    getOpenCodeServerLog,
    getOpencodeModelPreferences,
    getCachedOpenCodeModelCatalog,
    cacheOpenCodeModelCatalog,
    getClaudeServerLog,
    getClaudeModelCatalog,
    getCodexServerLog,
    hasClaudeCredentials,
    getCredentialStatus,
    getContainerGitHubCredentialStatus,
    checkClaudeCli,
    checkClaudeConfig,
    listAgentSkills,
    listAgentPlugins,
    readAgentSkill,
    listEnvironmentAgentSkills,
    readEnvironmentAgentSkill,
    checkGithubCli,
    getGitHubCliStatus,
    startGitHubCliLogin,
    getGitHubCliLogin,
    cancelGitHubCliLogin,
    checkAnyAiCli,
    getAvailableAiCli,
    greet,
    validateGitUrl,
    getGitRemoteUrl,
    testDomainResolution,
    validateDomains,
    addEnvironmentDomains,
    removeEnvironmentDomains,
    updateEnvironmentAllowedDomains,
    openInEditor,
    openLocalInEditor,
    getDockerImageStatus,
    getDockerTopology,
    previewDockerCleanup,
    executeDockerCleanup,
    getDockerCapacity,
    getContainerUsage,
    setContainerResourceLimits,
  };
}

export type DockerSkillsApi = ReturnType<typeof createDockerSkillsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  checkDocker,
  getContainerHostReachability,
  checkContainerHostReachability,
  dockerVersion,
  provisionEnvironment,
  dockerStartContainer,
  dockerStopContainer,
  dockerRemoveContainer,
  dockerContainerStatus,
  listDockerContainers,
  checkBaseImage,
  getDockerSystemStats,
  getOrkestratorContainers,
  reattachContainer,
  getContainerLogs,
  openContainerLogs,
  readContainerLogs,
  closeContainerLogs,
  streamContainerLogs,
  getContainerHostPort,
  propagateGithubCredentialsToContainers,
  getContainerServerLog,
  getOpenCodeServerLog,
  getOpencodeModelPreferences,
  getCachedOpenCodeModelCatalog,
  cacheOpenCodeModelCatalog,
  getClaudeServerLog,
  getClaudeModelCatalog,
  getCodexServerLog,
  hasClaudeCredentials,
  getCredentialStatus,
  getContainerGitHubCredentialStatus,
  checkClaudeCli,
  checkClaudeConfig,
  listAgentSkills,
  listAgentPlugins,
  readAgentSkill,
  listEnvironmentAgentSkills,
  readEnvironmentAgentSkill,
  checkGithubCli,
  getGitHubCliStatus,
  startGitHubCliLogin,
  getGitHubCliLogin,
  cancelGitHubCliLogin,
  checkAnyAiCli,
  getAvailableAiCli,
  greet,
  validateGitUrl,
  getGitRemoteUrl,
  testDomainResolution,
  validateDomains,
  addEnvironmentDomains,
  removeEnvironmentDomains,
  updateEnvironmentAllowedDomains,
  openInEditor,
  openLocalInEditor,
  getDockerImageStatus,
  getDockerTopology,
  previewDockerCleanup,
  executeDockerCleanup,
  getDockerCapacity,
  getContainerUsage,
  setContainerResourceLimits,
} = createDockerSkillsApi(commandBackendClient);
