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

interface RenameFileDialogProps {
  filePath: string | null;
  isPending: boolean;
  onCancel: () => void;
  onRename: (filePath: string, newName: string) => Promise<void>;
}

function fileName(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

/** The end of the name's stem, so the initial selection leaves the extension intact. */
export function fileNameStemLength(name: string): number {
  const extension = name.lastIndexOf(".");
  return extension > 0 ? extension : name.length;
}

export function RenameFileDialog({
  filePath,
  isPending,
  onCancel,
  onRename,
}: RenameFileDialogProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const currentName = filePath ? fileName(filePath) : "";
  const newName = value.trim();
  const unchanged = newName === currentName;

  useEffect(() => {
    if (filePath === null) return;
    const name = fileName(filePath);
    setValue(name);
    setError(null);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, fileNameStemLength(name));
    });
    return () => cancelAnimationFrame(frame);
  }, [filePath]);

  const submit = async () => {
    if (!filePath || !newName || unchanged || isPending) return;
    if (newName.includes("/") || newName.includes("\\")) {
      setError("File names cannot contain / or \\");
      return;
    }
    setError(null);
    try {
      await onRename(filePath, newName);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to rename file");
    }
  };

  return (
    <Dialog
      open={filePath !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>
            Rename <strong className="break-all text-foreground">{filePath ?? ""}</strong>.
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
            <Label htmlFor={inputId}>File name</Label>
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
            <Button type="submit" disabled={!newName || unchanged || isPending}>
              {isPending ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
