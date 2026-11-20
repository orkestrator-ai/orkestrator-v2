import {
  MAX_WORKSPACE_FILE_NAME_BYTES,
  MAX_WORKSPACE_FOLDER_NAME_BYTES,
} from "@orkestrator/protocol/contract/domains/files";
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
import { fileNameStemLength } from "./RenameFileDialog";

export type CreateEntryKind = "file" | "folder";

export interface CreateEntryDialogProps {
  /** Folder the entry is created in, `.` for the workspace root; `null` closes the dialog. */
  parentDirectory: string | null;
  isPending: boolean;
  onCancel: () => void;
  onCreate: (parentDirectory: string, name: string) => Promise<void>;
}

const ENTRY_COPY = {
  file: {
    noun: "file",
    capitalNoun: "File",
    defaultName: "untitled.txt",
    maxBytes: MAX_WORKSPACE_FILE_NAME_BYTES,
  },
  folder: {
    noun: "folder",
    capitalNoun: "Folder",
    defaultName: "New Folder",
    maxBytes: MAX_WORKSPACE_FOLDER_NAME_BYTES,
  },
} as const;

function parentLabel(parentDirectory: string): string {
  return parentDirectory === "." ? "the workspace root" : parentDirectory;
}

/**
 * The checks the backend makes on a new entry's name, run first so the dialog
 * can say what is wrong without a round trip. The backend still decides.
 */
export function createEntryNameError(kind: CreateEntryKind, name: string): string | null {
  const { noun, capitalNoun, maxBytes } = ENTRY_COPY[kind];
  if (name.length === 0) return `Enter a ${noun} name`;
  if (name === "." || name === "..") return `${capitalNoun} names cannot be . or ..`;
  if (name.includes("/") || name.includes("\\"))
    return `${capitalNoun} names cannot contain / or \\`;
  if (new TextEncoder().encode(name).length > maxBytes) {
    return `${capitalNoun} names cannot exceed ${maxBytes} bytes`;
  }
  return null;
}

/** Asks for the name of a new, empty file or folder in `parentDirectory`. */
export function CreateEntryDialog({
  kind,
  parentDirectory,
  isPending,
  onCancel,
  onCreate,
}: CreateEntryDialogProps & { kind: CreateEntryKind }) {
  const copy = ENTRY_COPY[kind];
  const [value, setValue] = useState<string>(copy.defaultName);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const name = value.trim();

  // Opening the dialog for a directory starts from the default name.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (parentDirectory !== openedFor) {
    setOpenedFor(parentDirectory);
    if (parentDirectory !== null) {
      setValue(copy.defaultName);
      setError(null);
    }
  }

  useEffect(() => {
    if (parentDirectory === null) return;
    // A file keeps its extension out of the selection, so typing replaces the stem.
    const selectionEnd =
      kind === "file" ? fileNameStemLength(copy.defaultName) : copy.defaultName.length;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, selectionEnd);
    });
    return () => cancelAnimationFrame(frame);
  }, [parentDirectory, kind, copy.defaultName]);

  const submit = async () => {
    if (!parentDirectory || isPending) return;
    const invalid = createEntryNameError(kind, name);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    try {
      await onCreate(parentDirectory, name);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : `Failed to create ${copy.noun}`,
      );
    }
  };

  return (
    <Dialog
      open={parentDirectory !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New {copy.noun}</DialogTitle>
          <DialogDescription>
            Create {kind === "file" ? "an empty file" : "a folder"} in{" "}
            <strong className="break-all text-foreground">
              {parentLabel(parentDirectory ?? ".")}
            </strong>
            .
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
            <Label htmlFor={inputId}>{copy.capitalNoun} name</Label>
            <Input
              id={inputId}
              ref={inputRef}
              autoFocus
              value={value}
              disabled={isPending}
              aria-invalid={error !== null}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-failure">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={isPending} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Creating…" : `Create ${copy.noun}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
