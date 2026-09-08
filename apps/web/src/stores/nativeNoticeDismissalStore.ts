import { create } from "zustand";
import { persist } from "zustand/middleware";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";

const MAX_DISMISSED_NOTICE_SESSIONS = 50;
const MAX_DISMISSED_NOTICES_PER_SESSION = 20;

interface NativeNoticeDismissalSession {
  sessionIdentity: string;
  occurrenceIds: string[];
}

interface NativeNoticeDismissalState {
  sessions: NativeNoticeDismissalSession[];
  dismiss: (sessionIdentity: string, occurrenceId: string) => void;
  reconcile: (sessionIdentity: string, activeOccurrenceIds: readonly string[]) => void;
  clear: () => void;
}

/**
 * Durable renderer preference for authoritative notices the user has seen.
 *
 * Both dimensions are bounded: provider snapshots carry at most a few notices,
 * and old sessions eventually age out of this local preference just as they do
 * from the rest of the renderer's retained session state.
 */
export const useNativeNoticeDismissalStore = create<NativeNoticeDismissalState>()(
  persist(
    (set) => ({
      sessions: [],
      dismiss: (sessionIdentity, occurrenceId) =>
        set((state) => {
          const previous = state.sessions.find(
            (session) => session.sessionIdentity === sessionIdentity,
          );
          if (previous?.occurrenceIds.includes(occurrenceId)) return state;
          const occurrenceIds = [
            ...(previous?.occurrenceIds ?? []).filter((id) => id !== occurrenceId),
            occurrenceId,
          ].slice(-MAX_DISMISSED_NOTICES_PER_SESSION);
          const otherSessions = state.sessions.filter(
            (session) => session.sessionIdentity !== sessionIdentity,
          );
          return {
            sessions: [
              ...otherSessions.slice(-(MAX_DISMISSED_NOTICE_SESSIONS - 1)),
              { sessionIdentity, occurrenceIds },
            ],
          };
        }),
      reconcile: (sessionIdentity, activeOccurrenceIds) =>
        set((state) => {
          const previous = state.sessions.find(
            (session) => session.sessionIdentity === sessionIdentity,
          );
          if (!previous) return state;
          const active = new Set(activeOccurrenceIds);
          const occurrenceIds = previous.occurrenceIds.filter((id) => active.has(id));
          if (occurrenceIds.length === previous.occurrenceIds.length) return state;
          const otherSessions = state.sessions.filter(
            (session) => session.sessionIdentity !== sessionIdentity,
          );
          return {
            sessions:
              occurrenceIds.length > 0
                ? [...otherSessions, { sessionIdentity, occurrenceIds }]
                : otherSessions,
          };
        }),
      clear: () => set({ sessions: [] }),
    }),
    {
      name: desktopConnectionStorageKey("native-notice-dismissals"),
      partialize: (state) => ({ sessions: state.sessions }),
    },
  ),
);
