import { create } from "zustand";
import type { Session, SessionStatus, SessionType } from "@/types";
import {
  getSessionsByEnvironment,
  createSession as apiCreateSession,
  updateSessionStatus as apiUpdateSessionStatus,
  updateSessionActivity as apiUpdateSessionActivity,
  deleteSession as apiDeleteSession,
  deleteSessionsByEnvironment as apiDeleteSessionsByEnvironment,
  disconnectEnvironmentSessions as apiDisconnectEnvironmentSessions,
  saveSessionBuffer as apiSaveSessionBuffer,
  loadSessionBuffer as apiLoadSessionBuffer,
  syncSessionsWithContainer as apiSyncSessionsWithContainer,
  renameSession as apiRenameSession,
  reorderSessions as apiReorderSessions,
} from "@/lib/backend";

/** Sort sessions by order field (lower = first) */
const sortByOrder = (sessions: Session[]): Session[] =>
  [...sessions].sort((a, b) => a.order - b.order);

interface SessionState {
  // State
  /** All sessions keyed by session ID */
  sessions: Map<string, Session>;
  /** Loading state per environment */
  loadingEnvironments: Set<string>;
  error: string | null;

  // Actions
  /** Load sessions for an environment from backend */
  loadSessionsForEnvironment: (environmentId: string) => Promise<void>;
  /** Create a new session and persist to backend */
  createSession: (
    environmentId: string,
    containerId: string,
    tabId: string,
    sessionType: SessionType
  ) => Promise<Session>;
  /** Update session status */
  updateSessionStatus: (
    sessionId: string,
    status: SessionStatus
  ) => Promise<void>;
  /** Update session activity timestamp */
  updateSessionActivity: (sessionId: string) => Promise<void>;
  /** Delete a session */
  deleteSession: (sessionId: string) => Promise<void>;
  /** Rename a session */
  renameSession: (sessionId: string, name: string | null) => Promise<void>;
  /** Delete all sessions for an environment */
  deleteSessionsByEnvironment: (environmentId: string) => Promise<void>;
  /** Disconnect all sessions for an environment */
  disconnectEnvironmentSessions: (environmentId: string) => Promise<void>;
  /** Save session buffer to file */
  saveSessionBuffer: (sessionId: string, buffer: string) => Promise<void>;
  /** Load session buffer from file */
  loadSessionBuffer: (sessionId: string) => Promise<string | null>;
  /** Sync sessions with container state */
  syncSessionsWithContainer: (
    environmentId: string,
    containerRunning: boolean
  ) => Promise<void>;
  /** Reorder sessions within an environment */
  reorderSessions: (environmentId: string, sessionIds: string[]) => Promise<void>;
  /** Clear all sessions from the store (doesn't delete from backend) */
  clearAllSessions: () => void;
  /** Set error */
  setError: (error: string | null) => void;

  // Local-only updates (for optimistic UI)
  /** Add session to store (local only) */
  addSession: (session: Session) => void;
  /** Update session in store (local only) */
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  /** Remove session from store (local only) */
  removeSession: (sessionId: string) => void;

  // Selectors
  /** Get all sessions for an environment */
  getSessionsByEnvironment: (environmentId: string) => Session[];
  /** Get a single session by ID */
  getSession: (sessionId: string) => Session | undefined;
  /** Check if sessions are loading for an environment */
  isLoadingEnvironment: (environmentId: string) => boolean;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  // Initial state
  sessions: new Map(),
  loadingEnvironments: new Set(),
  error: null,

  // Actions
  loadSessionsForEnvironment: async (environmentId) => {
    set((state) => ({
      loadingEnvironments: new Set(state.loadingEnvironments).add(environmentId),
      error: null,
    }));

    try {
      const sessions = await getSessionsByEnvironment(environmentId);
      set((state) => {
        const newSessions = new Map(state.sessions);
        // Clear existing sessions for this environment first
        for (const [id, session] of newSessions) {
          if (session.environmentId === environmentId) {
            newSessions.delete(id);
          }
        }
        // Add loaded sessions
        for (const session of sessions) {
          newSessions.set(session.id, session);
        }
        const newLoading = new Set(state.loadingEnvironments);
        newLoading.delete(environmentId);
        return { sessions: newSessions, loadingEnvironments: newLoading };
      });
    } catch (error) {
      set((state) => {
        const newLoading = new Set(state.loadingEnvironments);
        newLoading.delete(environmentId);
        return {
          error: error instanceof Error ? error.message : String(error),
          loadingEnvironments: newLoading,
        };
      });
    }
  },

  createSession: async (environmentId, containerId, tabId, sessionType) => {
    const session = await apiCreateSession(
      environmentId,
      containerId,
      tabId,
      sessionType
    );
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(session.id, session);
      return { sessions: newSessions };
    });
    return session;
  },

  updateSessionStatus: async (sessionId, status) => {
    // Optimistic update
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, { ...session, status });
      return { sessions: newSessions };
    });

    try {
      await apiUpdateSessionStatus(sessionId, status);
    } catch (error) {
      // Revert on error would be complex; just log for now
      console.error("Failed to update session status:", error);
    }
  },

  updateSessionActivity: async (sessionId) => {
    try {
      const updated = await apiUpdateSessionActivity(sessionId);
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.set(sessionId, updated);
        return { sessions: newSessions };
      });
    } catch (error) {
      // Silent failure - activity updates are best-effort
      console.debug("Failed to update session activity:", error);
    }
  },

  deleteSession: async (sessionId) => {
    // Optimistic removal
    const session = get().sessions.get(sessionId);
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    });

    try {
      await apiDeleteSession(sessionId);
    } catch (error) {
      // Revert on error
      if (session) {
        set((state) => {
          const newSessions = new Map(state.sessions);
          newSessions.set(sessionId, session);
          return { sessions: newSessions };
        });
      }
      throw error;
    }
  },

  renameSession: async (sessionId, name) => {
    // Optimistic update
    const session = get().sessions.get(sessionId);
    if (!session) return;

    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, { ...session, name: name ?? undefined });
      return { sessions: newSessions };
    });

    try {
      const updated = await apiRenameSession(sessionId, name);
      // Update with response from server
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.set(sessionId, updated);
        return { sessions: newSessions };
      });
    } catch (error) {
      // Revert on error
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.set(sessionId, session);
        return { sessions: newSessions };
      });
      throw error;
    }
  },

  deleteSessionsByEnvironment: async (environmentId) => {
    // Get sessions to delete for possible revert
    const sessionsToDelete = get().getSessionsByEnvironment(environmentId);

    // Optimistic removal
    set((state) => {
      const newSessions = new Map(state.sessions);
      for (const session of sessionsToDelete) {
        newSessions.delete(session.id);
      }
      return { sessions: newSessions };
    });

    try {
      await apiDeleteSessionsByEnvironment(environmentId);
    } catch (error) {
      // Revert on error
      set((state) => {
        const newSessions = new Map(state.sessions);
        for (const session of sessionsToDelete) {
          newSessions.set(session.id, session);
        }
        return { sessions: newSessions };
      });
      throw error;
    }
  },

  disconnectEnvironmentSessions: async (environmentId) => {
    try {
      const updated = await apiDisconnectEnvironmentSessions(environmentId);
      set((state) => {
        const newSessions = new Map(state.sessions);
        for (const session of updated) {
          newSessions.set(session.id, session);
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error("Failed to disconnect environment sessions:", error);
    }
  },

  saveSessionBuffer: async (sessionId, buffer) => {
    await apiSaveSessionBuffer(sessionId, buffer);
  },

  loadSessionBuffer: async (sessionId) => {
    return apiLoadSessionBuffer(sessionId);
  },

  syncSessionsWithContainer: async (environmentId, containerRunning) => {
    try {
      const sessions = await apiSyncSessionsWithContainer(
        environmentId,
        containerRunning
      );
      set((state) => {
        const newSessions = new Map(state.sessions);
        // Clear existing sessions for this environment first
        for (const [id, session] of newSessions) {
          if (session.environmentId === environmentId) {
            newSessions.delete(id);
          }
        }
        // Add synced sessions
        for (const session of sessions) {
          newSessions.set(session.id, session);
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error("Failed to sync sessions with container:", error);
    }
  },

  reorderSessions: async (environmentId, sessionIds) => {
    // Optimistic update - reorder locally first
    const currentSessions = get().getSessionsByEnvironment(environmentId);
    const sessionMap = new Map(currentSessions.map((s) => [s.id, s]));

    // Update order based on position in sessionIds array
    set((state) => {
      const newSessions = new Map(state.sessions);
      sessionIds.forEach((id, index) => {
        const session = sessionMap.get(id);
        if (session) {
          newSessions.set(id, { ...session, order: index });
        }
      });
      return { sessions: newSessions };
    });

    try {
      const reordered = await apiReorderSessions(environmentId, sessionIds);
      // Update with server response
      set((state) => {
        const newSessions = new Map(state.sessions);
        for (const session of reordered) {
          newSessions.set(session.id, session);
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      // Revert on error - reload from server
      console.error("Failed to reorder sessions:", error);
      get().loadSessionsForEnvironment(environmentId);
    }
  },

  clearAllSessions: () => set({ sessions: new Map() }),

  setError: (error) => set({ error }),

  // Local-only updates
  addSession: (session) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(session.id, session);
      return { sessions: newSessions };
    }),

  updateSession: (sessionId, updates) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, { ...session, ...updates });
      return { sessions: newSessions };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    }),

  // Selectors
  getSessionsByEnvironment: (environmentId) => {
    const sessions = Array.from(get().sessions.values()).filter(
      (s) => s.environmentId === environmentId
    );
    return sortByOrder(sessions);
  },

  getSession: (sessionId) => get().sessions.get(sessionId),

  isLoadingEnvironment: (environmentId) =>
    get().loadingEnvironments.has(environmentId),
}));
