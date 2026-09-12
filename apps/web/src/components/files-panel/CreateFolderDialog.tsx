import { useEffect, useId, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const DEFAULT_NEW_FOLDER_NAME = "New Folder";

interface CreateFolderDialogProps {
  parentDirectory: string | null;
  isPending: boolean;
  onCancel: () => void;
  onCreate: (parentDirectory: string, folderName: string) => Promise<void>;
}

function parentLabel(parentDirectory: string): string {
  return parentDirectory === "." ? "the workspace root" : parentDirectory;
}

export function CreateFolderDialog({
  parentDirectory,
  isPending,
  onCancel,
  onCreate,
}: CreateFolderDialogProps) {
  const [value, setValue] = useState(DEFAULT_NEW_FOLDER_NAME);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderName = value.trim();

  useEffect(() => {
    if (parentDirectory === null) return;
    setValue(DEFAULT_NEW_FOLDER_NAME);
    setError(null);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [parentDirectory]);

  const submit = async () => {
    if (!parentDirectory || !folderName || isPending) return;
    setError(null);
    try {
      await onCreate(parentDirectory, folderName);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create folder");
    }
  };

  return (
    <Dialog
      open={parentDirectory !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a folder in{" "}
            <strong className="text-foreground">{parentLabel(parentDirectory ?? ".")}</strong>.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={inputId}>Folder name</Label>
            <Input
              id={inputId}
              ref={inputRef}
              autoFocus
              value={value}
              maxLength={255}
              disabled={isPending}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={isPending} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!folderName || isPending}>
              {isPending ? "Creating…" : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
