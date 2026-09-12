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
import { BoundedPathList } from "./BoundedPathList";

export interface PendingFileAction {
  environmentId: string;
  kind: "revert" | "delete";
  paths: string[];
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
  const paths = action?.paths ?? [];
  const isBulkDelete = !isRevert && paths.length > 1;
  const primaryPath = paths[0];

  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isRevert ? "Revert file?" : isBulkDelete ? "Delete files?" : "Delete file?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isRevert ? (
              <>
                Restore <strong className="break-all text-foreground">{primaryPath}</strong> to its
                state in <strong className="break-all text-foreground">{targetRef}</strong>. Any
                changes to this file will be discarded.
              </>
            ) : isBulkDelete ? (
              <>
                Delete <strong className="text-foreground">{paths.length} files</strong> from this
                workspace. Git will stage the deletion when the files are tracked. Untracked files
                cannot be recovered from Git.
                <BoundedPathList paths={paths} />
              </>
            ) : (
              <>
                Delete <strong className="break-all text-foreground">{primaryPath}</strong> from
                this workspace. Git will stage the deletion when the file is tracked. Untracked
                files cannot be recovered from Git.
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
            className={
              isRevert
                ? undefined
                : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            }
          >
            {isPending
              ? "Working..."
              : isRevert
                ? "Revert"
                : isBulkDelete
                  ? "Delete files"
                  : "Delete file"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
