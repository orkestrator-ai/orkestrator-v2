import { toast } from "sonner";
import { AGENT_PLATFORM_LABELS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  ContainerLifecycleSnapshot,
  RebuildPreview,
  RebuildUnavailableReason,
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
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";

const UNAVAILABLE_REASONS: Record<RebuildUnavailableReason, string> = {
  "not-containerized": "Only container environments can be rebuilt.",
  "no-container": "This environment has no container yet.",
  "operation-in-progress": "Another container operation is running for this environment.",
  "image-unavailable": "The environment image is not available on this Docker host.",
  "image-without-storage-contract":
    "The environment image is too old to rebuild from. Update the image to rebuild without losing files.",
  "engine-without-volume-subpath":
    "Docker Engine 26 or newer is needed to keep agent sessions on persistent storage.",
  "disabled-by-configuration": "Persistent storage is disabled by configuration.",
  "admission-paused":
    "Rebuilds are paused on this installation. Recovery copies can still be restored or discarded.",
  "unsupported-topology": "A preserving rebuild needs a reachable local Docker engine.",
  "retention-limit":
    "This environment keeps the maximum number of recovery copies. Discard old copies first.",
  "unsupported-format": "This environment was changed by a newer version of Orkestrator.",
};

function providerName(provider: string): string {
  return isAgentPlatform(provider) ? AGENT_PLATFORM_LABELS[provider] : provider;
}

/** Reported from the backend's record, not from the rebuild's call returning. */
export function reportRebuildOutcome(after: ContainerLifecycleSnapshot | null): void {
  const outcome = after?.lastOutcome;
  if (after?.operation) {
    toast.info("The rebuild is still running", {
      description: "Its progress is shown in the environment's Container settings.",
    });
  } else if (
    outcome &&
    (outcome.kind === "rebuild" || outcome.kind === "migrate") &&
    outcome.status === "succeeded"
  ) {
    toast.success("Container rebuilt", {
      description: "Files and agent sessions were kept. The previous container is kept stopped.",
    });
  } else {
    toast.warning("The rebuild's result could not be confirmed", {
      description:
        "Open Container settings to see the environment's current container and any recovery copies.",
    });
  }
}

interface RebuildConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: RebuildPreview | null;
  allowUnknownCapacity: boolean;
  onAllowUnknownCapacityChange: (allow: boolean) => void;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * What a preserving rebuild keeps and what it does not, or why it cannot run
 * now. Every way into a rebuild confirms through this.
 */
export function RebuildConfirmDialog({
  open,
  onOpenChange,
  preview,
  allowUnknownCapacity,
  onAllowUnknownCapacityChange,
  disabled = false,
  onConfirm,
}: RebuildConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
                  {preview.providers.some((provider) => !provider.resumeQualified) ? (
                    <p className="text-xs">
                      Agent session files are copied for every agent. Continuing a conversation
                      after a rebuild has been verified for{" "}
                      {preview.providers.filter((provider) => provider.resumeQualified).length > 0
                        ? preview.providers
                            .filter((provider) => provider.resumeQualified)
                            .map((provider) => providerName(provider.provider))
                            .join(", ")
                        : "no agent yet"}
                      ; for the others it has not been verified.
                    </p>
                  ) : null}
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
              onChange={(event) => onAllowUnknownCapacityChange(event.target.checked)}
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
                onConfirm();
              }}
              disabled={disabled}
            >
              Rebuild
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
