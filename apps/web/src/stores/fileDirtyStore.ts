import { create } from "zustand";

/**
 * Track dirty (unsaved) state for file editor tabs.
 * Each file tab can have modified content that hasn't been saved yet.
 */
interface FileDirtyEntry {
  /** The modified content that differs from disk */
  content: string;
  /** Original content loaded from disk (for comparison) */
  originalContent: string;
}

interface FileDirtyState {
  /** Map of tabId -> dirty entry */
  dirtyFiles: Map<string, FileDirtyEntry>;

  /**
   * Set the original content when a file is loaded.
   * This establishes the baseline for dirty detection.
   */
  setOriginalContent: (tabId: string, content: string) => void;

  /**
   * Update the current content for a file tab.
   * The file is considered dirty if content differs from originalContent.
   */
  setContent: (tabId: string, content: string) => void;

  /**
   * Mark a file as saved (resets the dirty state).
   * Call this after successfully saving the file.
   */
  markSaved: (tabId: string, savedContent: string) => void;

  /**
   * Check if a file tab has unsaved changes.
   */
  isDirty: (tabId: string) => boolean;

  /**
   * Get the current content for a file tab (for saving).
   */
  getContent: (tabId: string) => string | null;

  /**
   * Clear dirty state for a file tab (e.g., when tab is closed).
   */
  clearDirty: (tabId: string) => void;
}

export const useFileDirtyStore = create<FileDirtyState>()((set, get) => ({
  dirtyFiles: new Map(),

  setOriginalContent: (tabId, content) => {
    set((state) => {
      const newMap = new Map(state.dirtyFiles);
      const existing = newMap.get(tabId);
      if (existing) {
        // Update original, keep current content
        newMap.set(tabId, { ...existing, originalContent: content });
      } else {
        // Initialize both to the same content (not dirty)
        newMap.set(tabId, { content, originalContent: content });
      }
      return { dirtyFiles: newMap };
    });
  },

  setContent: (tabId, content) => {
    set((state) => {
      const newMap = new Map(state.dirtyFiles);
      const existing = newMap.get(tabId);
      if (existing) {
        newMap.set(tabId, { ...existing, content });
      } else {
        // Content set without original - treat original as empty
        newMap.set(tabId, { content, originalContent: "" });
      }
      return { dirtyFiles: newMap };
    });
  },

  markSaved: (tabId, savedContent) => {
    set((state) => {
      const newMap = new Map(state.dirtyFiles);
      // After save, both original and current are the saved content
      newMap.set(tabId, { content: savedContent, originalContent: savedContent });
      return { dirtyFiles: newMap };
    });
  },

  isDirty: (tabId) => {
    const entry = get().dirtyFiles.get(tabId);
    if (!entry) return false;
    return entry.content !== entry.originalContent;
  },

  getContent: (tabId) => {
    const entry = get().dirtyFiles.get(tabId);
    return entry?.content ?? null;
  },

  clearDirty: (tabId) => {
    set((state) => {
      const newMap = new Map(state.dirtyFiles);
      newMap.delete(tabId);
      return { dirtyFiles: newMap };
    });
  },
}));
