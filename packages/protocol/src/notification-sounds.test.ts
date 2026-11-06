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
      agentQuestion: true,
      questionDesktopNotification: true,
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
      agentQuestion: true,
      questionDesktopNotification: true,
    });
  });

  test("a config written before the question alerts gets them on, and keeps an opt-out", () => {
    const earlier = { agentStopped: true, prMerged: true, coordinatorReport: false };
    expect(normalizeNotificationSoundSettings(earlier)).toMatchObject({
      coordinatorReport: false,
      agentQuestion: true,
      questionDesktopNotification: true,
    });
    expect(
      normalizeNotificationSoundSettings({
        agentQuestion: false,
        questionDesktopNotification: false,
      }),
    ).toMatchObject({ agentQuestion: false, questionDesktopNotification: false });
    expect(normalizeNotificationSoundSettings({ agentQuestion: "no" }).agentQuestion).toBe(true);
  });
});
