import { create } from "zustand";

/**
 * Expansion state for individual thinking, JSON, tool, and agent message parts.
 *
 * Transcripts render inside a virtualized list, so a message component is
 * unmounted as soon as it scrolls out of the viewport window. Keeping the
 * open/closed flag in component state would silently collapse a block the user
 * expanded and scrolled past, so the authoritative state lives here and the
 * component rehydrates from it on mount.
 */

/**
 * Upper bound on remembered keys. Expanding is a deliberate user action, so
 * this is generous; the cap only exists so a very long-lived session cannot
 * grow the set without limit. `Set` iterates in insertion order, so trimming
 * from the front drops the least recently expanded keys.
 */
const MAX_EXPANDED_KEYS = 500;

interface MessagePartExpansionState {
  expandedKeys: ReadonlySet<string>;
  setExpanded: (key: string, expanded: boolean) => void;
  reset: () => void;
}

export const useMessagePartExpansionStore = create<MessagePartExpansionState>(
  (set) => ({
    expandedKeys: new Set<string>(),

    setExpanded: (key, expanded) =>
      set((state) => {
        if (state.expandedKeys.has(key) === expanded) return state;

        const next = new Set(state.expandedKeys);
        if (expanded) {
          next.add(key);
        } else {
          next.delete(key);
        }

        if (next.size > MAX_EXPANDED_KEYS) {
          return {
            expandedKeys: new Set(
              [...next].slice(next.size - MAX_EXPANDED_KEYS),
            ),
          };
        }

        return { expandedKeys: next };
      }),

    reset: () => set({ expandedKeys: new Set<string>() }),
  }),
);
