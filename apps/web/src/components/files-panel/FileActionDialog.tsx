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

export interface PendingFileAction {
  environmentId: string;
  kind: "revert" | "delete";
  path: string;
}

interface FileActionDialogProps {
  action: PendingFileAction | null;
  targetRef: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function FileActionDialog({
  action,
  targetRef,
  isPending,
  onCancel,
  onConfirm,
}: FileActionDialogProps) {
  const isRevert = action?.kind === "revert";

  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isRevert ? "Revert file?" : "Delete file?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {isRevert ? (
              <>
                Restore <strong className="break-all text-foreground">{action?.path}</strong> to its
                state in <strong className="break-all text-foreground">{targetRef}</strong>. Any changes
                to this file will be discarded.
              </>
            ) : (
              <>
                Delete <strong className="break-all text-foreground">{action?.path}</strong> from this
                workspace. Git will stage the deletion when the file is tracked. Untracked files cannot
                be recovered from Git.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
            className={isRevert ? undefined : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
          >
            {isPending ? "Working..." : isRevert ? "Revert" : "Delete file"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
