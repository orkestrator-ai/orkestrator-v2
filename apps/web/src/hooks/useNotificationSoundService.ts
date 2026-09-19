import { useEffect, useRef } from "react";
import { normalizeNotificationSoundSettings } from "@orkestrator/protocol/notification-sounds";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { useUIStore } from "@/stores/uiStore";
import {
  playConfiguredNotificationSound,
  primeNotificationSounds,
} from "@/lib/notification-sounds";

/**
 * Announces a newly raised completion badge and primes Web Audio on the first
 * user gesture. The environment snapshot remains authoritative; existing
 * unread work at startup is baselined rather than replayed as a new sound.
 */
export function useNotificationSoundService(): void {
  const environments = useEnvironmentStore((state) => state.environments);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const agentStoppedSoundEnabled = useConfigStore(
    (state) =>
      normalizeNotificationSoundSettings(state.config.global.notificationSounds).agentStopped,
  );
  const prMergedSoundEnabled = useConfigStore(
    (state) => normalizeNotificationSoundSettings(state.config.global.notificationSounds).prMerged,
  );
  const previousUnreadRef = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    const nextUnread = new Map(
      environments.map((environment) => [environment.id, environment.hasUnreadWork === true]),
    );
    const previousUnread = previousUnreadRef.current;
    previousUnreadRef.current = nextUnread;
    if (!previousUnread) return;

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
  }, [environments, selectedEnvironmentId]);

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
