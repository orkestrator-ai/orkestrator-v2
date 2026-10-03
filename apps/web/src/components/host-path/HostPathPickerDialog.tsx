import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUp, File, Folder, Home, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { listHostDirectory, type HostDirectoryListing } from "@/lib/backend/files-sessions";
import { useHostPathPickerStore } from "@/lib/host-path-picker";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { cn } from "@/lib/utils";

/**
 * Mounted once at the app root; opened by `pickHostPath`. It lists directories
 * through the backend, so it browses the machine the backend runs on, whether
 * that is this computer or a remote host.
 */
export function HostPathPickerDialog() {
  const request = useHostPathPickerStore((state) => state.request);
  const settle = useHostPathPickerStore((state) => state.settle);
  const isFileMode = request?.mode === "file";

  const [listing, setListing] = useState<HostDirectoryListing | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const navigationPending = useRef(false);
  const addressId = useId();

  const load = useCallback(
    async (path: string | undefined, hidden: boolean) => {
      const generation = ++loadGeneration.current;
      navigationPending.current = true;
      setIsLoading(true);
      setSelectedFile(null);
      setError(null);
      try {
        const next = await listHostDirectory(path, {
          includeFiles: isFileMode,
          showHidden: hidden,
        });
        if (generation !== loadGeneration.current) return;
        setListing(next);
        setAddressInput(next.path);
        // A typed path that names a file selects it instead of just opening its folder.
        // Older remote backends omit requestedFile; preserve their exact-path selection.
        const requestedFile =
          next.requestedFile === undefined
            ? next.entries.find((entry) => !entry.isDirectory && entry.path === path)?.path
            : next.requestedFile;
        setSelectedFile(isFileMode ? (requestedFile ?? null) : null);
      } catch (loadError) {
        if (generation !== loadGeneration.current) return;
        setListing(null);
        setSelectedFile(null);
        setError(loadError instanceof Error ? loadError.message : "Could not read that folder.");
      } finally {
        if (generation === loadGeneration.current) {
          navigationPending.current = false;
          setIsLoading(false);
        }
      }
    },
    [isFileMode],
  );

  // `load` only changes with the request's mode, so this restarts browsing once per request.
  useEffect(() => {
    if (!request) {
      loadGeneration.current += 1;
      navigationPending.current = false;
      setListing(null);
      setSelectedFile(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setShowHidden(false);
    void load(request.defaultPath?.trim() || undefined, false);
  }, [request, load]);

  const navigate = (path: string) => void load(path, showHidden);

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    void load(listing?.path, next);
  };

  const canChoose = !!listing && !isLoading && !error;
  const chosenPath = canChoose ? (isFileMode ? selectedFile : listing.path) : null;
  const confirm = () => {
    if (chosenPath && !navigationPending.current) settle(chosenPath);
  };

  const noun = isFileMode ? "file" : "folder";
  const showRoots = (listing?.roots.length ?? 0) > 1;

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && settle(null)}>
      <DialogContent
        className={cn("flex max-h-[80dvh] flex-col sm:max-w-xl", Z_FULLSCREEN_DIALOG)}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <DialogHeader>
          <DialogTitle>{request?.title ?? `Choose a ${noun}`}</DialogTitle>
          <DialogDescription>
            Browsing the machine running the Orkestrator backend.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (addressInput.trim()) navigate(addressInput.trim());
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Parent folder"
            title="Parent folder"
            disabled={!listing?.parent || isLoading}
            onClick={() => listing?.parent && navigate(listing.parent)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Home folder"
            title="Home folder"
            disabled={!listing || isLoading}
            onClick={() => listing && navigate(listing.home)}
          >
            <Home />
          </Button>
          <label htmlFor={addressId} className="sr-only">
            Path
          </label>
          <Input
            id={addressId}
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            placeholder="/path/to/folder"
          />
        </form>

        <div className="flex flex-wrap items-center gap-2">
          {showRoots &&
            listing?.roots.map((root) => (
              <Button
                key={root}
                type="button"
                variant="ghost"
                size="sm"
                disabled={isLoading}
                onClick={() => navigate(root)}
              >
                {root}
              </Button>
            ))}
          <Button
            type="button"
            variant={showHidden ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={showHidden}
            className="ml-auto"
            onClick={toggleHidden}
          >
            Hidden items
          </Button>
        </div>

        <div
          className="min-h-48 flex-1 overflow-y-auto rounded-md border border-border/70"
          aria-busy={isLoading}
        >
          {error ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              {error}
            </p>
          ) : !listing ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : listing.entries.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {isFileMode ? "This folder is empty." : "No subfolders here."}
            </p>
          ) : (
            <ul className={cn(isLoading && "opacity-60")}>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={!canChoose}
                    aria-pressed={entry.isDirectory ? undefined : selectedFile === entry.path}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-elevated-hover",
                      selectedFile === entry.path && "bg-elevated",
                    )}
                    onClick={() => {
                      if (!canChoose || navigationPending.current) return;
                      if (entry.isDirectory) navigate(entry.path);
                      else setSelectedFile(entry.path);
                    }}
                    onDoubleClick={() => {
                      if (canChoose && !navigationPending.current && !entry.isDirectory) {
                        settle(entry.path);
                      }
                    }}
                  >
                    {entry.isDirectory ? (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <File className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
              {listing.truncated && (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  Only the first entries are shown. Type a path above to go further.
                </li>
              )}
            </ul>
          )}
        </div>

        {selectedFile && (
          <p className="break-all text-xs text-muted-foreground" aria-live="polite">
            Selected file: {selectedFile}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button type="button" disabled={!chosenPath || isLoading} onClick={confirm}>
            {isFileMode ? "Select file" : "Select this folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
