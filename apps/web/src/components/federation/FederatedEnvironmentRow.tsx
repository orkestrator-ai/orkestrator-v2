import { toast } from "sonner";
import {
  Bell,
  Link2,
  Loader2,
  MoreHorizontal,
  ExternalLink,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import { cn } from "@/lib/utils";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores";
import { MachineBadge, MachineDot, machineStatusText } from "./MachineDot";
import { useFederatedEnvironmentActions } from "./useFederatedEnvironmentActions";

const ACTIVITY_TEXT: Record<FederatedEnvironment["activity"], string> = {
  working: "Working",
  waiting: "Awaiting input",
  idle: "Idle",
};

/**
 * One environment in a multi-machine list. The coloured dot sits right
 * before the name and names the owner; activity is a separate label. A row
 * of this window's own machine selects it in place; a row of another
 * machine moves the window to that machine and opens it there. Actions carry the row's
 * captured reference, so a confirmation always names — and reaches — the
 * machine it was opened for.
 */
export function FederatedEnvironmentRow({
  machine,
  project,
  environment,
  showMachineLabel,
  indented = false,
}: {
  machine: MachineView;
  project: FederatedProject | null;
  environment: FederatedEnvironment;
  showMachineLabel: boolean;
  /** Nested under a project heading. */
  indented?: boolean;
}) {
  const compact = useMachineViewStore((state) => state.compactMachineLabels);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const { busy, writable, open, copyLink, start, stop, requestDelete, deleteDialog } =
    useFederatedEnvironmentActions(machine, environment);
  const live = machine.bound || machine.transport === "connected";
  const statusText = machine.bound
    ? "This window"
    : machineStatusText({
        transport: machine.transport,
        freshness: machine.freshness,
        loadedAt: machine.loadedAt,
      });
  const activityText = live
    ? ACTIVITY_TEXT[environment.activity]
    : `Connection lost; last observed ${ACTIVITY_TEXT[environment.activity].toLowerCase()}`;
  const selected = machine.bound && selectedEnvironmentId === environment.ref.environmentId;

  return (
    <div
      className={cn(
        "group mx-1 flex min-h-8 items-center gap-2 rounded-lg px-2 py-1",
        indented && "pl-9",
        selected ? "bg-selected text-selected-foreground" : "hover:bg-environment-hover",
        !live && "opacity-60",
      )}
      data-testid="federated-environment-row"
      data-machine={machine.connectionId}
      draggable={false}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={open}
        aria-label={`${environment.name}, on ${machine.name}, ${activityText}${
          project ? `, project ${project.name}` : ""
        }`}
        onDragStart={(event) => {
          event.preventDefault();
          toast.info("Environments belong to their machine", {
            description:
              "Moving work between machines isn't supported. Create a new environment on the other machine instead.",
          });
        }}
      >
        <MachineDot
          colorToken={machine.colorToken}
          machineName={machine.name}
          status={statusText}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{environment.name}</span>
          {project || showMachineLabel ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              {showMachineLabel ? (
                compact ? null : (
                  <span className="truncate">{machine.name}</span>
                )
              ) : null}
              {project && showMachineLabel && !compact ? <span aria-hidden="true">·</span> : null}
              {project ? <span className="truncate">{project.name}</span> : null}
            </span>
          ) : null}
        </span>
        {environment.hasUnreadWork ? (
          <Bell className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
        ) : null}
        <span
          className={cn(
            "shrink-0 text-[11px]",
            environment.activity === "waiting" && live ? "text-amber-400" : "text-muted-foreground",
          )}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : live ? (
            ACTIVITY_TEXT[environment.activity]
          ) : (
            "Unavailable"
          )}
        </span>
      </button>
      {!machine.bound ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 data-[state=open]:opacity-100"
              aria-label={`Actions for ${environment.name} on ${machine.name}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <MachineBadge colorToken={machine.colorToken} machineName={machine.name} />
              <span>· {statusText}</span>
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={open}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={copyLink}>
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!writable || busy} onSelect={start}>
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Start
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!writable || busy} onSelect={stop}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy}
              className="text-destructive focus:text-destructive"
              onSelect={requestDelete}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete…
            </DropdownMenuItem>
            {!writable ? (
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                {machine.name} is unavailable; actions are disabled until it reconnects.
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {deleteDialog}
    </div>
  );
}
