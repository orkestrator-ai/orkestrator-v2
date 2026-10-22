import { Layers, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALL_MACHINES, connectivitySummary, type MachineView } from "@/lib/federation/aggregate";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { CommandNodeMenuSection } from "./CommandNodeMenu";
import { useFederation } from "./FederationProvider";
import { MachineDot, machineStatusText } from "./MachineDot";

/**
 * The sidebar's machine filter. "All machines" is the default. Changing the
 * filter changes what the sidebar shows — never which machines are
 * connected, and never which machine the window works on or a running action
 * belongs to. Below the filters, the command node this client is connected
 * to, with the switch to another.
 */
export function MachinesFilter({ machines }: { machines: readonly MachineView[] }) {
  const filter = useMachineViewStore((state) => state.machineFilter);
  const setFilter = useMachineViewStore((state) => state.setMachineFilter);
  const selected = machines.find((machine) => machine.connectionId === filter) ?? null;
  const effectiveFilter = selected ? filter : ALL_MACHINES;
  const summary = connectivitySummary(machines);
  const commandNodeId = useFederation().portalState.selfId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 max-w-[14rem] justify-start gap-1.5 px-2 text-sm font-semibold"
          aria-label={`Machines: ${selected ? selected.name : "All machines"}. ${summary.label}`}
          data-testid="machines-filter"
        >
          {selected ? (
            <MachineDot colorToken={selected.colorToken} machineName={selected.name} />
          ) : (
            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{selected ? selected.name : "All machines"}</span>
          <span
            className="shrink-0 font-mono text-[10px] font-normal tabular-nums text-muted-foreground"
            data-testid="machines-connectivity"
          >
            {summary.connected}/{summary.total}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {summary.label}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={effectiveFilter} onValueChange={setFilter}>
          <DropdownMenuRadioItem value={ALL_MACHINES}>
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            All machines
          </DropdownMenuRadioItem>
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
              <DropdownMenuRadioItem
                key={machine.connectionId}
                value={machine.connectionId}
                aria-label={`${machine.name}, ${status}`}
              >
                <MachineDot
                  colorToken={machine.colorToken}
                  machineName={machine.name}
                  status={status}
                />
                <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{status}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
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
