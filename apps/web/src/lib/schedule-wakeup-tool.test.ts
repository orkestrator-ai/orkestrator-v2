import { describe, expect, test } from "bun:test";
import {
  AUTONOMOUS_LOOP_SENTINEL,
  formatWakeupDelay,
  isScheduleWakeupTool,
  parseScheduleWakeupArgs,
  parseScheduleWakeupResult,
  scheduleWakeupPreview,
} from "./schedule-wakeup-tool";

describe("isScheduleWakeupTool", () => {
  test.each(["ScheduleWakeup", "schedule_wakeup", "schedule-wakeup", " scheduleWakeup "])(
    "matches %s",
    (name) => {
      expect(isScheduleWakeupTool(name)).toBe(true);
    },
  );

  test.each([undefined, "", "CronCreate", "ScheduleWakeupLater"])("rejects %s", (name) => {
    expect(isScheduleWakeupTool(name)).toBe(false);
  });
});

describe("parseScheduleWakeupArgs", () => {
  test("reads a scheduled wakeup", () => {
    expect(
      parseScheduleWakeupArgs("ScheduleWakeup", {
        delaySeconds: 1800,
        noop: true,
        prompt: "Check the agents.",
        reason: "Fallback heartbeat.",
      }),
    ).toEqual({
      stop: false,
      delaySeconds: 1800,
      noop: true,
      prompt: "Check the agents.",
      reason: "Fallback heartbeat.",
      autonomous: false,
      extra: [],
    });
  });

  test("reads a stop call", () => {
    expect(parseScheduleWakeupArgs("ScheduleWakeup", { stop: true })).toMatchObject({
      stop: true,
      extra: [],
    });
  });

  test("flags the autonomous-loop sentinel and keeps unmodelled arguments", () => {
    const call = parseScheduleWakeupArgs("ScheduleWakeup", {
      delaySeconds: "60",
      prompt: AUTONOMOUS_LOOP_SENTINEL,
      label: "ci",
      empty: null,
    });
    expect(call?.delaySeconds).toBe(60);
    expect(call?.autonomous).toBe(true);
    expect(call?.extra).toEqual([["label", "ci"]]);
  });

  test("ignores other tools and empty arguments", () => {
    expect(parseScheduleWakeupArgs("Bash", { delaySeconds: 60 })).toBeNull();
    expect(parseScheduleWakeupArgs("ScheduleWakeup", undefined)).toBeNull();
    expect(parseScheduleWakeupArgs("ScheduleWakeup", { prompt: "  " })).toBeNull();
  });
});

describe("parseScheduleWakeupResult", () => {
  test("reads the fire time and clamped delay", () => {
    expect(
      parseScheduleWakeupResult(
        "Next wakeup scheduled for 21:16:00 (in 1859s). If you owe the user a status update, write it now.",
      ),
    ).toEqual({ scheduledFor: "21:16:00", inSeconds: 1859 });
  });

  test("reads a fire time without a delay", () => {
    expect(parseScheduleWakeupResult("Wakeup scheduled for 9:05 PM.")).toEqual({
      scheduledFor: "9:05 PM",
    });
  });

  test("returns null for unrelated output", () => {
    expect(parseScheduleWakeupResult(undefined)).toBeNull();
    expect(parseScheduleWakeupResult("Loop stopped.")).toBeNull();
  });
});

describe("formatWakeupDelay", () => {
  test.each([
    [0, "0s"],
    [45, "45s"],
    [60, "1m"],
    [150, "2m 30s"],
    [1800, "30m"],
    [1859, "30m 59s"],
    [3600, "1h"],
    [3900, "1h 5m"],
  ])("%d → %s", (seconds, expected) => {
    expect(formatWakeupDelay(seconds)).toBe(expected);
  });
});

describe("scheduleWakeupPreview", () => {
  test("summarises the delay and reason", () => {
    expect(
      scheduleWakeupPreview({
        stop: false,
        delaySeconds: 1800,
        reason: "Heartbeat",
        autonomous: false,
        extra: [],
      }),
    ).toBe("in 30m · Heartbeat");
  });

  test("summarises a stop", () => {
    expect(scheduleWakeupPreview({ stop: true, autonomous: false, extra: [] })).toBe(
      "Loop stopped",
    );
  });
});
