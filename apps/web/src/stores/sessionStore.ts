import { deepEqualJson } from "@/lib/chat/message-identity";
import type { Session, SessionStatus, SessionType } from "@/types";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.session");

/** Sort sessions by order field (lower = first) */
const sortByOrder = (sessions: Session[]): Session[] =>
  [...sessions].sort((a, b) => a.order - b.order);

interface SessionStatusQueue {
  tail: Promise<void>;
  confirmed: SessionStatus | undefined;
  latestToken: object;
}

/**
 * `scope`'s session commands: the `@/lib/backend` named exports (which suites
 * mock) on the app's command scope, otherwise the scope's own node.
 */
function sessionsApi(scope: NodeScope) {
  return backendApiForScope(scope, createFilesSessionsApi, {
    getSessionsByEnvironment: backend.getSessionsByEnvironment,
    createSession: backend.createSession,
    updateSessionStatus: backend.updateSessionStatus,
    updateSessionActivity: backend.updateSessionActivity,
    deleteSession: backend.deleteSession,
    deleteSessionsByEnvironment: backend.deleteSessionsByEnvironment,
    disconnectEnvironmentSessions: backend.disconnectEnvironmentSessions,
    saveSessionBuffer: backend.saveSessionBuffer,
    loadSessionBuffer: backend.loadSessionBuffer,
    syncSessionsWithContainer: backend.syncSessionsWithContainer,
    renameSession: backend.renameSession,
    reorderSessions: backend.reorderSessions,
  });
}

export interface SessionState {
  // State
  /** All sessions keyed by session ID */
  sessions: Map<string, Session>;
  /** Loading state per environment */
  loadingEnvironments: Set<string>;
  /** Monotonic generation of the latest successful persisted-session snapshot per environment. */
  sessionSnapshotGenerations: Map<string, number>;
  error: string | null;

  // Actions
  /** Load sessions for an environment from backend */
  loadSessionsForEnvironment: (environmentId: string) => Promise<void>;
  /** Create a new session and persist to backend */
  createSession: (
    environmentId: string,
    containerId: string,
    tabId: string,
    sessionType: SessionType,
  ) => Promise<Session>;
  /** Update session status */
  updateSessionStatus: (sessionId: string, status: SessionStatus) => Promise<void>;
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
  syncSessionsWithContainer: (environmentId: string, containerRunning: boolean) => Promise<void>;
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

/**
 * The persisted terminal sessions of a node's environments. One instance per
 * node scope (plan item 3010): session ids, load requests and the status
 * write queues belong to the node that holds the sessions.
 */
export const sessionStore = defineScopedStore<SessionState>("session", (scope) => (set, get) => {
  /** Read per call, so a suite's module mock installed later is seen. */
  const api = () => sessionsApi(scope);
  const activeSessionLoadRequests = new Map<string, object>();
  let nextSessionSnapshotGeneration = 0;
  /**
   * Status writes are serialized per session. Besides preserving backend order,
   * this gives a failed optimistic write an unambiguous last-confirmed value to
   * restore. A token still protects a newer optimistic value while an older
   * queued write settles.
   */
  const sessionStatusQueues = new Map<string, SessionStatusQueue>();
  return {
    // Initial state
    sessions: new Map(),
    loadingEnvironments: new Set(),
    sessionSnapshotGenerations: new Map(),
    error: null,

    // Actions
    loadSessionsForEnvironment: async (environmentId) => {
      const requestToken = {};
      activeSessionLoadRequests.set(environmentId, requestToken);
      set((state) => ({
        loadingEnvironments: new Set(state.loadingEnvironments).add(environmentId),
        error: null,
      }));

      try {
        const sessions = await api().getSessionsByEnvironment(environmentId);
        if (activeSessionLoadRequests.get(environmentId) !== requestToken) return;
        set((state) => {
          const existing = [...state.sessions.values()].filter(
            (session) => session.environmentId === environmentId,
          );
          const existingById = new Map(existing.map((session) => [session.id, session]));
          // Structural, not serialized: JSON.stringify is key-order sensitive (a
          // reordered but identical record would publish a spurious update) and
          // erases undefined-valued fields (a cleared field would be dropped).
          const unchanged =
            existing.length === sessions.length &&
            sessions.every((session) => {
              const current = existingById.get(session.id);
              return current !== undefined && deepEqualJson(current, session);
            });
          const newLoading = new Set(state.loadingEnvironments);
          newLoading.delete(environmentId);
          const newSnapshotGenerations = new Map(state.sessionSnapshotGenerations);
          newSnapshotGenerations.set(environmentId, (nextSessionSnapshotGeneration += 1));
          if (unchanged) {
            return {
              loadingEnvironments: newLoading,
              sessionSnapshotGenerations: newSnapshotGenerations,
              ...(state.error === null ? {} : { error: null }),
            };
          }

          const newSessions = new Map(state.sessions);
          // Clear existing sessions for this environment first
          for (const [id, session] of newSessions) {
            if (session.environmentId === environmentId) {
              newSessions.delete(id);
            }
          }
          // Add loaded sessions
          for (const session of sessions) {
            const current = existingById.get(session.id);
            newSessions.set(
              session.id,
              current && deepEqualJson(current, session) ? current : session,
            );
          }
          return {
            sessions: newSessions,
            loadingEnvironments: newLoading,
            sessionSnapshotGenerations: newSnapshotGenerations,
            ...(state.error === null ? {} : { error: null }),
          };
        });
      } catch (error) {
        if (activeSessionLoadRequests.get(environmentId) !== requestToken) return;
        set((state) => {
          const newLoading = new Set(state.loadingEnvironments);
          newLoading.delete(environmentId);
          return {
            error: error instanceof Error ? error.message : String(error),
            loadingEnvironments: newLoading,
          };
        });
      } finally {
        if (activeSessionLoadRequests.get(environmentId) === requestToken) {
          activeSessionLoadRequests.delete(environmentId);
        }
      }
    },

    createSession: async (environmentId, containerId, tabId, sessionType) => {
      const session = await api().createSession(environmentId, containerId, tabId, sessionType);
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.set(session.id, session);
        return { sessions: newSessions };
      });
      return session;
    },

    updateSessionStatus: async (sessionId, status) => {
      const requestToken = {};
      const existingQueue = sessionStatusQueues.get(sessionId);
      const queue: SessionStatusQueue = existingQueue ?? {
        tail: Promise.resolve(),
        confirmed: get().sessions.get(sessionId)?.status,
        latestToken: requestToken,
      };
      queue.latestToken = requestToken;
      sessionStatusQueues.set(sessionId, queue);
      // Optimistic update
      set((state) => {
        const session = state.sessions.get(sessionId);
        if (!session) return state;
        const newSessions = new Map(state.sessions);
        newSessions.set(sessionId, { ...session, status });
        return { sessions: newSessions };
      });

      const operation = queue.tail.then(async () => {
        try {
          await api().updateSessionStatus(sessionId, status);
          queue.confirmed = status;
        } catch (error) {
          if (queue.latestToken === requestToken && queue.confirmed !== undefined) {
            set((state) => {
              const current = state.sessions.get(sessionId);
              if (!current || current.status !== status) return state;
              const sessions = new Map(state.sessions);
              sessions.set(sessionId, { ...current, status: queue.confirmed! });
              return { sessions };
            });
          }
          log.error("status.update-failed", { sessionId, error: formatLogError(error) });
        }
      });
      queue.tail = operation;
      await operation;
      if (sessionStatusQueues.get(sessionId) === queue && queue.tail === operation) {
        sessionStatusQueues.delete(sessionId);
      }
    },

    updateSessionActivity: async (sessionId) => {
      try {
        const updated = await api().updateSessionActivity(sessionId);
        set((state) => {
          const newSessions = new Map(state.sessions);
          newSessions.set(sessionId, updated);
          return { sessions: newSessions };
        });
      } catch (error) {
        // Silent failure - activity updates are best-effort
        log.debug("activity.update-failed", () => ({ sessionId, error: formatLogError(error) }));
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
        await api().deleteSession(sessionId);
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
        const updated = await api().renameSession(sessionId, name);
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
        await api().deleteSessionsByEnvironment(environmentId);
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
        const updated = await api().disconnectEnvironmentSessions(environmentId);
        set((state) => {
          const newSessions = new Map(state.sessions);
          for (const session of updated) {
            newSessions.set(session.id, session);
          }
          return { sessions: newSessions };
        });
      } catch (error) {
        log.error("environment-sessions.disconnect-failed", {
          environmentId,
          error: formatLogError(error),
        });
      }
    },

    saveSessionBuffer: async (sessionId, buffer) => {
      await api().saveSessionBuffer(sessionId, buffer);
    },

    loadSessionBuffer: async (sessionId) => {
      return api().loadSessionBuffer(sessionId);
    },

    syncSessionsWithContainer: async (environmentId, containerRunning) => {
      try {
        const sessions = await api().syncSessionsWithContainer(environmentId, containerRunning);
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
        log.error("container-sessions.sync-failed", {
          environmentId,
          error: formatLogError(error),
        });
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
        const reordered = await api().reorderSessions(environmentId, sessionIds);
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
        log.error("reorder.failed", { environmentId, error: formatLogError(error) });
        get().loadSessionsForEnvironment(environmentId);
      }
    },

    clearAllSessions: () => set({ sessions: new Map(), sessionSnapshotGenerations: new Map() }),

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
        (s) => s.environmentId === environmentId,
      );
      return sortByOrder(sessions);
    },

    getSession: (sessionId) => get().sessions.get(sessionId),

    isLoadingEnvironment: (environmentId) => get().loadingEnvironments.has(environmentId),
  };
});

/** Reads the nearest node scope's sessions; other code uses `scope.store(sessionStore)`. */
export const useSessionStore = scopedStoreHook(sessionStore);
