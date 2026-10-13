import { describe, expect, test } from "bun:test";
import {
  claudeBackgroundCommandTimeouts,
  claudeBashMaxTimeoutEnvValue,
  formatClaudeCommandDuration,
  isValidClaudeBackgroundCommandLimitHours,
  resolveClaudeBackgroundCommandLimitHours,
} from "./claude-background-commands";

describe("Claude background command limit", () => {
  test("accepts whole hours from the CLI's own ceiling up to one week", () => {
    expect(isValidClaudeBackgroundCommandLimitHours(2)).toBe(true);
    expect(isValidClaudeBackgroundCommandLimitHours(168)).toBe(true);
    for (const value of [1, 169, 2.5, Number.NaN, "4", null, undefined]) {
      expect(isValidClaudeBackgroundCommandLimitHours(value)).toBe(false);
    }
    expect(resolveClaudeBackgroundCommandLimitHours(undefined)).toBe(2);
    expect(resolveClaudeBackgroundCommandLimitHours(0)).toBe(2);
    expect(resolveClaudeBackgroundCommandLimitHours(12)).toBe(12);
  });

  test("leaves BASH_MAX_TIMEOUT_MS unset at the default", () => {
    // Setting it to 2h would also raise the 10-minute foreground ceiling.
    expect(claudeBashMaxTimeoutEnvValue(undefined)).toBeUndefined();
    expect(claudeBashMaxTimeoutEnvValue(2)).toBeUndefined();
    expect(claudeBashMaxTimeoutEnvValue("garbage")).toBeUndefined();
    expect(claudeBashMaxTimeoutEnvValue(8)).toBe(String(8 * 60 * 60 * 1000));
  });

  test("mirrors the CLI's resolution of the BASH timeout variables", () => {
    expect(claudeBackgroundCommandTimeouts({})).toEqual({
      defaultMs: 1_800_000,
      maxMs: 7_200_000,
    });
    // A ceiling below the CLI's own is ignored; it cannot be lowered.
    expect(claudeBackgroundCommandTimeouts({ BASH_MAX_TIMEOUT_MS: "60000" }).maxMs).toBe(7_200_000);
    expect(claudeBackgroundCommandTimeouts({ BASH_MAX_TIMEOUT_MS: "28800000" })).toEqual({
      defaultMs: 1_800_000,
      maxMs: 28_800_000,
    });
    expect(
      claudeBackgroundCommandTimeouts({
        BASH_MAX_TIMEOUT_MS: "1",
        BASH_DEFAULT_TIMEOUT_MS: "10800000",
      }),
    ).toEqual({ defaultMs: 10_800_000, maxMs: 10_800_000 });
    expect(claudeBackgroundCommandTimeouts({ BASH_MAX_TIMEOUT_MS: "99999999999" }).maxMs).toBe(
      2_147_483_647,
    );
    expect(claudeBackgroundCommandTimeouts({ BASH_MAX_TIMEOUT_MS: "-5" }).maxMs).toBe(7_200_000);
  });

  test("formats durations in words", () => {
    expect(formatClaudeCommandDuration(1_800_000)).toBe("30 minutes");
    expect(formatClaudeCommandDuration(3_600_000)).toBe("1 hour");
    expect(formatClaudeCommandDuration(7_200_000)).toBe("2 hours");
    expect(formatClaudeCommandDuration(30 * 3_600_000)).toBe("1 day 6 hours");
    expect(formatClaudeCommandDuration(168 * 3_600_000)).toBe("7 days");
    expect(formatClaudeCommandDuration(90_000)).toBe("2 minutes");
  });
});
