/**
 * The renderer's window stores (plan items 4004 and 3018): ordinary zustand
 * stores with one instance per window, never per node (its chrome, its
 * selection, dialogs it shows, view state keyed by node). Every other module
 * in `apps/web/src/stores` is a per-node store: it defines a
 * `defineScopedStore` def and exports its hook with `scopedStoreHook(def)`, so
 * it is reached only through a node scope. A repository test
 * (`tests/unit/source-guards.test.ts`) fails on a store module in neither
 * group, so a store holding one node's state cannot be added as a window-wide
 * singleton by accident. Moving a store between the groups is a design
 * change: see `docs/development/node-scopes.md`.
 */
export interface WindowStore {
  /** The store's name in kebab case. */
  readonly store: string;
  /** Module id under `apps/web/src`. */
  readonly module: string;
}

export const WINDOW_STORES: readonly WindowStore[] = [
  { store: "active-coordinator-conversation", module: "stores/activeCoordinatorConversationStore" },
  { store: "app-dialog", module: "stores/appDialogStore" },
  { store: "artifact-live-host", module: "stores/artifactLiveHostStore" },
  { store: "bug-report", module: "stores/bugReportStore" },
  { store: "conversation-scroll-target", module: "stores/conversationScrollTargetStore" },
  { store: "error-dialog", module: "stores/errorDialogStore" },
  { store: "files-panel-chrome", module: "stores/filesPanelChromeStore" },
  { store: "flow-graph-view", module: "stores/flowGraphViewStore" },
  { store: "global-settings", module: "stores/globalSettingsStore" },
  { store: "machine-bulk-update", module: "stores/machineBulkUpdateStore" },
  { store: "machine-view", module: "stores/machineViewStore" },
  { store: "merge-pr-request", module: "stores/mergePrRequestStore" },
  { store: "message-part-expansion", module: "stores/messagePartExpansionStore" },
  { store: "native-notice-dismissal", module: "stores/nativeNoticeDismissalStore" },
  { store: "project-copy", module: "stores/projectCopyStore" },
  { store: "remote-workspace", module: "stores/remoteWorkspaceStore" },
  { store: "rich-content-view", module: "stores/richContentViewStore" },
  { store: "sidebar-action", module: "stores/sidebarActionStore" },
  { store: "static-html-frame-slots", module: "stores/staticHtmlFrameSlots" },
  { store: "terminal-portal", module: "stores/terminalPortalStore" },
  { store: "ui-chrome", module: "stores/uiChromeStore" },
  { store: "window-selection", module: "stores/windowSelectionStore" },
];
