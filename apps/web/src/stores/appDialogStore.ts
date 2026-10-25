import { create } from "zustand";

/**
 * A dialog requested from a surface that can unmount under it.
 *
 * The mobile projects drawer unmounts its content when it closes, and a modal
 * opened from inside it is trapped behind it while it stays open. A sidebar row
 * therefore only records the request here; `AppDialogHost` renders the dialog
 * outside the drawer, and the drawer closes when a request arrives.
 */
export type AppDialogRequest =
  | { kind: "environment-settings"; environmentId: string }
  /** Also how another machine's project menu reaches these, in that machine's workspace. */
  | { kind: "repository-settings"; projectId: string }
  | { kind: "delete-project"; projectId: string };

interface AppDialogState {
  /** The dialog to show, or null when none is open. */
  request: AppDialogRequest | null;
  open: (request: AppDialogRequest) => void;
  close: () => void;
}

export const useAppDialogStore = create<AppDialogState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
