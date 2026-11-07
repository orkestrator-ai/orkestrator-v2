/**
 * The authoritative resync of a node's projects and environments (plan item
 * 3004), registered on that node's store bindings (`store-resource-sync.ts`,
 * plan item 3014).
 *
 * Both stores are per node scope, so these registrations run on every scope:
 * each reads its own node and writes that node's stores. The live change
 * announcements for both collections are consumed by `useProjects` and the
 * sidebar's environment list sync; this module owns the manifest and full
 * reconciliation, so convergence never depends on the sidebar being mounted.
 *
 * Kept out of `store-resource-sync.ts` so the store bindings stay a list of
 * registrations, and out of the store modules so a store does not import the
 * backend. It imports the framework's types only, so `store-resource-sync.ts`
 * can import it back without a cycle.
 */
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createProjectsEnvironmentsApi } from "@/lib/backend/projects-environments";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { noteAuthoritativeRead } from "@/lib/node-scope/snapshot-sync";
import type { StoreResourceHandlers, StoreResourceSyncContext } from "@/lib/store-resource-sync";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";

/** `scope`'s list reads; the command scope keeps the named exports suites mock. */
function listReads(scope: NodeScope) {
  return backendApiForScope<
    ReturnType<typeof createProjectsEnvironmentsApi>,
    "getProjects" | "getEnvironmentSnapshots"
  >(scope, createProjectsEnvironmentsApi, backend);
}

function registerProjects(context: StoreResourceSyncContext): void {
  const projects = context.scope.store(projectStore);
  context.onResync("projects", async (pass) => {
    if (!pass.includes("project")) return;
    const projectsAtRequest = projects.getState().projects;
    const mutationVersion = projects.getState().getMutationVersion();
    const read = context.options.getProjects ?? listReads(context.scope).getProjects;
    const snapshot = await read();
    // A live refresh, local mutation, or newer manifest read may have
    // installed a newer collection while this request was in flight. Both
    // guards are needed: the mutation version covers optimistic writes,
    // while array identity orders concurrent authoritative reads.
    const accepted =
      !context.disposed() &&
      projects.getState().projects === projectsAtRequest &&
      projects.getState().applySnapshot(snapshot, mutationVersion);
    if (!context.disposed() && !accepted) pass.requeue("project");
  });
}

function registerEnvironments(context: StoreResourceSyncContext): void {
  const environments = context.scope.store(environmentStore);
  const projects = context.scope.store(projectStore);
  context.onResync("environments", async (pass) => {
    if (!pass.includes("environment")) return;
    const environmentsAtRequest = environments.getState().environments;
    // This phase runs after the project phase, so it sees projects added or
    // removed while the renderer was inactive. Install all project scopes
    // atomically: one failed read must not leave a half-new environment set.
    const projectIds = projects.getState().projects.map(({ id }) => id);
    const read =
      context.options.getEnvironmentSnapshots ?? listReads(context.scope).getEnvironmentSnapshots;
    const snapshots = await Promise.all(projectIds.map((projectId) => read(projectId)));
    const accepted =
      !context.disposed() && environments.getState().environments === environmentsAtRequest;
    if (accepted) {
      environments.getState().setEnvironments(snapshots.flat());
      // A scope painted from its local snapshot waits for this (plan item 4003).
      noteAuthoritativeRead(context.scope, "environment");
    } else if (!context.disposed()) {
      pass.requeue("environment");
    }
  });
}

/**
 * Plain frozen registrations, the shape `defineStoreResourceHandlers` makes:
 * calling it would import `store-resource-sync.ts`, which imports this module.
 */
export const projectResourceHandlers: StoreResourceHandlers = Object.freeze({
  name: "projects",
  runsOn: "every-scope",
  register: registerProjects,
});

export const environmentResourceHandlers: StoreResourceHandlers = Object.freeze({
  name: "environments",
  runsOn: "every-scope",
  register: registerEnvironments,
});
