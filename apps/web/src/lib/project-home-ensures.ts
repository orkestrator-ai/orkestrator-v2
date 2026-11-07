/**
 * The project home environment, ensured on demand per node (plan item 3007,
 * report Appendix B: `useFilesPanel`'s per-project map moves onto the scope).
 *
 * File mutations on a project's root checkout go through its home
 * environment, because every backend file mutation is authorised by an
 * environment record. Project ids belong to one node, so the in-flight
 * ensures are held per node scope and asked of that node.
 */

import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createProjectsEnvironmentsApi } from "@/lib/backend/projects-environments";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import type { Environment } from "@/types";

/** In-flight ensures by `projectId \0 configured checkout path`. */
const pendingHomeEnsures = defineScopedSlot<Map<string, Promise<Environment>>>(
  "project-home-ensures",
  () => new Map(),
);

/**
 * Returns the project's home environment, creating it on first use, and makes
 * it visible in the environment store.
 */
export function ensureProjectHomeInStore(
  projectId: string,
  scope: NodeScope = appCommandScope(),
): Promise<Environment> {
  if (isProjectHomeDeletionInProgress(projectId)) {
    return Promise.reject(new Error("The project home is being deleted"));
  }
  const pending = pendingHomeEnsures(scope);
  const key = `${projectId}\0${useProjectStore.getState().projects.find((project) => project.id === projectId)?.localPath ?? ""}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = reconcileHomeInStore(projectId, scope).finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  pending.set(key, task);
  return task;
}

export function isProjectHomeDeletionInProgress(projectId: string): boolean {
  const projects = useProjectStore.getState();
  const environments = useEnvironmentStore.getState();
  return (
    projects.deletingProjects.has(projectId) ||
    environments.environments.some(
      (environment) =>
        environment.projectId === projectId &&
        environment.projectHome &&
        environments.isDeleting(environment.id),
    )
  );
}

/** Fence new ensures first, then drain previously admitted work before teardown. */
export async function drainProjectHomeEnsures(
  projectId: string,
  scope: NodeScope = appCommandScope(),
): Promise<Environment[]> {
  const tasks = Array.from(pendingHomeEnsures(scope).entries())
    .filter(([key]) => key.startsWith(`${projectId}\0`))
    .map(([, task]) => task);
  const results = await Promise.allSettled(tasks);
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

async function reconcileHomeInStore(projectId: string, scope: NodeScope): Promise<Environment> {
  const configuredPath = useProjectStore
    .getState()
    .projects.find((project) => project.id === projectId)?.localPath;
  const api = backendApiForScope(scope, createProjectsEnvironmentsApi, {
    ensureProjectHomeEnvironment: backend.ensureProjectHomeEnvironment,
  });
  const environment = await api.ensureProjectHomeEnvironment(projectId);
  if (
    useProjectStore.getState().projects.find((project) => project.id === projectId)?.localPath !==
    configuredPath
  ) {
    throw new Error("The project checkout changed; try the file action again");
  }
  // The backend may have finished creation after teardown was fenced. Return
  // the record to the draining delete path, but never resurrect it in the UI.
  if (isProjectHomeDeletionInProgress(projectId)) return environment;
  const store = useEnvironmentStore.getState();
  if (store.environments.some((candidate) => candidate.id === environment.id)) {
    store.updateEnvironment(environment.id, environment);
  } else {
    store.addEnvironment(environment);
  }
  return environment;
}
