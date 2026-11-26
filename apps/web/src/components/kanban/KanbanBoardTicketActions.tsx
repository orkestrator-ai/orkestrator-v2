import { useEffect, useState } from "react";
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
import { useNodeScope } from "@/lib/node-scope/providers";
import { kanbanStore, useKanbanStore, type KanbanTask } from "@/stores/kanbanStore";
import { kanbanBuildStartOptions } from "./kanban-build-start";

const log = createLogger("web.kanban");

/**
 * Build… from a card's right-click menu: the same launcher, "Environment
 * already exists" confirmation and start as the ticket dialog's Build…, without
 * opening the ticket first. Both confirmations read the current ticket.
 */
export function KanbanCardBuildLauncher({
  projectId,
  taskId,
  onClose,
}: {
  projectId: string;
  taskId: string | null;
  onClose: () => void;
}) {
  const { startBuild } = useBuildPipeline();
  const tasks = useNodeScope().store(kanbanStore);
  const task = useKanbanStore((state) =>
    state.tasks.find((candidate) => candidate.id === taskId && candidate.projectId === projectId),
  );
  const localEnvironmentAvailable = useLocalEnvironmentAvailable(projectId);
  const machines = useBuildLaunchMachines(projectId);
  const { catalog, defaults } = useBuildLaunchOptions(projectId, task !== undefined);
  const [busy, setBusy] = useState(false);
  // Held rather than started at once: a ticket that already owns an
  // environment asks first, and the answer must keep the launcher's choices.
  const [confirmSelection, setConfirmSelection] = useState<{
    taskId: string;
    selection: BuildLaunchSelection;
  } | null>(null);
  const confirmationTaskExists = useKanbanStore((state) =>
    state.tasks.some(
      (candidate) => candidate.id === confirmSelection?.taskId && candidate.projectId === projectId,
    ),
  );
  const launcherTicketMissing = taskId !== null && task === undefined;
  const missingTicket =
    launcherTicketMissing || (confirmSelection !== null && !confirmationTaskExists);

  useEffect(() => {
    if (missingTicket) toast.error("This ticket was removed from the board");
    if (launcherTicketMissing) onClose();
  }, [launcherTicketMissing, missingTicket, onClose]);

  const findTask = (id: string) =>
    tasks
      .getState()
      .tasks.find((candidate) => candidate.id === id && candidate.projectId === projectId);

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
    if (!taskId) return;
    const target = findTask(taskId);
    onClose();
    if (!target) {
      toast.error("This ticket was removed from the board");
      return;
    }
    if (target.environmentId) {
      setConfirmSelection({ taskId: target.id, selection });
      return;
    }
    void start(target, selection);
  };

  return (
    <>
      <BuildLaunchDialog
        open={task !== undefined}
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
              {confirmationTaskExists
                ? "This task already has an environment linked to it. Starting a new build will create an additional environment."
                : "This ticket was removed from the board."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmSelection) return;
                const target = findTask(confirmSelection.taskId);
                setConfirmSelection(null);
                if (target) void start(target, confirmSelection.selection);
                else toast.error("This ticket was removed from the board");
              }}
              disabled={!confirmationTaskExists}
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
