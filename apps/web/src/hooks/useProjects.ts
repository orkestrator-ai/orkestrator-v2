// Hook for managing project operations with Electron backend
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useProjectStore } from "@/stores";
import * as backend from "@/lib/backend";

export function useProjects() {
  const {
    projects,
    isLoading,
    error,
    setProjects,
    addProject: addProjectToStore,
    removeProject: removeProjectFromStore,
    updateProject: updateProjectInStore,
    reorderProjects: reorderProjectsInStore,
    setLoading,
    setError,
    getProjectById,
  } = useProjectStore();

  // Load projects from backend on mount
  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projects = await backend.getProjects();
      setProjects(projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [setProjects, setLoading, setError]);

  const addProject = useCallback(
    async (gitUrl: string, localPath?: string) => {
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
    [addProjectToStore, setLoading, setError]
  );

  const removeProject = useCallback(
    async (projectId: string) => {
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
    [removeProjectFromStore, setLoading, setError]
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
      // Optimistically update the store
      reorderProjectsInStore(projectIds);
      try {
        // Persist to backend
        const reorderedProjects = await backend.reorderProjects(projectIds);
        setProjects(reorderedProjects);
      } catch (err) {
        // Reload from backend on error to restore correct state
        const message = err instanceof Error ? err.message : "Failed to reorder projects";
        setError(message);
        toast.error("Failed to reorder projects");
        await loadProjects();
        throw new Error(message);
      }
    },
    [reorderProjectsInStore, setProjects, setError, loadProjects]
  );

  const updateProject = useCallback(
    async (project: { id: string; name: string; localPath: string | null }) => {
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
    [updateProjectInStore, setError]
  );

  return {
    projects,
    isLoading,
    error,
    loadProjects,
    addProject,
    removeProject,
    updateProject,
    reorderProjects,
    validateGitUrl,
    getProjectById,
  };
}
