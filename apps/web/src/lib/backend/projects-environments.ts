import { environmentRequests, hydrationRequests } from "@/lib/hydration-request-limiter";
import { hydrationActivity } from "@/lib/hydration-activity";
import { systemApi } from "@/lib/node-scope/domains/system";
import { type AccountMachine } from "./agent-accounts";
import { projects as projectsDomain } from "@/lib/node-scope/domains/projects";
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
  isScopedResourceRevisionManifest,
  isScopedResourceSnapshotBatch,
  SCOPED_RESOURCE_SNAPSHOT_BATCH_MAX_BYTES,
  type ResourceChange,
  type ScopedResourceSnapshotBatch,
  type ScopedResourceRevisionManifest,
  type ResourceRevisionMap,
} from "@orkestrator/protocol/resource-events";
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import { commandBackendClient, type BackendClient, machineBackendClient } from "./client";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
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
  // The `projects` domain (plan item 7005): typed, decoded results.
  const projects = projectsDomain(client);
  // The `environments` domain (plan item 7003): typed, decoded results.
  const environments = () => domainApi(client, environmentsClient);
  const environmentsOn = (machine: AccountMachine) =>
    machine === undefined
      ? environments()
      : domainApi(machineBackendClient(client, machine), environmentsClient);

  async function getScopedResourceRevisionManifest(
    knownGeneration?: string,
    cursor = 0,
    knownRevisions: Partial<ResourceRevisionMap> = {},
    highWater?: number,
  ): Promise<ScopedResourceRevisionManifest> {
    const response = await systemApi(client).get_scoped_resource_revision_manifest({
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
    const response = await systemApi(client).get_scoped_resource_snapshots({ changes });
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

  /** `get_projects` without a known revision: always the list. */
  function projectList(answer: Awaited<ReturnType<ReturnType<typeof projects>["get_projects"]>>) {
    if (Array.isArray(answer)) return answer;
    throw new Error("Invalid projects response");
  }

  async function getProjects(machine?: AccountMachine): Promise<Project[]> {
    return projectList(
      await (
        machine === undefined ? projects() : projectsDomain(machineBackendClient(client, machine))()
      ).get_projects({}),
    );
  }

  async function addProject(
    gitUrl: string,
    localPath?: string,
    cloneOnly?: boolean,
  ): Promise<Project> {
    return projects().add_project({
      gitUrl,
      localPath,
      ...(cloneOnly === undefined ? {} : { cloneOnly }),
    });
  }

  async function createProjectFromScratch(localPath: string): Promise<Project> {
    return projects().create_project_from_scratch({ localPath });
  }

  async function listGitHubCloneAccounts(): Promise<GitHubCloneAccount[]> {
    return projects().list_github_clone_accounts({});
  }

  async function listGitHubCloneRepositories(
    owner: string,
    cursor?: string,
  ): Promise<GitHubCloneRepositoryList> {
    return projects().list_github_clone_repositories({
      owner,
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  async function removeProject(projectId: string): Promise<void> {
    return projects().remove_project({ projectId });
  }

  async function reorderProjects(projectIds: string[]): Promise<Project[]> {
    return projects().reorder_projects({ projectIds });
  }

  async function updateProject(
    projectId: string,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder" | "icon">>,
  ): Promise<Project> {
    return projects().update_project({ projectId, updates });
  }

  /**
   * Points the project checkout's GitHub SSH `origin` at HTTPS, after the
   * backend checked HTTPS works there. Offered when a start could not reach
   * the remote over SSH (`lifecycleRemedy: "use-https"`).
   */
  async function switchProjectRemoteToHttps(
    projectId: string,
  ): Promise<{ remoteUrl: string; changed: boolean }> {
    return projects().use_https_git_remote({ projectId });
  }

  /**
   * Persists a sidebar arrangement: the full project order plus any folder
   * memberships that changed, applied as one backend mutation.
   */
  async function arrangeProjects(
    projectIds: string[],
    folders: Record<string, string | null> = {},
  ): Promise<Project[]> {
    return projects().arrange_projects({ projectIds, folders });
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
      return await projects().arrange_projects_by_intent({ intent });
    } catch (error) {
      if (incompatibility(error, "arrange_projects_by_intent")?.code !== "unknown-command")
        throw error;
      return arrangeProjects(preview.projectIds, preview.folders);
    }
  }

  /** Bounded with the other hydration reads (`hydration-request-limiter.ts`). */
  async function getEnvironments(projectId: string): Promise<Environment[]> {
    return environmentRequests.run(() =>
      hydrationRequests.run(() => environments().getEnvironments({ projectId })),
    );
  }

  /**
   * Read the persisted environment list without reconciling Docker state.
   * Intended for frequent cross-client snapshot refreshes. Bounded with the
   * other hydration reads.
   */
  async function getEnvironmentSnapshots(projectId: string): Promise<Environment[]> {
    return hydrationActivity.track(() =>
      hydrationRequests.run(async () => {
        const snapshot = await environments().getEnvironmentSnapshots({ projectId });
        // Without a known revision the backend always answers the list.
        if (Array.isArray(snapshot)) return snapshot;
        if (snapshot.status === "changed") return snapshot.snapshot;
        throw new Error("get_environment_snapshots answered unchanged without a known revision");
      }),
    );
  }

  /**
   * Read one persisted environment, as `getEnvironmentSnapshots` lists it; `null`
   * when it no longer exists. Backends before this command reject it as unknown.
   */
  async function getEnvironmentSnapshot(environmentId: string): Promise<Environment | null> {
    return environments().getEnvironmentSnapshot({ environmentId });
  }

  async function reorderEnvironments(
    projectId: string,
    environmentIds: string[],
  ): Promise<Environment[]> {
    return environments().reorderEnvironments({ projectId, environmentIds });
  }

  async function getEnvironment(environmentId: string): Promise<Environment | null> {
    const environment = await environments().getEnvironment({ environmentId });
    // A final PR record answers only `includeFinalPrState`, which this read never sends.
    return environment === null || "finalPrState" in environment ? null : environment;
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
    return environments().createEnvironment({
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
    return environments().forkEnvironment({ environmentId, environmentType });
  }

  /**
   * Returns the project's home environment — the one that works directly in the
   * project's own checkout — creating it on first use. Idempotent; refreshes the
   * stored branch from the checkout on every call.
   */
  async function ensureProjectHomeEnvironment(projectId: string): Promise<Environment> {
    return environments().ensureProjectHomeEnvironment({ projectId });
  }

  async function deleteEnvironment(environmentId: string): Promise<void> {
    return environments().deleteEnvironment({ environmentId });
  }

  async function startEnvironment(environmentId: string): Promise<StartEnvironmentResult> {
    return environments().startEnvironment({ environmentId });
  }

  /**
   * Accept an environment start without keeping the renderer transport open for
   * Docker provisioning. Progress and completion are observed through the
   * authoritative environment snapshot and setup lifecycle events.
   */
  async function startEnvironmentInBackground(environmentId: string): Promise<void> {
    return environments().startEnvironmentBackground({ environmentId });
  }

  async function stopEnvironment(environmentId: string): Promise<void> {
    return environments().stopEnvironment({ environmentId });
  }

  /** Earlier states this environment keeps (rebuild, reset and restore sources). */
  async function listRecoveryCopies(
    environmentId: string,
    options: { measureSize?: boolean } = {},
  ): Promise<RecoveryCopyList> {
    return environments().listRecoveryCopies({ environmentId, ...options });
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
    return environments().discardRecoveryCopy({ environmentId, copyId, expectedRevision });
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
    await environments().restoreRecoveryCopy({
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
    return environmentsOn(machine).getContainerLifecycleSnapshot({ environmentId });
  }

  /** What a preserving rebuild would keep, and whether it is possible now. */
  async function getRebuildPreview(
    environmentId: string,
    machine?: AccountMachine,
  ): Promise<RebuildPreview> {
    return environmentsOn(machine).getRebuildPreview({ environmentId });
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
    return environments().cancelContainerOperation({ environmentId, operationId });
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
    await environmentsOn(machine).recreateEnvironment({ environmentId, ...options });
  }

  async function syncEnvironmentStatus(environmentId: string): Promise<Environment> {
    return environments().syncEnvironmentStatus({ environmentId });
  }

  /**
   * Sync all environments with Docker state at startup.
   * Clears container references for environments whose Docker containers no longer exist.
   * Returns an array of environment IDs that had their container references cleared.
   */
  async function syncAllEnvironmentsWithDocker(): Promise<string[]> {
    return environments().syncAllEnvironmentsWithDocker({});
  }

  async function renameEnvironment(environmentId: string, name: string): Promise<Environment> {
    return environments().renameEnvironment({ environmentId, name });
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
    return environments().moveEnvironment({ environmentId, destinationDir });
  }

  async function getEnvironmentStatus(environmentId: string): Promise<EnvironmentStatus> {
    return environments().getEnvironmentStatus({ environmentId });
  }

  /** Which agent inputs the environment's container was given, and whether they are current. */
  async function getEnvironmentInputs(environmentId: string): Promise<EnvironmentInputStatus> {
    return environments().getEnvironmentInputs({ environmentId });
  }

  /** Removes one provider's imported credentials from the environment's container. */
  async function revokeProviderCredentials(
    environmentId: string,
    provider: string,
  ): Promise<CredentialRevocationResult> {
    return environments().revokeProviderCredentials({ environmentId, provider });
  }

  /** Allows a revoked provider again; its configuration returns with the next rebuild. */
  async function restoreProviderCredentials(
    environmentId: string,
    provider: string,
  ): Promise<{ provider: string; pendingRebuild: boolean }> {
    return environments().restoreProviderCredentials({ environmentId, provider });
  }

  /** The configured network policy and what the container's firewall applied. */
  async function getEnvironmentNetworkPolicy(
    environmentId: string,
  ): Promise<EnvironmentNetworkPolicy> {
    return environments().getEnvironmentNetworkPolicy({ environmentId });
  }

  /** Applies the saved allowlist to the running container in place, when it can. */
  async function applyEnvironmentAllowedDomains(environmentId: string): Promise<{
    kind: "applied" | "not-applicable" | "rebuild-required" | "not-running" | "failed";
    policy: EnvironmentNetworkPolicy;
  }> {
    return environments().applyEnvironmentAllowedDomains({ environmentId });
  }

  /** Requested budget, its source, and what Docker applied to the current runtime. */
  async function getEnvironmentResources(
    environmentId: string,
  ): Promise<import("@orkestrator/protocol/container-resources").EnvironmentResourcePolicy> {
    return environments().getEnvironmentResources({ environmentId });
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
    return environments().updateEnvironmentResources({ environmentId, ...options });
  }

  return {
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
    switchProjectRemoteToHttps,
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
  switchProjectRemoteToHttps,
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
