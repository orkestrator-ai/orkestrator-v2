// Hook for managing project operations with Electron backend
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  applyProjectSnapshot,
  getProjectMutationVersion,
  invalidateProjectSnapshots,
  useProjectStore,
} from "@/stores/projectStore";
import * as backend from "@/lib/backend";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";

interface ProjectLoad {
  mutationVersion: number;
  promise: Promise<void>;
}

let latestProjectLoad: ProjectLoad | null = null;

const loadProjectsFromBackend = (): Promise<void> => {
  const mutationVersion = getProjectMutationVersion();

  // All hook instances share the same request for the same data generation.
  if (latestProjectLoad?.mutationVersion === mutationVersion) {
    return latestProjectLoad.promise;
  }

  const { setLoading, setError } = useProjectStore.getState();
  setLoading(true);
  setError(null);

  let promise!: Promise<void>;
  promise = (async () => {
    try {
      const projects = await backend.getProjects();
      applyProjectSnapshot(projects, mutationVersion);
    } catch (err) {
      // A failure from an obsolete read is no longer relevant to current data.
      if (getProjectMutationVersion() === mutationVersion) {
        useProjectStore
          .getState()
          .setError(err instanceof Error ? err.message : "Failed to load projects");
      }
    } finally {
      // A superseded request must not clear the newer request's loading state.
      if (latestProjectLoad?.promise === promise) {
        latestProjectLoad = null;
        useProjectStore.getState().setLoading(false);
      }
    }
  })();

  latestProjectLoad = { mutationVersion, promise };
  return promise;
};

export function useProjects() {
  const projects = useProjectStore((state) => state.projects);
  const isLoading = useProjectStore((state) => state.isLoading);
  const error = useProjectStore((state) => state.error);
  const setProjects = useProjectStore((state) => state.setProjects);
  const addProjectToStore = useProjectStore((state) => state.addProject);
  const removeProjectFromStore = useProjectStore((state) => state.removeProject);
  const updateProjectInStore = useProjectStore((state) => state.updateProject);
  const reorderProjectsInStore = useProjectStore((state) => state.reorderProjects);
  const setLoading = useProjectStore((state) => state.setLoading);
  const setError = useProjectStore((state) => state.setError);
  const getProjectById = useProjectStore((state) => state.getProjectById);

  const loadProjects = useCallback(loadProjectsFromBackend, []);

  // Load projects from backend on mount. Concurrent hook mounts share this read.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Converge when another client adds, renames, reorders or removes a project.
  // The snapshot cache is keyed by mutation version, so it must be invalidated
  // first or the shared in-flight read would replay stale data.
  useEffect(
    () =>
      onResourceChanged("project", () => {
        invalidateProjectSnapshots();
        void loadProjects();
      }),
    [loadProjects],
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
      }),
    [loadProjects],
  );

  const addProject = useCallback(
    async (gitUrl: string, localPath?: string) => {
      invalidateProjectSnapshots();
      setLoading(true);
      setError(null);
      try {
        const project = await backend.addProject(gitUrl, localPath);
        addProjectToStore(project);
        toast.success("Project added", { description: project.name });
        return project;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to add project";
        setError(message);
        toast.error("Failed to add project", { description: message });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [addProjectToStore, setLoading, setError],
  );

  const createProjectFromScratch = useCallback(
    async (localPath: string) => {
      invalidateProjectSnapshots();
      setLoading(true);
      setError(null);
      try {
        const project = await backend.createProjectFromScratch(localPath);
        addProjectToStore(project);
        toast.success("Project created", { description: project.name });
        return project;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create project";
        setError(message);
        toast.error("Failed to create project", { description: message });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [addProjectToStore, setLoading, setError],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      invalidateProjectSnapshots();
      setLoading(true);
      setError(null);
      try {
        await backend.removeProject(projectId);
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
    [removeProjectFromStore, setLoading, setError],
  );

  const validateGitUrl = useCallback(async (url: string) => {
    try {
      return await backend.validateGitUrl(url);
    } catch {
      return false;
    }
  }, []);

  const reorderProjects = useCallback(
    async (projectIds: string[]) => {
      invalidateProjectSnapshots();
      // Optimistically update the store
      reorderProjectsInStore(projectIds);
      try {
        // Persist to backend
        const reorderedProjects = await backend.reorderProjects(projectIds);
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
    [reorderProjectsInStore, setProjects, setError, loadProjects],
  );

  const updateProject = useCallback(
    async (project: { id: string; name: string; localPath: string | null }) => {
      invalidateProjectSnapshots();
      try {
        const updated = await backend.updateProject(project.id, {
          name: project.name,
          localPath: project.localPath,
        });
        updateProjectInStore(project.id, updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update project";
        setError(message);
        throw new Error(message);
      }
    },
    [updateProjectInStore, setError],
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
    validateGitUrl,
    getProjectById,
  };
}
