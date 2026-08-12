import { useProjectStore } from "@/stores/projectStore";

/**
 * Whether a project has a host checkout that can own local worktrees.
 *
 * An id the store does not know yet resolves to `true`, not `false`. The
 * project list hydrates asynchronously while `selectedProjectId` is restored
 * synchronously from the persisted UI store, so "not found" during that window
 * means "not loaded", not "no checkout". Defaulting to unavailable would let a
 * launcher silently rewrite a user's `local` default to `containerized`, and
 * nothing rewrites it back once the store arrives. The backend is the
 * authority either way: `create_environment` rejects a local request for a
 * project with no `localPath`.
 */
export function useLocalEnvironmentAvailable(projectId: string | undefined | null): boolean {
  return useProjectStore((state) => {
    if (!projectId) return true;
    const project = state.projects.find((candidate) => candidate.id === projectId);
    return project ? Boolean(project.localPath) : true;
  });
}
