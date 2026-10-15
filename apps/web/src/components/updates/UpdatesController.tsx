import { useEffect, useMemo, useRef } from "react";
import { ArrowUpCircle, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { isTerminalUpdatePhase, OPEN_UPDATE_PANEL_EVENT } from "@orkestrator/protocol/updates";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listen } from "@/lib/native/events";
import { localUpdateTransport } from "@/lib/updates/update-client";
import { selectUpdateTarget, useUpdateStore } from "@/stores/updateStore";
import { UpdateDetails } from "./UpdateDetails";
import { indicatorState, remoteRequesterLabel } from "./update-text";
import { useUpdateTarget } from "./useUpdateTarget";

export const UPDATE_AVAILABLE_TOAST_ID = "orkestrator-update-available";
export const REMOTE_UPDATE_TOAST_ID = "orkestrator-remote-update";

/**
 * Keeps this app's update state fresh and owns its dialog: the title-bar
 * indicator, the menu's Check for Updates… and the availability toast all
 * open it. Mounted once at the app root.
 */
export function UpdatesController() {
  const transport = useMemo(() => localUpdateTransport(), []);
  const target = useUpdateTarget(transport);
  const open = useUpdateStore((state) => state.dialogOpen);
  const setOpen = useUpdateStore((state) => state.setDialogOpen);
  const announced = useRef<string | null>(null);
  const noticedJob = useRef<string | null>(null);
  const available = target.snapshot?.available;
  const job = target.snapshot?.job ?? null;
  const requestedBy =
    job && !isTerminalUpdatePhase(job.phase) ? remoteRequesterLabel(job.requester) : null;
  const canInstall = target.snapshot?.host.canInstall ?? false;
  const desktop = typeof window !== "undefined" && Boolean(window.orkestrator?.updates);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen(OPEN_UPDATE_PANEL_EVENT, () => setOpen(true))
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [setOpen]);

  useEffect(() => {
    if (!available || !canInstall || announced.current === available.version) return;
    announced.current = available.version;
    toast.info(`Orkestrator ${available.version} is available`, {
      id: UPDATE_AVAILABLE_TOAST_ID,
      description: "Review what it needs and install it.",
      duration: 15_000,
      action: { label: "Update", onClick: () => setOpen(true) },
    });
  }, [available, canInstall, setOpen]);

  // Someone elsewhere is updating this machine: whoever sits at it should know
  // why the app is about to restart.
  useEffect(() => {
    if (!job || !requestedBy || noticedJob.current === job.id) return;
    noticedJob.current = job.id;
    toast.warning(`Updating to ${job.target.version}`, {
      id: REMOTE_UPDATE_TOAST_ID,
      description:
        job.restartPolicy === "immediate"
          ? `Requested by ${requestedBy}. The app restarts as soon as the update is ready, which interrupts running agents.`
          : `Requested by ${requestedBy}. It installs the next time the app restarts.`,
      duration: 30_000,
      action: { label: "View", onClick: () => setOpen(true) },
    });
  }, [job, requestedBy, setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="update-dialog"
      >
        <DialogHeader>
          <DialogTitle>Orkestrator updates</DialogTitle>
          <DialogDescription>
            Updates are checked every six hours. Nothing is downloaded or installed until you
            approve it.
          </DialogDescription>
        </DialogHeader>
        <UpdateDetails target={target} scope="local" canInstallOnQuit={desktop} />
      </DialogContent>
    </Dialog>
  );
}

/** Title-bar entry point; renders nothing when there is nothing to do. */
export function UpdateIndicator() {
  const snapshot = useUpdateStore(selectUpdateTarget("local")).snapshot;
  const setOpen = useUpdateStore((state) => state.setDialogOpen);
  const state = indicatorState(snapshot);
  if (state.kind === "none") return null;
  const label =
    state.kind === "available"
      ? `Update to ${state.version}`
      : state.kind === "ready"
        ? "Restart to update"
        : state.kind === "working"
          ? `${state.label}${state.percent !== null ? ` ${state.percent}%` : ""}`
          : state.label;
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-7 gap-1.5 px-2 text-xs ${
        state.kind === "attention" ? "text-amber-300" : "text-cyan-300"
      }`}
      aria-label={label}
      title={label}
      data-testid="update-indicator"
      onClick={() => setOpen(true)}
    >
      {state.kind === "working" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state.kind === "attention" ? (
        <ShieldAlert className="h-3.5 w-3.5" />
      ) : (
        <ArrowUpCircle className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">
        {state.kind === "available" ? "Update" : state.kind === "ready" ? "Restart" : null}
      </span>
    </Button>
  );
}
