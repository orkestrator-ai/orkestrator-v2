import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";

/**
 * Asked before a target switch or a close would drop an unsaved draft. A
 * draft belongs to exactly one backend/provider/environment, so it is never
 * carried over. It can open over an editor dialog, hence the layer above it.
 */
export function McpDiscardDialog({
  open,
  onKeep,
  onDiscard,
  reason = "switch",
}: {
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  reason?: "switch" | "close";
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <AlertDialogContent
        className={Z_FULLSCREEN_DIALOG_POPOVER}
        overlayClassName={Z_FULLSCREEN_DIALOG_POPOVER}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            {reason === "close"
              ? "Closing discards the server changes you have not saved; nothing has been saved."
              : "Your unsaved server changes belong to the configuration you are editing. Switching to another platform or environment discards them; nothing has been saved."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onKeep}>Keep editing</AlertDialogCancel>
          <Button variant="destructive" onClick={onDiscard}>
            {reason === "close" ? "Discard and close" : "Discard and switch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
