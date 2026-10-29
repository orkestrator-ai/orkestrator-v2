import { create } from "zustand";

/**
 * Whether the bug-report sheet is showing, and whether a draft is in progress.
 *
 * The sheet is opened from the sidebar's bottom bar, which unmounts with the
 * sidebar, so the request lives here and the sheet is hosted by the app shell.
 * Closing the sheet only hides it: the report and its agent session live in
 * the backend until the report is filed or discarded.
 */
interface BugReportState {
  sheetOpen: boolean;
  /** A report exists on the backend that has not been filed or discarded. */
  draftInProgress: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  setDraftInProgress: (inProgress: boolean) => void;
}

export const useBugReportStore = create<BugReportState>()((set) => ({
  sheetOpen: false,
  draftInProgress: false,
  openSheet: () => set({ sheetOpen: true }),
  closeSheet: () => set({ sheetOpen: false }),
  setDraftInProgress: (draftInProgress) => set({ draftInProgress }),
}));
