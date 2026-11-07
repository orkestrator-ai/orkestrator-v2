import { startCoordinatedPoll } from "@/lib/coordinated-poll";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  CONTAINER_LIFECYCLE_EVENT,
  parseContainerLifecycleError,
  type ContainerLifecycleEvent,
  type ContainerLifecycleSnapshot,
  type RebuildPreview,
} from "@orkestrator/protocol/container-lifecycle";
import { Button } from "@/components/ui/button";
import { listenAuthoritative } from "@/lib/native/authoritative-events";
import type { Environment } from "@/types";
import { RebuildConfirmDialog, reportRebuildOutcome } from "./RebuildConfirmDialog";
import type * as backend from "@/lib/backend";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** Progress reads while a rebuild runs and no event subscription is live. */
export const REBUILD_POLL_MS = 2_000;
/** Backstop reads under live lifecycle events, which carry the progress. */
export const REBUILD_BACKSTOP_POLL_MS = 15_000;

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
  const nodeBackend = useScopeBackend();
  const [preview, setPreview] = useState<RebuildPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [allowUnknownCapacity, setAllowUnknownCapacity] = useState(false);
  const [held, setHeld] = useState<{
    environmentId: string;
    snapshot: ContainerLifecycleSnapshot;
  } | null>(null);
  const snapshot = held?.environmentId === environment.id ? held.snapshot : null;
  const [cancelling, setCancelling] = useState(false);
  const [eventsLive, setEventsLive] = useState(false);
  const running = activeRebuild(snapshot);

  // Reads and events can land in either order; keep the newer snapshot.
  const applySnapshot = useCallback((environmentId: string, next: ContainerLifecycleSnapshot) => {
    setHeld((current) =>
      current?.environmentId === environmentId && next.revision < current.snapshot.revision
        ? current
        : { environmentId, snapshot: next },
    );
  }, []);

  const readGeneration = useRef(0);
  useLayoutEffect(() => {
    readGeneration.current += 1;
    return () => {
      readGeneration.current += 1;
    };
  }, [environment.id]);

  const refreshSnapshot = useCallback(() => {
    const generation = readGeneration.current;
    return nodeBackend.getContainerLifecycleSnapshot(environment.id).then(
      (next) => {
        if (generation === readGeneration.current) applySnapshot(environment.id, next);
      },
      () => {
        // The section stays usable; the backend re-checks everything anyway.
      },
    );
  }, [applySnapshot, environment.id, nodeBackend]);

  // The backend publishes every durable lifecycle write with its snapshot.
  // Subscribe before the first read, and read again whenever the transport
  // may have dropped events, so a rebuild started from another window or
  // before this dialog opened is followed without polling.
  useEffect(() => {
    const controller = new AbortController();
    void listenAuthoritative<ContainerLifecycleEvent>(
      CONTAINER_LIFECYCLE_EVENT,
      ({ payload }) => {
        if (
          !controller.signal.aborted &&
          payload?.environmentId === environment.id &&
          payload.snapshot
        ) {
          applySnapshot(environment.id, payload.snapshot);
        }
      },
      { onResync: refreshSnapshot, signal: controller.signal, resyncOnSubscribe: true },
    ).then(
      () => {
        if (!controller.signal.aborted) setEventsLive(true);
      },
      () => {
        if (controller.signal.aborted) return;
        setEventsLive(false);
        void refreshSnapshot();
      },
    );
    return () => controller.abort();
  }, [applySnapshot, environment.id, refreshSnapshot]);

  // While a rebuild runs, a slow read backs up the events; without a live
  // subscription it is the only source of progress, so it stays quick.
  useEffect(() => {
    if (!running) return;
    return startCoordinatedPoll({
      resource: "environment-rebuild",
      target: environment.id,
      intervalMs: eventsLive ? REBUILD_BACKSTOP_POLL_MS : REBUILD_POLL_MS,
      read: refreshSnapshot,
    });
  }, [environment.id, eventsLive, running, refreshSnapshot]);

  const openConfirm = async () => {
    setLoadingPreview(true);
    setAllowUnknownCapacity(false);
    try {
      setPreview(await nodeBackend.getRebuildPreview(environment.id));
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
      onUpdate(await nodeBackend.syncEnvironmentStatus(environment.id));
      // Reported from the backend's record, not from the call returning.
      const after = await nodeBackend
        .getContainerLifecycleSnapshot(environment.id)
        .catch(() => null);
      reportRebuildOutcome(after);
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      toast.error("Rebuild did not complete", {
        description: `${lifecycle?.message ?? (err instanceof Error ? err.message : String(err))} The original container was kept.`,
        // Everything is re-checked against the container as it is now.
      });
      try {
        onUpdate(await nodeBackend.syncEnvironmentStatus(environment.id));
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
      const result = await nodeBackend.cancelContainerOperation(
        environment.id,
        running.operationId,
      );
      if (!result.cancelled) toast.info("The rebuild can no longer be cancelled.");
    } catch (err) {
      toast.error("Could not cancel the rebuild", {
        description:
          parseContainerLifecycleError(err)?.message ??
          (err instanceof Error ? err.message : String(err)),
      });
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

      <RebuildConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        preview={preview}
        allowUnknownCapacity={allowUnknownCapacity}
        onAllowUnknownCapacityChange={setAllowUnknownCapacity}
        disabled={!dockerAvailable}
        onConfirm={() => void handleRebuild()}
      />
    </div>
  );
}
