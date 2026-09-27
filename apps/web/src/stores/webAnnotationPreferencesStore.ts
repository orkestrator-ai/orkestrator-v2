import { create } from "zustand";
import { persist } from "zustand/middleware";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";

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
      name: desktopConnectionStorageKey("web-annotation-preferences"),
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
