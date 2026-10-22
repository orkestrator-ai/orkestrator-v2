import { useEffect, useRef } from "react";
import { toast } from "sonner";

import * as backend from "@/lib/backend";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen } from "@/lib/native/events";
import { appVersionSkew, BUNDLED_APP_VERSION, normalizeBackendVersion } from "@/lib/app-version";
import { requestCurrentMachineUpdates } from "@/lib/settings-navigation";
import { describeVersionReminder, versionClientKind } from "@/lib/version-reminder";

export const VERSION_REMINDER_TOAST_ID = "orkestrator-version-reminder";
const DISMISSED_KEY = "orkestrator.versionReminder.dismissed";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, value);
  } catch {
    // Private mode or a full store: the reminder simply shows again.
  }
}

/**
 * Reminds the user to update when this renderer and its backend run different
 * Orkestrator versions.
 *
 * Renderer and backend can drift apart: orkestrator.dev serves the latest web
 * app to backends that update on their own schedule, the desktop app can
 * connect to another machine's backend, and a browser tab can outlive a
 * backend upgrade. Nothing else checks this, and a mismatch can make views
 * render the wrong shape silently.
 *
 * Checks on mount and on every event-stream reconnect, which is when a
 * restarted (possibly upgraded) backend comes back. A dismissed reminder stays
 * hidden for this session until either version changes.
 */
export function BackendVersionReminder() {
  /** Version pair of the reminder on screen, if any. */
  const shownPairRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const check = async () => {
      let reported: string | null;
      try {
        reported = normalizeBackendVersion(await backend.getAppVersion());
      } catch {
        // An unreachable backend has its own error states; the reconnect
        // event retries once it is back.
        return;
      }
      // A backend that cannot name its version cannot be compared.
      if (disposed || !reported) return;
      const skew = appVersionSkew(BUNDLED_APP_VERSION, reported);
      const hostCanUpdate =
        skew === "backend-older"
          ? await backend
              .getHostMaintenance()
              .then((host) => host.updater.available)
              .catch(() => false)
          : false;
      if (disposed) return;
      const reminder = describeVersionReminder({
        skew,
        clientVersion: BUNDLED_APP_VERSION,
        backendVersion: reported,
        clientKind: versionClientKind(),
        hostCanUpdate,
      });
      if (!reminder) {
        // Clearing it here is not the user dismissing it, so record nothing.
        if (shownPairRef.current !== null) {
          shownPairRef.current = null;
          toast.dismiss(VERSION_REMINDER_TOAST_ID);
        }
        return;
      }
      const pair = `${BUNDLED_APP_VERSION}\u0000${reported}`;
      if (readDismissed() === pair) {
        // Withdraw another pair's reminder without recording its dismissal.
        shownPairRef.current = null;
        toast.dismiss(VERSION_REMINDER_TOAST_ID);
        return;
      }
      if (shownPairRef.current === pair) return;
      shownPairRef.current = pair;
      toast.warning(reminder.title, {
        id: VERSION_REMINDER_TOAST_ID,
        description: reminder.description,
        duration: Infinity,
        onDismiss: () => {
          if (shownPairRef.current !== pair) return;
          shownPairRef.current = null;
          writeDismissed(pair);
        },
        ...(reminder.action === "reload"
          ? { action: { label: "Reload", onClick: () => window.location.reload() } }
          : reminder.action === "update"
            ? {
                action: {
                  label: "Update backend",
                  onClick: requestCurrentMachineUpdates,
                },
              }
            : {}),
      });
    };

    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => void check())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    void check();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
