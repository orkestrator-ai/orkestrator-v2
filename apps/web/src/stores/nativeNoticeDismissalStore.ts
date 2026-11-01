import { useEffect } from "react";
import { create } from "zustand";
import {
  NOTICE_DISMISSAL_LIMITS,
  normalizeNoticeDismissalSessions,
  type NoticeDismissalSession,
  type NoticeDismissalSnapshot,
} from "@orkestrator/protocol/notice-dismissals";
import * as backend from "@/lib/backend";
import { clientStateCapabilities } from "@/lib/client-state-capabilities";
import {
  clearLegacyPersistedState,
  readLegacyPersistedState,
  writeLegacyPersistedState,
} from "@/lib/legacy-local-state";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/** The key earlier releases kept dismissals under (per machine). */
export const LEGACY_NOTICE_DISMISSAL_KEY = "native-notice-dismissals";
/** Bounds on the browser copy kept against an older backend. */
const MAX_DISMISSED_NOTICE_SESSIONS = 50;
const MAX_DISMISSED_NOTICES_PER_SESSION = 20;

interface NativeNoticeDismissalState {
  sessions: NoticeDismissalSession[];
  /**
   * Whether the stored dismissals have been read. Notices wait for it, or a
   * reload would show every dismissed notice again until the answer arrived.
   */
  ready: boolean;
  dismiss: (sessionIdentity: string, occurrenceId: string) => void;
  reconcile: (sessionIdentity: string, activeOccurrenceIds: readonly string[]) => void;
  /** Reads the stored dismissals once; every consumer calls this when it mounts. */
  ensureHydrated: () => Promise<void>;
  clear: () => void;
}

/**
 * Dismissals of authoritative notices the user has seen, mirrored from the
 * backend (`list_notice_dismissals`) so a notice dismissed on one client stays
 * dismissed on every client.
 *
 * A dismissal applies here at once and is saved in the background. Changes from
 * other clients arrive as `notice-dismissal` hints and through the periodic
 * resync. Against an older backend the dismissals stay in this browser's copy,
 * as before; against a current one that copy is imported once and deleted.
 * Both dimensions are bounded by the store that holds them.
 */
export const useNativeNoticeDismissalStore = create<NativeNoticeDismissalState>()((set, get) => {
  let mode: "backend" | "legacy" | null = null;
  let hydration: Promise<void> | null = null;
  let stopSubscriptions: Array<() => void> | null = null;
  let revision = -1;
  /** Local writes not yet answered; a read that started before them is stale. */
  let inFlightWrites = 0;

  const adopt = (snapshot: NoticeDismissalSnapshot | null) => {
    if (!snapshot || snapshot.revision < revision) return;
    revision = snapshot.revision;
    if (inFlightWrites === 0) set({ sessions: snapshot.sessions });
  };

  const refresh = async () => {
    try {
      adopt(await backend.listNoticeDismissals());
    } catch {
      // Kept as is; the next hint or resync reads again.
    }
  };

  const reread = async () => {
    if (mode !== "backend") return;
    // Authoritative even across a backend whose revision restarted.
    revision = -1;
    await refresh();
  };

  const write = (operation: () => Promise<NoticeDismissalSnapshot | null>) => {
    inFlightWrites += 1;
    void operation()
      .catch(() => null)
      .then((snapshot) => {
        inFlightWrites -= 1;
        if (inFlightWrites > 0) return;
        // An answer overtaken by a newer revision (another client's change read
        // while this write ran) cannot be applied; read what is current instead.
        if (snapshot && snapshot.revision >= revision) adopt(snapshot);
        else void refresh();
      });
  };

  const persistLegacy = () => {
    const sessions = get()
      .sessions.slice(-MAX_DISMISSED_NOTICE_SESSIONS)
      .map((session) => ({
        sessionIdentity: session.sessionIdentity,
        occurrenceIds: session.occurrenceIds.slice(-MAX_DISMISSED_NOTICES_PER_SESSION),
      }));
    writeLegacyPersistedState(LEGACY_NOTICE_DISMISSAL_KEY, { sessions });
  };

  const hydrate = async () => {
    const capabilities = await clientStateCapabilities();
    const saved = normalizeNoticeDismissalSessions(
      readLegacyPersistedState(LEGACY_NOTICE_DISMISSAL_KEY)?.sessions,
    );
    if (!capabilities.noticeDismissals) {
      mode = "legacy";
      set({
        sessions: normalizeNoticeDismissalSessions([...saved, ...get().sessions]),
        ready: true,
      });
      return;
    }
    mode = "backend";
    stopSubscriptions ??= [
      onResourceChanged("notice-dismissal", () => {
        if (mode === "backend") void refresh();
      }),
      // Not in the durable manifest, so both recovery paths apply.
      onResourceResync(reread),
      onViewSafetyCheck(reread),
    ];
    // Dismissals made while the backend was unknown travel with the import.
    const local = get().sessions;
    const toImport = [...saved, ...local].filter((session) => session.occurrenceIds.length > 0);
    try {
      const snapshot = toImport.length
        ? await backend.dismissNotices(normalizeNoticeDismissalSessions(toImport))
        : await backend.listNoticeDismissals();
      if (snapshot) {
        if (saved.length > 0) clearLegacyPersistedState(LEGACY_NOTICE_DISMISSAL_KEY);
        adopt(snapshot);
      }
    } finally {
      set({ ready: true });
    }
  };

  return {
    sessions: [],
    ready: false,
    dismiss: (sessionIdentity, occurrenceId) => {
      const state = get();
      const previous = state.sessions.find(
        (session) => session.sessionIdentity === sessionIdentity,
      );
      if (previous?.occurrenceIds.includes(occurrenceId)) return;
      set({
        sessions: [
          ...state.sessions
            .filter((session) => session.sessionIdentity !== sessionIdentity)
            .slice(-(NOTICE_DISMISSAL_LIMITS.sessions - 1)),
          {
            sessionIdentity,
            occurrenceIds: [...(previous?.occurrenceIds ?? []), occurrenceId].slice(
              -NOTICE_DISMISSAL_LIMITS.occurrencesPerSession,
            ),
          },
        ],
      });
      if (mode === "backend") {
        write(() => backend.dismissNotices([{ sessionIdentity, occurrenceIds: [occurrenceId] }]));
      } else {
        persistLegacy();
      }
    },
    reconcile: (sessionIdentity, activeOccurrenceIds) => {
      const state = get();
      const previous = state.sessions.find(
        (session) => session.sessionIdentity === sessionIdentity,
      );
      if (!previous) return;
      const active = new Set(activeOccurrenceIds);
      const occurrenceIds = previous.occurrenceIds.filter((id) => active.has(id));
      if (occurrenceIds.length === previous.occurrenceIds.length) return;
      const others = state.sessions.filter(
        (session) => session.sessionIdentity !== sessionIdentity,
      );
      set({
        sessions:
          occurrenceIds.length > 0 ? [...others, { sessionIdentity, occurrenceIds }] : others,
      });
      if (mode === "backend") {
        write(() => backend.reconcileNoticeDismissals(sessionIdentity, activeOccurrenceIds));
      } else {
        persistLegacy();
      }
    },
    ensureHydrated: () => {
      hydration ??= hydrate().catch(() => {
        // Retried by the next consumer to mount.
        hydration = null;
        set({ ready: true });
      });
      return hydration;
    },
    clear: () => {
      for (const stop of stopSubscriptions ?? []) stop();
      stopSubscriptions = null;
      mode = null;
      hydration = null;
      revision = -1;
      inFlightWrites = 0;
      clearLegacyPersistedState(LEGACY_NOTICE_DISMISSAL_KEY);
      set({ sessions: [], ready: true });
    },
  };
});

/**
 * Hydrates the stored dismissals when a consumer mounts and reports whether
 * they have been read; notices wait for it.
 */
export function useNoticeDismissalsReady(): boolean {
  const ready = useNativeNoticeDismissalStore((state) => state.ready);
  useEffect(() => {
    void useNativeNoticeDismissalStore.getState().ensureHydrated();
  }, []);
  return ready;
}
