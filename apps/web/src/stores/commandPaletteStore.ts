import { create } from "zustand";
import { persist } from "zustand/middleware";
import { windowStorageKey } from "@/lib/desktop-storage-key";
import { commandById } from "@/lib/command-palette/catalog";
import { noteRecentCommand, RECENT_COMMAND_LIMIT } from "@/lib/command-palette/search";

/**
 * The ⌘K palette's memory, per window: the stable IDs of recently run
 * commands (never their targets, names or the query typed), at most
 * `RECENT_COMMAND_LIMIT`, and whether to keep them at all. Both are
 * clearable from the palette itself ("Clear recent commands", "Stop
 * remembering recent commands"). Recent destinations are the sidebar's own
 * node-qualified recents (`machineViewStore.recentKeys`), not stored here.
 */
export interface CommandPaletteState {
  recentCommandIds: string[];
  rememberRecent: boolean;
  noteCommand: (commandId: string) => void;
  clearRecent: () => void;
  setRememberRecent: (remember: boolean) => void;
}

/** Only catalogue IDs survive a reload: a renamed or removed command drops out. */
function knownRecentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((id): id is string => typeof id === "string" && commandById(id) !== undefined)
    .slice(0, RECENT_COMMAND_LIMIT);
}

export const useCommandPaletteStore = create<CommandPaletteState>()(
  persist(
    (set) => ({
      recentCommandIds: [],
      rememberRecent: true,
      noteCommand: (commandId) =>
        set((state) =>
          state.rememberRecent && commandById(commandId)
            ? { recentCommandIds: noteRecentCommand(state.recentCommandIds, commandId) }
            : state,
        ),
      clearRecent: () => set({ recentCommandIds: [] }),
      setRememberRecent: (remember) =>
        set(remember ? { rememberRecent: true } : { rememberRecent: false, recentCommandIds: [] }),
    }),
    {
      name: windowStorageKey("command-palette"),
      partialize: (state) => ({
        recentCommandIds: state.recentCommandIds,
        rememberRecent: state.rememberRecent,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as {
          recentCommandIds?: unknown;
          rememberRecent?: unknown;
        };
        const rememberRecent = stored.rememberRecent !== false;
        return {
          ...current,
          rememberRecent,
          recentCommandIds: rememberRecent ? knownRecentIds(stored.recentCommandIds) : [],
        };
      },
    },
  ),
);
