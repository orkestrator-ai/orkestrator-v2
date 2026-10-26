import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { requestCloseGlobalSettings } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import type { OutdatedEnvironment } from "../HostDependencySettings";
import { HostUpdatesPanel } from "../HostUpdatesPanel";
import { maintenanceIssues, type MachineEntry } from "./machine-list";
import { MachineStatusDot } from "./machine-ui";
import { useMachineMaintenance } from "./useMachineMaintenance";

/**
 * Orkestrator updates, agent tools, `gh` and the container image of one
 * machine. Requests go to that machine (through the command node for a
 * registered one) and its host applies them.
 */
export function MachineUpdatesDialog({
  machine,
  open,
  onOpenChange,
  initial,
  onSnapshot,
}: {
  machine: MachineEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: HostMaintenanceSnapshot | null;
  /** The list's update badge follows what this dialog reads. */
  onSnapshot: (key: string, snapshot: HostMaintenanceSnapshot) => void;
}) {
  const { client, snapshot, error, accept } = useMachineMaintenance(machine, { initial });
  useEffect(() => {
    if (snapshot) onSnapshot(machine.key, snapshot);
  }, [machine.key, onSnapshot, snapshot]);
  const issues = snapshot ? maintenanceIssues(snapshot) : [];
  // An environment on an older image is rebuilt one at a time, from its own
  // settings: Rebuild (keep work) reviews preservation and space for it.
  const nodeId = machine.role === "self" ? (machine.nodeId ?? "") : machine.nodeId;
  const rebuild =
    nodeId === null
      ? undefined
      : (environment: OutdatedEnvironment) => {
          onOpenChange(false);
          requestCloseGlobalSettings();
          openMachineWorkspace({
            connectionId: nodeId,
            projectId: environment.projectId,
            environmentId: environment.id,
            dialog: "environment-rebuild",
            title: environment.name,
          });
        };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:p-0 sm:max-w-[min(42rem,calc(100%-2rem))]",
          Z_FULLSCREEN_DIALOG,
        )}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <DialogHeader className="m-0 shrink-0 border-b border-zinc-800 px-6 pt-6 pb-4 sm:m-0">
          <DialogTitle className="flex items-center gap-2.5">
            <MachineStatusDot
              colorToken={machine.colorToken}
              connected={machine.connected}
              label={`${machine.name}: ${machine.statusText}`}
              decorative
            />
            <span className="min-w-0 break-all">Updates for {machine.name}</span>
          </DialogTitle>
          <DialogDescription>
            {issues.length > 0
              ? issues.join(" · ")
              : snapshot
                ? `Orkestrator ${snapshot.version} · everything reported is current`
                : "Reading the machine…"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="machine-updates">
          {client ? (
            <HostUpdatesPanel
              client={client}
              snapshot={snapshot}
              error={error}
              accept={accept}
              onRebuildEnvironment={rebuild}
            />
          ) : (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Waiting for {machine.name} to connect…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
