import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  parseContainerLifecycleError,
  type ContainerLifecycleSnapshot,
  type RebuildPreview,
  type RebuildUnavailableReason,
} from "@orkestrator/protocol/container-lifecycle";
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

const UNAVAILABLE_REASONS: Record<RebuildUnavailableReason, string> = {
  "not-containerized": "Only container environments can be rebuilt.",
  "no-container": "This environment has no container yet.",
  "operation-in-progress": "Another container operation is running for this environment.",
  "image-unavailable": "The environment image is not available on this Docker host.",
  "image-without-storage-contract":
    "The environment image predates persistent storage. Update the image to rebuild without losing files.",
  "engine-without-volume-subpath":
    "Docker Engine 26 or newer is needed to keep agent sessions on persistent storage.",
  "disabled-by-configuration": "Persistent storage is disabled by configuration.",
  "unsupported-topology": "A preserving rebuild needs a reachable local Docker engine.",
  "retention-limit":
    "This environment keeps the maximum number of recovery copies. Discard old copies first.",
  "unsupported-format": "This environment was changed by a newer version of Orkestrator.",
};

const PHASE_LABELS: Record<string, string> = {
  requested: "Starting",
  preflight: "Checking image and free space",
  quiescing: "Stopping work in the container",
  "source-stopped": "Container stopped",
  copying: "Copying and verifying files",
  verified: "Files verified",
  "candidate-prepared": "Creating the new container",
  "candidate-healthy": "New container is healthy",
};

function activeRebuild(snapshot: ContainerLifecycleSnapshot | null) {
  const operation = snapshot?.operation;
  return operation && (operation.kind === "migrate" || operation.kind === "rebuild")
    ? operation
    : null;
}

interface EnvironmentRebuildSectionProps {
  environment: Environment;
  dockerAvailable: boolean;
  onRestart: (environmentId: string, options: backend.RecreateEnvironmentOptions) => Promise<void>;
  /** Persists settings the rebuild should apply (for example port changes). */
  beforeRebuild: () => Promise<void>;
  onUpdate: (environment: Environment) => void;
  onClose: () => void;
}

/**
 * Non-destructive rebuild: the workspace and preserved agent state are copied
 * into a new container and verified before it replaces the old one. Progress
 * is read from the backend's lifecycle snapshot, so reopening the dialog (or
 * returning from another environment) shows the rebuild where it actually is.
 */
export function EnvironmentRebuildSection({
  environment,
  dockerAvailable,
  onRestart,
  beforeRebuild,
  onUpdate,
  onClose,
}: EnvironmentRebuildSectionProps) {
  const [preview, setPreview] = useState<RebuildPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [allowUnknownCapacity, setAllowUnknownCapacity] = useState(false);
  const [snapshot, setSnapshot] = useState<ContainerLifecycleSnapshot | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const running = activeRebuild(snapshot);

  const refreshSnapshot = useCallback(async () => {
    try {
      setSnapshot(await backend.getContainerLifecycleSnapshot(environment.id));
    } catch {
      // The section stays usable; the backend re-checks everything anyway.
    }
  }, [environment.id]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  // Poll only while a rebuild is in flight; it may have been started from
  // another window or before this dialog was opened.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refreshSnapshot(), 2_000);
    return () => clearInterval(timer);
  }, [running, refreshSnapshot]);

  const openConfirm = async () => {
    setLoadingPreview(true);
    setAllowUnknownCapacity(false);
    try {
      setPreview(await backend.getRebuildPreview(environment.id));
      setShowConfirm(true);
    } catch (err) {
      toast.error("Could not check whether this container can be rebuilt", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleRebuild = async () => {
    if (!preview?.available || !preview.containerId) return;
    setShowConfirm(false);
    try {
      await beforeRebuild();
      onClose();
      const pending = onRestart(environment.id, {
        intent: "preserve",
        expectedContainerId: preview.containerId,
        ...(allowUnknownCapacity ? { allowUnknownCapacity: true } : {}),
      });
      void refreshSnapshot();
      await pending;
      onUpdate(await backend.syncEnvironmentStatus(environment.id));
      toast.success("Container rebuilt", {
        description: "Files and agent sessions were kept. The previous container is kept stopped.",
      });
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      toast.error("Rebuild did not complete", {
        description: `${lifecycle?.message ?? (err instanceof Error ? err.message : String(err))} The original container was kept.`,
      });
      try {
        onUpdate(await backend.syncEnvironmentStatus(environment.id));
      } catch {
        // Ignore sync errors
      }
    } finally {
      void refreshSnapshot();
    }
  };

  const handleCancel = async () => {
    if (!running) return;
    setCancelling(true);
    try {
      const result = await backend.cancelContainerOperation(environment.id, running.operationId);
      if (!result.cancelled) toast.info("The rebuild can no longer be cancelled.");
    } finally {
      setCancelling(false);
      void refreshSnapshot();
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">Rebuild container</p>
      <p className="text-sm text-muted-foreground">
        Creates a new container with these settings and the current image, keeping the workspace and
        agent sessions. The current container is kept stopped as a recovery copy.
      </p>
      {running ? (
        <div className="flex items-center gap-2 text-sm" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{PHASE_LABELS[running.phase] ?? "Rebuilding"}…</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleCancel()}
            disabled={cancelling}
          >
            Cancel rebuild
          </Button>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void openConfirm()}
            disabled={!dockerAvailable || loadingPreview}
            title={!dockerAvailable ? "Start Docker to rebuild this container" : undefined}
          >
            {loadingPreview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Rebuild (keeps files)…
          </Button>
        </div>
      )}

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {preview?.available ? "Rebuild container and keep its files?" : "Rebuild unavailable"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {preview && !preview.available ? (
                  <p>
                    {preview.unavailableReason
                      ? UNAVAILABLE_REASONS[preview.unavailableReason]
                      : "This container cannot be rebuilt right now."}{" "}
                    Nothing was changed.
                  </p>
                ) : null}
                {preview?.available ? (
                  <>
                    <p>
                      Work in the container stops first. The files below are copied and verified
                      before the new container replaces this one; if anything fails, this container
                      stays in use unchanged.
                    </p>
                    <div>
                      <p className="font-medium">Kept</p>
                      <ul className="list-disc pl-5">
                        <li>{preview.preservedPaths[0]}</li>
                        {preview.providers.map((provider) => (
                          <li key={provider.provider}>
                            {provider.provider} sessions
                            {provider.level === "partial" && provider.limitations
                              ? ` — partly: ${provider.limitations}`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="font-medium">Not kept</p>
                      <ul className="list-disc pl-5">
                        {preview.notPreserved.map((entry) => (
                          <li key={entry}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                    <p>
                      Recovery copies kept for this environment: {preview.retainedCopies} of{" "}
                      {preview.retainedCopyLimit}.
                    </p>
                  </>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview?.available ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={allowUnknownCapacity}
                onChange={(event) => setAllowUnknownCapacity(event.target.checked)}
              />
              <span>Continue even if free space on the Docker host cannot be measured.</span>
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            {preview?.available ? (
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void handleRebuild();
                }}
                disabled={!dockerAvailable}
              >
                Rebuild
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
