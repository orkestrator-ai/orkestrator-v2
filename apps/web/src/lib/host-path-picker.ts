import { create } from "zustand";

export interface HostPathPickerOptions {
  /** Choose a folder or a file. */
  mode: "directory" | "file";
  title?: string;
  /** Where to start browsing; a stale path falls back to its nearest existing ancestor. */
  defaultPath?: string;
}

export interface HostPathPickerRequest extends HostPathPickerOptions {
  resolve: (path: string | null) => void;
}

interface HostPathPickerState {
  request: HostPathPickerRequest | null;
  /** Settles the open request with the chosen path, or null when cancelled. */
  settle: (path: string | null) => void;
}

export const useHostPathPickerStore = create<HostPathPickerState>()((set, get) => ({
  request: null,
  settle: (path) => {
    const { request } = get();
    if (!request) return;
    set({ request: null });
    request.resolve(path);
  },
}));

/**
 * Opens Orkestrator's own file/folder picker and resolves with the chosen
 * absolute path on the backend host, or null if the user cancelled.
 *
 * Unlike the operating system's dialog this browses the machine the backend
 * runs on, so it behaves the same for the local backend and for a remote
 * connection. A picker that is already open is cancelled by a newer request.
 */
export function pickHostPath(options: HostPathPickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useHostPathPickerStore.getState().settle(null);
    useHostPathPickerStore.setState({ request: { ...options, resolve } });
  });
}
