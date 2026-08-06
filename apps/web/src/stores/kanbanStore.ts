import { create } from "zustand";
import { toast } from "sonner";
import {
  getKanbanTasks,
  addKanbanTask,
  updateKanbanTask,
  deleteKanbanTask,
  addKanbanComment,
  deleteKanbanComment,
  addKanbanImage,
  deleteKanbanImage,
  getProjectNotes,
  saveProjectNotes,
  clearTaskBuildStatus,
  type KanbanTask,
  type KanbanStatus,
  type KanbanComment,
  type KanbanImage,
  type ProjectNotes,
} from "@/lib/backend";

import { useBuildPipelineStore } from "@/stores/buildPipelineStore";

export type { KanbanTask, KanbanStatus, KanbanComment, KanbanImage, ProjectNotes };

/**
 * Find the kanban task ID associated with an environment.
 * Checks the kanban store first, then falls back to the build pipeline store.
 * Returns the task (if found in kanban store) and the task ID.
 */
export function findTaskForEnvironment(environmentId: string): { task: KanbanTask | undefined; taskId: string | undefined } {
  const kanbanState = useKanbanStore.getState();
  const task = kanbanState.tasks.find((t) => t.environmentId === environmentId);
  if (task) return { task, taskId: task.id };
  const pipeline = Array.from(useBuildPipelineStore.getState().pipelines.values())
    .find((p) =>
      p.environmentId === environmentId
      && (p.source === undefined || p.source.type === "kanban")
    );
  return { task: undefined, taskId: pipeline?.taskId };
}

interface KanbanState {
  tasks: KanbanTask[];
  isLoading: boolean;
  currentProjectId: string | null;
  notes: string;
  notesLoading: boolean;
  /** Why the last notes load failed, or null when the notes are trustworthy. */
  notesError: string | null;
  currentNotesProjectId: string | null;

  // Task actions
  loadTasks: (projectId: string) => Promise<void>;
  addTask: (projectId: string, title: string, description: string) => Promise<string | undefined>;
  updateTask: (taskId: string, updates: Partial<Pick<KanbanTask, "title" | "description" | "acceptanceCriteria" | "status" | "environmentId" | "buildPipelineId" | "prUrl" | "prState" | "prMergeCommented">>) => Promise<void>;
  clearTaskBuildStatus: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  moveTask: (taskId: string, newStatus: KanbanStatus) => Promise<void>;
  addComment: (taskId: string, text: string) => Promise<void>;
  deleteComment: (taskId: string, commentId: string) => Promise<void>;
  addImage: (taskId: string, filename: string, data: string) => Promise<void>;
  deleteImage: (taskId: string, imageId: string) => Promise<void>;

  // Notes actions
  loadNotes: (projectId: string) => Promise<void>;
  saveNotes: (projectId: string, content: string) => Promise<void>;
}

export const useKanbanStore = create<KanbanState>()((set, get) => ({
  tasks: [],
  isLoading: false,
  currentProjectId: null,
  notes: "",
  notesLoading: false,
  notesError: null,
  currentNotesProjectId: null,

  loadTasks: async (projectId) => {
    set({ isLoading: true, currentProjectId: projectId });
    try {
      const tasks = await getKanbanTasks(projectId);
      // Guard: only update if the user hasn't navigated to a different project
      if (get().currentProjectId === projectId) {
        set({ tasks, isLoading: false });
      }
    } catch (error) {
      console.error("[KanbanStore] Failed to load tasks:", error);
      if (get().currentProjectId === projectId) {
        set({ isLoading: false });
      }
    }
  },

  addTask: async (projectId, title, description) => {
    try {
      const task = await addKanbanTask(projectId, title, description);
      set((state) => ({ tasks: [...state.tasks, task] }));
      return task.id;
    } catch (error) {
      console.error("[KanbanStore] Failed to add task:", error);
      return undefined;
    }
  },

  updateTask: async (taskId, updates) => {
    try {
      const updated = await updateKanbanTask(
        taskId,
        updates.title,
        updates.description,
        updates.acceptanceCriteria,
        updates.status,
        updates.environmentId,
        updates.buildPipelineId,
        updates.prUrl,
        updates.prState,
        updates.prMergeCommented,
      );
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to update task:", error);
    }
  },

  clearTaskBuildStatus: async (taskId) => {
    try {
      const { task: updated } = await clearTaskBuildStatus(taskId);
      useBuildPipelineStore.getState().removePipelinesForTask(taskId);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to clear task build status:", error);
      toast.error("Could not clear build status", {
        description: "The task is still linked, so it is safe to retry.",
      });
    }
  },

  deleteTask: async (taskId) => {
    try {
      await deleteKanbanTask(taskId);
      set((state) => ({ tasks: state.tasks.filter((t) => t.id !== taskId) }));
    } catch (error) {
      console.error("[KanbanStore] Failed to delete task:", error);
    }
  },

  moveTask: async (taskId, newStatus) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;

    // Optimistic update: immediately move the card in the UI
    const previousStatus = task.status;
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: newStatus } : t
      ),
    }));

    try {
      const updated = await updateKanbanTask(taskId, undefined, undefined, undefined, newStatus);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to move task:", error);
      // Rollback on failure
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, status: previousStatus } : t
        ),
      }));
    }
  },

  addComment: async (taskId, text) => {
    try {
      const updated = await addKanbanComment(taskId, text);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to add comment:", error);
    }
  },

  deleteComment: async (taskId, commentId) => {
    try {
      const updated = await deleteKanbanComment(taskId, commentId);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to delete comment:", error);
    }
  },

  addImage: async (taskId, filename, data) => {
    try {
      const updated = await addKanbanImage(taskId, filename, data);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to add image:", error);
    }
  },

  deleteImage: async (taskId, imageId) => {
    try {
      const updated = await deleteKanbanImage(taskId, imageId);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to delete image:", error);
    }
  },

  loadNotes: async (projectId) => {
    // Never expose the previous project's notes if this load fails. The editor
    // enables itself once notesLoading clears, so stale content here could be
    // edited and saved into the newly selected project.
    set({
      notes: "",
      notesLoading: true,
      notesError: null,
      currentNotesProjectId: projectId,
    });
    try {
      const result = await getProjectNotes(projectId);
      if (get().currentNotesProjectId === projectId) {
        set({ notes: result.content, notesLoading: false, notesError: null });
      }
    } catch (error) {
      console.error("[KanbanStore] Failed to load notes:", error);
      // The empty notes above are not this project's content, so the editor has
      // to stay disabled: a keystroke into it would autosave over the real
      // backend notes.
      if (get().currentNotesProjectId === projectId) {
        set({
          notesLoading: false,
          notesError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  saveNotes: async (projectId, content) => {
    try {
      await saveProjectNotes(projectId, content);
      if (get().currentNotesProjectId === projectId) {
        set({ notes: content });
      }
    } catch (error) {
      console.error("[KanbanStore] Failed to save notes:", error);
      throw error;
    }
  },
}));
