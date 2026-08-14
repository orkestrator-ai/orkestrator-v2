import { invoke } from "@/lib/native/backend";
import { getGatewayBaseUrl } from "@/lib/gateway-url";
import type { EnvironmentDiffStatsSnapshot } from "@orkestrator/protocol/diff-stats";
import type { PrMonitorMode, PrMonitorSnapshot } from "@orkestrator/protocol/pr-monitor";
import type {
  FeaturePlanningKind,
  FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
} from "@orkestrator/protocol/agent-interactions";
import type {
  BuildPipeline as BackendBuildPipeline,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import type { TabTeardownInput } from "@orkestrator/protocol/tab-teardown";
import type {
  LoopedReviewWorkflow as BackendLoopedReviewWorkflow,
  StartLoopedReviewInput,
} from "@orkestrator/protocol/review-workflow";
import type {
  MultiReviewWorkflow as BackendMultiReviewWorkflow,
  MultiReviewReviewerTranscript,
  StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import type {
  Project,
  Environment,
  EnvironmentType,
  AppConfig,
  GlobalConfig,
  GatewayTokenSettings,
  WebClientStatus,
  RepositoryConfig,
  EnvironmentStatus,
  NetworkAccessMode,
  DomainTestResult,
  PreferredEditor,
  PortMapping,
  Session,
  SessionType,
  SessionStatus,
  PrState,
  StartEnvironmentResult,
  EnsureEnvironmentSetupResult,
  DefaultAgent,
  ClaudeMode,
  ClaudeNativeBackend,
  CodexMode,
  OpenCodeMode,
  EnvironmentSetupSession,
  InitialPromptImageAttachment,
  PersistedPaneLayout,
  PersistedPaneLayoutInput,
  ClaudeModelCatalogSnapshot,
  PersistedLoopedReviewWorkflow,
  PersistedBuildPipeline,
  PersistedNativeAgentSession,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
} from "@/types";
import type {
  LinearCompletionCommentResult,
  LinearConnectionStatus,
  LinearIssueComment,
  LinearIssueDetail,
  LinearIssueListItem,
} from "@/types/linear";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssuesSnapshot,
  GitHubIssueStatus,
} from "@/types/github";
import type { CodexModel } from "@/lib/codex-client";
import {
  isAwaitBridgeReadyResult,
  type AgentBridgeKind,
  type AwaitBridgeReadyResult,
} from "@orkestrator/protocol/bridge-readiness";
import {
  isResourceRevisionManifest,
  type ResourceRevisionManifest,
  type ResourceRevisionMap,
} from "@orkestrator/protocol/resource-events";
import type { AgentModel } from "@orkestrator/protocol/native-agent";

/** PR detection result containing URL, state, and merge conflict status */
export interface PrDetectionResult {
  url: string;
  state: PrState;
  hasMergeConflicts: boolean | null;
}

// Typed command wrapper for the Electron backend.

// --- Project Commands ---

export async function getResourceRevisionManifest(
  knownGeneration?: string,
  knownRevisions: Partial<ResourceRevisionMap> = {},
): Promise<ResourceRevisionManifest> {
  const response = await invoke<unknown>("get_resource_revision_manifest", {
    ...(knownGeneration === undefined ? {} : { knownGeneration }),
    knownRevisions,
  });
  if (!isResourceRevisionManifest(response)) {
    throw new Error("Invalid resource revision manifest response");
  }
  return response;
}

export async function getProjects(): Promise<Project[]> {
  return invoke<Project[]>("get_projects");
}

export async function addProject(gitUrl: string, localPath?: string): Promise<Project> {
  return invoke<Project>("add_project", { gitUrl, localPath });
}

export async function createProjectFromScratch(localPath: string): Promise<Project> {
  return invoke<Project>("create_project_from_scratch", { localPath });
}

export async function removeProject(projectId: string): Promise<void> {
  return invoke("remove_project", { projectId });
}

export async function reorderProjects(projectIds: string[]): Promise<Project[]> {
  return invoke<Project[]>("reorder_projects", { projectIds });
}

export async function updateProject(
  projectId: string,
  updates: Partial<Pick<Project, "name" | "localPath">>
): Promise<Project> {
  return invoke<Project>("update_project", { projectId, updates });
}

// --- Environment Commands ---

export async function getEnvironments(projectId: string): Promise<Environment[]> {
  return invoke<Environment[]>("get_environments", { projectId });
}

/**
 * Read the persisted environment list without reconciling Docker state.
 * Intended for frequent cross-client snapshot refreshes.
 */
export async function getEnvironmentSnapshots(projectId: string): Promise<Environment[]> {
  return invoke<Environment[]>("get_environment_snapshots", { projectId });
}

export async function reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
  return invoke<Environment[]>("reorder_environments", { projectId, environmentIds });
}

export async function getEnvironment(environmentId: string): Promise<Environment | null> {
  return invoke<Environment | null>("get_environment", { environmentId });
}

export async function createEnvironment(
  projectId: string,
  name?: string,
  networkAccessMode?: NetworkAccessMode,
  initialPrompt?: string,
  portMappings?: PortMapping[],
  environmentType?: EnvironmentType,
  namingPrompt?: string,
  buildPipelineId?: string,
): Promise<Environment> {
  return invoke<Environment>("create_environment", {
    projectId,
    name,
    networkAccessMode,
    initialPrompt,
    portMappings,
    environmentType,
    namingPrompt,
    ...(buildPipelineId ? { buildPipelineId } : {}),
  });
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  return invoke("delete_environment", { environmentId });
}

export async function startEnvironment(environmentId: string): Promise<StartEnvironmentResult> {
  return invoke<StartEnvironmentResult>("start_environment", { environmentId });
}

/**
 * Accept an environment start without keeping the renderer transport open for
 * Docker provisioning. Progress and completion are observed through the
 * authoritative environment snapshot and setup lifecycle events.
 */
export async function startEnvironmentInBackground(environmentId: string): Promise<void> {
  return invoke<void>("start_environment_background", { environmentId });
}

export async function stopEnvironment(environmentId: string): Promise<void> {
  return invoke("stop_environment", { environmentId });
}

/**
 * Recreate an environment - preserves filesystem state via docker commit, then creates new container with updated port mappings
 * Note: All running processes will be terminated, but installed packages and file changes are preserved
 */
export async function recreateEnvironment(environmentId: string): Promise<void> {
  return invoke("recreate_environment", { environmentId });
}

export async function syncEnvironmentStatus(environmentId: string): Promise<Environment> {
  return invoke<Environment>("sync_environment_status", { environmentId });
}

/**
 * Sync all environments with Docker state at startup.
 * Clears container references for environments whose Docker containers no longer exist.
 * Returns an array of environment IDs that had their container references cleared.
 */
export async function syncAllEnvironmentsWithDocker(): Promise<string[]> {
  return invoke<string[]>("sync_all_environments_with_docker");
}

export async function renameEnvironment(environmentId: string, name: string): Promise<Environment> {
  return invoke<Environment>("rename_environment", { environmentId, name });
}

/**
 * Trigger background AI-generated rename from a prompt.
 * Used by native mode chat tabs to rename timestamp-named environments
 * after the first user message.
 */
export async function renameEnvironmentFromPrompt(environmentId: string, prompt: string): Promise<void> {
  return invoke<void>("rename_environment_from_prompt", { environmentId, prompt });
}

export async function getEnvironmentStatus(
  environmentId: string
): Promise<EnvironmentStatus> {
  return invoke<EnvironmentStatus>("get_environment_status", { environmentId });
}

// --- Terminal Commands ---

export async function attachTerminal(
  containerId: string,
  cols: number,
  rows: number
): Promise<string> {
  return invoke<string>("attach_terminal", { containerId, cols, rows });
}

export interface TerminalSessionCreateResult {
  sessionId: string;
  created: boolean;
  bootstrapped: boolean;
}

function parseTerminalSessionCreateResult(
  value: unknown,
): TerminalSessionCreateResult {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { sessionId?: unknown }).sessionId !== "string" ||
    (value as { sessionId: string }).sessionId.length === 0 ||
    typeof (value as { created?: unknown }).created !== "boolean" ||
    (
      (value as { bootstrapped?: unknown }).bootstrapped !== undefined &&
      typeof (value as { bootstrapped?: unknown }).bootstrapped !== "boolean"
    )
  ) {
    throw new Error("Backend returned an invalid terminal session result");
  }
  return {
    ...(value as Omit<TerminalSessionCreateResult, "bootstrapped">),
    // Compatibility with the previous backend for one release.
    bootstrapped: (value as { bootstrapped?: boolean }).bootstrapped ?? false,
  };
}

export async function createTerminalSession(
  containerId: string,
  cols: number,
  rows: number,
  user?: string,
  trackEnvironmentActivity = false,
  environmentId?: string,
  terminalKey?: string,
): Promise<TerminalSessionCreateResult> {
  const result = await invoke<unknown>("create_terminal_session", {
    containerId,
    cols,
    rows,
    user,
    trackEnvironmentActivity,
    environmentId,
    terminalKey,
  });
  return parseTerminalSessionCreateResult(result);
}

export async function startTerminalSession(sessionId: string): Promise<void> {
  return invoke("start_terminal_session", { sessionId });
}

export interface TerminalSessionStatus {
  id: string;
  running: boolean;
  bootstrapped?: boolean;
}

export interface BootstrapTerminalResult {
  bootstrapped: boolean;
  delivered: boolean;
  duplicate: boolean;
}

export async function bootstrapTerminalSession(
  sessionId: string,
  data: string,
): Promise<BootstrapTerminalResult> {
  return invoke<BootstrapTerminalResult>("bootstrap_terminal_session", {
    sessionId,
    data,
  });
}

export async function getTerminalSession(
  sessionId: string
): Promise<TerminalSessionStatus> {
  return invoke<TerminalSessionStatus>("get_terminal_session", { sessionId });
}

export async function getTerminalOutputBuffer(sessionId: string): Promise<string> {
  return invoke<string>("get_terminal_output_buffer", { sessionId });
}

export interface TerminalOutputSnapshot {
  mode?: "full" | "delta";
  reason?: "expired" | "generation-changed";
  output: string;
  revision: number;
  generation: number;
  truncated: boolean;
}

export interface TerminalOutputEvent {
  text: string;
  revision: number;
  generation: number;
}

export async function getTerminalOutputSnapshot(
  sessionId: string,
  cursor?: { revision: number; generation: number },
): Promise<TerminalOutputSnapshot> {
  const value = await invoke<unknown>("get_terminal_output_snapshot", {
    sessionId,
    ...(cursor
      ? { sinceRevision: cursor.revision, sinceGeneration: cursor.generation }
      : {}),
  });
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { output?: unknown }).output !== "string" ||
    !Number.isSafeInteger((value as { revision?: unknown }).revision) ||
    (value as { revision: number }).revision < 0 ||
    !Number.isSafeInteger((value as { generation?: unknown }).generation) ||
    (value as { generation: number }).generation < 0 ||
    (
      (value as { truncated?: unknown }).truncated !== undefined &&
      typeof (value as { truncated?: unknown }).truncated !== "boolean"
    )
  ) {
    throw new Error("Backend returned an invalid terminal output snapshot");
  }
  return {
    mode: (value as { mode?: "full" | "delta" }).mode,
    reason: (value as { reason?: "expired" | "generation-changed" }).reason,
    output: (value as { output: string }).output,
    revision: (value as { revision: number }).revision,
    generation: (value as { generation: number }).generation,
    // Accept older desktop backends during rolling upgrades.
    truncated: (value as { truncated?: boolean }).truncated ?? false,
  };
}

export async function awaitEnvironmentSetupSession(
  environmentId: string,
  timeoutMs = 15_000,
): Promise<EnvironmentSetupSession | null> {
  return invoke<EnvironmentSetupSession | null>("await_environment_setup_session", {
    environmentId,
    timeoutMs,
  });
}

export async function detachTerminal(sessionId: string): Promise<void> {
  return invoke("detach_terminal", { sessionId });
}

export async function teardownTab(input: TabTeardownInput): Promise<{ completed: boolean }> {
  return invoke("teardown_tab", { ...input });
}

export async function writeTerminal(
  sessionId: string,
  data: string
): Promise<void> {
  return invoke("terminal_write", { sessionId, data });
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("terminal_resize", { sessionId, cols, rows });
}

// --- Configuration Commands ---

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export interface AgentModelCatalogCache {
  schemaVersion: 1;
  claude?: {
    updatedAt: string;
    models: ClaudeModelCatalogSnapshot["models"];
  };
  codex?: {
    updatedAt: string;
    models: CodexModel[];
  };
  cursor?: {
    updatedAt: string;
    models: AgentModel[];
  };
  grok?: {
    updatedAt: string;
    models: AgentModel[];
  };
}

/** Load the host-wide last-known-good catalogues before any bridge starts. */
export async function getAgentModelCatalogCache(): Promise<AgentModelCatalogCache> {
  return invoke<AgentModelCatalogCache>("get_agent_model_catalog_cache");
}

/** Backend-normalized model catalogue consumed by the provider-neutral composer. */
export async function getNativeAgentModelCatalog(
  environmentId: string,
): Promise<import("@orkestrator/protocol/native-agent").AgentModel[]> {
  return invoke("get_native_agent_model_catalog", { environmentId });
}

/** Persist an authoritative catalogue for the next application launch. */
export async function cacheAgentModelCatalog(
  agent: "claude" | "codex",
  models: ClaudeModelCatalogSnapshot["models"] | CodexModel[],
): Promise<AgentModelCatalogCache> {
  return invoke<AgentModelCatalogCache>("cache_agent_model_catalog", {
    agent,
    models,
  });
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function getGlobalConfig(): Promise<GlobalConfig> {
  return invoke<GlobalConfig>("get_global_config");
}

export async function updateGlobalConfig(global: GlobalConfig): Promise<AppConfig> {
  return invoke<AppConfig>("update_global_config", { global });
}

export async function updateAgentModelDefault(
  key: "claudeModel" | "codexModel" | "opencodeModel",
  modelId: string,
): Promise<AppConfig> {
  return invoke<AppConfig>("update_agent_model_default", { key, modelId });
}

export async function setGitHubToken(token: string | null): Promise<AppConfig> {
  return invoke<AppConfig>("set_github_token", { token });
}

export async function setCursorApiKey(apiKey: string | null): Promise<AppConfig> {
  return invoke<AppConfig>("set_cursor_api_key", { apiKey });
}

export async function getWebClientStatus(): Promise<WebClientStatus> {
  if (window.orkestrator?.webClient) {
    return window.orkestrator.webClient.getStatus();
  }
  if (window.orkestratorGateway?.enabled) {
    return {
      enabled: true,
      running: true,
      url: `${getGatewayBaseUrl()}/`,
      error: null,
    };
  }
  throw new Error("Web client controls are only available in the desktop app");
}

export async function setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
  if (!window.orkestrator?.webClient) {
    throw new Error("Web client controls are only available in the desktop app");
  }
  return window.orkestrator.webClient.setEnabled(enabled);
}

export async function resetWebClientServe(): Promise<WebClientStatus> {
  if (!window.orkestrator?.webClient || window.orkestratorGateway?.enabled) {
    throw new Error("Tailscale Serve reset is only available for the local desktop app");
  }
  return window.orkestrator.webClient.resetServe();
}

export async function getGatewayTokenSettings(): Promise<GatewayTokenSettings> {
  if (!window.orkestrator?.webClient) {
    throw new Error("Gateway token settings are unavailable");
  }
  return window.orkestrator.webClient.getTokenSettings();
}

export async function setGatewayToken(token: string): Promise<GatewayTokenSettings> {
  if (!window.orkestrator?.webClient) {
    throw new Error("Gateway token settings are unavailable");
  }
  return window.orkestrator.webClient.setToken(token);
}

export async function getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
  return invoke<RepositoryConfig>("get_repository_config", { projectId });
}

export async function updateRepositoryConfig(
  projectId: string,
  repoConfig: RepositoryConfig
): Promise<AppConfig> {
  return invoke<AppConfig>("update_repository_config", { projectId, repoConfig });
}

export async function getLogDirectory(): Promise<string> {
  return invoke<string>("get_log_directory");
}

// --- Linear Commands ---

export async function getLinearConnection(): Promise<LinearConnectionStatus> {
  return invoke<LinearConnectionStatus>("get_linear_connection");
}

export async function connectLinear(apiKey: string): Promise<LinearConnectionStatus> {
  return invoke<LinearConnectionStatus>("connect_linear", { apiKey });
}

export async function disconnectLinear(): Promise<LinearConnectionStatus> {
  return invoke<LinearConnectionStatus>("disconnect_linear");
}

export async function getLinearIssues(): Promise<LinearIssueListItem[]> {
  return invoke<LinearIssueListItem[]>("get_linear_issues");
}

export async function getLinearIssue(issueId: string): Promise<LinearIssueDetail> {
  return invoke<LinearIssueDetail>("get_linear_issue", { issueId });
}

export async function postLinearIssueComment(issueId: string, body: string): Promise<LinearIssueComment> {
  return invoke<LinearIssueComment>("post_linear_issue_comment", { issueId, body });
}

export async function postLinearCompletionComment(
  pipelineId: string,
  issueId: string,
  body: string,
): Promise<LinearCompletionCommentResult> {
  return invoke<LinearCompletionCommentResult>("post_linear_completion_comment", { pipelineId, issueId, body });
}

export async function getGitHubIssues(projectId: string): Promise<GitHubIssuesSnapshot> {
  return invoke<GitHubIssuesSnapshot>("get_github_issues", { projectId });
}

export async function getGitHubIssue(
  projectId: string,
  issueNumber: number,
): Promise<GitHubIssueDetail> {
  return invoke<GitHubIssueDetail>("get_github_issue", { projectId, issueNumber });
}

export async function updateGitHubIssue(
  projectId: string,
  issueNumber: number,
  updates: { title: string; body: string },
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("update_github_issue", { projectId, issueNumber, ...updates });
}

export async function updateGitHubIssueStatus(
  projectId: string,
  issueNumber: number,
  status: GitHubIssueStatus,
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("update_github_issue_status", { projectId, issueNumber, status });
}

export async function closeGitHubIssue(
  projectId: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("close_github_issue", { projectId, issueNumber });
}

export async function addGitHubIssueComment(
  projectId: string,
  issueNumber: number,
  body: string,
): Promise<GitHubIssueComment> {
  return invoke<GitHubIssueComment>("add_github_issue_comment", { projectId, issueNumber, body });
}

export async function updateGitHubIssueComment(
  projectId: string,
  issueNumber: number,
  commentId: number,
  body: string,
): Promise<GitHubIssueComment> {
  return invoke<GitHubIssueComment>("update_github_issue_comment", {
    projectId,
    issueNumber,
    commentId,
    body,
  });
}

export interface GitHubCompletionCommentResult {
  status: "posted" | "already-posted";
  commentId: string;
  postedAt?: string;
}

export async function postGitHubCompletionComment(
  pipelineId: string,
  projectId: string,
  repositoryOwner: string,
  repositoryName: string,
  issueNumber: number,
  body: string,
): Promise<GitHubCompletionCommentResult> {
  return invoke<GitHubCompletionCommentResult>("post_github_completion_comment", {
    pipelineId,
    projectId,
    repositoryOwner,
    repositoryName,
    issueNumber,
    body,
  });
}

// --- GitHub Commands ---

export async function openInBrowser(url: string): Promise<void> {
  // Browser clients open links locally. Electron marks gateway metadata as a
  // desktop connection so a remote-backend session still uses the native
  // system-browser command instead of a renderer-created window.
  if (
    window.orkestratorGateway?.enabled &&
    !window.orkestratorGateway.desktop
  ) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  return invoke("open_in_browser", { url });
}

export async function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

export async function getEnvironmentPrUrl(environmentId: string): Promise<string | null> {
  return invoke<string | null>("get_environment_pr_url", { environmentId });
}

export interface VerifiedEnvironmentPr {
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN";
}

export async function verifyEnvironmentPr(
  environmentId: string,
  prUrl: string,
  targetBranch: string,
): Promise<VerifiedEnvironmentPr> {
  return invoke<VerifiedEnvironmentPr>("verify_environment_pr", {
    environmentId,
    prUrl,
    targetBranch,
  });
}

export async function clearEnvironmentPr(environmentId: string): Promise<void> {
  return invoke("clear_environment_pr", { environmentId });
}

export async function setEnvironmentPr(
  environmentId: string,
  prUrl: string,
  prState: PrState,
  hasMergeConflicts: boolean | null
): Promise<Environment> {
  return invoke<Environment>("set_environment_pr", { environmentId, prUrl, prState, hasMergeConflicts });
}

export async function overrideEnvironmentSetup(environmentId: string): Promise<Environment> {
  return invoke<Environment>("override_environment_setup", { environmentId });
}

export async function runEnvironmentSetup(environmentId: string): Promise<Environment> {
  return invoke<Environment>("run_environment_setup", { environmentId });
}

export async function ensureEnvironmentSetup(environmentId: string): Promise<EnsureEnvironmentSetupResult> {
  return invoke<EnsureEnvironmentSetupResult>("ensure_environment_setup", { environmentId });
}

/** Detect PR URL and state for the environment's branch (uses --head to check correct branch) */
export async function detectPr(containerId: string, branch: string): Promise<PrDetectionResult | null> {
  return invoke<PrDetectionResult | null>("detect_pr", { containerId, branch });
}

/** Detect PR URL and state for local (worktree-based) environments (uses --head to check correct branch) */
export async function detectPrLocal(environmentId: string, branch: string): Promise<PrDetectionResult | null> {
  return invoke<PrDetectionResult | null>("detect_pr_local", { environmentId, branch });
}

/** Merge method options for PR merging */
export type MergeMethod = "squash" | "merge" | "rebase";

export interface MergePrResult {
  outcome: "merged" | "pending" | "unknown";
}

export interface MergeEnvironmentPrResult extends MergePrResult {
  cleanupOutcome: "not-requested" | "pending" | "completed" | "failed";
  cleanupError?: string;
}

/**
 * Backend-owned merge workflow. The environment id is authoritative for both
 * local and container execution, and an optional cleanup follow-up is persisted
 * before GitHub is invoked.
 */
export async function mergeEnvironmentPr(
  environmentId: string,
  method?: MergeMethod,
  deleteBranch?: boolean,
  cleanupAfterMerge?: boolean,
): Promise<MergeEnvironmentPrResult> {
  return invoke<MergeEnvironmentPrResult>("merge_environment_pr", {
    environmentId,
    method,
    deleteBranch,
    cleanupAfterMerge,
  });
}

/** Submit and verify the current branch's PR merge from its container */
export async function mergePr(
  containerId: string,
  method?: MergeMethod,
  deleteBranch?: boolean
): Promise<MergePrResult> {
  return invoke<MergePrResult>("merge_pr", { containerId, method, deleteBranch });
}

/** Merge the local environment's PR through the GitHub API */
export async function mergePrLocal(
  environmentId: string,
  method?: MergeMethod,
  deleteBranch?: boolean
): Promise<MergePrResult> {
  return invoke<MergePrResult>("merge_pr_local", { environmentId, method, deleteBranch });
}

// --- Docker Commands ---

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

export async function dockerContainerStatus(
  containerId: string
): Promise<EnvironmentStatus> {
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
  name?: string
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
export async function getContainerHostPort(containerId: string, containerPort: number): Promise<number | null> {
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
  return invoke<OpenCodeModelCatalogSnapshot | null>(
    "get_opencode_model_catalog_cache",
    { projectId },
  );
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
function toCachedOpenCodeModel(
  model: CachedOpenCodeModel,
): CachedOpenCodeModel {
  const variants = Array.isArray(model.variants)
    ? model.variants.filter(
        (variant) => typeof variant === "string" && variant.trim().length > 0,
      )
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

export const AGENT_SKILL_PROVIDERS = ["claude", "codex", "opencode"] as const;
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

export async function testDomainResolution(
  domains: string[]
): Promise<DomainTestResult[]> {
  return invoke<DomainTestResult[]>("test_domain_resolution", { domains });
}

export async function validateDomains(
  domains: string[]
): Promise<DomainTestResult[]> {
  return invoke<DomainTestResult[]>("validate_domains", { domains });
}

export async function addEnvironmentDomains(
  environmentId: string,
  domains: string[]
): Promise<string> {
  return invoke<string>("add_environment_domains", { environmentId, domains });
}

export async function removeEnvironmentDomains(
  environmentId: string,
  domains: string[]
): Promise<string> {
  return invoke<string>("remove_environment_domains", { environmentId, domains });
}

export async function updateEnvironmentAllowedDomains(
  environmentId: string,
  domains: string[]
): Promise<Environment> {
  return invoke<Environment>("update_environment_allowed_domains", { environmentId, domains });
}

// --- Editor Commands ---

/** Open an editor (VS Code or Cursor) attached to a running container */
export async function openInEditor(
  containerId: string,
  editor: PreferredEditor
): Promise<void> {
  return invoke("open_in_editor", { containerId, editor });
}

/** Open an editor (VS Code or Cursor) for a local directory path */
export async function openLocalInEditor(
  path: string,
  editor: PreferredEditor
): Promise<void> {
  return invoke("open_local_in_editor", { path, editor });
}

// --- File Commands ---

/** Represents a file changed in git */
export interface GitFileChange {
  path: string;
  originalPath?: string;
  filename: string;
  directory: string;
  additions: number;
  deletions: number;
  status: string;
}

/** Represents a node in the file tree */
export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  extension?: string;
}

/** File content with metadata */
export interface FileContent {
  path: string;
  content: string;
  language: string;
}

export interface ConditionalSnapshot<T> {
  unchanged: boolean;
  digest: string;
  value?: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConditionalArraySnapshot<T>(
  response: unknown,
  command: string,
): ConditionalSnapshot<T[]> {
  // Older backends ignore knownDigest and return the original raw array.
  if (Array.isArray(response)) {
    return { unchanged: false, digest: "", value: response as T[] };
  }
  if (
    !isRecord(response)
    || typeof response.unchanged !== "boolean"
    || typeof response.digest !== "string"
    || (!response.unchanged && !Array.isArray(response.value))
    || (response.unchanged && response.value !== undefined)
  ) {
    throw new Error(`Invalid ${command} response`);
  }
  return response as unknown as ConditionalSnapshot<T[]>;
}

/** Get git changes comparing current state against a target branch */
export async function getGitStatus(
  containerId: string,
  targetBranch: string,
  includeUncommitted = true,
): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>("get_git_status", {
    containerId,
    targetBranch,
    includeUncommitted,
  });
}

export async function getGitStatusSnapshot(
  containerId: string,
  targetBranch: string,
  knownDigest?: string,
): Promise<ConditionalSnapshot<GitFileChange[]>> {
  const response = await invoke<unknown>("get_git_status", {
    containerId,
    targetBranch,
    includeUncommitted: true,
    knownDigest: knownDigest ?? "",
  });
  return normalizeConditionalArraySnapshot<GitFileChange>(
    response,
    "get_git_status",
  );
}

/** Get workspace file tree from a container */
export async function getFileTree(containerId: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("get_file_tree", { containerId });
}

export async function getFileTreeSnapshot(
  containerId: string,
  knownDigest?: string,
): Promise<ConditionalSnapshot<FileNode[]>> {
  const response = await invoke<unknown>("get_file_tree", {
    containerId,
    knownDigest: knownDigest ?? "",
  });
  return normalizeConditionalArraySnapshot<FileNode>(response, "get_file_tree");
}

/** Read a file from inside a container */
export async function readContainerFile(
  containerId: string,
  filePath: string
): Promise<FileContent> {
  return invoke<FileContent>("read_container_file", { containerId, filePath });
}

/** Read a file from a specific git branch inside a container
 * Returns null if the file doesn't exist in the specified branch (e.g., new file)
 */
export async function readFileAtBranch(
  containerId: string,
  filePath: string,
  branch: string
): Promise<FileContent | null> {
  return invoke<FileContent | null>("read_file_at_branch", {
    containerId,
    filePath,
    branch,
  });
}

/** Read a binary file from inside a container as base64 */
export async function readContainerFileBase64(
  containerId: string,
  filePath: string
): Promise<string> {
  return invoke<string>("read_container_file_base64", { containerId, filePath });
}

/** Write a file to inside a container from base64-encoded data */
export async function writeContainerFile(
  containerId: string,
  filePath: string,
  base64Data: string
): Promise<string> {
  return invoke<string>("write_container_file", { containerId, filePath, base64Data });
}

export interface InitialPromptAttachmentWrite {
  id: string;
  name: string;
  base64Data: string;
}

export interface SavedInitialPromptAttachment {
  name: string;
  path: string;
}

/** Persist an initial-prompt attachment batch atomically inside its environment. */
export async function writeInitialPromptAttachments(
  environmentId: string,
  attachments: InitialPromptAttachmentWrite[],
): Promise<SavedInitialPromptAttachment[]> {
  return invoke<SavedInitialPromptAttachment[]>("write_initial_prompt_attachments", {
    environmentId,
    attachments,
  });
}

/** Restore a container file to its state at the target branch or commit. */
export async function revertContainerFile(
  environmentId: string,
  filePath: string,
  targetBranch: string
): Promise<string> {
  return invoke<string>("revert_container_file", { environmentId, filePath, targetBranch });
}

/** Delete a container file and stage the deletion when it is tracked by Git. */
export async function deleteContainerFile(
  environmentId: string,
  filePath: string
): Promise<string> {
  return invoke<string>("delete_container_file", { environmentId, filePath });
}

// --- Local Environment File Commands ---

/** Get git changes for a local environment (worktree path) */
export async function getLocalGitStatus(
  worktreePath: string,
  targetBranch: string,
  includeUncommitted = true,
): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>("get_local_git_status", {
    worktreePath,
    targetBranch,
    includeUncommitted,
  });
}

export async function getLocalGitStatusSnapshot(
  worktreePath: string,
  targetBranch: string,
  knownDigest?: string,
): Promise<ConditionalSnapshot<GitFileChange[]>> {
  const response = await invoke<unknown>("get_local_git_status", {
    worktreePath,
    targetBranch,
    includeUncommitted: true,
    knownDigest: knownDigest ?? "",
  });
  return normalizeConditionalArraySnapshot<GitFileChange>(
    response,
    "get_local_git_status",
  );
}

/**
 * Authoritative diff-stat snapshot for every environment the backend tracks.
 *
 * The counts are computed in the backend, once, and announced over
 * `DIFF_STATS_CHANGED_EVENT`. This is the rehydration path a client uses when it
 * mounts or reconnects, because the event stream has no replay buffer.
 */
export async function getEnvironmentDiffStats(): Promise<EnvironmentDiffStatsSnapshot> {
  return invoke<EnvironmentDiffStatsSnapshot>("get_environment_diff_stats");
}

/** Forces an immediate rescan, e.g. after an operation that changed the tree. */
export async function refreshEnvironmentDiffStats(environmentId: string): Promise<void> {
  return invoke<void>("refresh_environment_diff_stats", { environmentId });
}

/**
 * Authoritative snapshot of the backend PR monitor. Read on mount and on every
 * event-stream reconnect; also arms monitoring on a freshly started backend.
 */
export async function getPrMonitorState(): Promise<PrMonitorSnapshot> {
  return invoke<PrMonitorSnapshot>("get_pr_monitor_state");
}

/**
 * Requests a monitoring mode for an environment (create-pending after the
 * Create PR button, merge-pending after Merge). Durable in the backend, so the
 * fast polling continues across renderer reloads and environment switches.
 */
export async function prMonitorWatch(environmentId: string, mode: PrMonitorMode): Promise<void> {
  return invoke<void>("pr_monitor_watch", { environmentId, mode });
}

/** Requests an immediate PR check for an environment already being monitored. */
export async function prMonitorRefresh(environmentId: string): Promise<void> {
  return invoke<void>("pr_monitor_refresh", { environmentId });
}

/** Durably re-check a conflicting PR when the launched agent turn completes. */
export async function armPrRefreshAfterAgentCompletion(
  environmentId: string,
): Promise<string | null> {
  return invoke<string | null>("arm_pr_refresh_after_agent_completion", { environmentId });
}

/** Roll back one exact post-completion refresh arm when its agent launch fails. */
export async function disarmPrRefreshAfterAgentCompletion(
  environmentId: string,
  armedAt: string,
): Promise<void> {
  return invoke<void>("disarm_pr_refresh_after_agent_completion", {
    environmentId,
    armedAt,
  });
}

/** Get file tree from a local environment (worktree path) */
export async function getLocalFileTree(worktreePath: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("get_local_file_tree", { worktreePath });
}

export async function getLocalFileTreeSnapshot(
  worktreePath: string,
  knownDigest?: string,
): Promise<ConditionalSnapshot<FileNode[]>> {
  const response = await invoke<unknown>("get_local_file_tree", {
    worktreePath,
    knownDigest: knownDigest ?? "",
  });
  return normalizeConditionalArraySnapshot<FileNode>(
    response,
    "get_local_file_tree",
  );
}

/** Read a file from a local environment (worktree path) */
export async function readLocalFile(
  worktreePath: string,
  filePath: string
): Promise<FileContent> {
  return invoke<FileContent>("read_local_file", { worktreePath, filePath });
}

/** Read a file from a specific git branch in a local environment
 * Returns null if the file doesn't exist in the specified branch (e.g., new file)
 */
export async function readLocalFileAtBranch(
  worktreePath: string,
  filePath: string,
  branch: string
): Promise<FileContent | null> {
  return invoke<FileContent | null>("read_local_file_at_branch", {
    worktreePath,
    filePath,
    branch,
  });
}

/** Write a file to a local environment (worktree path) from base64-encoded data */
export async function writeLocalFile(
  worktreePath: string,
  filePath: string,
  base64Data: string
): Promise<string> {
  return invoke<string>("write_local_file", { worktreePath, filePath, base64Data });
}

/** Restore a local file to its state at the target branch or commit. */
export async function revertLocalFile(
  environmentId: string,
  filePath: string,
  targetBranch: string
): Promise<string> {
  return invoke<string>("revert_local_file", { environmentId, filePath, targetBranch });
}

/** Delete a local file and stage the deletion when it is tracked by Git. */
export async function deleteLocalFile(
  environmentId: string,
  filePath: string
): Promise<string> {
  return invoke<string>("delete_local_file", { environmentId, filePath });
}

// --- Port Mapping Commands ---

/** Update port mappings for an environment (requires restart to apply) */
export async function updatePortMappings(
  environmentId: string,
  portMappings: PortMapping[]
): Promise<Environment> {
  return invoke<Environment>("update_port_mappings", {
    environmentId,
    portMappings,
  });
}

/** Update per-environment agent settings (pass null to use global defaults) */
export async function updateEnvironmentAgentSettings(
  environmentId: string,
  defaultAgent: DefaultAgent | null,
  claudeMode: ClaudeMode | null,
  claudeNativeBackend: ClaudeNativeBackend | null,
  opencodeMode: OpenCodeMode | null,
  codexMode: CodexMode | null,
  pendingAgentLaunch?: boolean,
  initialAgentModel?: string,
  initialReasoningEffort?: string,
  initialPromptAttachments?: InitialPromptImageAttachment[],
): Promise<Environment> {
  return invoke<Environment>("update_environment_agent_settings", {
    environmentId,
    defaultAgent,
    claudeMode,
    claudeNativeBackend,
    opencodeMode,
    codexMode,
    ...(typeof pendingAgentLaunch === "boolean" ? { pendingAgentLaunch } : {}),
    ...(initialAgentModel ? { initialAgentModel } : {}),
    ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
    ...(initialPromptAttachments ? { initialPromptAttachments } : {}),
  });
}

/** Persist or clear the post-setup agent launch intent. */
export async function setEnvironmentPendingAgentLaunch(
  environmentId: string,
  pending: boolean,
): Promise<Environment> {
  return invoke<Environment>("set_environment_pending_agent_launch", {
    environmentId,
    pending,
  });
}

/** Acknowledge that the backend-created startup session now has a durable tab. */
export async function acknowledgeStartupAgentSession(
  environmentId: string,
  startupSession: {
    providerSessionId?: string;
    startedAt?: string;
  },
): Promise<Environment> {
  return invoke<Environment>("acknowledge_startup_agent_session", {
    environmentId,
    ...(startupSession.providerSessionId
      ? { providerSessionId: startupSession.providerSessionId }
      : {}),
    ...(startupSession.startedAt ? { startedAt: startupSession.startedAt } : {}),
  });
}

/**
 * Persist the initial prompt after the renderer has rewritten it (for example to
 * add references to uploaded attachments), so a recovered launch reads the same
 * prompt the uninterrupted path would have used.
 */
export async function setEnvironmentInitialPrompt(
  environmentId: string,
  initialPrompt: string,
  initialPromptAttachments?: InitialPromptImageAttachment[],
): Promise<Environment> {
  return invoke<Environment>("set_environment_initial_prompt", {
    environmentId,
    initialPrompt,
    ...(initialPromptAttachments ? { initialPromptAttachments } : {}),
  });
}

export type AgentExtensionId = "claude" | "codex" | "opencode";

export interface AgentExtensionItem {
  name: string;
  status: "connected" | "configured" | "disabled" | "failed" | "pending";
  source?: string;
}

export interface AgentExtensionCatalog {
  agent: AgentExtensionId;
  mcpServers: AgentExtensionItem[];
  plugins: AgentExtensionItem[];
  mcpError?: string;
  pluginError?: string;
}

/**
 * Read the effective MCP and plugin configuration for every supported agent.
 *
 * The backend caches per environment because discovery health-checks (and so
 * spawns) the configured MCP servers. Pass `refresh` for an explicit reload.
 */
export async function getEnvironmentExtensions(
  environmentId: string,
  options: { refresh?: boolean } = {},
): Promise<AgentExtensionCatalog[]> {
  return invoke<AgentExtensionCatalog[]>("get_environment_extensions", {
    environmentId,
    refresh: options.refresh === true,
  });
}

// --- Session Commands (Persistent Session Tracking) ---

/** Create a new persistent session for tracking */
export async function createSession(
  environmentId: string,
  containerId: string,
  tabId: string,
  sessionType: SessionType
): Promise<Session> {
  return invoke<Session>("create_session", {
    environmentId,
    containerId,
    tabId,
    sessionType,
  });
}

/** Get a single session by ID */
export async function getSession(sessionId: string): Promise<Session | null> {
  return invoke<Session | null>("get_session", { sessionId });
}

/** Get all sessions for an environment */
export async function getSessionsByEnvironment(
  environmentId: string
): Promise<Session[]> {
  return invoke<Session[]>("get_sessions_by_environment", { environmentId });
}

/** Update session status (connected/disconnected) */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<Session> {
  return invoke<Session>("update_session_status", { sessionId, status });
}

/** Update session's last activity timestamp */
export async function updateSessionActivity(
  sessionId: string
): Promise<Session> {
  return invoke<Session>("update_session_activity", { sessionId });
}

/** Delete a session */
export async function deleteSession(sessionId: string): Promise<void> {
  return invoke("delete_session", { sessionId });
}

/** Delete all sessions for an environment */
export async function deleteSessionsByEnvironment(
  environmentId: string
): Promise<string[]> {
  return invoke<string[]>("delete_sessions_by_environment", { environmentId });
}

/** Rename a session */
export async function renameSession(
  sessionId: string,
  name: string | null
): Promise<Session> {
  return invoke<Session>("rename_session", { sessionId, name });
}

/** Mark all sessions for an environment as disconnected */
export async function disconnectEnvironmentSessions(
  environmentId: string
): Promise<Session[]> {
  return invoke<Session[]>("disconnect_environment_sessions", { environmentId });
}

/** Save a session's terminal buffer to a separate file */
export async function saveSessionBuffer(
  sessionId: string,
  buffer: string
): Promise<void> {
  return invoke("save_session_buffer", { sessionId, buffer });
}

/** Load a session's terminal buffer from file */
export async function loadSessionBuffer(
  sessionId: string
): Promise<string | null> {
  return invoke<string | null>("load_session_buffer", { sessionId });
}

/** Sync sessions for an environment with container state */
export async function syncSessionsWithContainer(
  environmentId: string,
  containerRunning: boolean
): Promise<Session[]> {
  return invoke<Session[]>("sync_sessions_with_container", {
    environmentId,
    containerRunning,
  });
}

/** Reorder sessions within an environment */
export async function reorderSessions(
  environmentId: string,
  sessionIds: string[]
): Promise<Session[]> {
  return invoke<Session[]>("reorder_sessions", { environmentId, sessionIds });
}

/** Clean up orphaned buffer files (buffers without corresponding sessions) */
export async function cleanupOrphanedBuffers(): Promise<string[]> {
  return invoke<string[]>("cleanup_orphaned_buffers", {});
}

// --- Pane Layout Commands (Restore-on-connect) ---

export async function getPaneLayout(
  environmentId: string,
): Promise<PersistedPaneLayout | null> {
  return invoke<PersistedPaneLayout | null>("get_pane_layout", { environmentId });
}

export async function savePaneLayout(
  environmentId: string,
  layout: PersistedPaneLayoutInput,
  expectedRevision: number,
): Promise<PersistedPaneLayout> {
  return invoke<PersistedPaneLayout>("save_pane_layout", {
    environmentId,
    layout,
    expectedRevision,
  });
}

export async function applyPaneLayoutIntent(
  environmentId: string,
  baseLayout: PersistedPaneLayoutInput,
  desiredLayout: PersistedPaneLayoutInput,
  selectionIntent?: import("@orkestrator/protocol/pane-layout-merge").PaneLayoutSelectionIntent,
): Promise<PersistedPaneLayout> {
  return invoke<PersistedPaneLayout>("apply_pane_layout_intent", {
    environmentId,
    baseLayout,
    desiredLayout,
    ...(selectionIntent ? { selectionIntent } : {}),
  });
}

export async function deletePaneLayout(
  environmentId: string,
  expectedRevision?: number,
): Promise<void> {
  return invoke("delete_pane_layout", {
    environmentId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

// --- Looped Code Review Workflow Commands ---

export async function startLoopedReview(
  input: StartLoopedReviewInput,
): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("start_looped_review", { ...input });
}

export async function pauseLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("pause_looped_review", { workflowId });
}

export async function resumeLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("resume_looped_review", { workflowId });
}

export async function retryLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("retry_looped_review", { workflowId });
}

export async function cancelLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("cancel_looped_review", { workflowId });
}

export async function getLoopedReviewProviderSession(
  workflowId: string,
  sessionId?: string,
): Promise<{ providerSessionId: string } | null> {
  return invoke("get_looped_review_provider_session", {
    workflowId,
    // Only an *absent* session id means "use the active session". A blank one
    // is a caller bug, and silently substituting the active session would open
    // the wrong provider transcript rather than reporting it.
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

export async function getLoopedReviewWorkflow<T = unknown>(
  workflowId: string,
): Promise<PersistedLoopedReviewWorkflow<T> | null> {
  return invoke<PersistedLoopedReviewWorkflow<T> | null>(
    "get_looped_review_workflow",
    { workflowId },
  );
}

export async function listLoopedReviewWorkflows<T = unknown>(
  environmentId: string,
): Promise<Array<PersistedLoopedReviewWorkflow<T>>> {
  return invoke<Array<PersistedLoopedReviewWorkflow<T>>>(
    "list_looped_review_workflows",
    { environmentId },
  );
}

export async function saveLoopedReviewWorkflow<T>(
  workflowId: string,
  environmentId: string,
  version: number,
  snapshot: T,
  expectedRevision?: number,
  controllerFence?: { ownerId: string; token: string },
): Promise<PersistedLoopedReviewWorkflow<T>> {
  return invoke<PersistedLoopedReviewWorkflow<T>>(
    "save_looped_review_workflow",
    {
      workflowId,
      environmentId,
      version,
      snapshot,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(controllerFence
        ? {
            controllerOwnerId: controllerFence.ownerId,
            controllerToken: controllerFence.token,
          }
        : {}),
    },
  );
}

export async function deleteLoopedReviewWorkflow(
  workflowId: string,
): Promise<void> {
  return invoke("delete_looped_review_workflow", { workflowId });
}

// --- Multi Review Workflow Commands ---

export async function startMultiReview(
  input: StartMultiReviewInput,
): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("start_multi_review", { ...input });
}

export async function addressMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("address_multi_review", { workflowId });
}

export async function retryMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("retry_multi_review", { workflowId });
}

export async function cancelMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("cancel_multi_review", { workflowId });
}

export async function getMultiReviewWorkflow<T = unknown>(
  workflowId: string,
): Promise<PersistedLoopedReviewWorkflow<T> | null> {
  return invoke<PersistedLoopedReviewWorkflow<T> | null>(
    "get_multi_review_workflow", { workflowId },
  );
}

export async function listMultiReviewWorkflows<T = unknown>(
  environmentId: string,
): Promise<Array<PersistedLoopedReviewWorkflow<T>>> {
  return invoke<Array<PersistedLoopedReviewWorkflow<T>>>(
    "list_multi_review_workflows", { environmentId },
  );
}

export async function getMultiReviewReviewerTranscript(
  workflowId: string,
  reviewerId: string,
): Promise<MultiReviewReviewerTranscript> {
  return invoke<MultiReviewReviewerTranscript>(
    "get_multi_review_reviewer_transcript", { workflowId, reviewerId },
  );
}

export async function deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
  return invoke("delete_multi_review_workflow", { workflowId });
}

// Controller leases are backend-only. The renderer has no caller for
// claim/validate/release, and backend-owned records reject renderer writes, so
// keeping wrappers here would only advertise an API the renderer must not use.

export async function ensureNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
  /**
   * Overrides the mode the phase would imply.
   *
   * Looped-review phases collapse onto `review`, and preparation has to commit
   * changes — a phase-derived read-only session would fail that round.
   */
  sessionMode?: "plan" | "build";
  fastMode?: boolean;
}): Promise<PersistedNativeAgentSession> {
  return invoke<PersistedNativeAgentSession>(
    "ensure_native_agent_session",
    input,
  );
}

export async function adoptNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  providerSessionId: string;
  expectedProviderSessionId?: string;
  model?: string;
  reasoningEffort?: string;
}): Promise<PersistedNativeAgentSession> {
  return invoke<PersistedNativeAgentSession>(
    "adopt_native_agent_session",
    input,
  );
}

export async function getNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
}): Promise<PersistedNativeAgentSession | null> {
  return invoke<PersistedNativeAgentSession | null>(
    "get_native_agent_session",
    input,
  );
}

export async function claimOpenCodeManualPrompt(input: {
  environmentId: string;
  logicalSessionKey: string;
  providerSessionId: string;
  requestId: string;
}): Promise<void> {
  return invoke("claim_opencode_manual_prompt", input);
}

export async function releaseOpenCodeManualPrompt(input: {
  environmentId: string;
  logicalSessionKey: string;
  providerSessionId: string;
  requestId: string;
}): Promise<void> {
  return invoke("release_opencode_manual_prompt", input);
}

export async function dispatchNativeAgentPrompt(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
  prompt: string;
  requestId: string;
  images?: Array<{ filename: string; data: string }>;
  schema?: Record<string, unknown>;
  mode?: "plan" | "build";
  fastMode?: boolean;
}): Promise<PersistedNativeAgentSession> {
  return invoke<PersistedNativeAgentSession>(
    "dispatch_native_agent_prompt",
    input,
  );
}

// --- Build Pipeline Persistence ---

export async function startBuildPipeline(
  input: StartBuildPipelineInput,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("start_build_pipeline", { ...input });
}

export async function pauseBuildPipeline(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("pause_build_pipeline", { pipelineId });
}

export async function resumeBuildPipeline(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("resume_build_pipeline", { pipelineId });
}

export async function cancelBuildPipeline(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("cancel_build_pipeline", { pipelineId });
}

export async function sendBuildPipelineMessage(
  pipelineId: string,
  text: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("send_build_pipeline_message", {
    pipelineId,
    text,
  });
}

export async function retryBuildPipelineReview(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("retry_build_pipeline_review", {
    pipelineId,
  });
}

export async function retryBuildPipelineStage(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("retry_build_pipeline_stage", {
    pipelineId,
  });
}

export async function retryBuildPipelineInteractionFailure(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("retry_build_pipeline_interaction_failure", {
    pipelineId,
  });
}

export async function retryBuildPipelineCompletionComment(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>(
    "retry_build_pipeline_completion_comment",
    { pipelineId },
  );
}

export async function importLegacyBuildPipelines(
  projectId: string,
  snapshots: unknown[],
): Promise<{ importedIds: string[]; skipped: number }> {
  return invoke("import_legacy_build_pipelines", { projectId, snapshots });
}

export async function getBuildPipeline<T = unknown>(
  pipelineId: string,
): Promise<PersistedBuildPipeline<T> | null> {
  return invoke<PersistedBuildPipeline<T> | null>("get_build_pipeline", { pipelineId });
}

export type ConditionalBuildPipeline<T> =
  | { unchanged: true; revision: number }
  | {
      unchanged: false;
      record: PersistedBuildPipeline<T>;
      messagePatches: Array<{
        sessionKey: string;
        baseRevision?: number;
        baseCount?: number;
        startIndex: number;
        revision: number;
        messages: unknown[];
      }>;
    }
  | PersistedBuildPipeline<T>
  | null;

export async function getBuildPipelineConditional<T = unknown>(
  pipelineId: string,
  knownRevision?: number,
  knownSessions?: Record<string, { revision: number; count: number }>,
): Promise<ConditionalBuildPipeline<T>> {
  const response = await invoke<unknown>("get_build_pipeline", {
    pipelineId,
    knownRevision,
    knownSessions,
  });
  if (response === null) return null;
  if (!isRecord(response)) {
    throw new Error("Invalid get_build_pipeline response");
  }
  if (!("unchanged" in response)) {
    if (typeof response.id !== "string") {
      throw new Error("Invalid get_build_pipeline response");
    }
    return response as unknown as PersistedBuildPipeline<T>;
  }
  if (
    response.unchanged === true
    && Number.isSafeInteger(response.revision)
    && (response.revision as number) >= 0
  ) {
    return response as { unchanged: true; revision: number };
  }
  if (
    response.unchanged !== false
    || !isRecord(response.record)
    || typeof response.record.id !== "string"
    || !Array.isArray(response.messagePatches)
    || !response.messagePatches.every((value) => {
      if (!isRecord(value)) return false;
      return typeof value.sessionKey === "string"
        && Number.isSafeInteger(value.startIndex)
        && (value.startIndex as number) >= 0
        && Number.isSafeInteger(value.revision)
        && (value.revision as number) >= 0
        && (value.baseRevision === undefined
          || (Number.isSafeInteger(value.baseRevision)
            && (value.baseRevision as number) >= 0))
        && (value.baseCount === undefined
          || (Number.isSafeInteger(value.baseCount)
            && (value.baseCount as number) >= 0))
        && Array.isArray(value.messages);
    })
  ) {
    throw new Error("Invalid get_build_pipeline response");
  }
  return response as unknown as ConditionalBuildPipeline<T>;
}

export async function listBuildPipelines<T = unknown>(
  projectId: string,
): Promise<Array<PersistedBuildPipeline<T>>> {
  return invoke<Array<PersistedBuildPipeline<T>>>("list_build_pipelines", { projectId });
}

export async function listBuildPipelinesConditional<T = unknown>(
  projectId: string,
  knownRevisions: Record<string, number>,
): Promise<{ ids: string[]; records: Array<PersistedBuildPipeline<T>> }> {
  const response = await invoke<unknown>("list_build_pipelines", {
    projectId,
    knownRevisions,
  });
  // Older backends ignore knownRevisions and return the complete record array.
  if (Array.isArray(response)) {
    if (!response.every((entry) => isRecord(entry) && typeof entry.id === "string")) {
      throw new Error("Invalid list_build_pipelines response");
    }
    return {
      ids: response.map((entry) => entry.id as string),
      records: response as Array<PersistedBuildPipeline<T>>,
    };
  }
  if (
    !isRecord(response)
    || !Array.isArray(response.ids)
    || !response.ids.every((id) => typeof id === "string")
    || !Array.isArray(response.records)
    || !response.records.every((entry) =>
      isRecord(entry) && typeof entry.id === "string"
    )
  ) {
    throw new Error("Invalid list_build_pipelines response");
  }
  return response as unknown as {
    ids: string[];
    records: Array<PersistedBuildPipeline<T>>;
  };
}

export async function deleteBuildPipeline(pipelineId: string): Promise<void> {
  return invoke("delete_build_pipeline", { pipelineId });
}

export async function clearTaskBuildStatus(taskId: string): Promise<{
  task: KanbanTask;
  removedPipelineIds: string[];
}> {
  return invoke("clear_task_build_status", { taskId });
}

/**
 * Marks or clears the environment's unread badge.
 *
 * A dedicated command rather than a general update so two clients racing on the
 * badge cannot clobber each other's unrelated environment fields.
 */
export async function setEnvironmentUnread(
  environmentId: string,
  unread: boolean,
  expectedLastActivityAt?: string | null,
): Promise<Environment> {
  return invoke<Environment>("set_environment_unread", {
    environmentId,
    unread,
    ...(expectedLastActivityAt === undefined ? {} : { expectedLastActivityAt }),
  });
}

// --- Prompt Queues ---

export async function getPromptQueue<T = unknown>(
  queueKey: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("get_prompt_queue", { queueKey });
}

export async function listPromptQueues<T = unknown>(
  environmentId: string,
): Promise<Array<PersistedPromptQueue<T>>> {
  return invoke<Array<PersistedPromptQueue<T>>>("list_prompt_queues", { environmentId });
}

export async function enqueuePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  message: T,
): Promise<PersistedPromptQueue<T>> {
  return invoke<PersistedPromptQueue<T>>("enqueue_prompt_queue_message", {
    queueKey,
    environmentId,
    message,
  });
}

export async function requeuePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  message: T,
): Promise<PersistedPromptQueue<T>> {
  return invoke<PersistedPromptQueue<T>>("requeue_prompt_queue_message", {
    queueKey,
    environmentId,
    message,
  });
}

export async function removePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  messageId: string,
): Promise<{
  removed: T | null;
  queue: PersistedPromptQueue<T> | null;
}> {
  return invoke("remove_prompt_queue_message", {
    queueKey,
    environmentId,
    messageId,
  });
}

export async function movePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  messageId: string,
  direction: "up" | "down",
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("move_prompt_queue_message", {
    queueKey,
    environmentId,
    messageId,
    direction,
  });
}

export async function claimPromptQueueHead<T>(
  queueKey: string,
  environmentId: string,
  expectedMessageId: string,
): Promise<{
  claimed: T | null;
  claimToken: string | null;
  queue: PersistedPromptQueue<T> | null;
}> {
  return invoke("claim_prompt_queue_head", {
    queueKey,
    environmentId,
    expectedMessageId,
  });
}

export async function acknowledgePromptQueueClaim<T>(
  queueKey: string,
  environmentId: string,
  claimToken: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("acknowledge_prompt_queue_claim", {
    queueKey,
    environmentId,
    claimToken,
  });
}

export async function rejectPromptQueueClaim<T>(
  queueKey: string,
  environmentId: string,
  claimToken: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("reject_prompt_queue_claim", {
    queueKey,
    environmentId,
    claimToken,
  });
}

export async function transferPromptQueueMessageToComposeDraft<T>(
  queueKey: string,
  environmentId: string,
  messageId: string,
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  expectedDraftRevision?: number,
): Promise<{
  removed: T | null;
  queue: PersistedPromptQueue<T> | null;
  draft: PersistedComposeDraft | null;
}> {
  return invoke("transfer_prompt_queue_message_to_compose_draft", {
    queueKey,
    environmentId,
    messageId,
    draftKey,
    ownerType,
    ownerId,
    ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
  });
}

export async function retryPromptQueueDispatch<T = unknown>(
  queueKey: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>(
    "retry_prompt_queue_dispatch",
    { queueKey },
  );
}

// --- Unsent drafts ---

export async function getComposeDraft<T = unknown>(
  draftKey: string,
): Promise<PersistedComposeDraft<T> | null> {
  return invoke<PersistedComposeDraft<T> | null>("get_compose_draft", { draftKey });
}

export async function listComposeDrafts<T = unknown>(
  ownerType: "environment" | "project",
  ownerId: string,
): Promise<Array<PersistedComposeDraft<T>>> {
  return invoke<Array<PersistedComposeDraft<T>>>("list_compose_drafts", {
    ownerType,
    ownerId,
  });
}

export async function saveComposeDraft<T>(
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: T,
  expectedRevision?: number,
): Promise<PersistedComposeDraft<T>> {
  return invoke<PersistedComposeDraft<T>>("save_compose_draft", {
    draftKey,
    ownerType,
    ownerId,
    value,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function deleteComposeDraft(
  draftKey: string,
  expectedRevision?: number,
): Promise<void> {
  return invoke("delete_compose_draft", {
    draftKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function getFileDraft(
  draftKey: string,
): Promise<PersistedFileDraft | null> {
  return invoke<PersistedFileDraft | null>("get_file_draft", { draftKey });
}

export async function saveFileDraft(
  draftKey: string,
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
  expectedRevision?: number,
): Promise<PersistedFileDraft> {
  return invoke<PersistedFileDraft>("save_file_draft", {
    draftKey,
    environmentId,
    filePath,
    content,
    originalContent,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function deleteFileDraft(
  draftKey: string,
  expectedRevision?: number,
): Promise<void> {
  return invoke("delete_file_draft", {
    draftKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

// --- Agent Handoffs ---

export async function getAgentHandoff<T = unknown>(
  handoffId: string,
): Promise<PersistedAgentHandoff<T> | null> {
  return invoke<PersistedAgentHandoff<T> | null>("get_agent_handoff", { handoffId });
}

export async function saveAgentHandoff<T extends Record<string, unknown>>(
  handoffId: string,
  environmentId: string,
  version: number,
  snapshot: T,
): Promise<PersistedAgentHandoff<T>> {
  return invoke<PersistedAgentHandoff<T>>("save_agent_handoff", {
    handoffId,
    environmentId,
    version,
    snapshot,
  });
}

export async function deleteAgentHandoff(
  handoffId: string,
  environmentId: string,
): Promise<boolean> {
  return invoke<boolean>("delete_agent_handoff", { handoffId, environmentId });
}

/**
 * Deletes every stored handoff for an environment that the restored pane layout
 * no longer references. Self-healing counterpart to the best-effort delete that
 * runs when a tab closes.
 */
export async function pruneAgentHandoffs(
  environmentId: string,
  referencedHandoffIds: string[],
): Promise<string[]> {
  return invoke<string[]>("prune_agent_handoffs", {
    environmentId,
    referencedHandoffIds,
  });
}

// --- Local Server Commands (for local/worktree environments) ---

/** Join the backend-owned startup wait for one environment/provider pair. */
export async function awaitBridgeReady(
  environmentId: string,
  agent: AgentBridgeKind,
  timeoutMs = 60_000,
): Promise<AwaitBridgeReadyResult> {
  const result = await invoke<unknown>("await_bridge_ready", {
    environmentId,
    agent,
    timeoutMs,
  });
  if (!isAwaitBridgeReadyResult(result)) {
    throw new Error("Backend returned an invalid bridge readiness result");
  }
  return result;
}

// --- Local Terminal Commands (for local/worktree environments) ---

/** Create a local terminal session for a local environment */
export async function createLocalTerminalSession(
  environmentId: string,
  cols: number,
  rows: number,
  trackEnvironmentActivity = false,
  terminalKey?: string,
): Promise<TerminalSessionCreateResult> {
  const result = await invoke<unknown>("create_local_terminal_session", {
    environmentId,
    cols,
    rows,
    trackEnvironmentActivity,
    terminalKey,
  });
  return parseTerminalSessionCreateResult(result);
}

/** Start a local terminal session and begin forwarding output */
export async function startLocalTerminalSession(sessionId: string): Promise<void> {
  return invoke("start_local_terminal_session", { sessionId });
}

/** Write data to a local terminal session */
export async function writeLocalTerminal(sessionId: string, data: string): Promise<void> {
  return invoke("local_terminal_write", { sessionId, data });
}

/** Resize a local terminal session */
export async function resizeLocalTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("local_terminal_resize", { sessionId, cols, rows });
}

/** Close a local terminal session */
export async function closeLocalTerminalSession(sessionId: string): Promise<void> {
  return invoke("close_local_terminal_session", { sessionId });
}

// --- File System Utilities ---

/** Read a binary file from the local filesystem as base64 */
export async function readFileBase64(path: string): Promise<string> {
  return invoke<string>("read_file_base64", { filePath: path });
}

/** Read a binary file from the local filesystem (deprecated: use readFileBase64 instead) */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  // Use our custom Electron command instead of the fs plugin (which has permission issues)
  const base64 = await readFileBase64(path);
  // Convert base64 to Uint8Array
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// --- Kanban commands ---

export interface KanbanComment {
  id: string;
  text: string;
  createdAt: string;
}

export interface KanbanImage {
  id: string;
  /** Original filename before WebP conversion */
  filename: string;
  createdAt: string;
}

export type KanbanStatus = "backlog" | "in-progress" | "review" | "done";

export interface KanbanTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: KanbanStatus;
  comments: KanbanComment[];
  images: KanbanImage[];
  createdAt: string;
  order: number;
  /** Linked build environment ID */
  environmentId?: string;
  /** Active build pipeline ID */
  buildPipelineId?: string;
  /** PR URL associated with this task */
  prUrl?: string;
  /** PR state (open, merged, closed) */
  prState?: PrState;
  /** Whether a merge/close comment has already been added */
  prMergeCommented?: boolean;
}

export interface ProjectNotes {
  projectId: string;
  content: string;
  updatedAt: string;
}

export type FeaturePlanStatus = "collecting" | "confirming" | "stories" | "building" | "built";

export interface FeaturePlanMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  /** Backend-confirmed model that produced this assistant response. */
  modelId?: string;
  /** Durable recovery marker for assistant responses that carry plan/story state. */
  stateApplication?: "pending" | "applied" | "superseded";
}

export interface FeatureStoryCard {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  messages: FeaturePlanMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface FeaturePlan {
  id: string;
  projectId: string;
  title: string;
  status: FeaturePlanStatus;
  summary: string;
  messages: FeaturePlanMessage[];
  stories: FeatureStoryCard[];
  createdAt: string;
  updatedAt: string;
  order: number;
  codexEnvironmentId?: string;
  codexSessionId?: string;
  buildTaskId?: string;
  buildPipelineId?: string;
  /**
   * Backend-owned planning exchange currently attached to this plan.
   *
   * Present only while the backend is advancing one, or after it failed and is
   * waiting for the user to retry. The renderer never writes it.
   */
  planning?: FeaturePlanningRecord;
}

/**
 * Hand the user's message to the backend planning supervisor.
 *
 * Everything after this — environment, bridge, session, dispatch, reply, parse,
 * persist — happens backend-side, so closing the view or reloading the page
 * cannot abandon it.
 */
export async function startFeaturePlanning(
  featureId: string,
  kind: FeaturePlanningKind,
  userMessage: string,
  storyId?: string,
): Promise<FeaturePlanningRecord> {
  return invoke<FeaturePlanningRecord>("start_feature_planning", {
    featureId,
    kind,
    userMessage,
    ...(storyId ? { storyId } : {}),
  });
}

export async function getFeaturePlanningSnapshot(
  projectId: string,
): Promise<FeaturePlanningRecord[]> {
  return invoke<FeaturePlanningRecord[]>("get_feature_planning_snapshot", { projectId });
}

export async function retryFeaturePlanning(
  featureId: string,
): Promise<FeaturePlanningRecord> {
  return invoke<FeaturePlanningRecord>("retry_feature_planning", { featureId });
}

export async function cancelFeaturePlanning(featureId: string): Promise<void> {
  return invoke<void>("cancel_feature_planning", { featureId });
}

export async function getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
  return invoke<KanbanTask[]>("get_kanban_tasks", { projectId });
}

export async function addKanbanTask(
  projectId: string,
  title: string,
  description: string
): Promise<KanbanTask> {
  return invoke<KanbanTask>("add_kanban_task", { projectId, title, description });
}

export async function updateKanbanTask(
  taskId: string,
  title?: string,
  description?: string,
  acceptanceCriteria?: string,
  status?: KanbanStatus,
  environmentId?: string,
  buildPipelineId?: string,
  prUrl?: string,
  prState?: PrState,
  prMergeCommented?: boolean,
): Promise<KanbanTask> {
  return invoke<KanbanTask>("update_kanban_task", { taskId, title, description, acceptanceCriteria, status, environmentId, buildPipelineId, prUrl, prState, prMergeCommented });
}

export async function deleteKanbanTask(taskId: string): Promise<void> {
  return invoke<void>("delete_kanban_task", { taskId });
}

export async function addKanbanComment(taskId: string, text: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("add_kanban_comment", { taskId, text });
}

export async function deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("delete_kanban_comment", { taskId, commentId });
}

export async function addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("add_kanban_image", { taskId, filename, data });
}

export async function deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("delete_kanban_image", { taskId, imageId });
}

/** Load kanban image data on demand. Returns base64-encoded WebP data. */
export async function getKanbanImageData(imageId: string): Promise<string> {
  return invoke<string>("get_kanban_image_data", { imageId });
}

export async function getProjectNotes(projectId: string): Promise<ProjectNotes> {
  return invoke<ProjectNotes>("get_project_notes", { projectId });
}

export async function saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
  return invoke<ProjectNotes>("save_project_notes", { projectId, content });
}

export async function getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
  return invoke<FeaturePlan[]>("get_feature_plans", { projectId });
}

export async function createFeaturePlan(projectId: string): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("create_feature_plan", { projectId });
}

export async function updateFeaturePlan(
  featureId: string,
  updates: Partial<Pick<
    FeaturePlan,
    | "title"
    | "status"
    | "summary"
    | "messages"
    | "stories"
    | "codexEnvironmentId"
    | "codexSessionId"
    | "buildTaskId"
    | "buildPipelineId"
  >>,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("update_feature_plan", { featureId, updates });
}

export async function claimFeaturePlanBuild(
  featureId: string,
  taskId: string,
): Promise<{ claimed: boolean; feature: FeaturePlan }> {
  return invoke<{ claimed: boolean; feature: FeaturePlan }>(
    "claim_feature_plan_build",
    { featureId, taskId },
  );
}

export async function appendFeaturePlanMessage(
  featureId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
  modelId?: string,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("append_feature_plan_message", {
    featureId,
    role,
    content,
    stateApplication,
    modelId,
  });
}

export async function appendFeatureStoryMessage(
  featureId: string,
  storyId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
  modelId?: string,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("append_feature_story_message", {
    featureId,
    storyId,
    role,
    content,
    stateApplication,
    modelId,
  });
}
