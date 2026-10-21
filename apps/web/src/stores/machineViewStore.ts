import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SidebarGrouping } from "@/lib/federation/aggregate";

/**
 * This client's cross-machine presentation: the machine filter, grouping
 * and the outer layout of machine panels. It is client-local by design —
 * filters and layout are not backend state — and every entry names a
 * machine by its saved connection, never by a route or forwarded port.
 * Hiding a machine, changing the filter or closing a panel is presentation
 * only: it never stops an agent or touches a backend.
 */

export interface MachinePanelSpec {
  /** Client-local ID of this outer panel. */
  id: string;
  connectionId: string;
  projectId: string;
  environmentId?: string;
  /** Last known title, for the panel header while it loads. */
  title: string;
}

export const MAX_MACHINE_PANELS = 4;

interface MachineViewState {
  /** `"all"` or a saved connection ID. Filters presentation, never connections. */
  machineFilter: string;
  grouping: Exclude<SidebarGrouping, "activity">;
  /** Show just the dot (plus tooltip) instead of the machine name label. */
  compactMachineLabels: boolean;
  panels: MachinePanelSpec[];
  focusedPanelId: string | null;
  setMachineFilter: (filter: string) => void;
  setGrouping: (grouping: Exclude<SidebarGrouping, "activity">) => void;
  setCompactMachineLabels: (compact: boolean) => void;
  /** Open (or focus) a panel for an environment of another machine. */
  openPanel: (spec: Omit<MachinePanelSpec, "id">) => string;
  closePanel: (panelId: string) => void;
  focusPanel: (panelId: string | null) => void;
  /** A machine was forgotten on this device: its panels go too. */
  closePanelsFor: (connectionId: string) => void;
}

let nextPanelId = 1;

export const useMachineViewStore = create<MachineViewState>()(
  persist(
    (set, get) => ({
      machineFilter: "all",
      grouping: "machine",
      compactMachineLabels: false,
      panels: [],
      focusedPanelId: null,
      setMachineFilter: (machineFilter) => set({ machineFilter }),
      setGrouping: (grouping) => set({ grouping }),
      setCompactMachineLabels: (compactMachineLabels) => set({ compactMachineLabels }),
      openPanel: (spec) => {
        const existing = get().panels.find(
          (panel) =>
            panel.connectionId === spec.connectionId &&
            panel.projectId === spec.projectId &&
            panel.environmentId === spec.environmentId,
        );
        if (existing) {
          set({ focusedPanelId: existing.id });
          return existing.id;
        }
        const id = `panel-${Date.now().toString(36)}-${nextPanelId++}`;
        set((state) => {
          const panels = [...state.panels, { ...spec, id }];
          // Bounded: the oldest panel closes first. Closing releases
          // observation only.
          return {
            panels: panels.slice(Math.max(0, panels.length - MAX_MACHINE_PANELS)),
            focusedPanelId: id,
          };
        });
        return id;
      },
      closePanel: (panelId) =>
        set((state) => ({
          panels: state.panels.filter((panel) => panel.id !== panelId),
          focusedPanelId: state.focusedPanelId === panelId ? null : state.focusedPanelId,
        })),
      focusPanel: (focusedPanelId) => set({ focusedPanelId }),
      closePanelsFor: (connectionId) =>
        set((state) => ({
          panels: state.panels.filter((panel) => panel.connectionId !== connectionId),
        })),
    }),
    {
      name: "machine-view-storage",
      partialize: (state) => ({
        machineFilter: state.machineFilter,
        grouping: state.grouping,
        compactMachineLabels: state.compactMachineLabels,
        panels: state.panels,
      }),
    },
  ),
);
