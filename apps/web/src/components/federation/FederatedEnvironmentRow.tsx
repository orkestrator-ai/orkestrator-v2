import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useState } from "react";
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
import {
  FEDERATED_LINK_PARAM,
  encodeResourceLink,
  type EnvironmentRef,
} from "@orkestrator/protocol/federation";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import {
  deleteFederatedEnvironment,
  startFederatedEnvironment,
  stopFederatedEnvironment,
} from "@/lib/federation/federated-actions";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { cn } from "@/lib/utils";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores";
import { useFederation } from "./FederationProvider";
import { MachineBadge, MachineDot, machineStatusText } from "./MachineDot";

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
  const { portal } = useFederation();
  const compact = useMachineViewStore((state) => state.compactMachineLabels);
  const openPanel = openMachineWorkspace;
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectProjectAndEnvironment = useUIStore((state) => state.selectProjectAndEnvironment);
  const [pendingDelete, setPendingDelete] = useState<EnvironmentRef | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = isMachineWritable(machine);
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

  const open = () => {
    if (machine.bound) {
      selectProjectAndEnvironment(environment.projectId, environment.ref.environmentId);
      return;
    }
    openPanel({
      connectionId: machine.connectionId,
      projectId: environment.projectId,
      environmentId: environment.ref.environmentId,
      title: environment.name,
    });
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (error instanceof OutcomeUnknownError) {
        toast.warning(`${label}: outcome unknown on ${machine.name}`, {
          description: error.message,
        });
      } else {
        toast.error(`${label} failed on ${machine.name}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setBusy(false);
    }
  };

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
            <DropdownMenuItem
              onSelect={() => {
                // A machine-qualified link: machine identity plus resource, never a
                // route, forwarded port or credential.
                const url = new URL(window.location.href);
                url.search = "";
                url.hash = "";
                url.searchParams.set(FEDERATED_LINK_PARAM, encodeResourceLink(environment.ref));
                const text = url.toString();
                const write =
                  window.orkestrator?.clipboard?.writeText(text) ??
                  navigator.clipboard?.writeText(text);
                void Promise.resolve(write).then(
                  () =>
                    toast.success("Copied link", {
                      description: `${environment.name} on ${machine.name}`,
                    }),
                  () => toast.error("Could not copy the link"),
                );
              }}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!writable || busy}
              onSelect={() => {
                const ref = environment.ref;
                void run("Start", () => startFederatedEnvironment(portal, ref));
              }}
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Start
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy}
              onSelect={() => {
                const ref = environment.ref;
                void run("Stop", () => stopFederatedEnvironment(portal, ref));
              }}
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!writable || busy}
              className="text-destructive focus:text-destructive"
              onSelect={() => setPendingDelete(environment.ref)}
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
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{environment.name}” on {machine.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the environment on <strong>{machine.name}</strong>, including its
              container, storage and recovery copies. Environments on other machines are not
              affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                // The reference captured when the dialog opened, whatever is focused now.
                const ref = pendingDelete;
                setPendingDelete(null);
                if (ref) void run("Delete", () => deleteFederatedEnvironment(portal, ref));
              }}
            >
              Delete on {machine.name}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
