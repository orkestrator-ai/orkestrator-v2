import { Loader2 } from "lucide-react";
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
import type { LinearIssueListItem } from "@/types/linear";

/**
 * Confirms Delete… from a Linear ticket's right-click menu. Deleting moves the
 * issue to Linear's trash, where Linear keeps it restorable for 30 days; the
 * dialog says so, and stays open while Linear answers.
 */
export function LinearIssueDeleteDialog({
  issue,
  deleting,
  buildRunning,
  onCancel,
  onConfirm,
}: {
  issue: LinearIssueListItem | null;
  deleting: boolean;
  /** A build of the issue is still running; deleting the issue does not stop it. */
  buildRunning: boolean;
  onCancel: () => void;
  onConfirm: (issue: LinearIssueListItem) => void;
}) {
  return (
    <AlertDialog
      open={issue !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {issue?.identifier ?? "this ticket"}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{issue?.title}</span> moves to
            Linear&apos;s trash, with its sub-issues. It can be restored in Linear for 30 days.
            {buildRunning && (
              <span className="mt-2 block">
                Its build is still running and carries on until you stop it.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={deleting}
            onClick={(event) => {
              // Stay open until Linear answers.
              event.preventDefault();
              if (issue) onConfirm(issue);
            }}
          >
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete ticket
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
