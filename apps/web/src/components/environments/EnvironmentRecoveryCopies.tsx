import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import type {
  RecoveryCopy,
  RecoveryCopyList,
  RecoveryCopyReason,
} from "@orkestrator/protocol/container-recovery";
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
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import type { Environment } from "@/types";
import { formatBytes } from "@/components/docker/docker-stats-format";

const REASONS: Record<RecoveryCopyReason, string> = {
  "migrate-source": "Container before moving to persistent storage",
  "rebuild-source": "Before a rebuild",
  "workspace-reset": "Before a reset",
  "restore-source": "Before restoring another copy",
  "failed-candidate": "Incomplete rebuild (cannot be restored)",
};

function describePresence(copy: RecoveryCopy): string | null {
  switch (copy.presence) {
    case "missing":
      return "Its Docker resources no longer exist.";
    case "partial":
      return "Some of its Docker resources no longer exist.";
    case "unknown":
      return "Docker could not be asked about it.";
    default:
      return null;
  }
}

type PendingAction = { kind: "restore" | "discard"; copy: RecoveryCopy } | null;

interface EnvironmentRecoveryCopiesProps {
  environment: Environment;
  dockerAvailable: boolean;
  onUpdate: (environment: Environment) => void;
  onClose: () => void;
}

/**
 * Earlier states the environment keeps after a rebuild, migration, reset or
 * restore. They stay until discarded here or the environment is deleted.
 * Restoring keeps the current state as another copy, so it never loses work.
 */
export function EnvironmentRecoveryCopies({
  environment,
  dockerAvailable,
  onUpdate,
  onClose,
}: EnvironmentRecoveryCopiesProps) {
  const [list, setList] = useState<RecoveryCopyList | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await backend.listRecoveryCopies(environment.id, { measureSize: true }));
    } catch {
      setList(null);
    } finally {
      setLoading(false);
    }
  }, [environment.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!list || list.copies.length === 0) {
    return loading ? (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking recovery copies…
      </div>
    ) : null;
  }

  const confirm = async () => {
    if (!pending) return;
    const { kind, copy } = pending;
    setWorking(true);
    try {
      if (kind === "discard") {
        const result = await backend.discardRecoveryCopy(
          environment.id,
          copy.copyId,
          list.revision,
        );
        if (!result) {
          // A repeated request: the first one already settled it.
          toast.info("That recovery copy was already handled", {
            description: "The list below shows what remains.",
          });
        } else if (!result.discarded) {
          toast.warning("Part of the copy could not be removed", {
            description: "What remains is still listed so it can be retried.",
          });
        } else {
          toast.success("Recovery copy deleted");
        }
      } else {
        onClose();
        await backend.restoreRecoveryCopy(
          environment.id,
          copy.copyId,
          environment.containerId ?? null,
          list.revision,
        );
        onUpdate(await backend.syncEnvironmentStatus(environment.id));
        const after = await backend.getContainerLifecycleSnapshot(environment.id).catch(() => null);
        if (after?.lastOutcome?.kind === "restore" && after.lastOutcome.status === "succeeded") {
          toast.success("Recovery copy restored", {
            description: "The previous state is kept as another recovery copy.",
          });
        } else {
          toast.warning("The restore's result could not be confirmed", {
            description: "Open Container settings to see which container is current.",
          });
        }
      }
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      toast.error(kind === "discard" ? "Could not delete the copy" : "Could not restore the copy", {
        description: lifecycle?.message ?? (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setWorking(false);
      setPending(null);
      void load();
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">Recovery copies</p>
      <p className="text-sm text-muted-foreground">
        Kept until you delete them. {list.copies.length} of {list.limit} used; another rebuild or
        reset that keeps a copy needs a free slot.
      </p>
      <ul className="flex flex-col gap-2">
        {list.copies.map((copy) => (
          <li
            key={copy.copyId}
            className="flex items-center justify-between gap-2 rounded-md bg-zinc-800/50 p-2 text-sm"
          >
            <div className="min-w-0">
              <div>{REASONS[copy.reason]}</div>
              <div className="text-xs text-muted-foreground">
                {copy.retainedAt ? new Date(copy.retainedAt).toLocaleString() : "Unknown date"}
                {copy.kind === "legacy-runtime" ? " · stopped container" : " · storage volumes"}
                {copy.sizeBytes !== null ? ` · ${formatBytes(copy.sizeBytes)}` : ""}
              </div>
              {describePresence(copy) ? (
                <div className="text-xs text-yellow-700 dark:text-yellow-400">
                  {describePresence(copy)}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!dockerAvailable || !copy.restorable || working}
                onClick={() => setPending({ kind: "restore", copy })}
              >
                Restore…
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!dockerAvailable || working}
                onClick={() => setPending({ kind: "discard", copy })}
              >
                Delete…
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next && !working) setPending(null);
        }}
      >
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "restore"
                ? "Restore this recovery copy?"
                : "Delete this recovery copy?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "restore"
                ? "Work in the container stops. The current container and files are kept as a new recovery copy, then the environment starts on the selected copy and setup runs again."
                : "The copy's container and volumes are deleted permanently. The environment's current files are not affected."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                pending?.kind === "discard"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              disabled={working}
              onClick={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              {pending?.kind === "restore" ? "Restore" : "Delete copy"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
