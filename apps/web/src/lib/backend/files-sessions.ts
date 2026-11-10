import { asWebModel, nativeSessions } from "@/lib/node-scope/domains/native-sessions";
import { files } from "@/lib/node-scope/domains/files";
import { git } from "@/lib/node-scope/domains/git";
import { pullRequests } from "@/lib/node-scope/domains/pull-requests";
import type { FileContentSchema } from "@orkestrator/protocol/contract/domains/files";
import type * as Schema from "effect/Schema";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { FileWritePrecondition } from "@orkestrator/protocol/file-write-precondition";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  DiffBaseBranch,
  DiffBaseCommit,
  EnvironmentDiffStatsSnapshot,
  EnvironmentDiffStatsSnapshotOutcome,
} from "@orkestrator/protocol/diff-stats";
import type {
  PrMonitorMode,
  PrMonitorSnapshot,
  PrMonitorSnapshotOutcome,
} from "@orkestrator/protocol/pr-monitor";
import { toViewSnapshotRequestArgs, type ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import {
  isWorktreeReadStamp,
  type WorktreeReadStamp,
  type WorktreeSnapshotRevisionsOutcome,
  type WorktreeSnapshotRevisionsSnapshot,
} from "@orkestrator/protocol/worktree-snapshots";
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
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import { commandBackendClient, type BackendClient } from "./client";
import { projects as projectsDomain } from "@/lib/node-scope/domains/projects";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
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
  /** Contents were omitted by the node cap or could not be read. */
  truncated?: boolean;
  extension?: string;
}

/** One truncated tree directory, read when it is expanded. */
export interface FileSubtree {
  children: FileNode[];
  /** The directory's own entries were not all listed. */
  truncated: boolean;
}

/** File content with metadata (the `files` domain's `FileContentSchema`, plan item 7002). */
export type FileContent = Schema.Schema.Type<typeof FileContentSchema>;

export interface ConditionalSnapshot<T> {
  unchanged: boolean;
  digest: string;
  value?: T;
  /**
   * Present when a current backend's tracked read owner served the read: the
   * owner generation, target lineage and file-list/tree revision of `value`
   * (see `@orkestrator/protocol/worktree-snapshots`). Absent from legacy
   * backends and for identities no owner tracks.
   */
  view?: WorktreeReadStamp;
}

/** Options for Files-panel snapshot reads. */
export interface SnapshotReadOptions {
  /**
   * Require an observation made after this call (a manual refresh). Current
   * backends wait for a scan that starts after the request instead of joining
   * one already running; legacy backends ignore the flag.
   */
  refresh?: boolean;
}

function refreshArgs(options: SnapshotReadOptions | undefined): { refresh?: true } {
  return options?.refresh ? { refresh: true } : {};
}

function normalizeConditionalArraySnapshot<T>(
  response: unknown,
  command: string,
): ConditionalSnapshot<T[]> {
  if (
    !isRecord(response) ||
    typeof response.unchanged !== "boolean" ||
    typeof response.digest !== "string" ||
    (!response.unchanged && !Array.isArray(response.value)) ||
    (response.unchanged && response.value !== undefined) ||
    // A malformed stamp is a malformed response, never a legacy one.
    (response.view !== undefined && !isWorktreeReadStamp(response.view))
  ) {
    throw new Error(`Invalid ${command} response`);
  }
  return response as unknown as ConditionalSnapshot<T[]>;
}

function normalizeFileSubtreeSnapshot(
  response: unknown,
  command: string,
): ConditionalSnapshot<FileSubtree> {
  // Older backends ignore knownDigest and return the directory itself.
  if (isRecord(response) && Array.isArray(response.children)) {
    return { unchanged: false, digest: "", value: response as unknown as FileSubtree };
  }
  if (
    !isRecord(response) ||
    typeof response.unchanged !== "boolean" ||
    typeof response.digest !== "string" ||
    (!response.unchanged && (!isRecord(response.value) || !Array.isArray(response.value.children)))
  ) {
    throw new Error(`Invalid ${command} response`);
  }
  return response as unknown as ConditionalSnapshot<FileSubtree>;
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

// --- Local Environment File Commands ---

// --- Port Mapping Commands ---

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

// --- Session Commands (Persistent Session Tracking) ---

// --- Pane Layout Commands (Restore-on-connect) ---

/** One entry of a directory on the machine running the Orkestrator backend. */
export interface HostDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface HostDirectoryListing {
  /** Directory actually listed: the nearest existing ancestor of the requested path. */
  path: string;
  /** Explicit non-directory path, normalized by the backend independently of entries. */
  requestedFile?: string | null;
  parent: string | null;
  home: string;
  roots: string[];
  entries: HostDirectoryEntry[];
  /** True when the directory held more entries than the backend returns. */
  truncated: boolean;
}

/** An image file read from the backend host. */
export interface HostImageFile {
  path: string;
  name: string;
  mimeType: string;
  base64: string;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
/**
 * A call that sends no arguments object, as today's `invoke(command)`: the
 * legacy adapter sends it bare, version 1 sends `{}` with the envelope.
 */
const NO_ARGUMENTS = undefined as unknown as Record<string, never>;

export function createFilesSessionsApi(client: BackendClient) {
  // The host folder picker and project icons (`projects` domain, plan item 7005).
  const hostFiles = projectsDomain(client);
  // The `environments` domain's commands here (plan item 7003).
  const environments = () => domainApi(client, environmentsClient);
  const native = () => nativeSessions(client);
  // The `files` domain client (plan item 7002).
  const filesDomain = () => files(client);
  // The `git` and `pull-requests` domain clients (plan item 7006).
  const gitDomain = () => git(client);
  const prDomain = () => pullRequests(client);

  async function getGitStatusSnapshot(
    containerId: string,
    targetBranch: string,
    knownDigest?: string,
    options?: SnapshotReadOptions,
  ): Promise<ConditionalSnapshot<GitFileChange[]>> {
    const response: unknown = await gitDomain().get_git_status({
      containerId,
      targetBranch,
      includeUncommitted: true,
      knownDigest: knownDigest ?? "",
      ...refreshArgs(options),
    });
    return normalizeConditionalArraySnapshot<GitFileChange>(response, "get_git_status");
  }

  /** Get workspace file tree from a container */
  async function getFileTree(containerId: string): Promise<FileNode[]> {
    return (await filesDomain().get_file_tree({ containerId })) as FileNode[];
  }

  async function getFileTreeSnapshot(
    containerId: string,
    knownDigest?: string,
    options?: SnapshotReadOptions,
  ): Promise<ConditionalSnapshot<FileNode[]>> {
    const response: unknown = await filesDomain().get_file_tree({
      containerId,
      knownDigest: knownDigest ?? "",
      ...refreshArgs(options),
    });
    return normalizeConditionalArraySnapshot<FileNode>(response, "get_file_tree");
  }

  /** Read one truncated directory of a container's file tree */
  async function getFileSubtreeSnapshot(
    containerId: string,
    directory: string,
    knownDigest?: string,
  ): Promise<ConditionalSnapshot<FileSubtree>> {
    const response: unknown = await filesDomain().get_file_subtree({
      containerId,
      directory,
      knownDigest: knownDigest ?? "",
    });
    return normalizeFileSubtreeSnapshot(response, "get_file_subtree");
  }

  /** Read a file from inside a container */
  async function readContainerFile(containerId: string, filePath: string): Promise<FileContent> {
    return filesDomain().read_container_file({ containerId, filePath });
  }

  /** Read a file from a specific git branch inside a container
   * Returns null if the file doesn't exist in the specified branch (e.g., new file)
   */

  /** Read a binary file from inside a container as base64 */
  async function readContainerFileBase64(containerId: string, filePath: string): Promise<string> {
    return filesDomain().read_container_file_base64({ containerId, filePath });
  }

  /** Write a file to inside a container from base64-encoded data */
  /**
   * `expected` makes the write conditional on the file still holding the content
   * the editor loaded; a mismatch rejects with the file-write conflict error.
   */
  async function writeContainerFile(
    containerId: string,
    filePath: string,
    base64Data: string,
    expected?: FileWritePrecondition,
  ): Promise<string> {
    return filesDomain().write_container_file({
      containerId,
      filePath,
      base64Data,
      ...(expected ? { expected } : {}),
    });
  }

  /** Persist an initial-prompt attachment batch atomically inside its environment. */
  async function writeInitialPromptAttachments(
    environmentId: string,
    attachments: InitialPromptAttachmentWrite[],
  ): Promise<SavedInitialPromptAttachment[]> {
    return [
      ...(await filesDomain().write_initial_prompt_attachments({ environmentId, attachments })),
    ];
  }

  /** Restore a container file to its state at the target branch or commit. */
  async function revertContainerFile(
    environmentId: string,
    filePath: string,
    targetBranch: string,
  ): Promise<string> {
    return filesDomain().revert_container_file({ environmentId, filePath, targetBranch });
  }

  /** Delete a container file and stage the deletion when it is tracked by Git. */
  async function deleteContainerFile(environmentId: string, filePath: string): Promise<string> {
    return filesDomain().delete_container_file({ environmentId, filePath });
  }

  /** Move a container file into an existing workspace directory. */
  async function moveContainerFile(
    environmentId: string,
    sourcePath: string,
    destinationDirectory: string,
  ): Promise<string> {
    return filesDomain().move_container_file({
      environmentId,
      sourcePath,
      destinationDirectory,
    });
  }

  /** Rename a container file in place without replacing an existing path. */
  async function renameContainerFile(
    environmentId: string,
    filePath: string,
    newName: string,
  ): Promise<string> {
    return filesDomain().rename_container_file({ environmentId, filePath, newName });
  }

  /** Create an empty folder inside an existing container workspace directory. */
  async function createContainerFolder(
    environmentId: string,
    parentDirectory: string,
    folderName: string,
  ): Promise<string> {
    return filesDomain().create_container_folder({
      environmentId,
      parentDirectory,
      folderName,
    });
  }

  /** Copy a browser-selected host file into an existing environment directory. */
  async function copyExternalFile(
    environmentId: string,
    destinationDirectory: string,
    fileName: string,
    base64Data: string,
  ): Promise<string> {
    return filesDomain().copy_external_file({
      environmentId,
      destinationDirectory,
      fileName,
      base64Data,
    });
  }

  async function getLocalGitStatusSnapshot(
    worktreePath: string,
    targetBranch: string,
    knownDigest?: string,
    options?: SnapshotReadOptions,
  ): Promise<ConditionalSnapshot<GitFileChange[]>> {
    const response: unknown = await gitDomain().get_local_git_status({
      worktreePath,
      targetBranch,
      includeUncommitted: true,
      knownDigest: knownDigest ?? "",
      ...refreshArgs(options),
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
  async function getEnvironmentDiffStats(): Promise<EnvironmentDiffStatsSnapshot>;

  /**
   * Conditional form: a current backend answers with a `ViewSnapshotOutcome`
   * (`unchanged` without a body when `known` is still current); a legacy backend
   * ignores `known` and returns a plain snapshot. Callers validate either shape.
   */
  async function getEnvironmentDiffStats(
    known: ViewRevisionStamp | undefined,
  ): Promise<EnvironmentDiffStatsSnapshot | EnvironmentDiffStatsSnapshotOutcome>;

  async function getEnvironmentDiffStats(
    known?: ViewRevisionStamp,
  ): Promise<EnvironmentDiffStatsSnapshot | EnvironmentDiffStatsSnapshotOutcome> {
    // The bare snapshot without `known`, the conditional outcome with it.
    return gitDomain().get_environment_diff_stats(
      known ? { ...toViewSnapshotRequestArgs(known) } : NO_ARGUMENTS,
    ) as Promise<EnvironmentDiffStatsSnapshot | EnvironmentDiffStatsSnapshotOutcome>;
  }

  /**
   * The environment's HEAD commit, or null when it cannot be read (deleted,
   * stopped or unreachable). The ticket view compares it with the commit a
   * Verify check judged; it never asks for the content fingerprint, so this
   * is one cheap Git read.
   */
  async function getEnvironmentHead(environmentId: string): Promise<string | null> {
    try {
      const { head } = await gitDomain().get_environment_uncommitted_paths({ environmentId });
      return typeof head === "string" && head ? head.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  /**
   * File-list and tree revisions of every environment the backend tracks
   * (`@orkestrator/protocol/worktree-snapshots`). Conditional with `known`, like
   * {@link getEnvironmentDiffStats}; a backend before step 03 does not know the
   * command, which callers treat as the `unsupported` capability.
   */
  async function getWorktreeSnapshotRevisions(
    known?: ViewRevisionStamp,
  ): Promise<WorktreeSnapshotRevisionsSnapshot | WorktreeSnapshotRevisionsOutcome> {
    // Without a known position, today's call has no arguments object.
    const answer = await filesDomain().get_worktree_snapshot_revisions(
      known ? { ...toViewSnapshotRequestArgs(known) } : NO_ARGUMENTS,
    );
    return answer as WorktreeSnapshotRevisionsSnapshot | WorktreeSnapshotRevisionsOutcome;
  }

  /** Branches an environment's checkout can compare its changes against. */
  async function listEnvironmentDiffBaseBranches(environmentId: string): Promise<DiffBaseBranch[]> {
    return gitDomain().list_environment_diff_base_branches({ environmentId });
  }

  /** The newest commits on `ref` (a full branch ref), first parents only. */
  async function listEnvironmentDiffBaseCommits(
    environmentId: string,
    ref: string,
  ): Promise<DiffBaseCommit[]> {
    return gitDomain().list_environment_diff_base_commits({ environmentId, ref });
  }

  /** Measures the environment's changes from `commit`; `null` restores the automatic base. */
  async function setEnvironmentDiffBase(
    environmentId: string,
    base: { ref: string; commit: string } | null,
  ): Promise<Environment> {
    return gitDomain().set_environment_diff_base({
      environmentId,
      ref: base?.ref ?? null,
      commit: base?.commit ?? null,
    });
  }

  /**
   * Authoritative snapshot of the backend PR monitor. Read on mount and on every
   * event-stream reconnect; also arms monitoring on a freshly started backend.
   */
  async function getPrMonitorState(): Promise<PrMonitorSnapshot>;

  /**
   * Conditional form: a current backend answers with a `ViewSnapshotOutcome`
   * (`unchanged` without a body when `known` is still current); a legacy backend
   * ignores `known` and returns a plain snapshot. Callers validate either shape.
   */
  async function getPrMonitorState(
    known: ViewRevisionStamp | undefined,
  ): Promise<PrMonitorSnapshot | PrMonitorSnapshotOutcome>;

  async function getPrMonitorState(
    known?: ViewRevisionStamp,
  ): Promise<PrMonitorSnapshot | PrMonitorSnapshotOutcome> {
    // The bare snapshot without `known`, the conditional outcome with it.
    return prDomain().get_pr_monitor_state(
      known ? { ...toViewSnapshotRequestArgs(known) } : NO_ARGUMENTS,
    ) as Promise<PrMonitorSnapshot | PrMonitorSnapshotOutcome>;
  }

  /**
   * Requests a monitoring mode for an environment (create-pending after the
   * Create PR button, merge-pending after Merge). Durable in the backend, so the
   * fast polling continues across renderer reloads and environment switches.
   */
  async function prMonitorWatch(environmentId: string, mode: PrMonitorMode): Promise<void> {
    return prDomain().pr_monitor_watch({ environmentId, mode });
  }

  /** Durably re-check a conflicting PR when the launched agent turn completes. */
  async function armPrRefreshAfterAgentCompletion(environmentId: string): Promise<string | null> {
    return prDomain().arm_pr_refresh_after_agent_completion({ environmentId });
  }

  /** Roll back one exact post-completion refresh arm when its agent launch fails. */
  async function disarmPrRefreshAfterAgentCompletion(
    environmentId: string,
    armedAt: string,
  ): Promise<void> {
    return prDomain().disarm_pr_refresh_after_agent_completion({
      environmentId,
      armedAt,
    });
  }

  /** Get file tree from a local environment (worktree path) */
  async function getLocalFileTree(worktreePath: string): Promise<FileNode[]> {
    return (await filesDomain().get_local_file_tree({ worktreePath })) as FileNode[];
  }

  async function getLocalFileTreeSnapshot(
    worktreePath: string,
    knownDigest?: string,
    options?: SnapshotReadOptions,
  ): Promise<ConditionalSnapshot<FileNode[]>> {
    const response: unknown = await filesDomain().get_local_file_tree({
      worktreePath,
      knownDigest: knownDigest ?? "",
      ...refreshArgs(options),
    });
    return normalizeConditionalArraySnapshot<FileNode>(response, "get_local_file_tree");
  }

  /** Read one truncated directory of a local environment's file tree */
  async function getLocalFileSubtreeSnapshot(
    worktreePath: string,
    directory: string,
    knownDigest?: string,
  ): Promise<ConditionalSnapshot<FileSubtree>> {
    const response: unknown = await filesDomain().get_local_file_subtree({
      worktreePath,
      directory,
      knownDigest: knownDigest ?? "",
    });
    return normalizeFileSubtreeSnapshot(response, "get_local_file_subtree");
  }

  /** Read a file from a local environment (worktree path) */
  async function readLocalFile(worktreePath: string, filePath: string): Promise<FileContent> {
    return filesDomain().read_local_file({ worktreePath, filePath });
  }

  /** Read a file from a specific git branch in a local environment
   * Returns null if the file doesn't exist in the specified branch (e.g., new file)
   */

  /** Write a file to a local environment (worktree path) from base64-encoded data */
  /** See `writeContainerFile` for `expected`. */
  async function writeLocalFile(
    worktreePath: string,
    filePath: string,
    base64Data: string,
    expected?: FileWritePrecondition,
  ): Promise<string> {
    return filesDomain().write_local_file({
      worktreePath,
      filePath,
      base64Data,
      ...(expected ? { expected } : {}),
    });
  }

  /** Restore a local file to its state at the target branch or commit. */
  async function revertLocalFile(
    environmentId: string,
    filePath: string,
    targetBranch: string,
  ): Promise<string> {
    return filesDomain().revert_local_file({ environmentId, filePath, targetBranch });
  }

  /** Delete a local file and stage the deletion when it is tracked by Git. */
  async function deleteLocalFile(environmentId: string, filePath: string): Promise<string> {
    return filesDomain().delete_local_file({ environmentId, filePath });
  }

  /** Move a local-worktree file into an existing workspace directory. */
  async function moveLocalFile(
    environmentId: string,
    sourcePath: string,
    destinationDirectory: string,
  ): Promise<string> {
    return filesDomain().move_local_file({
      environmentId,
      sourcePath,
      destinationDirectory,
    });
  }

  /** Rename a local-worktree file in place without replacing an existing path. */
  async function renameLocalFile(
    environmentId: string,
    filePath: string,
    newName: string,
  ): Promise<string> {
    return filesDomain().rename_local_file({ environmentId, filePath, newName });
  }

  /** Create an empty folder inside an existing local-worktree directory. */
  async function createLocalFolder(
    environmentId: string,
    parentDirectory: string,
    folderName: string,
  ): Promise<string> {
    return filesDomain().create_local_folder({
      environmentId,
      parentDirectory,
      folderName,
    });
  }

  /** Update port mappings for an environment (requires restart to apply) */
  async function updatePortMappings(
    environmentId: string,
    portMappings: PortMapping[],
  ): Promise<Environment> {
    return environments().updatePortMappings({
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
  async function updateEnvironmentAgentSettings(
    environmentId: string,
    agentSettings: AgentSettingsTier,
    pendingAgentLaunch?: boolean,
    initialAgentModel?: string,
    initialReasoningEffort?: string,
    initialPromptAttachments?: InitialPromptImageAttachment[],
    initialFastMode?: boolean,
  ): Promise<Environment> {
    return environments().updateEnvironmentAgentSettings({
      environmentId,
      agentSettings,
      ...(typeof pendingAgentLaunch === "boolean" ? { pendingAgentLaunch } : {}),
      ...(initialAgentModel ? { initialAgentModel } : {}),
      ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
      ...(initialPromptAttachments ? { initialPromptAttachments } : {}),
      // A boolean check, not truthiness: an explicit Normal is a choice the
      // launcher made and must not be dropped the way `false` would be.
      ...(typeof initialFastMode === "boolean" ? { initialFastMode } : {}),
    });
  }

  /** Atomically persist every input needed for a backend-owned startup launch. */
  async function prepareEnvironmentAgentLaunch(
    environmentId: string,
    input: {
      agent: AgentPlatform;
      initialPrompt?: string;
      model?: string;
      reasoningEffort?: string;
      fastMode?: boolean;
      conversationMode?: "plan" | "build";
      attachments?: InitialPromptImageAttachment[];
    },
  ): Promise<Environment> {
    return environments().updateEnvironmentAgentSettings({
      environmentId,
      pendingAgentLaunch: true,
      initialAgentPlatform: input.agent,
      ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
      ...(input.model ? { initialAgentModel: input.model } : {}),
      ...(input.reasoningEffort ? { initialReasoningEffort: input.reasoningEffort } : {}),
      ...(typeof input.fastMode === "boolean" ? { initialFastMode: input.fastMode } : {}),
      ...(input.conversationMode ? { initialConversationMode: input.conversationMode } : {}),
      ...(input.attachments ? { initialPromptAttachments: input.attachments } : {}),
    });
  }

  /**
   * Persist the initial prompt after the renderer has rewritten it (for example to
   * add references to uploaded attachments), so a recovered launch reads the same
   * prompt the uninterrupted path would have used.
   */

  /**
   * Read the effective MCP and plugin configuration for every supported agent.
   *
   * The backend caches per environment because discovery health-checks (and so
   * spawns) the configured MCP servers. Pass `refresh` for an explicit reload.
   */
  async function getEnvironmentExtensions(
    environmentId: string,
    options: { refresh?: boolean } = {},
  ): Promise<AgentExtensionCatalog[]> {
    return environments().getEnvironmentExtensions({
      environmentId,
      refresh: options.refresh === true,
    });
  }

  /** Create a new persistent session for tracking */
  async function createSession(
    environmentId: string,
    containerId: string,
    tabId: string,
    sessionType: SessionType,
  ): Promise<Session> {
    return asWebModel<Session>(
      native().create_session({
        environmentId,
        containerId,
        tabId,
        sessionType,
      }),
    );
  }

  /** Get a single session by ID */
  async function getSession(sessionId: string): Promise<Session | null> {
    return asWebModel<Session | null>(native().get_session({ sessionId }));
  }

  /** Get all sessions for an environment */
  async function getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    return asWebModel<Session[]>(native().get_sessions_by_environment({ environmentId }));
  }

  /** Update session status (connected/disconnected) */
  async function updateSessionStatus(sessionId: string, status: SessionStatus): Promise<Session> {
    return asWebModel<Session>(native().update_session_status({ sessionId, status }));
  }

  /** Update session's last activity timestamp */
  async function updateSessionActivity(sessionId: string): Promise<Session> {
    return asWebModel<Session>(native().update_session_activity({ sessionId }));
  }

  /** Delete a session */
  async function deleteSession(sessionId: string): Promise<void> {
    return native().delete_session({ sessionId });
  }

  /** Delete all sessions for an environment */
  async function deleteSessionsByEnvironment(environmentId: string): Promise<string[]> {
    return native().delete_sessions_by_environment({ environmentId });
  }

  /** Rename a session */
  async function renameSession(sessionId: string, name: string | null): Promise<Session> {
    return asWebModel<Session>(native().rename_session({ sessionId, name }));
  }

  /** Mark all sessions for an environment as disconnected */
  async function disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    return asWebModel<Session[]>(native().disconnect_environment_sessions({ environmentId }));
  }

  /** Save a session's terminal buffer to a separate file */
  async function saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    return native().save_session_buffer({ sessionId, buffer });
  }

  /** Load a session's terminal buffer from file */
  async function loadSessionBuffer(sessionId: string): Promise<string | null> {
    return native().load_session_buffer({ sessionId });
  }

  /** Sync sessions for an environment with container state */
  async function syncSessionsWithContainer(
    environmentId: string,
    containerRunning: boolean,
  ): Promise<Session[]> {
    return asWebModel<Session[]>(
      native().sync_sessions_with_container({
        environmentId,
        containerRunning,
      }),
    );
  }

  /** Reorder sessions within an environment */
  async function reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    return asWebModel<Session[]>(native().reorder_sessions({ environmentId, sessionIds }));
  }

  async function getPaneLayout(environmentId: string): Promise<PersistedPaneLayout | null> {
    return asWebModel<PersistedPaneLayout | null>(native().get_pane_layout({ environmentId }));
  }

  async function savePaneLayout(
    environmentId: string,
    layout: PersistedPaneLayoutInput,
    expectedRevision: number,
  ): Promise<PersistedPaneLayout> {
    return asWebModel<PersistedPaneLayout>(
      native().save_pane_layout({
        environmentId,
        layout,
        expectedRevision,
      }),
    );
  }

  async function applyPaneLayoutIntent(
    environmentId: string,
    baseLayout: PersistedPaneLayoutInput,
    desiredLayout: PersistedPaneLayoutInput,
    selectionIntent?: import("@orkestrator/protocol/pane-layout-merge").PaneLayoutSelectionIntent,
  ): Promise<PersistedPaneLayout> {
    return asWebModel<PersistedPaneLayout>(
      native().apply_pane_layout_intent({
        environmentId,
        baseLayout,
        desiredLayout,
        ...(selectionIntent ? { selectionIntent } : {}),
      }),
    );
  }

  async function deletePaneLayout(environmentId: string, expectedRevision?: number): Promise<void> {
    return native().delete_pane_layout({
      environmentId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  /**
   * Lists a directory on the backend host, not on this client. This is what lets
   * the in-app file and folder picker browse the remote machine over a gateway.
   * Omit `path` to start at the host's home directory.
   */

  /**
   * Creates one folder named `name` inside `parent` on the backend host and
   * returns its absolute path. Fails if the entry already exists.
   */

  /**
   * Absolute paths of images on the backend host where a project usually keeps
   * its icon or favicon (`public/favicon.svg`, `app/icon.png`, ...), best first.
   */
  async function findProjectIcons(root: string): Promise<string[]> {
    return hostFiles().find_project_icons({ root });
  }

  /** Reads one image file (at most 5 MB) from the backend host. */
  async function readHostImageFile(path: string): Promise<HostImageFile> {
    return hostFiles().read_host_image_file({ path });
  }

  return {
    getGitStatusSnapshot,
    getFileTree,
    getFileTreeSnapshot,
    getFileSubtreeSnapshot,
    readContainerFile,
    readContainerFileBase64,
    writeContainerFile,
    writeInitialPromptAttachments,
    revertContainerFile,
    deleteContainerFile,
    moveContainerFile,
    renameContainerFile,
    createContainerFolder,
    copyExternalFile,
    getLocalGitStatusSnapshot,
    getEnvironmentDiffStats,
    getEnvironmentHead,
    getWorktreeSnapshotRevisions,
    listEnvironmentDiffBaseBranches,
    listEnvironmentDiffBaseCommits,
    setEnvironmentDiffBase,
    getPrMonitorState,
    prMonitorWatch,
    armPrRefreshAfterAgentCompletion,
    disarmPrRefreshAfterAgentCompletion,
    getLocalFileTree,
    getLocalFileTreeSnapshot,
    getLocalFileSubtreeSnapshot,
    readLocalFile,
    writeLocalFile,
    revertLocalFile,
    deleteLocalFile,
    moveLocalFile,
    renameLocalFile,
    createLocalFolder,
    updatePortMappings,
    updateEnvironmentAgentSettings,
    prepareEnvironmentAgentLaunch,
    getEnvironmentExtensions,
    createSession,
    getSession,
    getSessionsByEnvironment,
    updateSessionStatus,
    updateSessionActivity,
    deleteSession,
    deleteSessionsByEnvironment,
    renameSession,
    disconnectEnvironmentSessions,
    saveSessionBuffer,
    loadSessionBuffer,
    syncSessionsWithContainer,
    reorderSessions,
    getPaneLayout,
    savePaneLayout,
    applyPaneLayoutIntent,
    deletePaneLayout,
    findProjectIcons,
    readHostImageFile,
  };
}

export type FilesSessionsApi = ReturnType<typeof createFilesSessionsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getGitStatusSnapshot,
  getFileTree,
  getFileTreeSnapshot,
  getFileSubtreeSnapshot,
  readContainerFile,
  readContainerFileBase64,
  writeContainerFile,
  writeInitialPromptAttachments,
  revertContainerFile,
  deleteContainerFile,
  moveContainerFile,
  renameContainerFile,
  createContainerFolder,
  copyExternalFile,
  getLocalGitStatusSnapshot,
  getEnvironmentDiffStats,
  getEnvironmentHead,
  getWorktreeSnapshotRevisions,
  listEnvironmentDiffBaseBranches,
  listEnvironmentDiffBaseCommits,
  setEnvironmentDiffBase,
  getPrMonitorState,
  prMonitorWatch,
  armPrRefreshAfterAgentCompletion,
  disarmPrRefreshAfterAgentCompletion,
  getLocalFileTree,
  getLocalFileTreeSnapshot,
  getLocalFileSubtreeSnapshot,
  readLocalFile,
  writeLocalFile,
  revertLocalFile,
  deleteLocalFile,
  moveLocalFile,
  renameLocalFile,
  createLocalFolder,
  updatePortMappings,
  updateEnvironmentAgentSettings,
  prepareEnvironmentAgentLaunch,
  getEnvironmentExtensions,
  createSession,
  getSession,
  getSessionsByEnvironment,
  updateSessionStatus,
  updateSessionActivity,
  deleteSession,
  deleteSessionsByEnvironment,
  renameSession,
  disconnectEnvironmentSessions,
  saveSessionBuffer,
  loadSessionBuffer,
  syncSessionsWithContainer,
  reorderSessions,
  getPaneLayout,
  savePaneLayout,
  applyPaneLayoutIntent,
  deletePaneLayout,
  findProjectIcons,
  readHostImageFile,
} = createFilesSessionsApi(commandBackendClient);
