import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import type {
  CleanupClassification,
  CleanupExecuteResult,
  CleanupPreview,
  CleanupPreviewRow,
} from "@orkestrator/protocol/container-recovery";
import {
  AlertDialog,
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
import { formatBytes } from "./docker-stats-format";

export const CLEANUP_REASONS: Record<Exclude<CleanupClassification, "eligible">, string> = {
  assigned: "In use by an environment",
  "retained-recovery": "Recovery copy of an environment",
  "live-environment-label": "Belongs to an existing environment",
  "operation-in-flight": "An operation is using it",
  "deletion-pending": "Owed to an environment deletion in progress",
  running: "Running",
  "foreign-owner": "Belongs to another installation",
  "identity-uncertain": "Its owner could not be confirmed",
  "in-use": "Mounted by a container",
};

function rowKey(row: Pick<CleanupPreviewRow, "kind" | "id">): string {
  return `${row.kind}:${row.id}`;
}

function describeResult(result: CleanupExecuteResult): string {
  const parts = [`${result.removed} removed`];
  if (result.alreadyAbsent) parts.push(`${result.alreadyAbsent} already gone`);
  if (result.conflicts) parts.push(`${result.conflicts} kept because they became in use`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  if (result.failed) parts.push(`${result.failed} could not be removed`);
  const reclaimed =
    result.reclaimedBytes > 0 ? ` · ${formatBytes(result.reclaimedBytes)} freed` : "";
  return `${parts.join(", ")}${reclaimed}`;
}

interface DockerCleanupReviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
}

/**
 * Reviewed cleanup: shows every resource of this installation with the reason
 * it is kept, and removes only what the user leaves selected from the listed
 * candidates. The backend re-checks each one at removal time and reports
 * per-resource outcomes; partial success is reported as such.
 */
export function DockerCleanupReview({ open, onOpenChange, onFinished }: DockerCleanupReviewProps) {
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CleanupExecuteResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setResult(null);
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        const next = await backend.previewDockerCleanup();
        if (cancelled) return;
        setPreview(next);
        const eligibleKeys = next.rows
          .filter((row) => row.classification === "eligible")
          .map((row) => rowKey(row));
        setSelected(new Set(eligibleKeys));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const eligible = useMemo(
    () => preview?.rows.filter((row) => row.classification === "eligible") ?? [],
    [preview],
  );
  const kept = useMemo(
    () => preview?.rows.filter((row) => row.classification !== "eligible") ?? [],
    [preview],
  );

  const toggle = (row: CleanupPreviewRow) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowKey(row))) next.delete(rowKey(row));
      else next.add(rowKey(row));
      return next;
    });
  };

  const execute = async () => {
    if (!preview) return;
    setWorking(true);
    setError(null);
    try {
      const chosen = eligible.filter((row) => selected.has(rowKey(row)));
      setResult(
        await backend.executeDockerCleanup({
          selectionToken: preview.selectionToken,
          containerIds: chosen.filter((row) => row.kind === "container").map((row) => row.id),
          volumeNames: chosen.filter((row) => row.kind === "volume").map((row) => row.id),
        }),
      );
      onFinished();
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      setError(lifecycle?.message ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      setWorking(false);
    }
  };

  const selectedCount = eligible.filter((row) => selected.has(rowKey(row))).length;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
      <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <AlertDialogHeader>
          <AlertDialogTitle>Review Docker cleanup</AlertDialogTitle>
          <AlertDialogDescription>
            Only stopped containers and volumes that no environment, recovery copy or operation
            references can be removed. Nothing else is touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[50vh] space-y-4 overflow-y-auto text-sm">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking resources…
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {result ? <p role="status">{describeResult(result)}</p> : null}
          {preview && !result ? (
            <>
              <section>
                <h4 className="font-medium">Can be removed ({eligible.length})</h4>
                {eligible.length === 0 ? (
                  <p className="text-muted-foreground">Nothing to clean up.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {eligible.map((row) => (
                      <li key={rowKey(row)}>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected.has(rowKey(row))}
                            onChange={() => toggle(row)}
                            disabled={working}
                          />
                          <span className="truncate">
                            {row.kind === "volume" ? "Volume" : "Container"}{" "}
                            {row.name || row.id.slice(0, 12)}
                            {row.sizeBytes !== null ? ` · ${formatBytes(row.sizeBytes)}` : ""}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {kept.length > 0 ? (
                <section>
                  <h4 className="font-medium">Kept ({kept.length})</h4>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {kept.map((row) => (
                      <li key={rowKey(row)} className="truncate">
                        {row.kind === "volume" ? "Volume" : "Container"}{" "}
                        {row.name || row.id.slice(0, 12)} —{" "}
                        {
                          CLEANUP_REASONS[
                            row.classification as Exclude<CleanupClassification, "eligible">
                          ]
                        }
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {preview.truncated ? (
                <p className="text-muted-foreground">
                  More resources exist than one review lists; run cleanup again afterwards.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>{result ? "Close" : "Cancel"}</AlertDialogCancel>
          {!result ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void execute()}
              disabled={working || loading || !preview || selectedCount === 0}
            >
              {working ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Remove {selectedCount} selected
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
