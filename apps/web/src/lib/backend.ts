import { invoke } from "@/lib/native/backend";
import { getGatewayBaseUrl } from "@/lib/gateway-url";
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
} from "@/types";
import type {
  LinearCompletionCommentResult,
  LinearConnectionStatus,
  LinearIssueComment,
  LinearIssueDetail,
  LinearIssueListItem,
} from "@/types/linear";

/** PR detection result containing URL, state, and merge conflict status */
export interface PrDetectionResult {
  url: string;
  state: PrState;
  hasMergeConflicts: boolean;
}

// Typed command wrapper for the Electron backend.

// --- Project Commands ---

export async function getProjects(): Promise<Project[]> {
  return invoke<Project[]>("get_projects");
}

export async function addProject(gitUrl: string, localPath?: string): Promise<Project> {
  return invoke<Project>("add_project", { gitUrl, localPath });
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
  namingPrompt?: string
): Promise<Environment> {
  return invoke<Environment>("create_environment", { projectId, name, networkAccessMode, initialPrompt, portMappings, environmentType, namingPrompt });
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  return invoke("delete_environment", { environmentId });
}

export async function startEnvironment(environmentId: string): Promise<StartEnvironmentResult> {
  return invoke<StartEnvironmentResult>("start_environment", { environmentId });
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

export async function createTerminalSession(
  containerId: string,
  cols: number,
  rows: number,
  user?: string
): Promise<string> {
  return invoke<string>("create_terminal_session", { containerId, cols, rows, user });
}

export async function startTerminalSession(sessionId: string): Promise<void> {
  return invoke("start_terminal_session", { sessionId });
}

export interface TerminalSessionStatus {
  id: string;
  running: boolean;
}

export async function getTerminalSession(
  sessionId: string
): Promise<TerminalSessionStatus> {
  return invoke<TerminalSessionStatus>("get_terminal_session", { sessionId });
}

export async function getTerminalOutputBuffer(sessionId: string): Promise<string> {
  return invoke<string>("get_terminal_output_buffer", { sessionId });
}

export async function getEnvironmentSetupSession(
  environmentId: string
): Promise<EnvironmentSetupSession | null> {
  return invoke<EnvironmentSetupSession | null>("get_environment_setup_session", { environmentId });
}

export async function detachTerminal(sessionId: string): Promise<void> {
  return invoke("detach_terminal", { sessionId });
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

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function getGlobalConfig(): Promise<GlobalConfig> {
  return invoke<GlobalConfig>("get_global_config");
}

export async function updateGlobalConfig(global: GlobalConfig): Promise<AppConfig> {
  return invoke<AppConfig>("update_global_config", { global });
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

export async function clearEnvironmentPr(environmentId: string): Promise<void> {
  return invoke("clear_environment_pr", { environmentId });
}

export async function setEnvironmentPr(
  environmentId: string,
  prUrl: string,
  prState: PrState,
  hasMergeConflicts?: boolean | null
): Promise<Environment> {
  return invoke<Environment>("set_environment_pr", { environmentId, prUrl, prState, hasMergeConflicts });
}

export async function setEnvironmentSetupComplete(
  environmentId: string,
  complete: boolean
): Promise<Environment> {
  return invoke<Environment>("set_environment_setup_complete", { environmentId, complete });
}

export async function runEnvironmentSetup(environmentId: string): Promise<Environment> {
  return invoke<Environment>("run_environment_setup", { environmentId });
}

export async function ensureEnvironmentSetup(environmentId: string): Promise<EnsureEnvironmentSetupResult> {
  return invoke<EnsureEnvironmentSetupResult>("ensure_environment_setup", { environmentId });
}

/**
 * Read-only fetch of a local environment's setupLocal commands from its
 * orkestrator-ai.json. Returns null for non-local envs or when no commands.
 */
export async function getSetupCommands(environmentId: string): Promise<string[] | null> {
  return invoke<string[] | null>("get_setup_commands", { environmentId });
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

/** Merge the current branch's PR using gh pr merge */
export async function mergePr(
  containerId: string,
  method?: MergeMethod,
  deleteBranch?: boolean
): Promise<void> {
  return invoke("merge_pr", { containerId, method, deleteBranch });
}

/** Merge the current branch's PR locally using gh pr merge */
export async function mergePrLocal(
  environmentId: string,
  method?: MergeMethod,
  deleteBranch?: boolean
): Promise<void> {
  return invoke("merge_pr_local", { environmentId, method, deleteBranch });
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

/** Result of Docker system prune operation */
export interface SystemPruneResult {
  /** Number of containers deleted */
  containersDeleted: number;
  /** Number of images deleted */
  imagesDeleted: number;
  /** Number of networks deleted */
  networksDeleted: number;
  /** Number of volumes deleted */
  volumesDeleted: number;
  /** Total space reclaimed in bytes */
  spaceReclaimed: number;
}

/** Perform Docker system prune - removes unused containers, images, networks, and optionally volumes */
export async function dockerSystemPrune(pruneVolumes: boolean = false): Promise<SystemPruneResult> {
  return invoke<SystemPruneResult>("docker_system_prune", { pruneVolumes });
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

/** Result of propagating GitHub token to containers */
export interface PropagateTokenResult {
  /** Environment IDs where token was successfully updated */
  updated: string[];
  /** Failed updates: [environment_id, error_message] */
  failed: [string, string][];
}

/** Propagate GitHub token to all running containerized environments */
export async function propagateGithubTokenToContainers(newToken: string | null): Promise<PropagateTokenResult> {
  return invoke<PropagateTokenResult>("propagate_github_token_to_containers", { newToken });
}

// --- OpenCode Server Commands ---

export interface OpenCodeServerStartResult {
  hostPort: number;
  wasRunning: boolean;
}

export interface OpenCodeServerStatus {
  running: boolean;
  hostPort: number | null;
}

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeModelPreferences {
  recent: OpenCodeModelRef[];
  favorite: OpenCodeModelRef[];
  variant: Record<string, string>;
}

/** Start the OpenCode server in a container */
export async function startOpenCodeServer(containerId: string): Promise<OpenCodeServerStartResult> {
  return invoke<OpenCodeServerStartResult>("start_opencode_server", { containerId });
}

/** Stop the OpenCode server in a container */
export async function stopOpenCodeServer(containerId: string): Promise<void> {
  return invoke("stop_opencode_server", { containerId });
}

/** Get the status of the OpenCode server in a container */
export async function getOpenCodeServerStatus(containerId: string): Promise<OpenCodeServerStatus> {
  return invoke<OpenCodeServerStatus>("get_opencode_server_status", { containerId });
}

/** Get the OpenCode server log from a container (for debugging) */
export async function getOpenCodeServerLog(containerId: string): Promise<string> {
  return invoke<string>("get_opencode_server_log", { containerId });
}

/** Get OpenCode model preferences from ~/.local/state/opencode/model.json */
export async function getOpencodeModelPreferences(): Promise<OpenCodeModelPreferences> {
  return invoke<OpenCodeModelPreferences>("get_opencode_model_preferences");
}

// --- Claude Bridge Server Commands ---

export interface ClaudeServerStartResult {
  hostPort: number;
  wasRunning: boolean;
}

export interface ClaudeServerStatus {
  running: boolean;
  hostPort: number | null;
}

export interface CodexServerStartResult {
  hostPort: number;
  wasRunning: boolean;
}

export interface CodexServerStatus {
  running: boolean;
  hostPort: number | null;
}

/** Start the Claude bridge server in a container */
export async function startClaudeServer(containerId: string): Promise<ClaudeServerStartResult> {
  return invoke<ClaudeServerStartResult>("start_claude_server", { containerId });
}

/** Stop the Claude bridge server in a container */
export async function stopClaudeServer(containerId: string): Promise<void> {
  return invoke("stop_claude_server", { containerId });
}

/** Get the status of the Claude bridge server in a container */
export async function getClaudeServerStatus(containerId: string): Promise<ClaudeServerStatus> {
  return invoke<ClaudeServerStatus>("get_claude_server_status", { containerId });
}

/** Get the Claude bridge server log from a container (for debugging) */
export async function getClaudeServerLog(containerId: string): Promise<string> {
  return invoke<string>("get_claude_server_log", { containerId });
}

/** Start the Codex bridge server in a container */
export async function startCodexServer(containerId: string): Promise<CodexServerStartResult> {
  return invoke<CodexServerStartResult>("start_codex_server", { containerId });
}

/** Stop the Codex bridge server in a container */
export async function stopCodexServer(containerId: string): Promise<void> {
  return invoke("stop_codex_server", { containerId });
}

/** Get the status of the Codex bridge server in a container */
export async function getCodexServerStatus(containerId: string): Promise<CodexServerStatus> {
  return invoke<CodexServerStatus>("get_codex_server_status", { containerId });
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

export async function hasClaudeCredentials(): Promise<boolean> {
  return invoke<boolean>("has_claude_credentials");
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  return invoke<CredentialStatus>("get_credential_status");
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

// --- Claude State Commands ---

export async function startClaudeStatePolling(containerId: string): Promise<void> {
  return invoke("start_claude_state_polling", { containerId });
}

export async function stopClaudeStatePolling(containerId: string): Promise<void> {
  return invoke("stop_claude_state_polling", { containerId });
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

/** Get git changes comparing current state against a target branch */
export async function getGitStatus(
  containerId: string,
  targetBranch: string
): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>("get_git_status", { containerId, targetBranch });
}

/** Get workspace file tree from a container */
export async function getFileTree(containerId: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("get_file_tree", { containerId });
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
  targetBranch: string
): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>("get_local_git_status", { worktreePath, targetBranch });
}

/** Get file tree from a local environment (worktree path) */
export async function getLocalFileTree(worktreePath: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("get_local_file_tree", { worktreePath });
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
): Promise<Environment> {
  return invoke<Environment>("update_environment_agent_settings", {
    environmentId,
    defaultAgent,
    claudeMode,
    claudeNativeBackend,
    opencodeMode,
    codexMode,
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

/** Update whether a session has launched its command (e.g., Claude) */
export async function setSessionHasLaunchedCommand(
  sessionId: string,
  hasLaunched: boolean
): Promise<Session> {
  return invoke<Session>("set_session_has_launched_command", { sessionId, hasLaunched });
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

// --- Local Server Commands (for local/worktree environments) ---

export interface LocalServerStartResult {
  port: number;
  pid: number;
  wasRunning: boolean;
}

export interface LocalServerStatus {
  running: boolean;
  port: number | null;
  pid: number | null;
}

/** Start the local OpenCode server for a local environment */
export async function startLocalOpencodeServer(environmentId: string): Promise<LocalServerStartResult> {
  return invoke<LocalServerStartResult>("start_local_opencode_server_cmd", { environmentId });
}

/** Stop the local OpenCode server for a local environment */
export async function stopLocalOpencodeServer(environmentId: string): Promise<void> {
  return invoke("stop_local_opencode_server_cmd", { environmentId });
}

/** Get the status of the local OpenCode server for a local environment */
export async function getLocalOpencodeServerStatus(environmentId: string): Promise<LocalServerStatus> {
  return invoke<LocalServerStatus>("get_local_opencode_server_status", { environmentId });
}

/** Start the local Claude-bridge server for a local environment */
export async function startLocalClaudeServer(environmentId: string): Promise<LocalServerStartResult> {
  return invoke<LocalServerStartResult>("start_local_claude_server_cmd", { environmentId });
}

/** Stop the local Claude-bridge server for a local environment */
export async function stopLocalClaudeServer(environmentId: string): Promise<void> {
  return invoke("stop_local_claude_server_cmd", { environmentId });
}

/** Get the status of the local Claude-bridge server for a local environment */
export async function getLocalClaudeServerStatus(environmentId: string): Promise<LocalServerStatus> {
  return invoke<LocalServerStatus>("get_local_claude_server_status", { environmentId });
}

/** Start the local Codex bridge server for a local environment */
export async function startLocalCodexServer(environmentId: string): Promise<LocalServerStartResult> {
  return invoke<LocalServerStartResult>("start_local_codex_server_cmd", { environmentId });
}

/** Stop the local Codex bridge server for a local environment */
export async function stopLocalCodexServer(environmentId: string): Promise<void> {
  return invoke("stop_local_codex_server_cmd", { environmentId });
}

/** Get the status of the local Codex bridge server for a local environment */
export async function getLocalCodexServerStatus(environmentId: string): Promise<LocalServerStatus> {
  return invoke<LocalServerStatus>("get_local_codex_server_status", { environmentId });
}

// --- Local Terminal Commands (for local/worktree environments) ---

/** Create a local terminal session for a local environment */
export async function createLocalTerminalSession(
  environmentId: string,
  cols: number,
  rows: number
): Promise<string> {
  return invoke<string>("create_local_terminal_session", { environmentId, cols, rows });
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
    | "stories"
    | "codexEnvironmentId"
    | "codexSessionId"
    | "buildTaskId"
    | "buildPipelineId"
  >>,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("update_feature_plan", { featureId, updates });
}

export async function appendFeaturePlanMessage(
  featureId: string,
  role: FeaturePlanMessage["role"],
  content: string,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("append_feature_plan_message", { featureId, role, content });
}

export async function appendFeatureStoryMessage(
  featureId: string,
  storyId: string,
  role: FeaturePlanMessage["role"],
  content: string,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("append_feature_story_message", { featureId, storyId, role, content });
}
