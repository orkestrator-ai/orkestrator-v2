/**
 * Which background events alert the user, and how. Despite the name this also
 * holds the one desktop-notification preference: it is the same "is this event
 * worth interrupting me for" choice, stored and synced the same way.
 */
export interface NotificationSoundSettings {
  agentStopped: boolean;
  prMerged: boolean;
  coordinatorReport: boolean;
  /** A distinct cue when an agent asks a question or waits on the user. */
  agentQuestion: boolean;
  /** A desktop notification for the same question/waiting events. */
  questionDesktopNotification: boolean;
}

export const DEFAULT_NOTIFICATION_SOUND_SETTINGS: Readonly<NotificationSoundSettings> =
  Object.freeze({
    agentStopped: true,
    prMerged: true,
    coordinatorReport: true,
    agentQuestion: true,
    questionDesktopNotification: true,
  });

const SETTING_KEYS = Object.keys(DEFAULT_NOTIFICATION_SOUND_SETTINGS) as Array<
  keyof NotificationSoundSettings
>;

/** Keep malformed or partially migrated config from changing notification behaviour. */
export function normalizeNotificationSoundSettings(value: unknown): NotificationSoundSettings {
  const candidate =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const settings = { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS };
  for (const key of SETTING_KEYS) {
    const stored = candidate[key];
    if (typeof stored === "boolean") settings[key] = stored;
  }
  return settings;
}
