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

  test("a config written before the coordinator report cue gets it on", () => {
    expect(normalizeNotificationSoundSettings({ agentStopped: false, prMerged: false })).toEqual({
      agentStopped: false,
      prMerged: false,
      coordinatorReport: true,
    });
    expect(normalizeNotificationSoundSettings({ coordinatorReport: false }).coordinatorReport).toBe(
      false,
    );
  });

  test("preserves explicit choices while filling missing fields", () => {
    expect(normalizeNotificationSoundSettings({ agentStopped: false })).toEqual({
      agentStopped: false,
      prMerged: true,
      coordinatorReport: true,
    });
  });
});
