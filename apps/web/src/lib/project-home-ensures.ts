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
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
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
  if (isProjectHomeDeletionInProgress(projectId, scope)) {
    return Promise.reject(new Error("The project home is being deleted"));
  }
  const pending = pendingHomeEnsures(scope);
  const key = `${projectId}\0${
    scope
      .store(projectStore)
      .getState()
      .projects.find((project) => project.id === projectId)?.localPath ?? ""
  }`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = reconcileHomeInStore(projectId, scope).finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  pending.set(key, task);
  return task;
}

export function isProjectHomeDeletionInProgress(
  projectId: string,
  scope: NodeScope = appCommandScope(),
): boolean {
  const projects = scope.store(projectStore).getState();
  const environments = scope.store(environmentStore).getState();
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
  // Held across the await: a disposed scope's stores can no longer be read.
  const projects = scope.store(projectStore);
  const environments = scope.store(environmentStore);
  const configuredPath = projects
    .getState()
    .projects.find((project) => project.id === projectId)?.localPath;
  const api = backendApiForScope(scope, createProjectsEnvironmentsApi, {
    ensureProjectHomeEnvironment: backend.ensureProjectHomeEnvironment,
  });
  const environment = await api.ensureProjectHomeEnvironment(projectId);
  if (
    projects.getState().projects.find((project) => project.id === projectId)?.localPath !==
    configuredPath
  ) {
    throw new Error("The project checkout changed; try the file action again");
  }
  // The backend may have finished creation after teardown was fenced. Return
  // the record to the draining delete path, but never resurrect it in the UI.
  if (scope.disposed || isProjectHomeDeletionInProgress(projectId, scope)) return environment;
  const store = environments.getState();
  if (store.environments.some((candidate) => candidate.id === environment.id)) {
    store.updateEnvironment(environment.id, environment);
  } else {
    store.addEnvironment(environment);
  }
  return environment;
}
