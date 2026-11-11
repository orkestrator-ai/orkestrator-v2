import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import type { CoordinatorPaneLayoutRecord } from "@orkestrator/protocol/coordinator-pane-layout";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createClientStateApi } from "@/lib/backend/client-state";
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
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/** The key earlier releases kept every project's layout under (per machine). */
export const LEGACY_COORDINATOR_LAYOUT_KEY = "coordinator-pane-layouts";
/** Projects an older backend's browser copy remembers (least recently used dropped first). */
export const MAX_REMEMBERED_COORDINATOR_LAYOUTS = 50;
/**
 * When a project's first read fails, it is read again after each of these
 * delays, then only on a resync, the periodic safety check, the next mount
 * or the panel's Retry.
 */
export const COORDINATOR_LAYOUT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

interface LayoutEntry {
  layout: CoordinatorPaneLayout | undefined;
  /** The backend revision `layout` was saved at or read from; 0 when none is stored. */
  revision: number;
  /** False until this client knows what the backend (or the browser copy) holds. */
  ready: boolean;
  /** The last attempt to learn that failed; still not ready. */
  failed: boolean;
}

/** `loading` and `failed` show no tab groups: nothing is known to reconcile against. */
export type CoordinatorPaneLayoutStatus = "loading" | "ready" | "failed";

export interface CoordinatorPaneLayoutState {
  entries: Record<string, LayoutEntry>;
  /** Applies a local change and saves it (to the backend, or the browser copy on an older one). */
  setLayout: (projectId: string, layout: CoordinatorPaneLayout) => void;
  /**
   * Reads the project's stored layout; called when its coordinator page
   * mounts. Until a read succeeds the project is not ready, so the panel never
   * reconciles (and saves) a default layout over one it has not read.
   */
  hydrate: (projectId: string) => Promise<void>;
  /** Reads a project whose read failed again now, with a fresh set of retries. */
  retry: (projectId: string) => Promise<void>;
  /** Also stops pending retries; called on scope dispose and by tests. */
  reset: () => void;
}

/** `scope`'s layout commands: the suites' mocked named exports on the app's command scope. */
function layoutApi(scope: NodeScope) {
  return backendApiForScope(scope, createClientStateApi, {
    getCoordinatorPaneLayout: backend.getCoordinatorPaneLayout,
    saveCoordinatorPaneLayout: backend.saveCoordinatorPaneLayout,
  });
}

/**
 * Each project's coordinator tab groups, per node, mirrored from the backend
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
 *
 * A failed read leaves the project not ready (to-do 5000, now retired): a panel
 * that rendered "nothing stored" would reconcile its default single group and
 * save it, and after a failed capability read that save went out over the
 * groups the backend held once the backend answered.
 */
export const coordinatorPaneLayoutStore = defineScopedStore<CoordinatorPaneLayoutState>(
  "coordinator-pane-layout",
  (scope) => (set, get) => {
    let mode: "backend" | "legacy" | null = null;
    let migration: Promise<void> | null = null;
    let stopSubscriptions: Array<() => void> | null = null;
    const saving = new Set<string>();
    const pending = new Map<string, CoordinatorPaneLayout>();
    const unconfirmedEdits = new Map<string, CoordinatorPaneLayout>();
    const hydrating = new Map<string, Promise<void>>();
    const retries = new Map<
      string,
      { attempt: number; timer: ReturnType<typeof setTimeout> | null }
    >();

    const entry = (projectId: string): LayoutEntry | undefined => get().entries[projectId];
    const patch = (projectId: string, next: Partial<LayoutEntry>) =>
      set((state) => {
        const current = state.entries[projectId] ?? {
          layout: undefined,
          revision: 0,
          ready: false,
          failed: false,
        };
        return { entries: { ...state.entries, [projectId]: { ...current, ...next } } };
      });

    const legacyLayouts = (): Array<{ projectId: string; layout: CoordinatorPaneLayout }> => {
      const raw = readLegacyPersistedState(LEGACY_COORDINATOR_LAYOUT_KEY, scope)?.layouts;
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
      writeLegacyPersistedState(LEGACY_COORDINATOR_LAYOUT_KEY, { layouts }, scope);
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
            await layoutApi(scope).saveCoordinatorPaneLayout(projectId, layout, 0);
          } catch (error) {
            // A project removed since is simply not imported.
            if (!(error instanceof Error && error.message.includes("Project not found"))) {
              complete = false;
            }
          }
        }
        if (complete) clearLegacyPersistedState(LEGACY_COORDINATOR_LAYOUT_KEY, scope);
      })();
      return migration;
    };

    const adopt = (projectId: string, record: CoordinatorPaneLayoutRecord | null) => {
      // A local change still being saved is newer than what was read.
      if (saving.has(projectId) || pending.has(projectId) || unconfirmedEdits.has(projectId))
        return;
      const current = entry(projectId);
      // The revision already held (this client's own save, announced back) or an
      // older answer: nothing new, and keeping the object avoids a re-render.
      if (current?.ready && record && record.revision <= current.revision) return;
      patch(projectId, {
        layout: record?.layout ?? (current?.ready ? undefined : current?.layout),
        revision: record?.revision ?? 0,
        ready: true,
        failed: false,
      });
      stopRetrying(projectId);
    };

    const stopRetrying = (projectId: string) => {
      const retry = retries.get(projectId);
      if (retry?.timer) clearTimeout(retry.timer);
      retries.delete(projectId);
    };

    /** The read failed before anything was known: stay not ready and read again later. */
    const readFailed = (projectId: string) => {
      if (entry(projectId)?.ready) return;
      patch(projectId, { failed: true });
      const retry = retries.get(projectId) ?? { attempt: 0, timer: null };
      if (retry.timer) return;
      const delay = COORDINATOR_LAYOUT_RETRY_DELAYS_MS[retry.attempt];
      retries.set(projectId, retry);
      if (delay === undefined) return;
      retry.attempt += 1;
      retry.timer = setTimeout(() => {
        retry.timer = null;
        void hydrate(projectId);
      }, delay);
    };

    const refresh = async (projectId: string) => {
      try {
        adopt(projectId, await layoutApi(scope).getCoordinatorPaneLayout(projectId));
      } catch {
        // Kept as is; the next hint or resync reads again.
        readFailed(projectId);
      }
    };

    const reconcileAll = async () => {
      await Promise.all(
        Object.keys(get().entries).map(async (projectId) => {
          // A project whose first read failed starts again from the capabilities.
          if (!entry(projectId)?.ready) return hydrate(projectId);
          if (mode !== "backend") return;
          // A change a dropped connection failed to save goes out first.
          return pending.has(projectId) ? flush(projectId) : refresh(projectId);
        }),
      );
    };

    const subscribe = () => {
      if (stopSubscriptions) return;
      stopSubscriptions = [
        onResourceChanged(
          "coordinator-pane-layout",
          (change) => {
            if (mode === "backend" && entry(change.id)) void refresh(change.id);
          },
          scope,
        ),
        // Not in the durable manifest, so both recovery paths apply: reconnects and
        // gaps (resync) and the periodic safety check.
        onResourceResync(reconcileAll, scope),
        onViewSafetyCheck(reconcileAll, scope),
      ];
    };
    const unsubscribe = () => {
      for (const stop of stopSubscriptions ?? []) stop();
      stopSubscriptions = null;
      for (const projectId of Array.from(retries.keys())) stopRetrying(projectId);
    };
    scope.onDispose("coordinator-pane-layout", unsubscribe);

    const flush = async (projectId: string) => {
      if (saving.has(projectId)) return;
      saving.add(projectId);
      try {
        for (;;) {
          const layout = pending.get(projectId);
          if (!layout) break;
          pending.delete(projectId);
          const result = await layoutApi(scope)
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
          const record = await layoutApi(scope).getCoordinatorPaneLayout(projectId);
          patch(projectId, { revision: record?.revision ?? 0 });
        } catch {
          continue; // Still unconfirmed; the next mount or reconnect tries again.
        }
        unconfirmedEdits.delete(projectId);
        if (!pending.has(projectId)) pending.set(projectId, layout);
        void flush(projectId);
      }
    };

    const readStored = async (projectId: string) => {
      let capabilities: ClientStateCapabilities;
      try {
        capabilities = await clientStateCapabilities(scope);
      } catch {
        // Nothing is known about the backend yet, so nothing is known about
        // the layout either: not ready, and read again later.
        readFailed(projectId);
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
          failed: false,
        });
        stopRetrying(projectId);
        return;
      }
      mode = "backend";
      await migrate();
      if (entry(projectId)?.ready) {
        await refresh(projectId);
        await sendUnconfirmedEdits();
        return;
      }
      try {
        const record = await layoutApi(scope).getCoordinatorPaneLayout(projectId);
        patch(projectId, {
          layout: unconfirmedEdits.get(projectId) ?? record?.layout ?? entry(projectId)?.layout,
          revision: record?.revision ?? 0,
          ready: true,
          failed: false,
        });
        stopRetrying(projectId);
      } catch {
        readFailed(projectId);
        return;
      }
      await sendUnconfirmedEdits();
      if (pending.has(projectId)) void flush(projectId);
    };

    /** One read per project at a time; a mount, a retry and a resync share it. */
    const hydrate = (projectId: string): Promise<void> => {
      const running = hydrating.get(projectId);
      if (running) return running;
      if (!entry(projectId)) patch(projectId, {});
      // Resyncs and safety checks also read again a project whose read failed.
      subscribe();
      const read = readStored(projectId).finally(() => hydrating.delete(projectId));
      hydrating.set(projectId, read);
      return read;
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
      hydrate,
      retry: (projectId) => {
        stopRetrying(projectId);
        return hydrate(projectId);
      },
      reset: () => {
        unsubscribe();
        hydrating.clear();
        mode = null;
        migration = null;
        saving.clear();
        pending.clear();
        unconfirmedEdits.clear();
        set({ entries: {} });
      },
    };
  },
);

/**
 * Reads the nearest node scope's layouts; other code uses
 * `scope.store(coordinatorPaneLayoutStore)`.
 */
export const useCoordinatorPaneLayoutStore = scopedStoreHook(coordinatorPaneLayoutStore);

export function selectCoordinatorPaneLayout(projectId: string) {
  return (state: CoordinatorPaneLayoutState) => state.entries[projectId]?.layout;
}

export function selectCoordinatorPaneLayoutReady(projectId: string) {
  return (state: CoordinatorPaneLayoutState) => state.entries[projectId]?.ready === true;
}

export function selectCoordinatorPaneLayoutStatus(projectId: string) {
  return (state: CoordinatorPaneLayoutState): CoordinatorPaneLayoutStatus => {
    const current = state.entries[projectId];
    if (current?.ready) return "ready";
    return current?.failed ? "failed" : "loading";
  };
}
