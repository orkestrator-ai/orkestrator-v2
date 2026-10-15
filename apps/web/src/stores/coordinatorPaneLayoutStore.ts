import { create } from "zustand";
import { persist } from "zustand/middleware";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import {
  sanitizeCoordinatorPaneLayout,
  type CoordinatorPaneLayout,
} from "@/lib/coordinator-pane-layout";

/** Projects whose coordinator tab groups are remembered (least recently used dropped first). */
export const MAX_REMEMBERED_COORDINATOR_LAYOUTS = 50;

interface RememberedLayout {
  projectId: string;
  layout: CoordinatorPaneLayout;
  updatedAt: number;
}

interface CoordinatorPaneLayoutState {
  layouts: RememberedLayout[];
  setLayout: (projectId: string, layout: CoordinatorPaneLayout) => void;
}

/**
 * Durable renderer UI preference: how each project's coordinator conversations
 * are grouped and split. Conversations themselves are backend-owned; a layout
 * naming a conversation that has since closed is reconciled away on render.
 */
export const useCoordinatorPaneLayoutStore = create<CoordinatorPaneLayoutState>()(
  persist(
    (set) => ({
      layouts: [],
      setLayout: (projectId, layout) =>
        set((state) => {
          if (state.layouts.find((entry) => entry.projectId === projectId)?.layout === layout) {
            return state;
          }
          return {
            layouts: [
              ...state.layouts
                .filter((entry) => entry.projectId !== projectId)
                .slice(-(MAX_REMEMBERED_COORDINATOR_LAYOUTS - 1)),
              { projectId, layout, updatedAt: Date.now() },
            ],
          };
        }),
    }),
    {
      name: desktopConnectionStorageKey("coordinator-pane-layouts"),
      partialize: (state) => ({ layouts: state.layouts }),
      merge: (persisted, current) => {
        const raw = (persisted as { layouts?: unknown } | undefined)?.layouts;
        const layouts = Array.isArray(raw)
          ? raw.slice(-MAX_REMEMBERED_COORDINATOR_LAYOUTS).flatMap((entry): RememberedLayout[] => {
              if (!entry || typeof entry !== "object") return [];
              const record = entry as Record<string, unknown>;
              const layout = sanitizeCoordinatorPaneLayout(record.layout);
              if (typeof record.projectId !== "string" || !layout) return [];
              return [
                {
                  projectId: record.projectId,
                  layout,
                  updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
                },
              ];
            })
          : [];
        return { ...current, layouts };
      },
    },
  ),
);

export function selectCoordinatorPaneLayout(projectId: string) {
  return (state: CoordinatorPaneLayoutState) =>
    state.layouts.find((entry) => entry.projectId === projectId)?.layout;
}
