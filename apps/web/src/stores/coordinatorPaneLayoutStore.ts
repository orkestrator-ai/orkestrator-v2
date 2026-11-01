import { create } from "zustand";
import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import type { CoordinatorPaneLayoutRecord } from "@orkestrator/protocol/coordinator-pane-layout";
import * as backend from "@/lib/backend";
import { clientStateCapabilities } from "@/lib/client-state-capabilities";
import {
  sanitizeCoordinatorPaneLayout,
  type CoordinatorPaneLayout,
} from "@/lib/coordinator-pane-layout";
import {
  clearLegacyPersistedState,
  readLegacyPersistedState,
  writeLegacyPersistedState,
} from "@/lib/legacy-local-state";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/** The key earlier releases kept every project's layout under (per machine). */
export const LEGACY_COORDINATOR_LAYOUT_KEY = "coordinator-pane-layouts";
/** Projects an older backend's browser copy remembers (least recently used dropped first). */
export const MAX_REMEMBERED_COORDINATOR_LAYOUTS = 50;

interface LayoutEntry {
  layout: CoordinatorPaneLayout | undefined;
  /** The backend revision `layout` was saved at or read from; 0 when none is stored. */
  revision: number;
  /** False until this client knows what the backend (or the browser copy) holds. */
  ready: boolean;
}

interface CoordinatorPaneLayoutState {
  entries: Record<string, LayoutEntry>;
  /** Applies a local change and saves it (to the backend, or the browser copy on an older one). */
  setLayout: (projectId: string, layout: CoordinatorPaneLayout) => void;
  /** Reads the project's stored layout; called when its coordinator page mounts. */
  hydrate: (projectId: string) => Promise<void>;
  reset: () => void;
}

/**
 * Each project's coordinator tab groups, mirrored from the backend
 * (`get/save_coordinator_pane_layout`), so every client shows the same
 * grouping. Conversations themselves are backend-owned; a layout naming a
 * conversation that has since closed is reconciled away on render.
 *
 * Saves are serialized per project and compare-and-swap on the revision. A
 * conflict means another client saved first: its layout is adopted. Changes
 * from other clients arrive as `coordinator-pane-layout` hints and through the
 * periodic resync. Against an older backend the layout stays in this browser's
 * copy, as before; against a current one that copy is imported once and
 * deleted.
 */
export const useCoordinatorPaneLayoutStore = create<CoordinatorPaneLayoutState>()((set, get) => {
  let mode: "backend" | "legacy" | null = null;
  let migration: Promise<void> | null = null;
  let stopSubscriptions: Array<() => void> | null = null;
  const saving = new Set<string>();
  const pending = new Map<string, CoordinatorPaneLayout>();
  const unconfirmedEdits = new Map<string, CoordinatorPaneLayout>();

  const entry = (projectId: string): LayoutEntry | undefined => get().entries[projectId];
  const patch = (projectId: string, next: Partial<LayoutEntry>) =>
    set((state) => {
      const current = state.entries[projectId] ?? { layout: undefined, revision: 0, ready: false };
      return { entries: { ...state.entries, [projectId]: { ...current, ...next } } };
    });

  const legacyLayouts = (): Array<{ projectId: string; layout: CoordinatorPaneLayout }> => {
    const raw = readLegacyPersistedState(LEGACY_COORDINATOR_LAYOUT_KEY)?.layouts;
    if (!Array.isArray(raw)) return [];
    const byProject = new Map<string, CoordinatorPaneLayout>();
    for (const item of raw.slice(-MAX_REMEMBERED_COORDINATOR_LAYOUTS)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const layout = sanitizeCoordinatorPaneLayout(record.layout);
      if (
        typeof record.projectId !== "string" ||
        !record.projectId ||
        record.projectId.length > 200 ||
        !layout
      ) {
        continue;
      }
      byProject.delete(record.projectId);
      byProject.set(record.projectId, layout);
    }
    return Array.from(byProject, ([projectId, layout]) => ({ projectId, layout }));
  };

  const writeLegacy = (projectId: string, layout: CoordinatorPaneLayout) => {
    const layouts = [
      ...legacyLayouts()
        .filter((item) => item.projectId !== projectId)
        .slice(-(MAX_REMEMBERED_COORDINATOR_LAYOUTS - 1)),
      { projectId, layout },
    ].map((item) => ({ ...item, updatedAt: Date.now() }));
    writeLegacyPersistedState(LEGACY_COORDINATOR_LAYOUT_KEY, { layouts });
  };

  /** One-time import of this browser's copy. Kept for a later session if any save failed. */
  const migrate = () => {
    migration ??= (async () => {
      const saved = legacyLayouts();
      if (saved.length === 0) return;
      let complete = true;
      for (const { projectId, layout } of saved) {
        try {
          // Revision 0: never replaces a layout another client already saved.
          await backend.saveCoordinatorPaneLayout(projectId, layout, 0);
        } catch (error) {
          // A project removed since is simply not imported.
          if (!(error instanceof Error && error.message.includes("Project not found"))) {
            complete = false;
          }
        }
      }
      if (complete) clearLegacyPersistedState(LEGACY_COORDINATOR_LAYOUT_KEY);
    })();
    return migration;
  };

  const adopt = (projectId: string, record: CoordinatorPaneLayoutRecord | null) => {
    // A local change still being saved is newer than what was read.
    if (saving.has(projectId) || pending.has(projectId) || unconfirmedEdits.has(projectId)) return;
    const current = entry(projectId);
    // The revision already held (this client's own save, announced back) or an
    // older answer: nothing new, and keeping the object avoids a re-render.
    if (current?.ready && record && record.revision <= current.revision) return;
    patch(projectId, {
      layout: record?.layout ?? (current?.ready ? undefined : current?.layout),
      revision: record?.revision ?? 0,
      ready: true,
    });
  };

  const refresh = async (projectId: string) => {
    try {
      adopt(projectId, await backend.getCoordinatorPaneLayout(projectId));
    } catch {
      // Kept as is; the next hint or resync reads again.
      if (!entry(projectId)?.ready) patch(projectId, { ready: true });
    }
  };

  const reconcileAll = async () => {
    if (mode !== "backend") return;
    await Promise.all(
      Object.keys(get().entries).map((projectId) =>
        // A change a dropped connection failed to save goes out first.
        pending.has(projectId) ? flush(projectId) : refresh(projectId),
      ),
    );
  };

  const subscribe = () => {
    if (stopSubscriptions) return;
    stopSubscriptions = [
      onResourceChanged("coordinator-pane-layout", (change) => {
        if (mode === "backend" && entry(change.id)) void refresh(change.id);
      }),
      // Not in the durable manifest, so both recovery paths apply: reconnects and
      // gaps (resync) and the periodic safety check.
      onResourceResync(reconcileAll),
      onViewSafetyCheck(reconcileAll),
    ];
  };

  const flush = async (projectId: string) => {
    if (saving.has(projectId)) return;
    saving.add(projectId);
    try {
      for (;;) {
        const layout = pending.get(projectId);
        if (!layout) break;
        pending.delete(projectId);
        const result = await backend
          .saveCoordinatorPaneLayout(projectId, layout, entry(projectId)?.revision ?? 0)
          .catch(() => null);
        if (!result) {
          // Unsaved, not abandoned: the next change or resync sends the latest.
          if (!pending.has(projectId)) pending.set(projectId, layout);
          break;
        }
        if (result.status === "saved") {
          patch(projectId, { revision: result.record.revision });
          continue;
        }
        // Another client saved first: its layout wins, and any queued local
        // change made against the old one is dropped with it.
        pending.delete(projectId);
        patch(projectId, {
          layout: result.current?.layout,
          revision: result.current?.revision ?? 0,
        });
      }
    } finally {
      saving.delete(projectId);
    }
  };

  /**
   * Edits made before the backend answered its capabilities were based on no
   * revision of its layout, so they are saved over whatever it holds now. The
   * import cannot carry them: revision 0 never replaces a stored layout.
   */
  const sendUnconfirmedEdits = async () => {
    for (const [projectId, layout] of Array.from(unconfirmedEdits)) {
      try {
        const record = await backend.getCoordinatorPaneLayout(projectId);
        patch(projectId, { revision: record?.revision ?? 0 });
      } catch {
        continue; // Still unconfirmed; the next mount or reconnect tries again.
      }
      unconfirmedEdits.delete(projectId);
      if (!pending.has(projectId)) pending.set(projectId, layout);
      void flush(projectId);
    }
  };

  return {
    entries: {},
    setLayout: (projectId, layout) => {
      const current = entry(projectId);
      if (current?.layout === layout) return;
      patch(projectId, { layout });
      if (mode !== "backend") {
        // Unknown yet: kept in the browser copy too, which an older backend's
        // session keeps using.
        writeLegacy(projectId, layout);
        if (mode === null) unconfirmedEdits.set(projectId, layout);
        return;
      }
      pending.set(projectId, layout);
      if (current?.ready) void flush(projectId);
    },
    hydrate: async (projectId) => {
      let capabilities: ClientStateCapabilities;
      try {
        capabilities = await clientStateCapabilities();
      } catch {
        // Nothing is known about the backend yet: render what is held, and the
        // next mount or reconnect asks again.
        if (!entry(projectId)?.ready) patch(projectId, { ready: true });
        return;
      }
      if (!capabilities.coordinatorPaneLayouts) {
        mode = "legacy";
        unconfirmedEdits.clear();
        const current = entry(projectId);
        if (current?.ready) return;
        patch(projectId, {
          layout:
            current?.layout ?? legacyLayouts().find((item) => item.projectId === projectId)?.layout,
          ready: true,
        });
        return;
      }
      mode = "backend";
      subscribe();
      await migrate();
      if (entry(projectId)?.ready) {
        await refresh(projectId);
        await sendUnconfirmedEdits();
        return;
      }
      try {
        const record = await backend.getCoordinatorPaneLayout(projectId);
        patch(projectId, {
          layout: unconfirmedEdits.get(projectId) ?? record?.layout ?? entry(projectId)?.layout,
          revision: record?.revision ?? 0,
          ready: true,
        });
      } catch {
        patch(projectId, { ready: true });
      }
      await sendUnconfirmedEdits();
      if (pending.has(projectId)) void flush(projectId);
    },
    reset: () => {
      for (const stop of stopSubscriptions ?? []) stop();
      stopSubscriptions = null;
      mode = null;
      migration = null;
      saving.clear();
      pending.clear();
      unconfirmedEdits.clear();
      set({ entries: {} });
    },
  };
});

export function selectCoordinatorPaneLayout(projectId: string) {
  return (state: CoordinatorPaneLayoutState) => state.entries[projectId]?.layout;
}

export function selectCoordinatorPaneLayoutReady(projectId: string) {
  return (state: CoordinatorPaneLayoutState) => state.entries[projectId]?.ready === true;
}
