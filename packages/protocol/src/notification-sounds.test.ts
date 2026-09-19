import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATION_SOUND_SETTINGS,
  normalizeNotificationSoundSettings,
} from "./notification-sounds";

describe("notification sound settings", () => {
  test("defaults missing and malformed settings", () => {
    expect(normalizeNotificationSoundSettings(undefined)).toEqual(
      DEFAULT_NOTIFICATION_SOUND_SETTINGS,
    );
    expect(normalizeNotificationSoundSettings({ agentStopped: "yes", prMerged: null })).toEqual(
      DEFAULT_NOTIFICATION_SOUND_SETTINGS,
    );
  });

  test("preserves explicit choices while filling missing fields", () => {
    expect(normalizeNotificationSoundSettings({ agentStopped: false })).toEqual({
      agentStopped: false,
      prMerged: true,
    });
  });
});
