import { create } from "zustand";
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
    .find((p) => p.environmentId === environmentId);
  return { task: undefined, taskId: pipeline?.taskId };
}

interface KanbanState {
  tasks: KanbanTask[];
  isLoading: boolean;
  currentProjectId: string | null;
  notes: string;
  notesLoading: boolean;
  currentNotesProjectId: string | null;

  // Task actions
  loadTasks: (projectId: string) => Promise<void>;
  addTask: (projectId: string, title: string, description: string) => Promise<string | undefined>;
  updateTask: (taskId: string, updates: Partial<Pick<KanbanTask, "title" | "description" | "acceptanceCriteria" | "status" | "environmentId" | "buildPipelineId" | "prUrl" | "prState" | "prMergeCommented">>) => Promise<void>;
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
    set({ notesLoading: true, currentNotesProjectId: projectId });
    try {
      const result = await getProjectNotes(projectId);
      if (get().currentNotesProjectId === projectId) {
        set({ notes: result.content, notesLoading: false });
      }
    } catch (error) {
      console.error("[KanbanStore] Failed to load notes:", error);
      if (get().currentNotesProjectId === projectId) {
        set({ notesLoading: false });
      }
    }
  },

  saveNotes: async (projectId, content) => {
    try {
      await saveProjectNotes(projectId, content);
      set({ notes: content });
    } catch (error) {
      console.error("[KanbanStore] Failed to save notes:", error);
    }
  },
}));
