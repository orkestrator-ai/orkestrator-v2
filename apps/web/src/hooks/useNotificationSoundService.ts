import { useEffect, useRef, useState } from "react";
import {
  ENVIRONMENT_ATTENTION_EVENT,
  isEnvironmentAttentionEvent,
} from "@orkestrator/protocol/environment-attention";
import { normalizeNotificationSoundSettings } from "@orkestrator/protocol/notification-sounds";
import { BoundedKeySet } from "@/lib/bounded-hydration";
import { clientStateCapabilities } from "@/lib/client-state-capabilities";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { useVisibleEnvironmentId } from "./useVisibleEnvironmentId";
import {
  playConfiguredNotificationSound,
  primeNotificationSounds,
} from "@/lib/notification-sounds";

/** Attention ids remembered so a re-delivered event never sounds twice. */
export const ATTENTION_DEDUPE_LIMIT = 256;
/** Several environments finishing together are one cue. */
export const ATTENTION_COALESCE_MS = 500;

/**
 * Plays the "agent stopped" cue from the backend's `environment-attention`
 * events (one per badge edge, with an id), and primes Web Audio on the first
 * user gesture. An environment already on screen stays quiet: that is this
 * client's own presentation decision, as is the cue being a sound at all.
 *
 * On/off stays in the shared config rather than per device: it says which
 * events deserve an alert, and a device that should be silent (a phone, a
 * muted desktop) already has its own mute. Moving it per device would bring
 * back browser-local state with no synced default for a new client.
 *
 * A backend that predates the event keeps the previous inference from the
 * environment snapshot's `hasUnreadWork` edge. Existing unread work at startup
 * is baselined rather than replayed, on either path; an event missed while
 * disconnected is not replayed either, because a late sound is not state.
 */
export function useNotificationSoundService(): void {
  const environments = useEnvironmentStore((state) => state.environments);
  const selectedEnvironmentId = useVisibleEnvironmentId();
  const agentStoppedSoundEnabled = useConfigStore(
    (state) =>
      normalizeNotificationSoundSettings(state.config.global.notificationSounds).agentStopped,
  );
  const prMergedSoundEnabled = useConfigStore(
    (state) => normalizeNotificationSoundSettings(state.config.global.notificationSounds).prMerged,
  );
  const previousUnreadRef = useRef<Map<string, boolean> | null>(null);
  const visibleEnvironmentRef = useRef(selectedEnvironmentId);
  useEffect(() => {
    visibleEnvironmentRef.current = selectedEnvironmentId;
  }, [selectedEnvironmentId]);
  const [eventDriven, setEventDriven] = useState(false);

  useEffect(() => {
    let disposed = false;
    const probe = () => {
      void clientStateCapabilities()
        .then((capabilities) => {
          if (!disposed) setEventDriven(capabilities.environmentAttention);
        })
        // Nothing learned: stays on the current path until the next reconnect.
        .catch(() => undefined);
    };
    // First, so the capability cache hears a reconnect before this re-probes.
    probe();
    let stopReconnects: UnlistenFn | null = null;
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, probe)
      .then((stop) => {
        if (disposed) stop();
        else stopReconnects = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stopReconnects?.();
    };
  }, []);

  useEffect(() => {
    if (!eventDriven) return;
    let disposed = false;
    let stop: UnlistenFn | null = null;
    const seen = new BoundedKeySet(ATTENTION_DEDUPE_LIMIT);
    let lastCueAt = Number.NEGATIVE_INFINITY;
    void listen<unknown>(ENVIRONMENT_ATTENTION_EVENT, (event) => {
      // The payload crosses a process boundary; validate rather than trust.
      if (!isEnvironmentAttentionEvent(event.payload)) return;
      const { attentionId, environmentId } = event.payload;
      if (!seen.add(attentionId)) return;
      if (environmentId === visibleEnvironmentRef.current) return;
      const now = Date.now();
      if (now - lastCueAt < ATTENTION_COALESCE_MS) return;
      lastCueAt = now;
      void playConfiguredNotificationSound("agent-stopped");
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [eventDriven]);

  useEffect(() => {
    const nextUnread = new Map(
      environments.map((environment) => [environment.id, environment.hasUnreadWork === true]),
    );
    const previousUnread = previousUnreadRef.current;
    previousUnreadRef.current = nextUnread;
    if (!previousUnread || eventDriven) return;

    for (const [environmentId, unread] of nextUnread) {
      // A newly discovered environment belongs to snapshot hydration, not a
      // renderer-observed edge. The selected environment can optimistically
      // clear this bit before an authoritative snapshot restores it, so its
      // raw badge edge is not a semantic background completion.
      if (
        environmentId !== selectedEnvironmentId &&
        unread &&
        previousUnread.get(environmentId) === false
      ) {
        void playConfiguredNotificationSound("agent-stopped");
        break;
      }
    }
  }, [environments, eventDriven, selectedEnvironmentId]);

  useEffect(() => {
    if (!agentStoppedSoundEnabled && !prMergedSoundEnabled) return;
    let priming = false;
    let disposed = false;
    const prime = () => {
      if (priming) return;
      priming = true;
      void primeNotificationSounds().then((ready) => {
        priming = false;
        if (!ready || disposed) return;
        window.removeEventListener("pointerdown", prime);
        window.removeEventListener("keydown", prime);
      });
    };
    window.addEventListener("pointerdown", prime);
    window.addEventListener("keydown", prime);
    return () => {
      disposed = true;
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, [agentStoppedSoundEnabled, prMergedSoundEnabled]);
}
