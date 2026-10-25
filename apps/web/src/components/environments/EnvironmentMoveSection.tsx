import { useState } from "react";
import { FolderInput, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { pickHostPath } from "@/lib/host-path-picker";
import type { Environment } from "@/types";

interface EnvironmentMoveSectionProps {
  environment: Environment;
  onUpdate: (environment: Environment) => void;
}

// Host paths are POSIX: the backend runs on macOS or Linux.
function parentFolder(worktreePath: string): string {
  const trimmed = worktreePath.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function folderName(worktreePath: string): string {
  const trimmed = worktreePath.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function joinPath(folder: string, name: string): string {
  return `${folder.replace(/\/+$/, "")}/${name}`;
}

/** Why the environment cannot be moved right now, or null when it can. */
export function environmentMoveBlockedReason(environment: Environment): string | null {
  if (environment.lifecycleOperation === "moving") return "This environment is being moved.";
  if (environment.worktreeMove)
    return "Move recovery is pending. Restart Orkestrator to retry recovery.";
  if (environment.lifecycleOperation === "deleting" || environment.deletionRequestedAt) {
    return "This environment is being deleted.";
  }
  if (environment.lifecycleOperation === "merging") return "This environment is being merged.";
  const activity = environment.agentActivityState ?? "idle";
  if (activity === "working" || activity === "waiting") {
    return "An agent is running in this environment. Moving is available once it finishes.";
  }
  if (environment.status === "creating" || environment.status === "stopping") {
    return "Wait for the environment to finish starting or stopping.";
  }
  if (environment.setupPhase === "running") return "Environment setup is still running.";
  return null;
}

/**
 * Moves a local environment's worktree, with every file in it, into another
 * folder. The backend refuses while an agent is running and re-checks
 * everything shown here, so the disabled state is a courtesy, not the guard.
 */
export function EnvironmentMoveSection({ environment, onUpdate }: EnvironmentMoveSectionProps) {
  const worktreePath = environment.worktreePath ?? "";
  const currentFolder = parentFolder(worktreePath);
  const [destination, setDestination] = useState(currentFolder);
  const [showConfirm, setShowConfirm] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A completed move (here or elsewhere) changes the folder the field starts from.
  const [startFolder, setStartFolder] = useState(currentFolder);
  if (startFolder !== currentFolder) {
    setStartFolder(currentFolder);
    setDestination(currentFolder);
  }

  const blockedReason = environmentMoveBlockedReason(environment);
  const trimmed = destination.trim();
  const target = trimmed ? joinPath(trimmed, folderName(worktreePath)) : "";
  const unchanged = trimmed.replace(/\/+$/, "") === currentFolder;
  const canMove = !blockedReason && !moving && trimmed.length > 0 && !unchanged;

  const handleBrowse = async () => {
    const chosen = await pickHostPath({
      mode: "directory",
      title: "Choose the folder to move this environment into",
      defaultPath: trimmed || currentFolder,
    });
    if (chosen) {
      setDestination(chosen);
      setError(null);
    }
  };

  const handleMove = async () => {
    setMoving(true);
    setError(null);
    try {
      const updated = await backend.moveEnvironment(environment.id, trimmed);
      // The store merges field by field and JSON drops cleared fields, so the
      // settled move markers are passed explicitly.
      onUpdate({
        ...updated,
        lifecycleOperation: updated.lifecycleOperation,
        lifecycleOperationStartedAt: updated.lifecycleOperationStartedAt,
        worktreeMove: updated.worktreeMove,
        lifecycleError: updated.lifecycleError ?? null,
      });
      setShowConfirm(false);
      if (updated.lifecycleError)
        toast.warning("Environment moved with a warning", { description: updated.lifecycleError });
      else toast.success("Environment moved", { description: updated.worktreePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setShowConfirm(false);
      toast.error("Failed to move environment", { description: message });
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">Move environment</p>
      <p className="text-sm text-muted-foreground">
        Moves the worktree and every file in it, including uncommitted changes and ignored files,
        into another folder. The worktree keeps its folder name.
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Destination folder"
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value);
            setError(null);
          }}
          placeholder="/path/to/folder"
          className="font-mono text-sm"
          disabled={moving}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleBrowse()}
          disabled={moving}
        >
          <FolderOpen className="mr-2 h-4 w-4" aria-hidden="true" />
          Browse…
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowConfirm(true)}
          disabled={!canMove}
        >
          {moving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FolderInput className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          Move…
        </Button>
      </div>
      {blockedReason ? (
        <p className="text-xs text-muted-foreground" role="status">
          {blockedReason}
        </p>
      ) : null}
      {environment.worktreeMove?.phase === "committed" && environment.lifecycleError ? (
        <p className="text-sm" role="alert">
          {environment.lifecycleError}
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <AlertDialog open={showConfirm} onOpenChange={(open) => !moving && setShowConfirm(open)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Move this environment?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">From</p>
                  <p className="break-all font-mono text-xs">{worktreePath}</p>
                  <p className="font-medium text-foreground">To</p>
                  <p className="break-all font-mono text-xs">{target}</p>
                </div>
                <p>
                  The environment&apos;s terminals and agent connections are closed first and reopen
                  in the new folder. Moving to another disk copies every file and can take a while.
                </p>
                <p>
                  Claude, Codex, Cursor and Pi conversations continue in the new folder. OpenCode
                  and Grok start new conversations there; their earlier ones stay in the
                  agents&apos; own history.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={moving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleMove();
              }}
              disabled={moving}
            >
              {moving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
