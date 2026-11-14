import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ActivitySortOrder } from "@orkestrator/protocol/environment-activity-order";
import { windowStorageKey } from "@/lib/desktop-storage-key";
import { createUIWindowStateStorage } from "@/lib/ui-state-storage";

/** Zoom level constraints */
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;

export type EnvironmentSortMode = "project" | "activity";
/**
 * How "By activity" orders environments. Every order keeps merged environments
 * below unmerged ones and working environments below the others. Within those
 * groups `priority` puts unread work, then waiting, before idle, newest first
 * within each; `newest` and `oldest` order by activity time alone. Defined with
 * the shared comparator.
 */
export type { ActivitySortOrder } from "@orkestrator/protocol/environment-activity-order";

/**
 * The window's UI chrome (report §5.1, plan item 3006): one per window and
 * shared by every node it shows, so hiding the sidebar or zooming on one
 * node's workspace does it for all of them. What belongs to a node (its
 * selection's projection, collapsed projects, recents) is in the scoped
 * `uiStore`; the node-qualified selection itself is the window scope's
 * (`windowSelectionStore`).
 */
export interface UIChromeState {
  /** Whether the left projects/environments panel is visible. */
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** How environments are arranged in the sidebar. */
  environmentSortMode: EnvironmentSortMode;
  /** Order of the "By activity" list. */
  activitySortOrder: ActivitySortOrder;
  /** Zoom level as a percentage (50-200, default 100) */
  zoomLevel: number;
  /** Multi Review graph height set by dragging its divider; null sizes it to the graph. */
  multiReviewGraphHeight: number | null;
  /** Build pipeline graph height set by dragging its divider; null sizes it to the graph. */
  pipelineGraphHeight: number | null;
  /**
   * This client's data-saving preference: slower background reads of what it
   * shows (`setReadCoordinatorDataSaving`). Client-local by design — it never
   * changes another client's freshness or the backend's own cadence.
   */
  dataSaving: boolean;
  /**
   * The coordinator's first-run card was dismissed. Per user on this device,
   * across projects and nodes: the coordinator works the same way everywhere.
   */
  coordinatorIntroDismissed: boolean;
  /**
   * Settings → Debug → "Debug button": shows the bottom bar's debug button,
   * which captures the window and files a pipeline environment for the
   * environment in front. Per window, like the rest of the chrome.
   */
  debugButtonEnabled: boolean;

  /** Toggle the left projects/environments panel. */
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setEnvironmentSortMode: (mode: EnvironmentSortMode) => void;
  setActivitySortOrder: (order: ActivitySortOrder) => void;
  /** Set zoom level (clamped to 50-200) */
  setZoomLevel: (level: number) => void;
  /** Zoom in by 10% */
  zoomIn: () => void;
  /** Zoom out by 10% */
  zoomOut: () => void;
  /** Reset zoom to 100% */
  resetZoom: () => void;
  setMultiReviewGraphHeight: (height: number | null) => void;
  setPipelineGraphHeight: (height: number | null) => void;
  setDataSaving: (enabled: boolean) => void;
  setCoordinatorIntroDismissed: (dismissed: boolean) => void;
  setDebugButtonEnabled: (enabled: boolean) => void;
}

type PersistedUIChrome = Pick<
  UIChromeState,
  | "sidebarWidth"
  | "sidebarOpen"
  | "environmentSortMode"
  | "activitySortOrder"
  | "zoomLevel"
  | "multiReviewGraphHeight"
  | "pipelineGraphHeight"
  | "dataSaving"
  | "coordinatorIntroDismissed"
  | "debugButtonEnabled"
>;

const PERSISTED_CHROME_FIELDS: readonly (keyof PersistedUIChrome)[] = [
  "sidebarWidth",
  "sidebarOpen",
  "environmentSortMode",
  "activitySortOrder",
  "zoomLevel",
  "multiReviewGraphHeight",
  "pipelineGraphHeight",
  "dataSaving",
  "coordinatorIntroDismissed",
  "debugButtonEnabled",
];

/**
 * Applies the window's stored chrome to `current`. Only the chrome fields
 * are read: the same record may still hold node fields an earlier release
 * kept there (read by the scoped `uiStore`), and fields for UI that no longer
 * exists, which the next write leaves out.
 */
export function mergePersistedUIChrome(persisted: unknown, current: UIChromeState): UIChromeState {
  const stored = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<
    string,
    unknown
  >;
  const restored: Partial<PersistedUIChrome> = {};
  for (const field of PERSISTED_CHROME_FIELDS) {
    if (field in stored) (restored as Record<string, unknown>)[field] = stored[field];
  }
  return { ...current, ...restored };
}

export const createUIChromeStore = () =>
  create<UIChromeState>()(
    persist(
      (set) => ({
        sidebarOpen: true,
        sidebarWidth: 280,
        environmentSortMode: "project",
        activitySortOrder: "priority",
        zoomLevel: ZOOM_DEFAULT,
        multiReviewGraphHeight: null,
        pipelineGraphHeight: null,
        dataSaving: false,
        coordinatorIntroDismissed: false,
        debugButtonEnabled: false,

        toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
        setSidebarOpen: (open) => set({ sidebarOpen: open }),
        setSidebarWidth: (width) => set({ sidebarWidth: width }),
        setEnvironmentSortMode: (mode) => set({ environmentSortMode: mode }),
        setActivitySortOrder: (order) => set({ activitySortOrder: order }),
        setZoomLevel: (level) => set({ zoomLevel: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)) }),
        zoomIn: () =>
          set((state) => ({ zoomLevel: Math.min(ZOOM_MAX, state.zoomLevel + ZOOM_STEP) })),
        zoomOut: () =>
          set((state) => ({ zoomLevel: Math.max(ZOOM_MIN, state.zoomLevel - ZOOM_STEP) })),
        resetZoom: () => set({ zoomLevel: ZOOM_DEFAULT }),
        setMultiReviewGraphHeight: (height) => set({ multiReviewGraphHeight: height }),
        setPipelineGraphHeight: (height) => set({ pipelineGraphHeight: height }),
        setDataSaving: (enabled) => set({ dataSaving: enabled }),
        setCoordinatorIntroDismissed: (dismissed) => set({ coordinatorIntroDismissed: dismissed }),
        setDebugButtonEnabled: (enabled) => set({ debugButtonEnabled: enabled }),
      }),
      {
        name: windowStorageKey("ui-storage"),
        storage: createJSONStorage(() => createUIWindowStateStorage()),
        merge: mergePersistedUIChrome,
        partialize: (state): PersistedUIChrome => {
          const persisted: Partial<PersistedUIChrome> = {};
          for (const field of PERSISTED_CHROME_FIELDS) {
            (persisted as Record<string, unknown>)[field] = state[field];
          }
          return persisted as PersistedUIChrome;
        },
      },
    ),
  );

/** The window's sidebar, zoom, sort and graph sizes, shared by every node it shows. */
export const useUIChromeStore = createUIChromeStore();
