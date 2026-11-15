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
 * Confirms removing a project and, with it, its environments, tickets,
 * project notes and feature plans (to-do 5820, retired).
 */
export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectName,
  environmentCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  /** The project's environments, deleted with it. */
  environmentCount: number;
  /** Closes the dialog once it resolves; a rejection keeps it open for a retry. */
  onConfirm: () => Promise<void> | void;
}) {
  const confirmDelete = async (event: React.MouseEvent) => {
    // Radix closes alert dialogs on action clicks by default. Defer closing
    // until the asynchronous deletion has actually succeeded.
    event.preventDefault();
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller owns error reporting. Keep the confirmation open so the
      // user can retry instead of producing an unhandled promise rejection.
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Project</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to remove <strong>{projectName}</strong> from your projects?
            <span className="block mt-2">
              Its tickets and their images, project notes and feature plans on this machine are
              deleted too. This cannot be undone. The checkout on disk is kept.
            </span>
            {environmentCount > 0 && (
              <span className="block mt-2 text-orange-500">
                Warning: This project has {environmentCount} environment
                {environmentCount !== 1 && "s"} that will also be deleted.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
