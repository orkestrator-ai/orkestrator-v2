import { create } from "zustand";

/** The environment the debug button was pressed for. */
export interface DebugBuildTarget {
  /** `null` is this window's own backend; else the in-tree node the environment is on. */
  nodeId: string | null;
  projectId: string;
  environmentId: string;
}

/**
 * The debug dialog's request: which environment it is for, and the window
 * capture taken before it opened.
 *
 * The button lives in the sidebar's bottom bar, which unmounts with the
 * sidebar (the mobile drawer closes for a dialog), so the request lives here
 * and `AppShell` hosts the dialog (`DebugBuildDialogHost`). Window-level, like
 * the bug report's: the target names the node it belongs to.
 *
 * `capturing` covers the moment between the press and the dialog opening,
 * while the window is captured without it; a second press then does nothing.
 */
interface DebugBuildState {
  open: boolean;
  capturing: boolean;
  target: DebugBuildTarget | null;
  /** Base64 PNG of the window as it was before the dialog opened. */
  screenshot: string | null;
  /** Why there is no screenshot, when the capture failed or is unavailable. */
  captureError: string | null;
  beginCapture: (target: DebugBuildTarget) => void;
  showDialog: (capture: { screenshot: string | null; captureError: string | null }) => void;
  close: () => void;
}

export const useDebugBuildStore = create<DebugBuildState>()((set) => ({
  open: false,
  capturing: false,
  target: null,
  screenshot: null,
  captureError: null,
  beginCapture: (target) =>
    set({ capturing: true, open: false, target, screenshot: null, captureError: null }),
  showDialog: ({ screenshot, captureError }) =>
    set({ capturing: false, open: true, screenshot, captureError }),
  // The capture is dropped with the dialog: a window image is not kept around.
  close: () =>
    set({ open: false, capturing: false, target: null, screenshot: null, captureError: null }),
}));
