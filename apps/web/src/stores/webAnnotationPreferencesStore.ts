import { create } from "zustand";
import { persist } from "zustand/middleware";
import { COMMAND_STORAGE_NODE, nodeStorageKey } from "@/lib/persistence-keys";

/** Environments whose remembered destination is kept (oldest dropped first). */
export const MAX_REMEMBERED_DESTINATIONS = 50;

interface RememberedDestination {
  environmentId: string;
  /** Backend tab identity of the native-agent session last chosen. */
  tabId: string;
  updatedAt: number;
}

interface WebAnnotationPreferencesState {
  destinations: RememberedDestination[];
  rememberDestination: (environmentId: string, tabId: string) => void;
  forgetDestination: (environmentId: string) => void;
}

/**
 * Durable renderer UI preference: the agent session last chosen for web
 * annotation requests, per environment. It only preselects a destination;
 * nothing is ever sent because a preference exists.
 */
export const useWebAnnotationPreferencesStore = create<WebAnnotationPreferencesState>()(
  persist(
    (set) => ({
      destinations: [],
      rememberDestination: (environmentId, tabId) =>
        set((state) => ({
          destinations: [
            ...state.destinations
              .filter((entry) => entry.environmentId !== environmentId)
              .slice(-(MAX_REMEMBERED_DESTINATIONS - 1)),
            { environmentId, tabId, updatedAt: Date.now() },
          ],
        })),
      forgetDestination: (environmentId) =>
        set((state) => ({
          destinations: state.destinations.filter((entry) => entry.environmentId !== environmentId),
        })),
    }),
    {
      // The command node until this store is scoped (plan items 3006, 3007, 3012).
      name: nodeStorageKey("web-annotation-preferences", COMMAND_STORAGE_NODE),
      partialize: (state) => ({ destinations: state.destinations }),
    },
  ),
);

export function rememberedDestinationTabId(environmentId: string): string | null {
  return (
    useWebAnnotationPreferencesStore
      .getState()
      .destinations.find((entry) => entry.environmentId === environmentId)?.tabId ?? null
  );
}
