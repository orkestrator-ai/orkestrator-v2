import { invoke } from "@/lib/native/backend";
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
  type ResourceRevisionManifest,
  type ResourceRevisionMap,
} from "@orkestrator/protocol/resource-events";
/** PR detection result containing URL, state, and merge conflict status */

/** PR detection result containing URL, state, and merge conflict status */
export interface PrDetectionResult {
  url: string;
  state: PrState;
  hasMergeConflicts: boolean | null;
}

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
  updates: Partial<Pick<Project, "name" | "localPath">>,
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

export async function reorderEnvironments(
  projectId: string,
  environmentIds: string[],
): Promise<Environment[]> {
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

export async function getEnvironmentStatus(environmentId: string): Promise<EnvironmentStatus> {
  return invoke<EnvironmentStatus>("get_environment_status", { environmentId });
}

// --- Terminal Commands ---
