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
 * from the front drops the least recently expanded keys — see `evictToCap`,
 * which skips keys whose row is still on screen before falling back to that
 * order.
 *
 * This set is shared by every transcript in the app session, and tool rows are
 * by far the most numerous disclosure in one, so the cap is reachable in
 * ordinary use rather than only in pathological sessions.
 */
const MAX_EXPANDED_KEYS = 500;

/**
 * Keys whose disclosure is currently mounted, counted rather than flagged so
 * the same key rendered in two places (or remounted before React runs the old
 * cleanup) is only released once every holder is gone.
 *
 * This lives outside the store state on purpose: mounting and unmounting rows
 * is the virtualized list's routine scroll behaviour, and routing it through
 * `set` would re-render every subscriber on every scroll frame for information
 * no component reads.
 */
const mountedKeyCounts = new Map<string, number>();

/**
 * Mark `key` as on screen until the returned release function runs.
 *
 * Eviction consults this so the cap cannot collapse a disclosure the reader is
 * currently looking at — that silent collapse is the exact regression this
 * store exists to prevent, and hitting the cap is not a reason to reintroduce
 * it. Off-screen keys stay evictable, which is what keeps the set bounded.
 */
export function retainExpansionKey(key: string): () => void {
  mountedKeyCounts.set(key, (mountedKeyCounts.get(key) ?? 0) + 1);

  let released = false;
  return () => {
    // Guard double-release: React may invoke a cleanup twice under StrictMode,
    // and an over-release would make a still-mounted row look evictable.
    if (released) return;
    released = true;

    const remaining = (mountedKeyCounts.get(key) ?? 0) - 1;
    if (remaining > 0) {
      mountedKeyCounts.set(key, remaining);
    } else {
      mountedKeyCounts.delete(key);
    }
  };
}

/**
 * Drop keys until the set fits the cap, preferring the least recently expanded
 * key whose row is off screen. Mounted rows are only sacrificed when every
 * other candidate is also mounted, and `protectedKey` — the key being expanded
 * right now — is never dropped, since discarding it would throw away the click
 * currently being handled.
 *
 * `keys` must already be a private copy; this mutates it. Deleting from a `Set`
 * while iterating it is well defined: entries not yet reached are skipped.
 */
function evictToCap(keys: Set<string>, protectedKey: string): Set<string> {
  let overflow = keys.size - MAX_EXPANDED_KEYS;
  if (overflow <= 0) return keys;

  for (const key of keys) {
    if (overflow === 0) break;
    if (key === protectedKey || mountedKeyCounts.has(key)) continue;
    keys.delete(key);
    overflow--;
  }

  // Excluding one protected key still leaves `size - 1` candidates, which is
  // always at least the overflow, so the cap is reached either way.
  for (const key of keys) {
    if (overflow === 0) break;
    if (key === protectedKey) continue;
    keys.delete(key);
    overflow--;
  }

  return keys;
}

interface MessagePartExpansionState {
  expandedKeys: ReadonlySet<string>;
  setExpanded: (key: string, expanded: boolean) => void;
  reset: () => void;
}

export const useMessagePartExpansionStore = create<MessagePartExpansionState>((set) => ({
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

      return { expandedKeys: evictToCap(next, key) };
    }),

  reset: () => set({ expandedKeys: new Set<string>() }),
}));
