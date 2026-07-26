import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { FileText, Image as ImageIcon, Loader2, Plus, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { FileIcon } from "@/components/files-panel/FileIcon";
import { cn } from "@/lib/utils";
import { createUuid } from "@/lib/uuid";
import type { FileCandidate } from "@/types";

const MAX_RESULTS = 100;
const IMAGE_EXTENSIONS = new Set([
  "gif",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

export interface NativeAttachmentFileSearch {
  searchFiles: (
    query: string,
    limit?: number,
    options?: { filesOnly?: boolean },
  ) => FileCandidate[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void | Promise<void>;
  isAvailable: boolean;
}

export interface WorkspaceAttachment {
  id: string;
  type: "file" | "image";
  path: string;
  name: string;
}

interface NativeAttachmentMenuProps {
  disabled?: boolean;
  fileSearch: NativeAttachmentFileSearch;
  onSelectFile: (file: FileCandidate) => void;
  onCloseAutoFocus?: () => void;
  fileActionLabel?: string;
  filePickerTitle?: string;
  filePickerDescription?: string;
}

interface WorkspaceFilePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileSearch: NativeAttachmentFileSearch;
  onSelectFile: (file: FileCandidate) => void;
  onCloseAutoFocus?: () => void;
  title: string;
  description: string;
}

function getFileExtension(file: FileCandidate): string {
  const lastDotIndex = file.filename.lastIndexOf(".");
  const filenameExtension =
    lastDotIndex > 0 && lastDotIndex < file.filename.length - 1
      ? file.filename.slice(lastDotIndex + 1)
      : "";
  const extension = file.extension || filenameExtension;
  return extension.replace(/^\./, "").toLowerCase();
}

function normalizeRootPath(rootPath: string | undefined): string | undefined {
  if (!rootPath) return undefined;

  const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || (rootPath.startsWith("/") ? "/" : undefined);
}

export function createWorkspaceAttachment(
  file: FileCandidate,
  containerId?: string,
  worktreePath?: string,
): WorkspaceAttachment | null {
  const relativePath = file.relativePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const pathSegments = relativePath.split("/");
  const rootPath = containerId
    ? "/workspace"
    : normalizeRootPath(worktreePath);

  if (
    !rootPath
    || !relativePath
    || file.isDirectory
    || pathSegments.some((segment) => segment === ".." || segment.length === 0)
  ) {
    return null;
  }

  return {
    id: createUuid(),
    type: IMAGE_EXTENSIONS.has(getFileExtension(file)) ? "image" : "file",
    path: `${rootPath === "/" ? "" : rootPath}/${relativePath}`,
    name: file.filename,
  };
}

function WorkspaceFilePickerDialog({
  open,
  onOpenChange,
  fileSearch,
  onSelectFile,
  onCloseAutoFocus,
  title,
  description,
}: WorkspaceFilePickerDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const {
    searchFiles,
    isLoading,
    error,
    refresh,
    isAvailable,
  } = fileSearch;

  const results = useMemo(
    () =>
      searchFiles(query, MAX_RESULTS, { filesOnly: true }),
    [query, searchFiles],
  );
  const safeSelectedIndex = Math.min(
    selectedIndex,
    Math.max(results.length - 1, 0),
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }

    setSelectedIndex(0);
    void Promise.resolve()
      .then(() => refresh())
      .catch(() => {
        // The file-search owner exposes refresh failures through `error`.
      });
  }, [open, refresh]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, safeSelectedIndex]);

  const handleSelect = (file: FileCandidate) => {
    onSelectFile(file);
    onOpenChange(false);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isAvailable || isLoading || error) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) =>
        Math.min(current + 1, Math.max(results.length - 1, 0)),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      const selectedFile = results[safeSelectedIndex];
      if (!selectedFile) return;
      event.preventDefault();
      handleSelect(selectedFile);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!onCloseAutoFocus) return;
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Search className="h-4 w-4 text-muted-foreground" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="border-b border-border px-5 py-4">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Type a file name or path"
            aria-label="Search workspace files"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={!isAvailable}
            className="h-11 rounded-lg border-border/80 bg-background text-sm"
          />
        </div>

        <div className="max-h-[28rem] overflow-y-auto p-2">
          {!isAvailable ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              Start the environment to attach workspace files.
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading files...
            </div>
          ) : error ? (
            <div className="px-3 py-10 text-center text-sm text-destructive">
              {error}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              No files match that search.
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((file, index) => {
                const isSelected = index === safeSelectedIndex;
                const lastSlashIndex = file.relativePath.lastIndexOf("/");
                const directory =
                  lastSlashIndex >= 0
                    ? file.relativePath.slice(0, lastSlashIndex)
                    : "";

                return (
                  <button
                    key={file.relativePath}
                    ref={isSelected ? selectedItemRef : undefined}
                    type="button"
                    onClick={() => handleSelect(file)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                      isSelected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <FileIcon
                      filename={file.filename}
                      className="h-4 w-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {file.filename}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {directory || file.relativePath}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NativeAttachmentMenu({
  disabled = false,
  fileSearch,
  onSelectFile,
  onCloseAutoFocus,
  fileActionLabel = "Attach file from workspace",
  filePickerTitle = "Attach workspace file",
  filePickerDescription = "Search this environment and add a file to the current prompt.",
}: NativeAttachmentMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

  useEffect(() => {
    if (!disabled) return;
    setMenuOpen(false);
    setFilePickerOpen(false);
  }, [disabled]);

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            aria-label="Add attachment"
            title="Add attachment"
          >
            <Plus className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          collisionPadding={8}
          className="w-64"
        >
          <DropdownMenuItem
            disabled={!fileSearch.isAvailable}
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              setFilePickerOpen(true);
            }}
          >
            <FileText />
            {fileActionLabel}
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <ImageIcon />
            Paste image into the input
            <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WorkspaceFilePickerDialog
        open={filePickerOpen}
        onOpenChange={setFilePickerOpen}
        fileSearch={fileSearch}
        onSelectFile={onSelectFile}
        onCloseAutoFocus={onCloseAutoFocus}
        title={filePickerTitle}
        description={filePickerDescription}
      />
    </>
  );
}
