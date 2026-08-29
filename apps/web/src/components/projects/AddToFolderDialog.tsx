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
import { Folder } from "lucide-react";
import {
  MAX_PROJECT_FOLDER_NAME_LENGTH,
  normalizeProjectFolderName,
  projectFolderKey,
} from "@orkestrator/protocol/project-folders";
import { cn } from "@/lib/utils";

interface AddToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project being filed, used only for the prompt text. */
  projectName: string;
  /** Folder the project is already in, if any. */
  currentFolder: string | null;
  /** Existing folder names, offered as one-click targets. */
  existingFolders: readonly string[];
  onSubmit: (folderName: string) => Promise<void> | void;
}

/**
 * Names a folder for one project.
 *
 * There is no separate "create" and "add to existing" path, because a folder
 * has no existence apart from its name: typing a name that already exists
 * joins that folder, and typing a new one brings it into being. The suggestion
 * buttons only save typing.
 */
export function AddToFolderDialog({
  open,
  onOpenChange,
  projectName,
  currentFolder,
  existingFolders,
  onSubmit,
}: AddToFolderDialogProps) {
  const [value, setValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(currentFolder ?? "");
    setError(null);
    setIsSaving(false);
  }, [open, currentFolder]);

  const normalized = normalizeProjectFolderName(value);
  const matchesExisting =
    normalized !== null &&
    existingFolders.some((folder) => projectFolderKey(folder) === projectFolderKey(normalized));

  const submit = async () => {
    if (!normalized || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await onSubmit(normalized);
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to add to folder");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Folder</DialogTitle>
          <DialogDescription>
            Type a folder name for <strong className="text-foreground">{projectName}</strong>. An
            existing name adds it to that folder; a new one creates the folder here.
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
              maxLength={MAX_PROJECT_FOLDER_NAME_LENGTH}
              placeholder="e.g. Work"
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
            {matchesExisting && (
              <p className="text-xs text-muted-foreground">
                Adds to the existing “{normalized}” folder.
              </p>
            )}
          </div>

          {existingFolders.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Existing folders</p>
              <div className="flex flex-wrap gap-1.5">
                {existingFolders.map((folder) => (
                  <Button
                    key={folder}
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-7 gap-1.5 px-2 text-xs",
                      normalized !== null &&
                        projectFolderKey(folder) === projectFolderKey(normalized) &&
                        "border-primary",
                    )}
                    onClick={() => {
                      setValue(folder);
                      setError(null);
                      inputRef.current?.focus();
                    }}
                  >
                    <Folder className="h-3 w-3" aria-hidden="true" />
                    {folder}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!normalized || isSaving}>
              {isSaving ? "Adding…" : "Add to Folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
