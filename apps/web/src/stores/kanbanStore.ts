import { toast } from "sonner";
import * as backend from "@/lib/backend";
import type {
  KanbanTask,
  KanbanStatus,
  KanbanComment,
  KanbanImage,
  ProjectNotes,
} from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createKanbanApi } from "@/lib/backend/kanban";
import { createWorkflowsApi } from "@/lib/backend/workflows";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.kanban");

export type { KanbanTask, KanbanStatus, KanbanComment, KanbanImage, ProjectNotes };

/**
 * Find the kanban task ID associated with an environment of `scope`'s node.
 * Checks the kanban store first, then falls back to the build pipeline store.
 * Returns the task (if found in kanban store) and the task ID.
 */
export function findTaskForEnvironment(
  environmentId: string,
  scope: NodeScope,
): {
  task: KanbanTask | undefined;
  taskId: string | undefined;
} {
  const kanbanState = scope.store(kanbanStore).getState();
  const task = kanbanState.tasks.find((t) => t.environmentId === environmentId);
  if (task) return { task, taskId: task.id };
  const pipeline = Array.from(scope.store(buildPipelineStore).getState().pipelines.values()).find(
    (p) =>
      p.environmentId === environmentId && (p.source === undefined || p.source.type === "kanban"),
  );
  return { task: undefined, taskId: pipeline?.taskId };
}

export interface KanbanState {
  tasks: KanbanTask[];
  isLoading: boolean;
  currentProjectId: string | null;
  notes: string;
  notesLoading: boolean;
  /** A successful snapshot exists for currentNotesProjectId, even during refresh. */
  notesLoaded: boolean;
  /** Why the last notes load failed, including background refresh failures. */
  notesError: string | null;
  currentNotesProjectId: string | null;
  /**
   * A ticket something outside the board (Settings → Self-improvement) asked
   * to open. The board opens it once it is mounted and has loaded the ticket,
   * then clears the request, so the board need not be on screen when it is set.
   */
  openTicketRequest: { projectId: string; ticketId: string } | null;

  requestOpenTicket: (projectId: string, ticketId: string) => void;
  clearOpenTicketRequest: () => void;

  // Task actions
  loadTasks: (projectId: string) => Promise<void>;
  addTask: (projectId: string, title: string, description: string) => Promise<string | undefined>;
  updateTask: (
    taskId: string,
    updates: Partial<
      Pick<
        KanbanTask,
        | "title"
        | "description"
        | "acceptanceCriteria"
        | "status"
        | "environmentId"
        | "buildPipelineId"
        | "prUrl"
        | "prState"
        | "prMergeCommented"
      >
    >,
  ) => Promise<void>;
  /** Save an edit of the ticket's title, kind and markdown. Resolves false when it failed. */
  updateTaskContent: (
    taskId: string,
    content: Parameters<typeof backend.updateKanbanTaskContent>[1],
  ) => Promise<boolean>;
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

/**
 * `scope`'s Kanban commands: the suites' mocked `@/lib/backend` named exports
 * on the app's command scope, otherwise the scope's own node.
 */
function kanbanApi(scope: NodeScope) {
  return {
    ...backendApiForScope(scope, createKanbanApi, {
      getKanbanTasks: backend.getKanbanTasks,
      addKanbanTask: backend.addKanbanTask,
      updateKanbanTask: backend.updateKanbanTask,
      updateKanbanTaskContent: backend.updateKanbanTaskContent,
      deleteKanbanTask: backend.deleteKanbanTask,
      addKanbanComment: backend.addKanbanComment,
      deleteKanbanComment: backend.deleteKanbanComment,
      addKanbanImage: backend.addKanbanImage,
      deleteKanbanImage: backend.deleteKanbanImage,
      getProjectNotes: backend.getProjectNotes,
      saveProjectNotes: backend.saveProjectNotes,
    }),
    ...backendApiForScope(scope, createWorkflowsApi, {
      clearTaskBuildStatus: backend.clearTaskBuildStatus,
    }),
  };
}

/**
 * The open project's Kanban board and notes, per node: tickets belong to the
 * node that holds the project (plan item 3011).
 */
export const kanbanStore = defineScopedStore<KanbanState>("kanban", (scope) => (set, get) => {
  /** Read per call, so a suite's module mock installed later is seen. */
  const api = () => kanbanApi(scope);
  return {
    tasks: [],
    isLoading: false,
    currentProjectId: null,
    notes: "",
    notesLoading: false,
    notesLoaded: false,
    notesError: null,
    currentNotesProjectId: null,
    openTicketRequest: null,

    requestOpenTicket: (projectId, ticketId) => set({ openTicketRequest: { projectId, ticketId } }),
    clearOpenTicketRequest: () => set({ openTicketRequest: null }),

    loadTasks: async (projectId) => {
      set({ isLoading: true, currentProjectId: projectId });
      try {
        const tasks = await api().getKanbanTasks(projectId);
        // Guard: only update if the user hasn't navigated to a different project
        if (get().currentProjectId === projectId) {
          set({ tasks, isLoading: false });
        }
      } catch (error) {
        log.error("tasks.load-failed", { projectId, error: formatLogError(error) });
        if (get().currentProjectId === projectId) {
          set({ isLoading: false });
        }
      }
    },

    addTask: async (projectId, title, description) => {
      try {
        const task = await api().addKanbanTask(projectId, title, description);
        set((state) => ({ tasks: [...state.tasks, task] }));
        return task.id;
      } catch (error) {
        log.error("task.add-failed", { projectId, error: formatLogError(error) });
        return undefined;
      }
    },

    updateTask: async (taskId, updates) => {
      try {
        const updated = await api().updateKanbanTask(
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
        log.error("task.update-failed", { taskId, error: formatLogError(error) });
      }
    },

    updateTaskContent: async (taskId, content) => {
      try {
        const updated = await api().updateKanbanTaskContent(taskId, content);
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
        return true;
      } catch (error) {
        log.error("task.content-update-failed", { taskId, error: formatLogError(error) });
        toast.error("Could not save the ticket", {
          description: "Your edit is still in the editor, so you can retry.",
        });
        return false;
      }
    },

    clearTaskBuildStatus: async (taskId) => {
      try {
        const { task: updated } = await api().clearTaskBuildStatus(taskId);
        scope.store(buildPipelineStore).getState().removePipelinesForTask(taskId);
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
      } catch (error) {
        log.error("task.build-status-clear-failed", { taskId, error: formatLogError(error) });
        toast.error("Could not clear build status", {
          description: "The task is still linked, so it is safe to retry.",
        });
      }
    },

    deleteTask: async (taskId) => {
      try {
        await api().deleteKanbanTask(taskId);
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== taskId) }));
      } catch (error) {
        log.error("task.delete-failed", { taskId, error: formatLogError(error) });
      }
    },

    moveTask: async (taskId, newStatus) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task || task.status === newStatus) return;

      // Optimistic update: immediately move the card in the UI
      const previousStatus = task.status;
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)),
      }));

      try {
        const updated = await api().updateKanbanTask(
          taskId,
          undefined,
          undefined,
          undefined,
          newStatus,
        );
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
      } catch (error) {
        log.error("task.move-failed", { taskId, error: formatLogError(error) });
        // Rollback on failure
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status: previousStatus } : t)),
        }));
      }
    },

    addComment: async (taskId, text) => {
      try {
        const updated = await api().addKanbanComment(taskId, text);
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
      } catch (error) {
        log.error("comment.add-failed", { taskId, error: formatLogError(error) });
      }
    },

    deleteComment: async (taskId, commentId) => {
      try {
        const updated = await api().deleteKanbanComment(taskId, commentId);
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
      } catch (error) {
        log.error("comment.delete-failed", { taskId, commentId, error: formatLogError(error) });
      }
    },

    addImage: async (taskId, filename, data) => {
      try {
        const updated = await api().addKanbanImage(taskId, filename, data);
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
      } catch (error) {
        log.error("image.add-failed", { taskId, error: formatLogError(error) });
      }
    },

    deleteImage: async (taskId, imageId) => {
      try {
        const updated = await api().deleteKanbanImage(taskId, imageId);
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }));
      } catch (error) {
        log.error("image.delete-failed", { taskId, imageId, error: formatLogError(error) });
      }
    },

    loadNotes: async (projectId) => {
      // Refreshes retain the last successful snapshot and the live editor. Only
      // a project switch clears content and requires a new successful load.
      const sameProject = get().currentNotesProjectId === projectId;
      set({
        ...(!sameProject ? { notes: "", notesLoaded: false } : {}),
        notesLoading: true,
        notesError: null,
        currentNotesProjectId: projectId,
      });
      try {
        const result = await api().getProjectNotes(projectId);
        if (get().currentNotesProjectId === projectId) {
          set({ notes: result.content, notesLoaded: true, notesLoading: false, notesError: null });
        }
      } catch (error) {
        log.error("notes.load-failed", { projectId, error: formatLogError(error) });
        // Initial failures remain disabled; refresh failures retain the known
        // snapshot and draft while exposing the retry action.
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
        await api().saveProjectNotes(projectId, content);
        if (get().currentNotesProjectId === projectId) {
          set({ notes: content });
        }
      } catch (error) {
        log.error("notes.save-failed", { projectId, error: formatLogError(error) });
        throw error;
      }
    },
  };
});

/** Reads the nearest node scope's board; other code uses `scope.store(kanbanStore)`. */
export const useKanbanStore = scopedStoreHook(kanbanStore);
