import type { ContextItem } from "@orkestrator/protocol/rich-interactions";
import { defineScopedStore, scopedStoreHook } from "@/lib/node-scope/scoped-store";

/**
 * The visible context tray (feature 15): references the person collected for
 * their next request, per conversation (`environmentId\0logicalSessionKey`) on
 * the node that runs it. Collecting, previewing and reordering are local and
 * cost no model call; nothing here is sent until the person sends the tray.
 * Kept in the node scope so switching environments and returning restores
 * each conversation's own tray.
 */
export interface ContextTrayState {
  trays: Map<string, ContextItem[]>;
  add: (key: string, item: ContextItem) => void;
  update: (key: string, itemId: string, patch: Partial<ContextItem>) => void;
  remove: (key: string, itemId: string) => void;
  move: (key: string, itemId: string, delta: -1 | 1) => void;
  clear: (key: string) => void;
}

export const CONTEXT_TRAY_MAX_ITEMS = 40;

export function contextTrayKey(environmentId: string, logicalSessionKey: string): string {
  return `${environmentId}\0${logicalSessionKey}`;
}

export const contextTrayStore = defineScopedStore<ContextTrayState>("context-tray", () => (set) => ({
  trays: new Map(),
  add: (key, item) =>
    set((state) => {
      const items = state.trays.get(key) ?? [];
      if (items.length >= CONTEXT_TRAY_MAX_ITEMS || items.some((existing) => existing.itemId === item.itemId)) return state;
      const trays = new Map(state.trays);
      trays.set(key, [...items, item]);
      return { trays };
    }),
  update: (key, itemId, patch) =>
    set((state) => {
      const items = state.trays.get(key);
      if (!items) return state;
      const trays = new Map(state.trays);
      trays.set(key, items.map((item) => (item.itemId === itemId ? { ...item, ...patch, itemId } : item)));
      return { trays };
    }),
  remove: (key, itemId) =>
    set((state) => {
      const items = state.trays.get(key);
      if (!items) return state;
      const trays = new Map(state.trays);
      trays.set(key, items.filter((item) => item.itemId !== itemId));
      return { trays };
    }),
  move: (key, itemId, delta) =>
    set((state) => {
      const items = [...(state.trays.get(key) ?? [])];
      const index = items.findIndex((item) => item.itemId === itemId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= items.length) return state;
      [items[index], items[target]] = [items[target]!, items[index]!];
      const trays = new Map(state.trays);
      trays.set(key, items);
      return { trays };
    }),
  clear: (key) =>
    set((state) => {
      if (!state.trays.has(key)) return state;
      const trays = new Map(state.trays);
      trays.delete(key);
      return { trays };
    }),
}));

export const useContextTrayStore = scopedStoreHook(contextTrayStore);
