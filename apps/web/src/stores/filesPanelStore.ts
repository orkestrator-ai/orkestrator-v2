import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GitFileChange, FileNode } from "@/lib/backend";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import type { CreateFileTabOptions } from "@/contexts/TerminalContext";

export type FilesPanelTab = "changes" | "all-files";

/**
 * A file the user opened from a view that has no editor panes of its own (the
 * project board shows the project root). The named environment's pane layout
 * opens it once that environment is active and able to host file tabs.
 */
export interface PendingFileOpen {
  environmentId: string;
  filePath: string;
  options?: CreateFileTabOptions;
}

interface FilesPanelState {
  // Panel visibility
  isOpen: boolean;

  // Panel width (persisted)
  panelWidth: number;

  // Active tab
  activeTab: FilesPanelTab;

  // Expanded folder paths in the tree (persisted). Folders are collapsed by default.
  expandedFolders: string[];

  // Git changes data
  changes: GitFileChange[];
  isLoadingChanges: boolean;

  // File tree data
  fileTree: FileNode[];
  isLoadingTree: boolean;

  // Target branch for diff comparison (e.g., "main")
  targetBranch: string;

  // File open waiting for its environment's panes to mount (not persisted)
  pendingFileOpens: PendingFileOpen[];

  // Actions
  togglePanel: () => void;
  /** Opens the panel on "All files", for a target with nothing to review yet. */
  openPanelOnAllFiles: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setActiveTab: (tab: FilesPanelTab) => void;
  setPanelWidth: (width: number) => void;
  setFolderExpanded: (path: string, expanded: boolean) => void;
  setChanges: (changes: GitFileChange[]) => void;
  setFileTree: (tree: FileNode[]) => void;
  setLoadingChanges: (loading: boolean) => void;
  setLoadingTree: (loading: boolean) => void;
  setTargetBranch: (branch: string) => void;
  requestFileOpen: (request: PendingFileOpen) => void;
  /** Clears the pending open, but only if it is still `request`. */
  clearPendingFileOpen: (request: PendingFileOpen) => void;
}

export const useFilesPanelStore = create<FilesPanelState>()(
  persist(
    (set) => ({
      // Initial state
      isOpen: false,
      panelWidth: 320,
      activeTab: "changes",
      expandedFolders: [],
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
      targetBranch: "main",
      pendingFileOpens: [],

      // Actions
      togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),
      openPanelOnAllFiles: () => set({ isOpen: true, activeTab: "all-files" }),
      openPanel: () => set({ isOpen: true }),
      closePanel: () => set({ isOpen: false }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      setFolderExpanded: (path, expanded) =>
        set((state) => ({
          expandedFolders: expanded
            ? state.expandedFolders.includes(path)
              ? state.expandedFolders
              : [...state.expandedFolders, path]
            : state.expandedFolders.filter((p) => p !== path),
        })),
      setChanges: (changes) => set({ changes }),
      setFileTree: (tree) => set({ fileTree: tree }),
      setLoadingChanges: (loading) => set({ isLoadingChanges: loading }),
      setLoadingTree: (loading) => set({ isLoadingTree: loading }),
      setTargetBranch: (branch) => set({ targetBranch: branch }),
      requestFileOpen: (request) =>
        set((state) => {
          if (state.pendingFileOpens.length >= 100 || request.filePath.length > 4096) {
            throw new Error("Too many pending file opens; wait for the editor to open");
          }
          return { pendingFileOpens: [...state.pendingFileOpens, request] };
        }),
      clearPendingFileOpen: (request) =>
        set((state) => ({
          pendingFileOpens: state.pendingFileOpens.filter((pending) => pending !== request),
        })),
    }),
    {
      name: desktopConnectionStorageKey("files-panel-storage"),
      partialize: (state) => ({
        panelWidth: state.panelWidth,
        expandedFolders: state.expandedFolders,
      }),
    },
  ),
);
