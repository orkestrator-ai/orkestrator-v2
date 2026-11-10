import { useProjectStore } from "@/stores/projectStore";

/**
 * What this node scope knows about a project's local checkout.
 *
 * - `loading`: the node's project list has not been read yet.
 * - `missing`: the list has been read and holds no project with this id, or
 *   it could not be read. Ids are per node, so this is also what a project
 *   shown under another node's scope looks like; Repository settings cannot
 *   open for it here.
 * - `no-checkout`: the project is here but has no local path.
 * - `ready`: the project has a local path.
 */
export type ProjectCheckoutState = "loading" | "missing" | "no-checkout" | "ready";

export function useProjectCheckout(projectId: string): ProjectCheckoutState {
  return useProjectStore((state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (project) return project.localPath?.trim() ? "ready" : "no-checkout";
    const readFailed = !state.isLoading && state.error !== null;
    return state.hasLoaded || readFailed ? "missing" : "loading";
  });
}
