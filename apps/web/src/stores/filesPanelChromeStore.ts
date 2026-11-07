import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  COMMAND_STORAGE_NODE,
  desktopConnectionStorageKey,
  windowStorageKey,
} from "@/lib/desktop-storage-key";

/**
 * The files panel's window chrome (report §7.1 class (d), plan item 3007):
 * whether the panel is shown and how wide it is. One per window and shared
 * by every node, so opening the panel on one node's workspace opens it for
 * all of them, as before. What the panel shows (tab, folders, pull request
 * tabs, loaded files) is per node, in `filesPanelStore`.
 */
export interface FilesPanelChromeState {
  isOpen: boolean;
  /** Persisted per window. */
  panelWidth: number;
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setPanelWidth: (width: number) => void;
}

export const FILES_PANEL_DEFAULT_WIDTH_PX = 320;
const MIN_PERSISTED_WIDTH_PX = 120;
const MAX_PERSISTED_WIDTH_PX = 4096;

function boundedWidth(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PERSISTED_WIDTH_PX &&
    value <= MAX_PERSISTED_WIDTH_PX
    ? value
    : null;
}

/**
 * The width earlier releases kept with the files panel's node state, under
 * the command node's `files-panel-storage` key. Read only while this window
 * has no width of its own; the field there is no longer written.
 */
export function legacyFilesPanelWidth(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(
      desktopConnectionStorageKey("files-panel-storage", COMMAND_STORAGE_NODE),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { panelWidth?: unknown } } | null;
    return boundedWidth(parsed?.state?.panelWidth);
  } catch {
    return null;
  }
}

/** The files panel's open state and width for this window. */
export const useFilesPanelChromeStore = create<FilesPanelChromeState>()(
  persist(
    (set) => ({
      isOpen: false,
      panelWidth: legacyFilesPanelWidth() ?? FILES_PANEL_DEFAULT_WIDTH_PX,
      togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),
      openPanel: () => set({ isOpen: true }),
      closePanel: () => set({ isOpen: false }),
      setPanelWidth: (width) => set({ panelWidth: width }),
    }),
    {
      name: windowStorageKey("files-panel-chrome"),
      partialize: (state) => ({ panelWidth: state.panelWidth }),
      merge: (persisted, current) => ({
        ...current,
        panelWidth:
          boundedWidth((persisted as { panelWidth?: unknown } | undefined)?.panelWidth) ??
          current.panelWidth,
      }),
    },
  ),
);
