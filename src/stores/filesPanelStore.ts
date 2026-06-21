import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GitFileChange, FileNode } from "@/lib/backend";

export type FilesPanelTab = "changes" | "all-files";

interface FilesPanelState {
  // Panel visibility
  isOpen: boolean;

  // Panel width (persisted)
  panelWidth: number;

  // Active tab
  activeTab: FilesPanelTab;

  // Collapsed folder paths in the tree (persisted)
  collapsedFolders: string[];

  // Git changes data
  changes: GitFileChange[];
  isLoadingChanges: boolean;

  // File tree data
  fileTree: FileNode[];
  isLoadingTree: boolean;

  // Target branch for diff comparison (e.g., "main")
  targetBranch: string;

  // Actions
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setActiveTab: (tab: FilesPanelTab) => void;
  setPanelWidth: (width: number) => void;
  toggleFolderCollapse: (path: string) => void;
  setChanges: (changes: GitFileChange[]) => void;
  setFileTree: (tree: FileNode[]) => void;
  setLoadingChanges: (loading: boolean) => void;
  setLoadingTree: (loading: boolean) => void;
  setTargetBranch: (branch: string) => void;
}

export const useFilesPanelStore = create<FilesPanelState>()(
  persist(
    (set) => ({
      // Initial state
      isOpen: false,
      panelWidth: 320,
      activeTab: "changes",
      collapsedFolders: [],
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
      targetBranch: "main",

      // Actions
      togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),
      openPanel: () => set({ isOpen: true }),
      closePanel: () => set({ isOpen: false }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      toggleFolderCollapse: (path) =>
        set((state) => ({
          collapsedFolders: state.collapsedFolders.includes(path)
            ? state.collapsedFolders.filter((p) => p !== path)
            : [...state.collapsedFolders, path],
        })),
      setChanges: (changes) => set({ changes }),
      setFileTree: (tree) => set({ fileTree: tree }),
      setLoadingChanges: (loading) => set({ isLoadingChanges: loading }),
      setLoadingTree: (loading) => set({ isLoadingTree: loading }),
      setTargetBranch: (branch) => set({ targetBranch: branch }),
    }),
    {
      name: "files-panel-storage",
      partialize: (state) => ({
        panelWidth: state.panelWidth,
        collapsedFolders: state.collapsedFolders,
      }),
    }
  )
);
