import type { ReactNode } from "react";
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

/**
 * The confirmation for deleting an environment, from any row. It names the
 * machine whenever the client can show machines, and says what the deletion
 * removes for that kind of environment.
 */
export function EnvironmentDeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  name,
  machineName,
  projectHome,
  local,
  running,
  hasPullRequest,
  notice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  name: string;
  machineName: string | null;
  projectHome: boolean;
  local: boolean;
  running: boolean;
  /** `true` when known to have a PR; another machine's row knows only once its record is read. */
  hasPullRequest: boolean;
  /** Extra notes from the owning machine (e.g. design canvases kept with it). */
  notice?: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Environment</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{name}</strong>
            {machineName ? (
              <>
                {" "}
                on <strong>{machineName}</strong>
              </>
            ) : null}
            ?
            {projectHome ? (
              <span className="block mt-2">
                Only Orkestrator&apos;s sessions for it are removed. Your project checkout, its
                files and its branch are not touched.
              </span>
            ) : local ? (
              <span className="block mt-2 text-orange-500">
                This will delete the git worktree from {machineName ?? "your machine"}.
              </span>
            ) : (
              <>
                <span className="block mt-2">
                  Its container, persistent storage and any recovery copies kept from earlier
                  rebuilds are deleted with it.
                </span>
                {running && (
                  <span className="block mt-2 text-orange-500">
                    Warning: This environment is currently running. It will be stopped before
                    deletion.
                  </span>
                )}
              </>
            )}
            {hasPullRequest && (
              <span className="block mt-2">
                This environment has an associated PR that will remain open.
              </span>
            )}
            {notice}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {machineName ? `Delete on ${machineName}` : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
