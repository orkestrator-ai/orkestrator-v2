import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  parseContainerLifecycleError,
  type RebuildPreview,
} from "@orkestrator/protocol/container-lifecycle";
import type {
  CleanupClassification,
  CleanupExecuteResult,
  CleanupPreview,
  CleanupPreviewRow,
  LegacyRuntimeExposure,
  LegacyRuntimeRow,
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
import {
  RebuildConfirmDialog,
  reportRebuildOutcome,
} from "@/components/environments/RebuildConfirmDialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { useAccountMachine } from "@/components/settings/account-machine";
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
  "legacy-unadopted": "Created before ownership labels; reattach it or remove it yourself",
  "in-use": "Mounted by a container",
};

const KIND_LABELS: Record<CleanupPreviewRow["kind"], string> = {
  container: "Container",
  volume: "Volume",
  network: "Network",
};

const EXPOSURE_LABELS: Record<LegacyRuntimeExposure, string> = {
  "host-mounts": "Your agent home directories are mounted into it",
  "shared-bridge": "It shares a Docker network with other containers and the host",
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
  const { machine } = useAccountMachine();
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CleanupExecuteResult | null>(null);
  const [rebuildTarget, setRebuildTarget] = useState<{
    environmentId: string;
    preview: RebuildPreview;
  } | null>(null);
  const [allowUnknownCapacity, setAllowUnknownCapacity] = useState(false);
  const [checkingRebuild, setCheckingRebuild] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState<ReadonlySet<string>>(new Set());
  const [refresh, setRefresh] = useState(0);

  // Each opening reviews a fresh preview.
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setPreview(null);
      setResult(null);
      setError(null);
      setLoading(true);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await backend.previewDockerCleanup(machine);
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
  }, [open, machine, refresh]);

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
        await backend.executeDockerCleanup(
          {
            selectionToken: preview.selectionToken,
            containerIds: chosen.filter((row) => row.kind === "container").map((row) => row.id),
            volumeNames: chosen.filter((row) => row.kind === "volume").map((row) => row.id),
            networkNames: chosen.filter((row) => row.kind === "network").map((row) => row.id),
          },
          machine,
        ),
      );
      onFinished();
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      setError(lifecycle?.message ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      setWorking(false);
    }
  };

  const openRebuild = async (row: LegacyRuntimeRow) => {
    setCheckingRebuild(row.environmentId);
    setAllowUnknownCapacity(false);
    try {
      setRebuildTarget({
        environmentId: row.environmentId,
        preview: await backend.getRebuildPreview(row.environmentId, machine),
      });
    } catch (err) {
      toast.error("Could not check whether this container can be rebuilt", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCheckingRebuild(null);
    }
  };

  // The rebuild belongs to the backend: closing this review does not stop it,
  // and the next opening lists the environment as busy until it finishes.
  const rebuild = async () => {
    if (!rebuildTarget?.preview.available || !rebuildTarget.preview.containerId) return;
    const { environmentId, preview: reviewed } = rebuildTarget;
    setRebuildTarget(null);
    setRebuilding((current) => new Set(current).add(environmentId));
    try {
      await backend.recreateEnvironment(
        environmentId,
        {
          intent: "preserve",
          expectedContainerId: reviewed.containerId!,
          ...(allowUnknownCapacity ? { allowUnknownCapacity: true } : {}),
        },
        machine,
      );
      reportRebuildOutcome(
        await backend.getContainerLifecycleSnapshot(environmentId, machine).catch(() => null),
      );
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      toast.error("Rebuild did not complete", {
        description: `${lifecycle?.message ?? (err instanceof Error ? err.message : String(err))} The original container was kept.`,
      });
    } finally {
      setRebuilding((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
      onFinished();
      setRefresh((current) => current + 1);
    }
  };

  const selectedCount = eligible.filter((row) => selected.has(rowKey(row))).length;
  const legacyRuntimes = preview?.legacyRuntimes ?? [];
  const legacyUnchecked = preview?.legacyRuntimesUnchecked ?? 0;

  return (
    <>
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
                {legacyRuntimes.length > 0 ? (
                  <section>
                    <h4 className="font-medium">
                      Older containers to rebuild ({legacyRuntimes.length})
                    </h4>
                    <p className="text-muted-foreground">
                      Rebuilding keeps each environment&apos;s files and gives it only what its
                      enabled agents need. Nothing here is removed.
                    </p>
                    <ul className="mt-1 space-y-1">
                      {legacyRuntimes.map((row) => {
                        const rebuildingHere = rebuilding.has(row.environmentId);
                        const busy = row.busy || rebuildingHere;
                        return (
                          <li
                            key={row.environmentId}
                            className="flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate">{row.environmentName}</p>
                              <p className="text-xs text-muted-foreground">
                                {row.exposures
                                  .map((exposure) => EXPOSURE_LABELS[exposure])
                                  .join(". ")}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="shrink-0"
                              aria-label={`Rebuild ${row.environmentName}`}
                              onClick={() => void openRebuild(row)}
                              disabled={busy || checkingRebuild !== null}
                            >
                              {busy || checkingRebuild === row.environmentId ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : null}
                              {rebuildingHere ? "Rebuilding…" : row.busy ? "Busy" : "Rebuild…"}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
                {legacyUnchecked > 0 ? (
                  <p className="text-muted-foreground">
                    Docker did not answer for {legacyUnchecked}{" "}
                    {legacyUnchecked === 1 ? "environment's container" : "environments' containers"}
                    , so older containers may be missing from this review.
                  </p>
                ) : null}
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
                              {KIND_LABELS[row.kind]} {row.name || row.id.slice(0, 12)}
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
                          {KIND_LABELS[row.kind]} {row.name || row.id.slice(0, 12)} —{" "}
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
      <RebuildConfirmDialog
        open={rebuildTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRebuildTarget(null);
        }}
        preview={rebuildTarget?.preview ?? null}
        allowUnknownCapacity={allowUnknownCapacity}
        onAllowUnknownCapacityChange={setAllowUnknownCapacity}
        onConfirm={() => void rebuild()}
      />
    </>
  );
}
