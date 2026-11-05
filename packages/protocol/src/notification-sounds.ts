export interface NotificationSoundSettings {
  agentStopped: boolean;
  prMerged: boolean;
  coordinatorReport: boolean;
}

export const DEFAULT_NOTIFICATION_SOUND_SETTINGS: Readonly<NotificationSoundSettings> =
  Object.freeze({
    agentStopped: true,
    prMerged: true,
    coordinatorReport: true,
  });

/** Keep malformed or partially migrated config from changing notification behaviour. */
export function normalizeNotificationSoundSettings(value: unknown): NotificationSoundSettings {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS };
  }
  const candidate = value as Record<string, unknown>;
  return {
    agentStopped:
      typeof candidate.agentStopped === "boolean"
        ? candidate.agentStopped
        : DEFAULT_NOTIFICATION_SOUND_SETTINGS.agentStopped,
    prMerged:
      typeof candidate.prMerged === "boolean"
        ? candidate.prMerged
        : DEFAULT_NOTIFICATION_SOUND_SETTINGS.prMerged,
    coordinatorReport:
      typeof candidate.coordinatorReport === "boolean"
        ? candidate.coordinatorReport
        : DEFAULT_NOTIFICATION_SOUND_SETTINGS.coordinatorReport,
  };
}
