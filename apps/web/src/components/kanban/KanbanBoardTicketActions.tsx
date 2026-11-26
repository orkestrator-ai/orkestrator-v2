import { useState } from "react";
import { toast } from "sonner";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
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
import { buttonVariants } from "@/components/ui/button";
import { BuildLaunchDialog, type BuildLaunchSelection } from "@/components/build/BuildLaunchDialog";
import { useBuildLaunchMachines } from "@/components/build/build-machines";
import { useBuildLaunchOptions } from "@/hooks/useBuildLaunchOptions";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { useLocalEnvironmentAvailable } from "@/hooks/useLocalEnvironmentAvailable";
import type { KanbanTask } from "@/stores/kanbanStore";
import { kanbanBuildStartOptions } from "./kanban-build-start";

const log = createLogger("web.kanban");

/**
 * Build… from a card's right-click menu: the same launcher, "Environment
 * already exists" confirmation and start as the ticket dialog's Build…, without
 * opening the ticket first. `task` is the ticket being launched, or null.
 */
export function KanbanCardBuildLauncher({
  projectId,
  task,
  onClose,
}: {
  projectId: string;
  task: KanbanTask | null;
  onClose: () => void;
}) {
  const { startBuild } = useBuildPipeline();
  const localEnvironmentAvailable = useLocalEnvironmentAvailable(projectId);
  const machines = useBuildLaunchMachines(projectId);
  const { catalog, defaults } = useBuildLaunchOptions(projectId, task !== null);
  const [busy, setBusy] = useState(false);
  // Held rather than started at once: a ticket that already owns an
  // environment asks first, and the answer must keep the launcher's choices.
  const [confirmSelection, setConfirmSelection] = useState<{
    task: KanbanTask;
    selection: BuildLaunchSelection;
  } | null>(null);

  const start = async (target: KanbanTask, selection: BuildLaunchSelection) => {
    setBusy(true);
    try {
      await startBuild(
        target,
        selection.environmentType,
        selection.steps.build.agent,
        kanbanBuildStartOptions(selection),
      );
    } catch (error) {
      // The hook reports its own failures; this covers a throw it did not.
      log.error("build.start-failed", { taskId: target.id, error: formatLogError(error) });
      toast.error("Failed to start build");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = (selection: BuildLaunchSelection) => {
    if (!task) return;
    const target = task;
    onClose();
    if (target.environmentId) {
      setConfirmSelection({ task: target, selection });
      return;
    }
    void start(target, selection);
  };

  return (
    <>
      <BuildLaunchDialog
        open={task !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        catalog={catalog}
        busy={busy}
        machines={machines}
        localEnvironmentAvailable={localEnvironmentAvailable}
        deliveryPolicy={task?.sections.delivery?.policy}
        {...defaults}
        onConfirm={handleConfirm}
      />
      <AlertDialog
        open={confirmSelection !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmSelection(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Environment already exists</AlertDialogTitle>
            <AlertDialogDescription>
              This task already has an environment linked to it. Starting a new build will create an
              additional environment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmSelection) void start(confirmSelection.task, confirmSelection.selection);
                setConfirmSelection(null);
              }}
            >
              Start build
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Delete… from a card's right-click menu: confirms, then removes the ticket from the board. */
export function KanbanCardDeleteConfirm({
  task,
  buildRunning,
  onCancel,
  onConfirm,
}: {
  task: KanbanTask | null;
  /** The ticket's build is still running; deleting the ticket does not stop it. */
  buildRunning: boolean;
  onCancel: () => void;
  onConfirm: (task: KanbanTask) => void;
}) {
  return (
    <AlertDialog
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this ticket?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{task?.title}</span> and its comments and
            images will be removed from the board. Its environment, branch and pull request are
            kept.
            {buildRunning && (
              <span className="mt-2 block">
                Its build is still running and carries on until you stop it.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={() => {
              if (task) onConfirm(task);
            }}
          >
            Delete ticket
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
