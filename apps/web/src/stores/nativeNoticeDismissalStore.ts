import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_DISMISSED_NOTICE_SESSIONS = 50;
const MAX_DISMISSED_NOTICES_PER_SESSION = 20;

interface NativeNoticeDismissalSession {
  sessionIdentity: string;
  occurrenceIds: string[];
}

interface NativeNoticeDismissalState {
  sessions: NativeNoticeDismissalSession[];
  dismiss: (sessionIdentity: string, occurrenceId: string) => void;
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
      clear: () => set({ sessions: [] }),
    }),
    {
      name: "native-notice-dismissals",
      partialize: (state) => ({ sessions: state.sessions }),
    },
  ),
);
