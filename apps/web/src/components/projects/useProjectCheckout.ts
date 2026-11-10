import { useProjectStore } from "@/stores/projectStore";

/**
 * What this node scope knows about a project's local checkout.
 *
 * - `loading`: the node's project list has not been read yet.
 * - `unavailable`: the list has never been read and the last read failed, so
 *   whether the node has this project is unknown. The store's `error` says
 *   why; a reload may still find it.
 * - `missing`: the list has been read and holds no project with this id. Ids
 *   are per node, so this is also what a project shown under another node's
 *   scope looks like; Repository settings cannot open for it here.
 * - `no-checkout`: the project is here but has no local path.
 * - `ready`: the project has a local path.
 */
export type ProjectCheckoutState = "loading" | "unavailable" | "missing" | "no-checkout" | "ready";

export function useProjectCheckout(projectId: string): ProjectCheckoutState {
  return useProjectStore((state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (project) return project.localPath?.trim() ? "ready" : "no-checkout";
    if (state.hasLoaded) return "missing";
    return !state.isLoading && state.error !== null ? "unavailable" : "loading";
  });
}

/** The node's last project-list read error, for an `unavailable` checkout. */
export function useProjectListError(): string | null {
  return useProjectStore((state) => state.error);
}
