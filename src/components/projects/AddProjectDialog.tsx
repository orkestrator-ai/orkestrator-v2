import { useState, useCallback } from "react";
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
import { FolderOpen, Loader2 } from "lucide-react";
import { open as openDialog } from "@/lib/native/dialog";
import { getGitRemoteUrl } from "@/lib/backend";
import { cn } from "@/lib/utils";

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (gitUrl: string, localPath?: string) => Promise<void>;
  validateGitUrl: (url: string) => Promise<boolean>;
}

export function AddProjectDialog({
  open: isOpen,
  onOpenChange,
  onAdd,
  validateGitUrl,
}: AddProjectDialogProps) {
  const [gitUrl, setGitUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isValidUrl, setIsValidUrl] = useState<boolean | null>(null);

  const resetForm = useCallback(() => {
    setGitUrl("");
    setLocalPath("");
    setError(null);
    setIsValidUrl(null);
  }, []);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        resetForm();
      }
      onOpenChange(isOpen);
    },
    [onOpenChange, resetForm]
  );

  const handleGitUrlChange = useCallback(
    async (value: string) => {
      setGitUrl(value);
      setError(null);

      if (value.trim()) {
        const valid = await validateGitUrl(value);
        setIsValidUrl(valid);
      } else {
        setIsValidUrl(null);
      }
    },
    [validateGitUrl]
  );

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Repository Directory",
      });

      if (selected && typeof selected === "string") {
        setLocalPath(selected);

        // Try to get the git remote URL from the selected directory
        try {
          const remoteUrl = await getGitRemoteUrl(selected);
          if (remoteUrl) {
            setGitUrl(remoteUrl);
            const valid = await validateGitUrl(remoteUrl);
            setIsValidUrl(valid);
          }
        } catch (err) {
          // Silently ignore - directory may not be a git repo
          console.debug("Could not get git remote URL:", err);
        }
      }
    } catch (err) {
      console.error("Failed to open directory picker:", err);
    }
  }, [validateGitUrl]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!gitUrl.trim()) {
        setError("Git URL is required");
        return;
      }

      if (isValidUrl === false) {
        setError("Invalid Git URL format");
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        await onAdd(gitUrl.trim(), localPath.trim() || undefined);
        handleOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add project");
      } finally {
        setIsLoading(false);
      }
    },
    [gitUrl, localPath, isValidUrl, onAdd, handleOpenChange]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            Add a Git repository to manage with Claude Code. You can either enter a remote Git URL
            or select a local repository.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Git URL Input */}
          <div className="space-y-2">
            <label htmlFor="gitUrl" className="text-sm font-medium">
              Git URL <span className="text-destructive">*</span>
            </label>
            <Input
              id="gitUrl"
              type="text"
              placeholder="git@github.com:user/repo.git or https://..."
              value={gitUrl}
              onChange={(e) => handleGitUrlChange(e.target.value)}
              className={cn(
                isValidUrl === false && "border-destructive",
                isValidUrl === true && "border-green-500"
              )}
              disabled={isLoading}
            />
            {isValidUrl === false && (
              <p className="text-xs text-destructive">
                Enter a valid Git URL (SSH or HTTPS format)
              </p>
            )}
          </div>

          {/* Local Path Input */}
          <div className="space-y-2">
            <label htmlFor="localPath" className="text-sm font-medium">
              Local Path <span className="text-muted-foreground">(optional)</span>
            </label>
            <div className="flex gap-2">
              <Input
                id="localPath"
                type="text"
                placeholder="/path/to/repository"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                disabled={isLoading}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowse}
                disabled={isLoading}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If you have a local clone, select it to copy .env files to environments.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !gitUrl.trim()}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
