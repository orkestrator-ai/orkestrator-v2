import { environmentRequests, hydrationRequests } from "@/lib/hydration-request-limiter";
import { hydrationActivity } from "@/lib/hydration-activity";
import { type AccountMachine } from "./agent-accounts";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type {
  ProjectArrangement,
  ProjectArrangementIntent,
} from "@orkestrator/protocol/project-arrangement";
import type {
  ContainerLifecycleSnapshot,
  RebuildPreview,
  RecreateEnvironmentIntent,
} from "@orkestrator/protocol/container-lifecycle";
import type {
  CredentialRevocationResult,
  EnvironmentInputStatus,
  EnvironmentNetworkPolicy,
  RecoveryCopyList,
} from "@orkestrator/protocol/container-recovery";
import type {
  GitHubCloneAccount,
  GitHubCloneRepositoryList,
} from "@orkestrator/protocol/github-clone";
import type {
  Project,
  Environment,
  EnvironmentType,
  EnvironmentStatus,
  NetworkAccessMode,
  PortMapping,
  PrState,
  StartEnvironmentResult,
} from "@/types";
import {
  isResourceRevisionManifest,
  isScopedResourceRevisionManifest,
  isScopedResourceSnapshotBatch,
  SCOPED_RESOURCE_SNAPSHOT_BATCH_MAX_BYTES,
  type ResourceChange,
  type ScopedResourceSnapshotBatch,
  type ScopedResourceRevisionManifest,
  type ResourceRevisionManifest,
  type ResourceRevisionMap,
} from "@orkestrator/protocol/resource-events";
import { clientInvoke, commandBackendClient, machineInvoker, type BackendClient } from "./client";
/** PR detection result containing URL, state, and merge conflict status */

export interface PrDetectionResult {
  url: string;
  state: PrState;
  hasMergeConflicts: boolean | null;
}

// Typed command wrapper for the Electron backend.

// --- Project Commands ---

// --- Environment Commands ---

export interface RecreateEnvironmentOptions {
  /**
   * `preserve` copies the workspace and provider state into a new container
   * and commits it only after verification; it is refused, with nothing
   * changed, where the image or engine cannot preserve them. `discard`
   * deletes the container and everything in its filesystem.
   */
  intent: RecreateEnvironmentIntent;
  /** The container the user reviewed; a different runtime conflicts. */
  expectedContainerId: string | null;
  /** Preserve only: proceed when Docker host free space cannot be measured. */
  allowUnknownCapacity?: boolean;
  /** Discard only: keep the current container and files as a recovery copy. */
  keepRecoveryCopy?: boolean;
}

// --- Terminal Commands ---

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createProjectsEnvironmentsApi(client: BackendClient) {
  const invoke = clientInvoke(client);
  const machineInvoke = machineInvoker(client);

  async function getResourceRevisionManifest(
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

  async function getScopedResourceRevisionManifest(
    knownGeneration?: string,
    cursor = 0,
    knownRevisions: Partial<ResourceRevisionMap> = {},
    highWater?: number,
  ): Promise<ScopedResourceRevisionManifest> {
    const response = await invoke<unknown>("get_scoped_resource_revision_manifest", {
      ...(knownGeneration === undefined ? {} : { knownGeneration }),
      cursor,
      knownRevisions,
      ...(highWater === undefined ? {} : { highWater }),
    });
    if (!isScopedResourceRevisionManifest(response)) {
      throw new Error("Invalid scoped resource revision manifest response");
    }
    return response;
  }

  async function getScopedResourceSnapshots(
    changes: ResourceChange[],
  ): Promise<ScopedResourceSnapshotBatch> {
    const response = await invoke<unknown>("get_scoped_resource_snapshots", { changes });
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      SCOPED_RESOURCE_SNAPSHOT_BATCH_MAX_BYTES
    ) {
      throw new Error("Scoped resource snapshot batch response exceeded its limit");
    }
    if (!isScopedResourceSnapshotBatch(response)) {
      throw new Error("Invalid scoped resource snapshot batch response");
    }
    return response;
  }

  async function getProjects(machine?: AccountMachine): Promise<Project[]> {
    return machine === undefined
      ? invoke<Project[]>("get_projects")
      : machineInvoke<Project[]>(machine, "get_projects");
  }

  async function addProject(
    gitUrl: string,
    localPath?: string,
    cloneOnly?: boolean,
  ): Promise<Project> {
    return invoke<Project>("add_project", {
      gitUrl,
      localPath,
      ...(cloneOnly === undefined ? {} : { cloneOnly }),
    });
  }

  async function createProjectFromScratch(localPath: string): Promise<Project> {
    return invoke<Project>("create_project_from_scratch", { localPath });
  }

  async function listGitHubCloneAccounts(): Promise<GitHubCloneAccount[]> {
    return invoke<GitHubCloneAccount[]>("list_github_clone_accounts");
  }

  async function listGitHubCloneRepositories(
    owner: string,
    cursor?: string,
  ): Promise<GitHubCloneRepositoryList> {
    return invoke<GitHubCloneRepositoryList>("list_github_clone_repositories", {
      owner,
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  async function removeProject(projectId: string): Promise<void> {
    return invoke("remove_project", { projectId });
  }

  async function reorderProjects(projectIds: string[]): Promise<Project[]> {
    return invoke<Project[]>("reorder_projects", { projectIds });
  }

  async function updateProject(
    projectId: string,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder" | "icon">>,
  ): Promise<Project> {
    return invoke<Project>("update_project", { projectId, updates });
  }

  /**
   * Persists a sidebar arrangement: the full project order plus any folder
   * memberships that changed, applied as one backend mutation.
   */
  async function arrangeProjects(
    projectIds: string[],
    folders: Record<string, string | null> = {},
  ): Promise<Project[]> {
    return invoke<Project[]>("arrange_projects", { projectIds, folders });
  }

  /**
   * Sends a sidebar gesture for the backend to resolve against its current
   * projects. `preview` is what this client resolved locally; it is written as a
   * whole arrangement only to a backend that predates the command.
   */
  async function arrangeProjectsByIntent(
    intent: ProjectArrangementIntent,
    preview: ProjectArrangement,
  ): Promise<Project[]> {
    try {
      return await invoke<Project[]>("arrange_projects_by_intent", { intent });
    } catch (error) {
      if (incompatibility(error, "arrange_projects_by_intent")?.code !== "unknown-command")
        throw error;
      return arrangeProjects(preview.projectIds, preview.folders);
    }
  }

  /** Bounded with the other hydration reads (`hydration-request-limiter.ts`). */
  async function getEnvironments(projectId: string): Promise<Environment[]> {
    return environmentRequests.run(() =>
      hydrationRequests.run(() => invoke<Environment[]>("get_environments", { projectId })),
    );
  }

  /**
   * Read the persisted environment list without reconciling Docker state.
   * Intended for frequent cross-client snapshot refreshes. Bounded with the
   * other hydration reads.
   */
  async function getEnvironmentSnapshots(projectId: string): Promise<Environment[]> {
    return hydrationActivity.track(() =>
      hydrationRequests.run(() =>
        invoke<Environment[]>("get_environment_snapshots", { projectId }),
      ),
    );
  }

  /**
   * Read one persisted environment, as `getEnvironmentSnapshots` lists it; `null`
   * when it no longer exists. Backends before this command reject it as unknown.
   */
  async function getEnvironmentSnapshot(environmentId: string): Promise<Environment | null> {
    return invoke<Environment | null>("get_environment_snapshot", { environmentId });
  }

  async function reorderEnvironments(
    projectId: string,
    environmentIds: string[],
  ): Promise<Environment[]> {
    return invoke<Environment[]>("reorder_environments", { projectId, environmentIds });
  }

  async function getEnvironment(environmentId: string): Promise<Environment | null> {
    return invoke<Environment | null>("get_environment", { environmentId });
  }

  async function createEnvironment(
    projectId: string,
    name?: string,
    networkAccessMode?: NetworkAccessMode,
    initialPrompt?: string,
    portMappings?: PortMapping[],
    environmentType?: EnvironmentType,
    namingPrompt?: string,
    buildPipelineId?: string,
    /** Parent folder for a local environment's worktree; omitted uses the default. */
    worktreeBaseDir?: string,
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
      ...(worktreeBaseDir ? { worktreeBaseDir } : {}),
    });
  }

  async function forkEnvironment(
    environmentId: string,
    environmentType: EnvironmentType,
  ): Promise<Environment> {
    return invoke<Environment>("fork_environment", { environmentId, environmentType });
  }

  /**
   * Returns the project's home environment — the one that works directly in the
   * project's own checkout — creating it on first use. Idempotent; refreshes the
   * stored branch from the checkout on every call.
   */
  async function ensureProjectHomeEnvironment(projectId: string): Promise<Environment> {
    return invoke<Environment>("ensure_project_home_environment", { projectId });
  }

  async function deleteEnvironment(environmentId: string): Promise<void> {
    return invoke("delete_environment", { environmentId });
  }

  async function startEnvironment(environmentId: string): Promise<StartEnvironmentResult> {
    return invoke<StartEnvironmentResult>("start_environment", { environmentId });
  }

  /**
   * Accept an environment start without keeping the renderer transport open for
   * Docker provisioning. Progress and completion are observed through the
   * authoritative environment snapshot and setup lifecycle events.
   */
  async function startEnvironmentInBackground(environmentId: string): Promise<void> {
    return invoke<void>("start_environment_background", { environmentId });
  }

  async function stopEnvironment(environmentId: string): Promise<void> {
    return invoke("stop_environment", { environmentId });
  }

  /** Earlier states this environment keeps (rebuild, reset and restore sources). */
  async function listRecoveryCopies(
    environmentId: string,
    options: { measureSize?: boolean } = {},
  ): Promise<RecoveryCopyList> {
    return invoke<RecoveryCopyList>("list_recovery_copies", { environmentId, ...options });
  }

  /** Permanently deletes one recovery copy, bound to the reviewed list revision. */
  async function discardRecoveryCopy(
    environmentId: string,
    copyId: string,
    expectedRevision: number,
  ): Promise<
    | {
        copyId: string;
        discarded: boolean;
        kept: { containerId: string | null; volumes: string[] };
      }
    | undefined
  > {
    return invoke("discard_recovery_copy", { environmentId, copyId, expectedRevision });
  }

  /**
   * Makes a recovery copy current again. The current container and files are
   * kept as another recovery copy first; the environment then starts on the copy.
   */
  async function restoreRecoveryCopy(
    environmentId: string,
    copyId: string,
    expectedContainerId: string | null,
    expectedRevision: number,
  ): Promise<void> {
    return invoke("restore_recovery_copy", {
      environmentId,
      copyId,
      expectedContainerId,
      expectedRevision,
    });
  }

  /** The authoritative container lifecycle state, for rehydrating progress. */
  async function getContainerLifecycleSnapshot(
    environmentId: string,
    machine?: AccountMachine,
  ): Promise<ContainerLifecycleSnapshot> {
    return machineInvoke<ContainerLifecycleSnapshot>(machine, "get_container_lifecycle_snapshot", {
      environmentId,
    });
  }

  /** What a preserving rebuild would keep, and whether it is possible now. */
  async function getRebuildPreview(
    environmentId: string,
    machine?: AccountMachine,
  ): Promise<RebuildPreview> {
    return machineInvoke<RebuildPreview>(machine, "get_rebuild_preview", { environmentId });
  }

  /**
   * Asks an uncommitted rebuild to stop at its next phase boundary. The
   * original container stays authoritative; the lifecycle snapshot reports the
   * outcome.
   */
  async function cancelContainerOperation(
    environmentId: string,
    operationId: string,
  ): Promise<{ cancelled: boolean; pending?: boolean }> {
    return invoke("cancel_container_operation", { environmentId, operationId });
  }

  /**
   * Replace an environment's container. Only an explicit, reviewed discard can
   * remove a container whose writable layer holds the workspace; see
   * `parseContainerLifecycleError` for the typed refusals.
   */
  async function recreateEnvironment(
    environmentId: string,
    options: RecreateEnvironmentOptions,
    machine?: AccountMachine,
  ): Promise<void> {
    return machineInvoke(machine, "recreate_environment", { environmentId, ...options });
  }

  async function syncEnvironmentStatus(environmentId: string): Promise<Environment> {
    return invoke<Environment>("sync_environment_status", { environmentId });
  }

  /**
   * Sync all environments with Docker state at startup.
   * Clears container references for environments whose Docker containers no longer exist.
   * Returns an array of environment IDs that had their container references cleared.
   */
  async function syncAllEnvironmentsWithDocker(): Promise<string[]> {
    return invoke<string[]>("sync_all_environments_with_docker");
  }

  async function renameEnvironment(environmentId: string, name: string): Promise<Environment> {
    return invoke<Environment>("rename_environment", { environmentId, name });
  }

  /**
   * Moves a local environment's worktree, with all its files, into
   * `destinationDir` (the worktree keeps its folder name). Refused while an
   * agent is working in the environment.
   */
  async function moveEnvironment(
    environmentId: string,
    destinationDir: string,
  ): Promise<Environment> {
    return invoke<Environment>("move_environment", { environmentId, destinationDir });
  }

  async function getEnvironmentStatus(environmentId: string): Promise<EnvironmentStatus> {
    return invoke<EnvironmentStatus>("get_environment_status", { environmentId });
  }

  /** Which agent inputs the environment's container was given, and whether they are current. */
  async function getEnvironmentInputs(environmentId: string): Promise<EnvironmentInputStatus> {
    return invoke<EnvironmentInputStatus>("get_environment_inputs", { environmentId });
  }

  /** Removes one provider's imported credentials from the environment's container. */
  async function revokeProviderCredentials(
    environmentId: string,
    provider: string,
  ): Promise<CredentialRevocationResult> {
    return invoke<CredentialRevocationResult>("revoke_provider_credentials", {
      environmentId,
      provider,
    });
  }

  /** Allows a revoked provider again; its configuration returns with the next rebuild. */
  async function restoreProviderCredentials(
    environmentId: string,
    provider: string,
  ): Promise<{ provider: string; pendingRebuild: boolean }> {
    return invoke("restore_provider_credentials", { environmentId, provider });
  }

  /** The configured network policy and what the container's firewall applied. */
  async function getEnvironmentNetworkPolicy(
    environmentId: string,
  ): Promise<EnvironmentNetworkPolicy> {
    return invoke<EnvironmentNetworkPolicy>("get_environment_network_policy", { environmentId });
  }

  /** Applies the saved allowlist to the running container in place, when it can. */
  async function applyEnvironmentAllowedDomains(environmentId: string): Promise<{
    kind: "applied" | "not-applicable" | "rebuild-required" | "not-running" | "failed";
    policy: EnvironmentNetworkPolicy;
  }> {
    return invoke("apply_environment_allowed_domains", { environmentId });
  }

  /** Requested budget, its source, and what Docker applied to the current runtime. */
  async function getEnvironmentResources(
    environmentId: string,
  ): Promise<import("@orkestrator/protocol/container-resources").EnvironmentResourcePolicy> {
    return invoke("get_environment_resources", { environmentId });
  }

  /**
   * Sets (or with `null` clears) this environment's budget, optionally applying
   * it to the running container now. The result reports what Docker applied.
   */
  async function updateEnvironmentResources(
    environmentId: string,
    options: {
      limits: import("@orkestrator/protocol/container-resources").ContainerResourceLimits | null;
      applyNow: boolean;
      allowBelowUsage?: boolean;
    },
  ): Promise<import("@orkestrator/protocol/container-resources").EnvironmentResourcePolicy> {
    return invoke("update_environment_resources", { environmentId, ...options });
  }

  return {
    getResourceRevisionManifest,
    getScopedResourceRevisionManifest,
    getScopedResourceSnapshots,
    getProjects,
    addProject,
    createProjectFromScratch,
    listGitHubCloneAccounts,
    listGitHubCloneRepositories,
    removeProject,
    reorderProjects,
    updateProject,
    arrangeProjects,
    arrangeProjectsByIntent,
    getEnvironments,
    getEnvironmentSnapshots,
    getEnvironmentSnapshot,
    reorderEnvironments,
    getEnvironment,
    createEnvironment,
    forkEnvironment,
    ensureProjectHomeEnvironment,
    deleteEnvironment,
    startEnvironment,
    startEnvironmentInBackground,
    stopEnvironment,
    listRecoveryCopies,
    discardRecoveryCopy,
    restoreRecoveryCopy,
    getContainerLifecycleSnapshot,
    getRebuildPreview,
    cancelContainerOperation,
    recreateEnvironment,
    syncEnvironmentStatus,
    syncAllEnvironmentsWithDocker,
    renameEnvironment,
    moveEnvironment,
    getEnvironmentStatus,
    getEnvironmentInputs,
    revokeProviderCredentials,
    restoreProviderCredentials,
    getEnvironmentNetworkPolicy,
    applyEnvironmentAllowedDomains,
    getEnvironmentResources,
    updateEnvironmentResources,
  };
}

export type ProjectsEnvironmentsApi = ReturnType<typeof createProjectsEnvironmentsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getResourceRevisionManifest,
  getScopedResourceRevisionManifest,
  getScopedResourceSnapshots,
  getProjects,
  addProject,
  createProjectFromScratch,
  listGitHubCloneAccounts,
  listGitHubCloneRepositories,
  removeProject,
  reorderProjects,
  updateProject,
  arrangeProjects,
  arrangeProjectsByIntent,
  getEnvironments,
  getEnvironmentSnapshots,
  getEnvironmentSnapshot,
  reorderEnvironments,
  getEnvironment,
  createEnvironment,
  forkEnvironment,
  ensureProjectHomeEnvironment,
  deleteEnvironment,
  startEnvironment,
  startEnvironmentInBackground,
  stopEnvironment,
  listRecoveryCopies,
  discardRecoveryCopy,
  restoreRecoveryCopy,
  getContainerLifecycleSnapshot,
  getRebuildPreview,
  cancelContainerOperation,
  recreateEnvironment,
  syncEnvironmentStatus,
  syncAllEnvironmentsWithDocker,
  renameEnvironment,
  moveEnvironment,
  getEnvironmentStatus,
  getEnvironmentInputs,
  revokeProviderCredentials,
  restoreProviderCredentials,
  getEnvironmentNetworkPolicy,
  applyEnvironmentAllowedDomains,
  getEnvironmentResources,
  updateEnvironmentResources,
} = createProjectsEnvironmentsApi(commandBackendClient);
