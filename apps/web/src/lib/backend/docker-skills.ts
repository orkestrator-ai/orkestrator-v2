import { invoke } from "@/lib/native/backend";
import type {
  Environment,
  EnvironmentStatus,
  DomainTestResult,
  PreferredEditor,
  ClaudeModelCatalogSnapshot,
} from "@/types";
/** PR detection result containing URL, state, and merge conflict status */

export async function checkDocker(): Promise<boolean> {
  return invoke<boolean>("check_docker");
}

export async function dockerVersion(): Promise<string> {
  return invoke<string>("docker_version");
}

export async function provisionEnvironment(environmentId: string): Promise<string> {
  return invoke<string>("provision_environment", { environmentId });
}

export async function dockerStartContainer(containerId: string): Promise<void> {
  return invoke("docker_start_container", { containerId });
}

export async function dockerStopContainer(containerId: string): Promise<void> {
  return invoke("docker_stop_container", { containerId });
}

export async function dockerRemoveContainer(containerId: string): Promise<void> {
  return invoke("docker_remove_container", { containerId });
}

export async function dockerContainerStatus(containerId: string): Promise<EnvironmentStatus> {
  return invoke<EnvironmentStatus>("docker_container_status", { containerId });
}

export async function listDockerContainers(): Promise<[string, string][]> {
  return invoke<[string, string][]>("list_docker_containers");
}

export async function checkBaseImage(): Promise<boolean> {
  return invoke<boolean>("check_base_image");
}

/** Docker system statistics */
export interface DockerSystemStats {
  /** Memory currently used by containers (bytes) */
  memoryUsed: number;
  /** Total memory allocated to Docker (bytes) */
  memoryTotal: number;
  /** Number of CPUs available to Docker */
  cpus: number;
  /** Total CPU usage percentage across all running containers */
  cpuUsagePercent: number;
  /** Total disk space used by Docker (bytes) */
  diskUsed: number;
  /** Total disk space allocated to Docker (bytes) */
  diskTotal: number;
  /** Number of running containers */
  containersRunning: number;
  /** Total number of containers */
  containersTotal: number;
  /** Total number of images */
  imagesTotal: number;
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
  /** Creation timestamp (Unix seconds) */
  created: number;
  /** Environment ID label (if set) */
  environmentId: string | null;
  /** Project ID label (if set) */
  projectId: string | null;
  /** Whether this container is assigned to a known environment */
  isAssigned: boolean;
  /** CPU usage percentage (0-100), null if container is not running */
  cpuPercent: number | null;
}

/** Get Docker system statistics (memory, CPU, disk usage) */
export async function getDockerSystemStats(): Promise<DockerSystemStats> {
  return invoke<DockerSystemStats>("get_docker_system_stats");
}

/** Get all containers using the orkestrator-ai image */
export async function getOrkestratorContainers(): Promise<ContainerInfo[]> {
  return invoke<ContainerInfo[]>("get_orkestrator_containers");
}

/** Remove orphaned containers (not assigned to any environment) */
export async function cleanupOrphanedContainers(): Promise<number> {
  return invoke<number>("cleanup_orphaned_containers");
}

/** Reattach an orphaned container to a project by creating a new environment entry */
export async function reattachContainer(
  projectId: string,
  containerId: string,
  name?: string,
): Promise<Environment> {
  return invoke<Environment>("reattach_container", { projectId, containerId, name });
}

/** Result of a Docker prune operation */
export interface SystemPruneResult {
  /** Number of containers deleted */
  containersDeleted: number;
  /** Number of images deleted. Always 0: images are shared, so none are pruned. */
  imagesDeleted: number;
  /** Number of networks deleted. Always 0: this app creates no networks. */
  networksDeleted: number;
  /** Number of volumes deleted. Always 0: this app creates no volumes. */
  volumesDeleted: number;
  /** Total space reclaimed in bytes */
  spaceReclaimed: number;
}

/**
 * Remove this instance's stopped containers.
 *
 * Scoped to containers labelled with this backend registry's owner, plus legacy
 * Orkestrator containers created before owner labels existed. Images, networks
 * and volumes are deliberately left alone because they cannot be limited safely
 * to resources this instance created.
 */
export async function dockerSystemPrune(): Promise<SystemPruneResult> {
  return invoke<SystemPruneResult>("docker_system_prune", {});
}

/** Get container logs (non-streaming, returns last N lines) */
export async function getContainerLogs(containerId: string, tail?: string): Promise<string> {
  return invoke<string>("get_container_logs", { containerId, tail });
}

/** Start streaming container logs to the frontend via "container-log" events */
export async function streamContainerLogs(containerId: string): Promise<void> {
  return invoke("stream_container_logs", { containerId });
}

/** Get the host port mapped to a specific container port */
export async function getContainerHostPort(
  containerId: string,
  containerPort: number,
): Promise<number | null> {
  return invoke<number | null>("get_container_host_port", { containerId, containerPort });
}

/** Result of applying GitHub credentials to running containers. */
export interface PropagateTokenResult {
  /** Environment IDs where token was successfully updated */
  updated: string[];
  /** Failed updates: [environment_id, error_message] */
  failed: [string, string][];
}

/** Apply the selected GitHub credential source to all running containers. */
export async function propagateGithubCredentialsToContainers(): Promise<PropagateTokenResult> {
  return invoke<PropagateTokenResult>("propagate_github_token_to_containers");
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
}

export interface OpenCodeModelCatalogSnapshot {
  schemaVersion: 2;
  projectId: string;
  catalogVersion: string;
  updatedAt: string;
  models: CachedOpenCodeModel[];
}

/** Get the OpenCode server log from a container (for debugging) */
export async function getOpenCodeServerLog(containerId: string): Promise<string> {
  return invoke<string>("get_opencode_server_log", { containerId });
}

/** Get OpenCode model preferences from ~/.local/state/opencode/model.json */
export async function getOpencodeModelPreferences(): Promise<OpenCodeModelPreferences> {
  return invoke<OpenCodeModelPreferences>("get_opencode_model_preferences");
}

/** Load the durable project-scoped catalogue before an OpenCode server is ready. */
export async function getCachedOpenCodeModelCatalog(
  projectId: string,
): Promise<OpenCodeModelCatalogSnapshot | null> {
  return invoke<OpenCodeModelCatalogSnapshot | null>("get_opencode_model_catalog_cache", {
    projectId,
  });
}

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

/**
 * Store a newly-discovered catalogue. The backend hashes normalized model data
 * and only rewrites the cache when the catalogue version has actually changed.
 */
export async function cacheOpenCodeModelCatalog(
  projectId: string,
  models: CachedOpenCodeModel[],
): Promise<OpenCodeModelCatalogSnapshot> {
  return invoke<OpenCodeModelCatalogSnapshot>("cache_opencode_model_catalog", {
    projectId,
    // A non-array is a caller bug; forwarding it lets the command reject it
    // with a named error instead of throwing a TypeError in the renderer.
    models: (Array.isArray(models) ? models : []).map(toCachedOpenCodeModel),
  });
}

// --- Claude Bridge Server Commands ---

/** Get the Claude bridge server log from a container (for debugging) */
export async function getClaudeServerLog(containerId: string): Promise<string> {
  return invoke<string>("get_claude_server_log", { containerId });
}

/** Read or refresh the backend-owned Claude model catalog for an environment. */
export async function getClaudeModelCatalog(
  environmentId: string,
  forceRefresh = false,
): Promise<ClaudeModelCatalogSnapshot> {
  return invoke<ClaudeModelCatalogSnapshot>("get_claude_model_catalog", {
    environmentId,
    forceRefresh,
  });
}

/** Get the Codex bridge server log from a container (for debugging) */
export async function getCodexServerLog(containerId: string): Promise<string> {
  return invoke<string>("get_codex_server_log", { containerId });
}

// --- Credential Commands ---

export interface CredentialStatus {
  available: boolean;
  expiresAt: number | null;
}

export interface GitHubCredentialStatus {
  source: "host-cli" | "pat";
  available: boolean;
}

export async function hasClaudeCredentials(): Promise<boolean> {
  return invoke<boolean>("has_claude_credentials");
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  return invoke<CredentialStatus>("get_credential_status");
}

/** Report whether the credential source selected for container Git operations is usable. */
export async function getContainerGitHubCredentialStatus(): Promise<GitHubCredentialStatus> {
  return invoke<GitHubCredentialStatus>("get_container_github_credential_status");
}

// --- CLI Detection and Onboarding Commands ---

/** Check if the Claude CLI binary is installed and available */
export async function checkClaudeCli(): Promise<boolean> {
  return invoke<boolean>("check_claude_cli");
}

/** Check if the Claude config file (~/.claude.json) exists (indicates user is logged in) */
export async function checkClaudeConfig(): Promise<boolean> {
  return invoke<boolean>("check_claude_config");
}

/** Check if the OpenCode CLI binary is installed and available */
export async function checkOpencodeCli(): Promise<boolean> {
  return invoke<boolean>("check_opencode_cli");
}

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

/** List every skill the given agent can load from its user-level skill roots */
export async function listAgentSkills(provider: AgentSkillProvider): Promise<AgentSkillScan> {
  return invoke<AgentSkillScan>("list_agent_skills", { provider });
}

/** Read one SKILL.md; the backend rejects paths outside the agent's skill roots */
export async function readAgentSkill(
  provider: AgentSkillProvider,
  filePath: string,
): Promise<AgentSkillFile> {
  return invoke<AgentSkillFile>("read_agent_skill", { provider, filePath });
}

/** List the skills the selected agent can load inside one environment. */
export async function listEnvironmentAgentSkills(
  environmentId: string,
  provider: AgentSkillProvider,
): Promise<AgentSkillScan> {
  return invoke<AgentSkillScan>("list_environment_agent_skills", {
    environmentId,
    provider,
  });
}

/** Read a SKILL.md from the selected environment's validated skill roots. */
export async function readEnvironmentAgentSkill(
  environmentId: string,
  provider: AgentSkillProvider,
  filePath: string,
): Promise<AgentSkillFile> {
  return invoke<AgentSkillFile>("read_environment_agent_skill", {
    environmentId,
    provider,
    filePath,
  });
}

/** Check if the Codex CLI binary is installed and available */
export async function checkCodexCli(): Promise<boolean> {
  return invoke<boolean>("check_codex_cli");
}

/** Check if the GitHub CLI (gh) binary is installed and available */
export async function checkGithubCli(): Promise<boolean> {
  return invoke<boolean>("check_github_cli");
}

/** Check if any AI CLI (Claude or OpenCode) is available for name generation */
export async function checkAnyAiCli(): Promise<boolean> {
  return invoke<boolean>("check_any_ai_cli");
}

/** Get the name of the available AI CLI ("claude", "opencode", or null if none) */
export async function getAvailableAiCli(): Promise<string | null> {
  return invoke<string | null>("get_available_ai_cli");
}

// --- Utility Commands ---

export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name });
}

export async function browseForDirectory(): Promise<string | null> {
  if (window.orkestrator?.dialog && !window.orkestratorGateway?.enabled) {
    const selected = await window.orkestrator.dialog.open({ directory: true });
    return typeof selected === "string" ? selected : null;
  }
  return invoke<string | null>("browse_for_directory");
}

export async function validateGitUrl(url: string): Promise<boolean> {
  return invoke<boolean>("validate_git_url", { url });
}

export async function getGitRemoteUrl(path: string): Promise<string | null> {
  return invoke<string | null>("get_git_remote_url", { path });
}

// --- Network Commands ---

export async function testDomainResolution(domains: string[]): Promise<DomainTestResult[]> {
  return invoke<DomainTestResult[]>("test_domain_resolution", { domains });
}

export async function validateDomains(domains: string[]): Promise<DomainTestResult[]> {
  return invoke<DomainTestResult[]>("validate_domains", { domains });
}

export async function addEnvironmentDomains(
  environmentId: string,
  domains: string[],
): Promise<string> {
  return invoke<string>("add_environment_domains", { environmentId, domains });
}

export async function removeEnvironmentDomains(
  environmentId: string,
  domains: string[],
): Promise<string> {
  return invoke<string>("remove_environment_domains", { environmentId, domains });
}

export async function updateEnvironmentAllowedDomains(
  environmentId: string,
  domains: string[],
): Promise<Environment> {
  return invoke<Environment>("update_environment_allowed_domains", { environmentId, domains });
}

// --- Editor Commands ---

/** Open an editor (VS Code or Cursor) attached to a running container */
export async function openInEditor(containerId: string, editor: PreferredEditor): Promise<void> {
  return invoke("open_in_editor", { containerId, editor });
}

/** Open an editor (VS Code or Cursor) for a local directory path */
export async function openLocalInEditor(path: string, editor: PreferredEditor): Promise<void> {
  return invoke("open_local_in_editor", { path, editor });
}

// --- File Commands ---

/** Represents a file changed in git */
