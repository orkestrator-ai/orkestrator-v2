import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  CANCELLABLE_HOST_UPDATE_JOB_STATES,
  isActiveHostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";
import { describeHostUpdateJob } from "@/components/settings/HostUpdatesPanel";
import { useHostMaintenance } from "@/components/settings/useHostMaintenance";
import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import * as backend from "@/lib/backend";
import { requestCurrentMachineUpdates } from "@/lib/settings-navigation";
import { versionClientKind } from "@/lib/version-reminder";

export const HOST_UPDATE_TOAST_ID = "orkestrator-host-update";
const RELOADED_KEY = "orkestrator.hostUpdate.reloadedFor";
/** A success older than this is history, not something to react to. */
const RECENT_MS = 10 * 60 * 1000;

function readReloaded(): string | null {
  try {
    return window.sessionStorage.getItem(RELOADED_KEY);
  } catch {
    return null;
  }
}

function writeReloaded(jobId: string): void {
  try {
    window.sessionStorage.setItem(RELOADED_KEY, jobId);
  } catch {
    // Without storage the reload guard is the version check alone.
  }
}

/**
 * Shows an update of the connected backend's host while it runs, on every
 * client, wherever the user is in the app. The toast follows the job across
 * the backend restart (the snapshot is re-read on reconnect).
 *
 * A page served by that backend reloads itself once the host is back on the
 * new version, so it runs the matching renderer instead of the one it loaded
 * before the update.
 */
export function HostUpdateBanner() {
  const { snapshot } = useHostMaintenance();
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    const job = snapshot?.job;
    if (!snapshot || !job) return;
    if (isActiveHostUpdateJob(job)) {
      shownFor.current = job.id;
      const description =
        job.state === "awaiting-restart" && job.restartAt
          ? `${describeHostUpdateJob(job, null).replace(/ The host is restarting…$/, "")} The host restarts at ${new Date(job.restartAt).toLocaleTimeString()}.`
          : describeHostUpdateJob(job, null);
      const options = {
        id: HOST_UPDATE_TOAST_ID,
        description,
        duration: Infinity,
        action: CANCELLABLE_HOST_UPDATE_JOB_STATES.has(job.state)
          ? {
              label: "Cancel",
              onClick: () => {
                void backend.cancelHostUpdate(job.id).catch((error: unknown) => {
                  toast.error(
                    `Could not cancel the update: ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
              },
            }
          : { label: "Details", onClick: requestCurrentMachineUpdates },
      };
      if (job.state === "awaiting-restart" || job.state === "waiting-for-idle") {
        toast.warning("Orkestrator is updating on the host", options);
      } else {
        toast.loading("Orkestrator is updating on the host", options);
      }
      return;
    }
    const recent = job.completedAt !== null && Date.now() - Date.parse(job.completedAt) < RECENT_MS;
    if (
      job.state === "succeeded" &&
      recent &&
      versionClientKind() === "backend-served" &&
      snapshot.version !== BUNDLED_APP_VERSION &&
      readReloaded() !== job.id
    ) {
      writeReloaded(job.id);
      window.location.reload();
      return;
    }
    if (shownFor.current !== job.id) return;
    shownFor.current = null;
    const text = describeHostUpdateJob(job, null);
    if (job.state === "succeeded") {
      toast.success("Orkestrator updated on the host", {
        id: HOST_UPDATE_TOAST_ID,
        description: text,
        duration: 8_000,
      });
    } else if (job.state === "failed") {
      toast.error("The host update failed", {
        id: HOST_UPDATE_TOAST_ID,
        description: text,
        duration: 15_000,
      });
    } else {
      toast.info("Host update stopped", {
        id: HOST_UPDATE_TOAST_ID,
        description: text,
        duration: 8_000,
      });
    }
  }, [snapshot]);

  return null;
}
