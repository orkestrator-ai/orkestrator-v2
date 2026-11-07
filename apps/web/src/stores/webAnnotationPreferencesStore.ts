import type { StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { nodeStorageKey } from "@/lib/persistence-keys";

/** Environments whose remembered destination is kept (oldest dropped first). */
export const MAX_REMEMBERED_DESTINATIONS = 50;

interface RememberedDestination {
  environmentId: string;
  /** Backend tab identity of the native-agent session last chosen. */
  tabId: string;
  updatedAt: number;
}

export interface WebAnnotationPreferencesState {
  destinations: RememberedDestination[];
  rememberDestination: (environmentId: string, tabId: string) => void;
  forgetDestination: (environmentId: string) => void;
}

/**
 * Durable renderer UI preference: the agent session last chosen for web
 * annotation requests, per environment. It only preselects a destination;
 * nothing is ever sent because a preference exists. Kept per node (plan item
 * 3012): an environment id and a tab identity belong to their node, so each
 * node scope persists under its own key (`nodeStorageKey`; the command node
 * keeps today's key).
 */
export const webAnnotationPreferencesStore = defineScopedStore<WebAnnotationPreferencesState>(
  "web-annotation-preferences",
  (scope) => {
    const creator: StateCreator<
      WebAnnotationPreferencesState,
      [],
      [["zustand/persist", Pick<WebAnnotationPreferencesState, "destinations">]]
    > = persist(
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
            destinations: state.destinations.filter(
              (entry) => entry.environmentId !== environmentId,
            ),
          })),
      }),
      {
        name: nodeStorageKey("web-annotation-preferences", scope),
        partialize: (state) => ({ destinations: state.destinations }),
      },
    );
    // `persist` adds its `persist` API to the store; nothing here reads it.
    return creator as StateCreator<WebAnnotationPreferencesState>;
  },
);

/**
 * Reads the nearest node scope's remembered destinations; other code uses
 * `scope.store(webAnnotationPreferencesStore)`.
 */
export const useWebAnnotationPreferencesStore = scopedStoreHook(webAnnotationPreferencesStore);

/** The tab last chosen for `environmentId` on `scope`'s node (the app's command scope when omitted). */
export function rememberedDestinationTabId(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): string | null {
  return (
    scope
      .store(webAnnotationPreferencesStore)
      .getState()
      .destinations.find((entry) => entry.environmentId === environmentId)?.tabId ?? null
  );
}
