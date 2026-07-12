import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Loader2, Search } from "lucide-react";
import { useEnvironmentStore, useUIStore } from "@/stores";
import { useTerminalContext } from "@/contexts";
import { useFileSearch } from "@/hooks/useFileSearch";
import { FileIcon } from "@/components/files-panel/FileIcon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { FileCandidate } from "@/types";

const MAX_RESULTS = 50;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function OpenFileDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  const deferredQuery = useDeferredValue(query);
  const { selectedEnvironmentId } = useUIStore();
  const selectedEnvironment = useEnvironmentStore((state) =>
    state.environments.find((environment) => environment.id === selectedEnvironmentId) ?? null
  );
  const { createFileTab } = useTerminalContext();

  const { searchFiles, isLoading, error, isAvailable, refresh } = useFileSearch(
    selectedEnvironment?.containerId ?? undefined,
    selectedEnvironment?.worktreePath ?? undefined,
    open
  );

  const results = useMemo(
    () =>
      searchFiles(deferredQuery, MAX_RESULTS).filter(
        (file) => !file.isDirectory
      ),
    [deferredQuery, searchFiles]
  );

  const canOpenFiles = !!selectedEnvironment && !!createFileTab && isAvailable;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setOpen(true);
        return;
      }

      if (!open || event.key !== "Escape") {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      event.preventDefault();
      setOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }

    setSelectedIndex(0);
    void refresh();

    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [open, refresh]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [deferredQuery, selectedEnvironmentId]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedIndex]);

  const handleSelect = (file: FileCandidate) => {
    if (!createFileTab) {
      return;
    }

    createFileTab(file.relativePath);
    setOpen(false);
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) =>
        Math.min(current + 1, Math.max(results.length - 1, 0))
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      const selectedFile = results[selectedIndex];
      if (!selectedFile) {
        return;
      }

      event.preventDefault();
      handleSelect(selectedFile);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Search className="h-4 w-4 text-muted-foreground" />
            Open File
          </DialogTitle>
          <DialogDescription>
            Search the selected environment and open a file in a new tab.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-border px-5 py-4">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Type a file name or path"
            aria-label="Search files"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={!canOpenFiles}
            className="h-11 rounded-lg border-border/80 bg-background text-sm"
          />
        </div>

        <div className="max-h-[28rem] overflow-y-auto p-2">
          {!selectedEnvironment && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              Select an environment to open files.
            </div>
          )}

          {selectedEnvironment && !isAvailable && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              Start the selected environment to search its files.
            </div>
          )}

          {canOpenFiles && isLoading && (
            <div className="flex items-center justify-center gap-2 px-3 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading files...
            </div>
          )}

          {canOpenFiles && !isLoading && error && (
            <div className="px-3 py-10 text-center text-sm text-destructive">
              {error}
            </div>
          )}

          {canOpenFiles && !isLoading && !error && results.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              No files match that search.
            </div>
          )}

          {canOpenFiles && !isLoading && !error && results.length > 0 && (
            <div className="space-y-1">
              {results.map((file, index) => {
                const isSelected = index === selectedIndex;
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
                        : "hover:bg-accent/50"
                    )}
                  >
                    <FileIcon filename={file.filename} className="h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{file.filename}</div>
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
