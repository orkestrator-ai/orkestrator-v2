import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { invoke } from "@/lib/native/backend";
import type { EnvironmentDiffStatsSnapshot } from "@orkestrator/protocol/diff-stats";
import type { PrMonitorMode, PrMonitorSnapshot } from "@orkestrator/protocol/pr-monitor";
import type {
  Environment,
  PortMapping,
  Session,
  SessionType,
  SessionStatus,
  InitialPromptImageAttachment,
  PersistedPaneLayout,
  PersistedPaneLayoutInput,
} from "@/types";
import { isRecord } from "./shared";
/** PR detection result containing URL, state, and merge conflict status */

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

function normalizeConditionalArraySnapshot<T>(
  response: unknown,
  command: string,
): ConditionalSnapshot<T[]> {
  // Older backends ignore knownDigest and return the original raw array.
  if (Array.isArray(response)) {
    return { unchanged: false, digest: "", value: response as T[] };
  }
  if (
    !isRecord(response) ||
    typeof response.unchanged !== "boolean" ||
    typeof response.digest !== "string" ||
    (!response.unchanged && !Array.isArray(response.value)) ||
    (response.unchanged && response.value !== undefined)
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
  return normalizeConditionalArraySnapshot<GitFileChange>(response, "get_git_status");
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
  filePath: string,
): Promise<FileContent> {
  return invoke<FileContent>("read_container_file", { containerId, filePath });
}

/** Read a file from a specific git branch inside a container
 * Returns null if the file doesn't exist in the specified branch (e.g., new file)
 */
export async function readFileAtBranch(
  containerId: string,
  filePath: string,
  branch: string,
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
  filePath: string,
): Promise<string> {
  return invoke<string>("read_container_file_base64", { containerId, filePath });
}

/** Write a file to inside a container from base64-encoded data */
export async function writeContainerFile(
  containerId: string,
  filePath: string,
  base64Data: string,
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
  targetBranch: string,
): Promise<string> {
  return invoke<string>("revert_container_file", { environmentId, filePath, targetBranch });
}

/** Delete a container file and stage the deletion when it is tracked by Git. */
export async function deleteContainerFile(
  environmentId: string,
  filePath: string,
): Promise<string> {
  return invoke<string>("delete_container_file", { environmentId, filePath });
}

/** Move a container file into an existing workspace directory. */
export async function moveContainerFile(
  environmentId: string,
  sourcePath: string,
  destinationDirectory: string,
): Promise<string> {
  return invoke<string>("move_container_file", {
    environmentId,
    sourcePath,
    destinationDirectory,
  });
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
  return normalizeConditionalArraySnapshot<GitFileChange>(response, "get_local_git_status");
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
  return normalizeConditionalArraySnapshot<FileNode>(response, "get_local_file_tree");
}

/** Read a file from a local environment (worktree path) */
export async function readLocalFile(worktreePath: string, filePath: string): Promise<FileContent> {
  return invoke<FileContent>("read_local_file", { worktreePath, filePath });
}

/** Read a file from a specific git branch in a local environment
 * Returns null if the file doesn't exist in the specified branch (e.g., new file)
 */
export async function readLocalFileAtBranch(
  worktreePath: string,
  filePath: string,
  branch: string,
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
  base64Data: string,
): Promise<string> {
  return invoke<string>("write_local_file", { worktreePath, filePath, base64Data });
}

/** Restore a local file to its state at the target branch or commit. */
export async function revertLocalFile(
  environmentId: string,
  filePath: string,
  targetBranch: string,
): Promise<string> {
  return invoke<string>("revert_local_file", { environmentId, filePath, targetBranch });
}

/** Delete a local file and stage the deletion when it is tracked by Git. */
export async function deleteLocalFile(environmentId: string, filePath: string): Promise<string> {
  return invoke<string>("delete_local_file", { environmentId, filePath });
}

/** Move a local-worktree file into an existing workspace directory. */
export async function moveLocalFile(
  environmentId: string,
  sourcePath: string,
  destinationDirectory: string,
): Promise<string> {
  return invoke<string>("move_local_file", {
    environmentId,
    sourcePath,
    destinationDirectory,
  });
}

// --- Port Mapping Commands ---

/** Update port mappings for an environment (requires restart to apply) */
export async function updatePortMappings(
  environmentId: string,
  portMappings: PortMapping[],
): Promise<Environment> {
  return invoke<Environment>("update_port_mappings", {
    environmentId,
    portMappings,
  });
}

/** Update per-environment agent settings (pass null to use global defaults) */
/**
 * Persist an environment's agent overrides.
 *
 * One `agentSettings` block replaces the five positional nullable arguments this
 * took before. The launch-intent arguments below are deliberately separate:
 * they describe one pending run, not a durable setting.
 */
export async function updateEnvironmentAgentSettings(
  environmentId: string,
  agentSettings: AgentSettingsTier,
  pendingAgentLaunch?: boolean,
  initialAgentModel?: string,
  initialReasoningEffort?: string,
  initialPromptAttachments?: InitialPromptImageAttachment[],
): Promise<Environment> {
  return invoke<Environment>("update_environment_agent_settings", {
    environmentId,
    agentSettings,
    ...(typeof pendingAgentLaunch === "boolean" ? { pendingAgentLaunch } : {}),
    ...(initialAgentModel ? { initialAgentModel } : {}),
    ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
    ...(initialPromptAttachments ? { initialPromptAttachments } : {}),
  });
}

/** Atomically persist every input needed for a backend-owned startup launch. */
export async function prepareEnvironmentAgentLaunch(
  environmentId: string,
  input: {
    agent: AgentPlatform;
    initialPrompt?: string;
    model?: string;
    reasoningEffort?: string;
    conversationMode?: "plan" | "build";
    attachments?: InitialPromptImageAttachment[];
  },
): Promise<Environment> {
  return invoke<Environment>("update_environment_agent_settings", {
    environmentId,
    pendingAgentLaunch: true,
    initialAgentPlatform: input.agent,
    ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    ...(input.model ? { initialAgentModel: input.model } : {}),
    ...(input.reasoningEffort ? { initialReasoningEffort: input.reasoningEffort } : {}),
    ...(input.conversationMode ? { initialConversationMode: input.conversationMode } : {}),
    ...(input.attachments ? { initialPromptAttachments: input.attachments } : {}),
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

export type AgentExtensionId = "claude" | "codex" | "cursor" | "grok" | "opencode" | "pi";

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
  sessionType: SessionType,
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
export async function getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
  return invoke<Session[]>("get_sessions_by_environment", { environmentId });
}

/** Update session status (connected/disconnected) */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
): Promise<Session> {
  return invoke<Session>("update_session_status", { sessionId, status });
}

/** Update session's last activity timestamp */
export async function updateSessionActivity(sessionId: string): Promise<Session> {
  return invoke<Session>("update_session_activity", { sessionId });
}

/** Delete a session */
export async function deleteSession(sessionId: string): Promise<void> {
  return invoke("delete_session", { sessionId });
}

/** Delete all sessions for an environment */
export async function deleteSessionsByEnvironment(environmentId: string): Promise<string[]> {
  return invoke<string[]>("delete_sessions_by_environment", { environmentId });
}

/** Rename a session */
export async function renameSession(sessionId: string, name: string | null): Promise<Session> {
  return invoke<Session>("rename_session", { sessionId, name });
}

/** Mark all sessions for an environment as disconnected */
export async function disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
  return invoke<Session[]>("disconnect_environment_sessions", { environmentId });
}

/** Save a session's terminal buffer to a separate file */
export async function saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
  return invoke("save_session_buffer", { sessionId, buffer });
}

/** Load a session's terminal buffer from file */
export async function loadSessionBuffer(sessionId: string): Promise<string | null> {
  return invoke<string | null>("load_session_buffer", { sessionId });
}

/** Sync sessions for an environment with container state */
export async function syncSessionsWithContainer(
  environmentId: string,
  containerRunning: boolean,
): Promise<Session[]> {
  return invoke<Session[]>("sync_sessions_with_container", {
    environmentId,
    containerRunning,
  });
}

/** Reorder sessions within an environment */
export async function reorderSessions(
  environmentId: string,
  sessionIds: string[],
): Promise<Session[]> {
  return invoke<Session[]>("reorder_sessions", { environmentId, sessionIds });
}

/** Clean up orphaned buffer files (buffers without corresponding sessions) */
export async function cleanupOrphanedBuffers(): Promise<string[]> {
  return invoke<string[]>("cleanup_orphaned_buffers", {});
}

// --- Pane Layout Commands (Restore-on-connect) ---

export async function getPaneLayout(environmentId: string): Promise<PersistedPaneLayout | null> {
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
