import { create } from "zustand";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";

/**
 * Local view preferences for rich transcript blocks: disclosure state,
 * source/preview/data choice, wrapping, expansion, chart series selection and
 * diagram viewport. Keyed by the scoped block/artifact identity from
 * `rich-identity.ts`, so identical message ids in two environments or two
 * backends never share state.
 *
 * Bounds (documented in docs/architecture/rich-transcripts.md):
 *  - at most 500 inactive entries, evicted least-recently-used;
 *  - entries whose block is mounted ("active") are never evicted while
 *    mounted, but are counted against their own bound (200); past it the
 *    oldest active entry becomes evictable like an inactive one;
 *  - deliberately pinned entries (an open full-screen viewer) are bounded at
 *    50; pinning beyond that unpins the oldest pin and reports it so the
 *    caller can show a recovery action instead of silently losing state.
 * Source text, binary media and arbitrary application state never live here.
 */

export type RichViewChoice = "preview" | "source" | "data";

export interface RichViewState {
  open?: boolean;
  view?: RichViewChoice;
  wrap?: boolean;
  expanded?: boolean;
  hiddenSeries?: readonly string[];
  viewport?: { x: number; y: number; scale: number };
  /** Temporary reveal applied by find; restored when find closes unless the user changed it. */
  findRevealed?: boolean;
}

const mountCounts = new Map<string, number>();
const pinOrder: string[] = [];
const pinListeners = new Set<() => void>();

function notifyPins(): void {
  for (const listener of Array.from(pinListeners)) listener();
}

interface RichContentViewStore {
  entries: ReadonlyMap<string, RichViewState>;
  update: (key: string, patch: Partial<RichViewState>) => void;
  clearPrefixes: (prefixes: readonly string[]) => void;
  reset: () => void;
}

function evict(
  entries: Map<string, RichViewState>,
  protectedKey: string,
): Map<string, RichViewState> {
  const limit = FRONTEND_RENDER_POLICY.maxInactiveViewStateEntries;
  const activeLimit = FRONTEND_RENDER_POLICY.maxActiveViewStateEntries;
  const pinned = new Set(pinOrder);
  let inactive = 0;
  let active = 0;
  for (const key of entries.keys()) {
    if (pinned.has(key)) continue;
    if (mountCounts.has(key)) active++;
    else inactive++;
  }
  // Map iteration order is insertion order; `update` re-inserts on write, so
  // the front of the map is least recently used.
  for (const key of Array.from(entries.keys())) {
    if (inactive <= limit && active <= activeLimit) break;
    if (key === protectedKey || pinned.has(key)) continue;
    const isActive = mountCounts.has(key);
    if (isActive && active > activeLimit) {
      entries.delete(key);
      active--;
    } else if (!isActive && inactive > limit) {
      entries.delete(key);
      inactive--;
    }
  }
  return entries;
}

export const useRichContentViewStore = create<RichContentViewStore>((set) => ({
  entries: new Map(),
  update: (key, patch) =>
    set((state) => {
      const previous = state.entries.get(key);
      const nextValue = { ...previous, ...patch };
      if (
        previous &&
        Object.keys(patch).every((field) =>
          Object.is(
            previous[field as keyof RichViewState],
            nextValue[field as keyof RichViewState],
          ),
        )
      ) {
        return state;
      }
      const next = new Map(state.entries);
      next.delete(key);
      next.set(key, nextValue);
      return { entries: evict(next, key) };
    }),
  clearPrefixes: (prefixes) =>
    set((state) => {
      const next = new Map(state.entries);
      for (const key of Array.from(next.keys())) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) next.delete(key);
      }
      const pinsBefore = pinOrder.length;
      for (let i = pinOrder.length - 1; i >= 0; i--) {
        if (prefixes.some((prefix) => pinOrder[i]!.startsWith(prefix))) pinOrder.splice(i, 1);
      }
      if (pinOrder.length !== pinsBefore) queueMicrotask(notifyPins);
      return { entries: next };
    }),
  reset: () => {
    const hadPins = pinOrder.length > 0;
    pinOrder.length = 0;
    set({ entries: new Map() });
    if (hadPins) notifyPins();
  },
}));

/** Keep `key` protected from eviction while the block is mounted. */
export function retainRichViewKey(key: string): () => void {
  mountCounts.set(key, (mountCounts.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (mountCounts.get(key) ?? 0) - 1;
    if (remaining > 0) mountCounts.set(key, remaining);
    else mountCounts.delete(key);
  };
}

/**
 * Pin a key (an open expanded viewer). Returns the key that lost its pin when
 * the pin bound was reached, so the caller can surface a recovery action.
 */
export function pinRichViewKey(key: string): { release: () => void; displaced: string | null } {
  const existing = pinOrder.indexOf(key);
  if (existing >= 0) pinOrder.splice(existing, 1);
  pinOrder.push(key);
  let displaced: string | null = null;
  if (pinOrder.length > FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries)
    displaced = pinOrder.shift() ?? null;
  notifyPins();
  return {
    displaced,
    release: () => {
      const index = pinOrder.indexOf(key);
      if (index < 0) return;
      pinOrder.splice(index, 1);
      notifyPins();
    },
  };
}

function subscribePins(listener: () => void): () => void {
  pinListeners.add(listener);
  return () => {
    pinListeners.delete(listener);
  };
}

const readPinned = () => pinOrder.length > 0;

/** Whether any expanded viewer (a pinned view) is open in this window. */
export function useRichViewPinned(): boolean {
  return useSyncExternalStore(subscribePins, readPinned, readPinned);
}

/**
 * Drop every entry of a deleted environment. Keys are encoded tuples whose
 * third element is the environment id (see `rich-identity.ts`).
 */
export function clearRichViewEnvironment(environmentId: string): void {
  const fragment = `,${JSON.stringify(environmentId)},`;
  const state = useRichContentViewStore.getState();
  const prefixes = Array.from(state.entries.keys()).filter((key) => {
    const head = key.indexOf(",");
    const second = head >= 0 ? key.indexOf(",", head + 1) : -1;
    return second >= 0 && key.startsWith(fragment, second);
  });
  if (prefixes.length > 0) state.clearPrefixes(prefixes);
}

export function richViewStoreStats(): { entries: number; mounted: number; pinned: number } {
  return {
    entries: useRichContentViewStore.getState().entries.size,
    mounted: mountCounts.size,
    pinned: pinOrder.length,
  };
}

/**
 * Read and write one field of a block's view state with a narrow selector, so
 * a row re-renders only when its own field changes.
 */
export function useRichViewField<K extends keyof RichViewState>(
  key: string,
  field: K,
  fallback: NonNullable<RichViewState[K]>,
): readonly [NonNullable<RichViewState[K]>, (value: RichViewState[K]) => void] {
  useEffect(() => retainRichViewKey(key), [key]);
  const value = useRichContentViewStore((state) => state.entries.get(key)?.[field]);
  const update = useRichContentViewStore((state) => state.update);
  const setValue = useCallback(
    (next: RichViewState[K]) => update(key, { [field]: next } as Partial<RichViewState>),
    [field, key, update],
  );
  return [(value ?? fallback) as NonNullable<RichViewState[K]>, setValue] as const;
}
