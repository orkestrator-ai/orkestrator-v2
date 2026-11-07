import { create } from "zustand";

/**
 * Whether the bug-report sheet is showing, for which node, and whether a
 * draft is in progress.
 *
 * The sheet is opened from the sidebar's bottom bar, which unmounts with the
 * sidebar, so the request lives here and the sheet is hosted by the app shell.
 * Closing the sheet only hides it: the report and its agent session live in
 * the backend until the report is filed or discarded.
 *
 * The store stays window-level (plan item 3017); the report runs against a
 * chosen node scope (plan item 5003): `sheetNodeId` is `null` for this
 * document's own backend, or the node id of another node shown in the
 * window's own tree, whose sheet `BugReportSheetHost` renders on its scope.
 */
interface BugReportState {
  sheetOpen: boolean;
  /** The node whose report the sheet shows; `null` is this document's own backend. */
  sheetNodeId: string | null;
  /** A report exists on this document's own backend that has not been filed or discarded. */
  draftInProgress: boolean;
  /** Opens the sheet for `nodeId` (default: this document's own backend). */
  openSheet: (nodeId?: string | null) => void;
  closeSheet: () => void;
  setDraftInProgress: (inProgress: boolean) => void;
}

export const useBugReportStore = create<BugReportState>()((set) => ({
  sheetOpen: false,
  sheetNodeId: null,
  draftInProgress: false,
  openSheet: (nodeId = null) => set({ sheetOpen: true, sheetNodeId: nodeId }),
  closeSheet: () => set({ sheetOpen: false }),
  setDraftInProgress: (draftInProgress) => set({ draftInProgress }),
}));
