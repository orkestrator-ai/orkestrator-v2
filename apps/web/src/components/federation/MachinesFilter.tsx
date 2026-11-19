import { Layers, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  connectivitySummary,
  isMachineFilterActive,
  setMachineShownInFilter,
  shownMachineIds,
  type MachineView,
} from "@/lib/federation/aggregate";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { CommandNodeMenuSection } from "./CommandNodeMenu";
import { useFederation } from "./FederationProvider";
import { MachineDot, machineStatusText } from "./MachineDot";

/**
 * The sidebar's machine filter. "All machines" is the default. The machine
 * tiles set the same filter (`machineFilter`), so both always show the same
 * selection: the trigger reads "2/7" while two of seven machines are shown,
 * and each machine is a checkbox. Changing the filter changes what the
 * sidebar shows — never which machines are connected, and never which
 * machine the window works on or a running action belongs to. Below the
 * filters, the command node this client is connected to, with the switch to
 * another.
 */
export function MachinesFilter({ machines }: { machines: readonly MachineView[] }) {
  const filter = useMachineViewStore((state) => state.machineFilter);
  const setFilter = useMachineViewStore((state) => state.setMachineFilter);
  const filtered = isMachineFilterActive(machines, filter);
  const shown = shownMachineIds(machines, filter);
  const selectedMachines = filtered
    ? machines.filter((machine) => shown.has(machine.connectionId))
    : [];
  const selected = selectedMachines.length === 1 ? selectedMachines[0]! : null;
  const title = !filtered
    ? "All machines"
    : selected
      ? selected.name
      : `${selectedMachines.length} machines`;
  const summary = connectivitySummary(machines);
  const commandNodeId = useFederation().portalState.selfId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 max-w-[14rem] justify-start gap-1.5 px-2 text-sm font-semibold"
          aria-label={`Machines: ${title}${
            filtered ? `, ${selectedMachines.length} of ${machines.length} shown` : ""
          }. ${summary.label}`}
          data-testid="machines-filter"
        >
          {selected ? (
            <MachineDot colorToken={selected.colorToken} machineName={selected.name} />
          ) : (
            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{title}</span>
          {filtered ? (
            <span
              className="shrink-0 font-mono text-[10px] font-normal tabular-nums text-foreground"
              data-testid="machines-selection"
            >
              {selectedMachines.length}/{machines.length}
            </span>
          ) : (
            <span
              className="shrink-0 font-mono text-[10px] font-normal tabular-nums text-muted-foreground"
              data-testid="machines-connectivity"
            >
              {summary.connected}/{summary.total}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {summary.label}
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={!filtered}
          onCheckedChange={() => setFilter([])}
          onSelect={(event) => event.preventDefault()}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          All machines
        </DropdownMenuCheckboxItem>
        {machines.map((machine) => {
          const status = machine.bound
            ? "This window"
            : machine.connectionId === commandNodeId
              ? "Command node"
              : machineStatusText({
                  transport: machine.transport,
                  freshness: machine.freshness,
                  loadedAt: machine.loadedAt,
                });
          return (
            <DropdownMenuCheckboxItem
              key={machine.connectionId}
              checked={filtered && shown.has(machine.connectionId)}
              // Kept open so several machines can be picked in turn.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                setFilter(
                  filtered
                    ? setMachineShownInFilter(machines, filter, machine.connectionId, checked)
                    : [machine.connectionId],
                )
              }
              aria-label={`${machine.name}, ${status}`}
            >
              <MachineDot
                colorToken={machine.colorToken}
                machineName={machine.name}
                status={status}
              />
              <span className="min-w-0 flex-1 truncate">{machine.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{status}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <CommandNodeMenuSection />
        <DropdownMenuItem onSelect={() => requestGlobalSettings("machines")}>
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Manage machines…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
