import { useEffect, useRef } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "zustand";
import { toast } from "sonner";
import type { BackendId } from "@orkestrator/protocol/federation";
import { formatSampleTime } from "@/hooks/useSystemUsage";
import {
  isMachineFilterActive,
  shownMachineIds,
  toggleMachineFilter,
  type MachineView,
} from "@/lib/federation/aggregate";
import {
  currencyDescription,
  currencyOffersUpdate,
  machineViewCurrency,
} from "@/lib/federation/fleet-currency";
import { machineInitials } from "@/lib/federation/machine-initials";
import { machineTileClasses } from "@/lib/federation/machine-colors";
import { arrangeMachines } from "@/lib/federation/sidebar-layout";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { updatePortalLayout, usePortalLayout } from "@/lib/portal/portal-layout";
import { portalStore } from "@/lib/portal/portal-store";
import { cn } from "@/lib/utils";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useFederation } from "./FederationProvider";
import { machineStatusText } from "./MachineDot";
import { useMachineCpu, useMachineScopeLookup } from "./MachineCpuReadings";

const TILE_DRAG_PREFIX = "machine-tile:";

/**
 * One rounded square per machine, in machine order, between the search bar
 * and the list (design EL01): the machine's colour with its initials over a
 * darker shade with its CPU. The tiles are the machine filter's other face
 * (`machineFilter`, which the machines menu also sets): with every machine
 * shown a click shows only that machine, after that a click adds or removes
 * one, and removing the last one shows them all again. Dragging a tile
 * reorders the machines (`PortalLayout.machineOrder`); a press that moves
 * less than 8 px is a click, never a drag.
 */
export function MachineTiles({ machines }: { machines: readonly MachineView[] }) {
  const filter = useMachineViewStore((state) => state.machineFilter);
  const setMachineFilter = useMachineViewStore((state) => state.setMachineFilter);
  const { portalState } = useFederation();
  const layout = usePortalLayout();
  const scopeOf = useMachineScopeLookup();
  // No keyboard sensor: Space and Enter toggle a tile. Keyboard users reorder
  // machines in Settings → Machines.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  if (machines.length === 0) return null;
  const filtered = isMachineFilterActive(machines, filter);
  const shown = shownMachineIds(machines, filter);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const machineOrder = arrangeMachines(
      machines,
      machines,
      layout,
      portalState.selfId,
      String(active.id).slice(TILE_DRAG_PREFIX.length),
      String(over.id).slice(TILE_DRAG_PREFIX.length),
    );
    if (machineOrder)
      updatePortalLayout({ machineOrder }).catch((error: unknown) =>
        toast.error("Could not save the machine order", {
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext
        items={machines.map((machine) => `${TILE_DRAG_PREFIX}${machine.connectionId}`)}
        strategy={horizontalListSortingStrategy}
      >
        <div
          role="group"
          aria-label="Machines shown in the list"
          data-testid="machine-tiles"
          data-filtered={filtered || undefined}
          className="flex flex-wrap gap-1.5 border-b border-border/50 px-2.5 py-2"
        >
          {machines.map((machine) => (
            <MachineTile
              key={machine.connectionId}
              machine={machine}
              scope={scopeOf(machine)}
              state={!filtered ? "all" : shown.has(machine.connectionId) ? "selected" : "faded"}
              onToggle={() =>
                setMachineFilter(toggleMachineFilter(machines, filter, machine.connectionId))
              }
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function MachineTile({
  machine,
  scope,
  state,
  onToggle,
}: {
  machine: MachineView;
  scope: NodeScope | null;
  /** Every machine shown; this one picked by the filter; or filtered out. */
  state: "all" | "selected" | "faded";
  onToggle: () => void;
}) {
  const connected = machine.bound || machine.transport === "connected";
  const { cpu, sampledAt } = useMachineCpu({
    nodeId: machine.backendId as BackendId,
    bound: machine.bound,
    connected,
    scope,
  });
  const commandRelease = useStore(portalStore.store, (portal) => portal.commandRelease);
  const currency = machineViewCurrency(machine, { commandRelease });
  // Only the pointer listeners: the sortable's keyboard attributes would
  // rename the toggle a "sortable" and take Space and Enter from it.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${TILE_DRAG_PREFIX}${machine.connectionId}`,
  });
  // The click that ends a drag must not also toggle the filter.
  const suppressClick = useRef(false);
  useEffect(() => {
    if (isDragging) {
      suppressClick.current = true;
      return;
    }
    if (!suppressClick.current) return;
    const timer = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [isDragging]);

  const colors = machineTileClasses(machine.colorToken);
  const reading = cpu === null ? "—" : `${Math.round(cpu)}%`;
  const status = machine.bound
    ? "This window"
    : machineStatusText({
        transport: machine.transport,
        freshness: machine.freshness,
        loadedAt: machine.loadedAt,
      });
  const shown = state !== "faded";
  const sampleTime = cpu === null ? null : formatSampleTime(sampledAt);
  const label = [
    machine.name,
    `CPU ${cpu === null ? "unavailable" : reading}`,
    ...(connected ? [] : [status]),
    shown ? "shown" : "hidden",
  ].join(", ");
  const tooltip = [
    `${machine.name} · ${status}`,
    `CPU ${cpu === null ? "unavailable" : reading}${sampleTime ? ` (sampled at ${sampleTime})` : ""}`,
    ...(currency ? [currencyDescription(machine.name, currency)] : []),
    shown ? "Shown in the list. Click to change." : "Hidden from the list. Click to show.",
  ].join("\n");
  const dimmed = cpu === null;

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      type="button"
      aria-pressed={shown}
      aria-label={label}
      title={tooltip}
      data-testid="machine-tile"
      data-machine={machine.connectionId}
      data-machine-color={machine.colorToken ?? "neutral"}
      data-state={state}
      data-dimmed={dimmed || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={() => {
        if (suppressClick.current) return;
        onToggle();
      }}
      className={cn(
        "relative flex size-10 shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg outline-none transition-[opacity,filter,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
        "forced-colors:border forced-colors:border-[CanvasText]",
        state === "selected" && "ring-2 ring-foreground/85 ring-offset-2 ring-offset-sidebar",
        state === "faded" && "opacity-40 brightness-50 saturate-50",
        state !== "faded" && dimmed && "opacity-55",
        isDragging && "z-50 cursor-grabbing opacity-70",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-1/2 items-center justify-center font-mono text-[11px] leading-none font-bold tracking-tight text-zinc-950",
          colors.top,
        )}
      >
        {machineInitials(machine.name)}
      </span>
      <span
        aria-hidden="true"
        data-testid="machine-tile-cpu"
        className={cn(
          "flex h-1/2 items-center justify-center font-mono text-[10px] leading-none text-white tabular-nums",
          colors.bottom,
        )}
      >
        {reading}
      </span>
      {currency && currencyOffersUpdate(currency) ? (
        <span
          aria-hidden="true"
          data-testid="machine-tile-update"
          className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-300 ring-1 ring-zinc-950"
        />
      ) : null}
    </button>
  );
}
