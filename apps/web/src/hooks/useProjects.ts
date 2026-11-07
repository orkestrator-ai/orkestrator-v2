// Hook for managing project operations with Electron backend
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { errorText } from "@/components/settings/machines/machine-ui";
import type { StoreApi } from "zustand";
import { projectStore, useProjectStore, type ProjectState } from "@/stores/projectStore";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createDockerSkillsApi } from "@/lib/backend/docker-skills";
import { createProjectsEnvironmentsApi } from "@/lib/backend/projects-environments";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { defineScopedSlot } from "@/lib/node-scope-slots";
import {
  resolveProjectArrangementIntent,
  type ProjectArrangementIntent,
} from "@orkestrator/protocol/project-arrangement";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";

interface ProjectLoad {
  mutationVersion: number;
  promise: Promise<void>;
}

/** One node's shared project read (plan item 3004): project ids are node-local. */
interface ProjectLoads {
  readonly store: StoreApi<ProjectState>;
  latest: ProjectLoad | null;
}

const projectLoads = defineScopedSlot<ProjectLoads>("project-loads", (scope) => ({
  store: scope.store(projectStore),
  latest: null,
}));

/** `scope`'s project commands; the command scope keeps the mocked named exports. */
function projectsApi(scope: NodeScope) {
  return backendApiForScope<
    ReturnType<typeof createProjectsEnvironmentsApi>,
    | "addProject"
    | "arrangeProjectsByIntent"
    | "createProjectFromScratch"
    | "getProjects"
    | "removeProject"
    | "reorderProjects"
    | "updateProject"
  >(scope, createProjectsEnvironmentsApi, backend);
}

/** Reads `scope`'s projects into its store; concurrent callers share one read. */
export const loadProjectsFromBackend = (scope: NodeScope): Promise<void> => {
  const loads = projectLoads(scope);
  const store = loads.store;
  const mutationVersion = store.getState().getMutationVersion();

  // All hook instances share the same request for the same data generation.
  if (loads.latest?.mutationVersion === mutationVersion) {
    return loads.latest.promise;
  }

  const { setLoading, setError } = store.getState();
  setLoading(true);
  setError(null);

  let promise!: Promise<void>;
  promise = (async () => {
    try {
      const projects = await projectsApi(scope).getProjects();
      store.getState().applySnapshot(projects, mutationVersion);
    } catch (err) {
      // A failure from an obsolete read is no longer relevant to current data.
      if (store.getState().getMutationVersion() === mutationVersion) {
        store.getState().setError(err instanceof Error ? err.message : "Failed to load projects");
      }
    } finally {
      // A superseded request must not clear the newer request's loading state.
      if (loads.latest?.promise === promise) {
        loads.latest = null;
        store.getState().setLoading(false);
      }
    }
  })();

  loads.latest = { mutationVersion, promise };
  return promise;
};

export function useProjects() {
  // The node whose projects this reads: the nearest node scope, which is also
  // the one `useProjectStore` reads below.
  const scope = useNodeScope();
  const projects = useProjectStore((state) => state.projects);
  const isLoading = useProjectStore((state) => state.isLoading);
  const error = useProjectStore((state) => state.error);
  const setProjects = useProjectStore((state) => state.setProjects);
  const addProjectToStore = useProjectStore((state) => state.addProject);
  const removeProjectFromStore = useProjectStore((state) => state.removeProject);
  const updateProjectInStore = useProjectStore((state) => state.replaceProject);
  const reorderProjectsInStore = useProjectStore((state) => state.reorderProjects);
  const arrangeProjectsInStore = useProjectStore((state) => state.arrangeProjects);
  const setLoading = useProjectStore((state) => state.setLoading);
  const setError = useProjectStore((state) => state.setError);
  const getProjectById = useProjectStore((state) => state.getProjectById);
  const invalidateProjectSnapshots = useProjectStore((state) => state.invalidateSnapshots);

  const loadProjects = useCallback(() => loadProjectsFromBackend(scope), [scope]);

  // Load projects from backend on mount. Concurrent hook mounts share this read.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Converge when another client adds, renames, reorders or removes a project.
  // The snapshot cache is keyed by mutation version, so it must be invalidated
  // first or the shared in-flight read would replay stale data.
  useEffect(
    () =>
      onResourceChanged(
        "project",
        () => {
          invalidateProjectSnapshots();
          void loadProjects();
        },
        scope,
      ),
    [scope, invalidateProjectSnapshots, loadProjects],
  );

  // Manifest reconciliation only reloads this collection when its opaque
  // revision differs. The global store binding owns that inactive-safe read;
  // this hook retains the explicit fallback for rolling upgrades and diagnosis.
  useEffect(
    () =>
      onResourceResync((request) => {
        if (request.reason === "manifest") return;
        if (request.resources !== null && !request.resources.has("project")) return;
        invalidateProjectSnapshots();
        return loadProjects();
      }, scope),
    [scope, invalidateProjectSnapshots, loadProjects],
  );

  const addProject = useCallback(
    async (gitUrl: string, localPath?: string, cloneOnly?: boolean) => {
      invalidateProjectSnapshots();
      setLoading(true);
      setError(null);
      try {
        const project = await projectsApi(scope).addProject(gitUrl, localPath, cloneOnly);
        addProjectToStore(project);
        toast.success("Project added", { description: project.name });
        return project;
      } catch (err) {
        const message = err instanceof Error ? errorText(err) : "Failed to add project";
        setError(message);
        toast.error("Failed to add project", { description: message });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [scope, invalidateProjectSnapshots, addProjectToStore, setLoading, setError],
  );

  const createProjectFromScratch = useCallback(
    async (localPath: string) => {
      invalidateProjectSnapshots();
      setLoading(true);
      setError(null);
      try {
        const project = await projectsApi(scope).createProjectFromScratch(localPath);
        addProjectToStore(project);
        toast.success("Project created", { description: project.name });
        return project;
      } catch (err) {
        const message = err instanceof Error ? errorText(err) : "Failed to create project";
        setError(message);
        toast.error("Failed to create project", { description: message });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [scope, invalidateProjectSnapshots, addProjectToStore, setLoading, setError],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      invalidateProjectSnapshots();
      setLoading(true);
      setError(null);
      try {
        await projectsApi(scope).removeProject(projectId);
        removeProjectFromStore(projectId);
        toast.success("Project removed");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to remove project";
        setError(message);
        toast.error("Failed to remove project", { description: message });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [scope, invalidateProjectSnapshots, removeProjectFromStore, setLoading, setError],
  );

  const validateGitUrl = useCallback(
    async (url: string) => {
      try {
        return await backendApiForScope(scope, createDockerSkillsApi, {
          validateGitUrl: backend.validateGitUrl,
        }).validateGitUrl(url);
      } catch {
        return false;
      }
    },
    [scope],
  );

  const reorderProjects = useCallback(
    async (projectIds: string[]) => {
      invalidateProjectSnapshots();
      // Optimistically update the store
      reorderProjectsInStore(projectIds);
      try {
        // Persist to backend
        const reorderedProjects = await projectsApi(scope).reorderProjects(projectIds);
        setProjects(reorderedProjects);
      } catch (err) {
        // Reload from backend on error to restore correct state
        const message = err instanceof Error ? err.message : "Failed to reorder projects";
        toast.error("Failed to reorder projects");
        await loadProjects();
        // loadProjects clears stale errors before recovery; retain the mutation
        // failure so callers can still surface why the reorder was rolled back.
        setError(message);
        throw new Error(message);
      }
    },
    [
      scope,
      invalidateProjectSnapshots,
      reorderProjectsInStore,
      setProjects,
      setError,
      loadProjects,
    ],
  );

  /**
   * Applies a sidebar gesture: previewed here against this client's copy, and
   * resolved by the backend against its current projects under the store lock,
   * so a stale copy cannot undo what another client just arranged. A gesture
   * that changes nothing locally is not sent.
   */
  const arrangeProjectsByIntent = useCallback(
    async (intent: ProjectArrangementIntent) => {
      const preview = resolveProjectArrangementIntent(
        intent,
        scope.store(projectStore).getState().projects,
      );
      if (!preview) return;
      invalidateProjectSnapshots();
      arrangeProjectsInStore(preview.projectIds, preview.folders);
      try {
        setProjects(await projectsApi(scope).arrangeProjectsByIntent(intent, preview));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to arrange projects";
        // A folder-free arrangement is a plain reorder — the most common drag
        // in the sidebar — so naming folders there reports a feature the user
        // never touched.
        toast.error(
          Object.keys(preview.folders).length === 0
            ? "Failed to reorder projects"
            : "Failed to update project folders",
        );
        await loadProjects();
        // loadProjects clears stale errors before recovery; retain the mutation
        // failure so callers can still surface why the arrangement was rolled back.
        setError(message);
        throw new Error(message);
      }
    },
    [
      scope,
      invalidateProjectSnapshots,
      arrangeProjectsInStore,
      setProjects,
      setError,
      loadProjects,
    ],
  );

  const updateProject = useCallback(
    async (project: {
      id: string;
      name: string;
      gitUrl?: string;
      localPath: string | null;
      icon?: string | null;
    }) => {
      invalidateProjectSnapshots();
      try {
        const updated = await projectsApi(scope).updateProject(project.id, {
          name: project.name,
          ...(project.gitUrl !== undefined ? { gitUrl: project.gitUrl } : {}),
          localPath: project.localPath,
          ...(project.icon !== undefined ? { icon: project.icon } : {}),
        });
        // Use the authoritative record so removed optional fields disappear locally.
        updateProjectInStore(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update project";
        setError(message);
        throw new Error(message);
      }
    },
    [scope, invalidateProjectSnapshots, updateProjectInStore, setError],
  );

  return {
    projects,
    isLoading,
    error,
    loadProjects,
    addProject,
    createProjectFromScratch,
    removeProject,
    updateProject,
    reorderProjects,
    arrangeProjectsByIntent,
    validateGitUrl,
    getProjectById,
  };
}
