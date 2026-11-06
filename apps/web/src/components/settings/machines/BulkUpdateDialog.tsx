import { useEffect, useRef, useState } from "react";
import type { HostRestartImpact } from "@orkestrator/protocol/host-maintenance";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import { describeRestartImpact, IDLE_WAITS } from "../HostUpdatesPanel";
import { machineMaintenanceClient } from "./machine-access";
import type { MachineEntry } from "./machine-list";
import { MachineStatusDot } from "./machine-ui";

export interface BulkUpdateChoice {
  whenIdle: boolean;
  maxWaitSeconds: number;
}

/**
 * Mounted only while open, so each opening reads what is running afresh.
 *
 * Confirms updating the ticked machines to the newest Orkestrator, showing
 * what is running on each so the restart's cost is visible before it starts.
 */
export function BulkUpdateDialog({
  machines,
  open,
  onOpenChange,
  onConfirm,
}: {
  machines: MachineEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (choice: BulkUpdateChoice) => void;
}) {
  const [whenIdle, setWhenIdle] = useState(false);
  const [maxWait, setMaxWait] = useState<number>(3_600);
  // Undefined while reading, null when the machine could not say.
  const [impacts, setImpacts] = useState<Record<string, HostRestartImpact | null>>({});

  // The list is rebuilt on every render; its keys say when it really changed.
  const signature = machines.map((machine) => machine.key).join(",");
  const targets = useRef(machines);
  useEffect(() => {
    targets.current = machines;
  });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    for (const machine of targets.current) {
      const client = machineMaintenanceClient(machine);
      if (!client) continue;
      client.getHostRestartImpact().then(
        (impact) =>
          !cancelled && setImpacts((previous) => ({ ...previous, [machine.key]: impact })),
        () => !cancelled && setImpacts((previous) => ({ ...previous, [machine.key]: null })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [open, signature]);

  const count = machines.length;
  const includesThisWindow = machines.some((machine) => machine.role === "self");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Update {count === 1 ? machines[0]?.name : `${count} machines`} to the latest
            Orkestrator?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Each machine checks for the newest release on its update channel, downloads it and
            restarts Orkestrator to install it: the desktop app where it runs one, otherwise its
            backend service. Restarting ends agent turns and terminals running there; containers
            keep running. Machines already on the newest release are left alone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4 text-sm">
          <ul
            className="divide-y divide-border/60 rounded-md border border-border/60"
            data-testid="bulk-update-machines"
          >
            {machines.map((machine) => {
              const impact = impacts[machine.key];
              return (
                <li key={machine.key} className="flex gap-2.5 px-3 py-2">
                  <MachineStatusDot
                    colorToken={machine.colorToken}
                    connected={machine.connected}
                    label={machine.name}
                    decorative
                    className="mt-1.5"
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{machine.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {impact === undefined
                        ? "Checking what is running…"
                        : impact === null
                          ? "Could not read what is running"
                          : describeRestartImpact(impact)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          {includesThisWindow ? (
            <p className="text-xs text-muted-foreground">
              This window&apos;s machine is asked last. The page reconnects when it is back.
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="bulk-update-when-idle" className="text-sm font-normal">
              Wait until no agent or pipeline is running
            </Label>
            <Switch id="bulk-update-when-idle" checked={whenIdle} onCheckedChange={setWhenIdle} />
          </div>
          {whenIdle && (
            <div className="flex items-center justify-between gap-4">
              <Label className="text-sm font-normal text-muted-foreground">
                Restart anyway after
              </Label>
              <Select value={String(maxWait)} onValueChange={(value) => setMaxWait(Number(value))}>
                <SelectTrigger className="w-36" aria-label="Restart anyway after">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                  {IDLE_WAITS.map((option) => (
                    <SelectItem key={option.seconds} value={String(option.seconds)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm({ whenIdle, maxWaitSeconds: maxWait })}
            disabled={count === 0}
          >
            {whenIdle ? "Update when idle" : count === 1 ? "Update" : `Update ${count} machines`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
