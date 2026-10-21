import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SidebarGrouping } from "@/lib/federation/aggregate";

/**
 * This client's cross-machine presentation: the machine filter and
 * grouping. It is client-local by design — filters are not backend state —
 * and every entry names a machine by its identity, never by a route or
 * forwarded port. Hiding a machine or changing the filter is presentation
 * only: it never stops an agent or touches a backend.
 */

interface MachineViewState {
  /** `"all"` or a machine identity. Filters presentation, never connections. */
  machineFilter: string;
  grouping: Exclude<SidebarGrouping, "activity">;
  /** Show just the dot (plus tooltip) instead of the machine name label. */
  compactMachineLabels: boolean;
  setMachineFilter: (filter: string) => void;
  setGrouping: (grouping: Exclude<SidebarGrouping, "activity">) => void;
  setCompactMachineLabels: (compact: boolean) => void;
}

export const useMachineViewStore = create<MachineViewState>()(
  persist(
    (set) => ({
      machineFilter: "all",
      grouping: "machine",
      compactMachineLabels: false,
      setMachineFilter: (machineFilter) => set({ machineFilter }),
      setGrouping: (grouping) => set({ grouping }),
      setCompactMachineLabels: (compactMachineLabels) => set({ compactMachineLabels }),
    }),
    {
      name: "machine-view-storage",
      partialize: (state) => ({
        machineFilter: state.machineFilter,
        grouping: state.grouping,
        compactMachineLabels: state.compactMachineLabels,
      }),
    },
  ),
);
