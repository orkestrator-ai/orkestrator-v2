import { describe, expect, mock, test } from "bun:test";
import {
  PENDING_RENAME_FAILED_MESSAGE,
  PENDING_RENAME_RECOVERED_MESSAGE,
  PENDING_RENAME_RETRY_MAX_MS,
  PENDING_RENAME_STILL_FAILING_MESSAGE,
  PendingRenameFailureLog,
  pendingRenameRetryDelayMs,
  summarizePendingRenameFailure,
} from "./pending-rename-failure-log.js";
import { CommandFailedError } from "./shell.js";

const PROMPT = "Please review the OAuth callback flow";

function codexFailure(details: ConstructorParameters<typeof CommandFailedError>[1] = {}) {
  return new CommandFailedError(`401 Unauthorized\nuser: ${PROMPT}`, {
    stdout: PROMPT,
    exitCode: 1,
    ...details,
  });
}

describe("summarizePendingRenameFailure", () => {
  test("keeps only content-free fields of a command failure", () => {
    expect(summarizePendingRenameFailure(codexFailure())).toEqual({
      reason: "command-failed",
      error: "CommandFailedError",
      exitCode: 1,
      signal: null,
    });
    expect(summarizePendingRenameFailure(codexFailure({ timedOut: true })).reason).toBe(
      "command-timed-out",
    );
    expect(
      summarizePendingRenameFailure(codexFailure({ executableMissing: true, exitCode: null }))
        .reason,
    ).toBe("command-missing");
  });

  test("reduces any other error to its class name", () => {
    expect(summarizePendingRenameFailure(new TypeError(PROMPT))).toEqual({
      reason: "error",
      error: "TypeError",
    });
    expect(summarizePendingRenameFailure(PROMPT)).toEqual({ reason: "error", error: "string" });
  });
});

describe("pendingRenameRetryDelayMs", () => {
  test("doubles from 30 seconds and stops at 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 100, 10_000].map(pendingRenameRetryDelayMs)).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      PENDING_RENAME_RETRY_MAX_MS,
      PENDING_RENAME_RETRY_MAX_MS,
      PENDING_RENAME_RETRY_MAX_MS,
      PENDING_RENAME_RETRY_MAX_MS,
    ]);
    expect(PENDING_RENAME_RETRY_MAX_MS).toBe(30 * 60_000);
  });

  test("treats a count below one as the first failure", () => {
    expect(pendingRenameRetryDelayMs(0)).toBe(30_000);
  });
});

describe("PendingRenameFailureLog", () => {
  test("returns the consecutive failure count for the intent", () => {
    const log = new PendingRenameFailureLog(() => undefined);
    expect(log.failed("env-1", PROMPT, codexFailure())).toBe(1);
    expect(log.failed("env-1", PROMPT, codexFailure())).toBe(2);
    expect(log.failed("env-2", PROMPT, codexFailure())).toBe(1);
    expect(log.failed("env-1", "A different first prompt", codexFailure())).toBe(1);
    log.succeeded("env-1");
    expect(log.failed("env-1", "A different first prompt", codexFailure())).toBe(1);
  });

  test("logs the first failure in full, then counts at powers of two, never the prompt", () => {
    const warn = mock((..._data: unknown[]) => undefined);
    const log = new PendingRenameFailureLog(warn);
    for (let attempt = 0; attempt < 9; attempt += 1) log.failed("env-1", PROMPT, codexFailure());

    expect(warn.mock.calls).toEqual([
      [
        PENDING_RENAME_FAILED_MESSAGE,
        {
          environmentId: "env-1",
          reason: "command-failed",
          error: "CommandFailedError",
          exitCode: 1,
          signal: null,
        },
      ],
      [
        PENDING_RENAME_STILL_FAILING_MESSAGE,
        { environmentId: "env-1", failures: 2, reason: "command-failed" },
      ],
      [
        PENDING_RENAME_STILL_FAILING_MESSAGE,
        { environmentId: "env-1", failures: 4, reason: "command-failed" },
      ],
      [
        PENDING_RENAME_STILL_FAILING_MESSAGE,
        { environmentId: "env-1", failures: 8, reason: "command-failed" },
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("OAuth");
  });

  test("a new intent or environment logs its first failure again", () => {
    const warn = mock((..._data: unknown[]) => undefined);
    const log = new PendingRenameFailureLog(warn);
    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-2", PROMPT, codexFailure());
    log.failed("env-1", "A different first prompt", codexFailure());

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      PENDING_RENAME_FAILED_MESSAGE,
      PENDING_RENAME_FAILED_MESSAGE,
      PENDING_RENAME_FAILED_MESSAGE,
    ]);
  });

  test("a success after failures logs the count once and resets the streak", () => {
    const warn = mock((..._data: unknown[]) => undefined);
    const log = new PendingRenameFailureLog(warn);
    log.succeeded("env-1");
    expect(warn).not.toHaveBeenCalled();

    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-1", PROMPT, codexFailure());
    log.succeeded("env-1");
    log.succeeded("env-1");
    expect(warn.mock.calls.at(-1)).toEqual([
      PENDING_RENAME_RECOVERED_MESSAGE,
      { environmentId: "env-1", failures: 3 },
    ]);
    expect(warn).toHaveBeenCalledTimes(3);

    log.failed("env-1", PROMPT, codexFailure());
    expect(warn.mock.calls.at(-1)?.[0]).toBe(PENDING_RENAME_FAILED_MESSAGE);
  });

  test("forgets environments that no longer hold an intent", () => {
    const warn = mock((..._data: unknown[]) => undefined);
    const log = new PendingRenameFailureLog(warn);
    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-2", PROMPT, codexFailure());
    log.retainOnly(new Set(["env-2"]));
    log.succeeded("env-1");
    log.succeeded("env-2");

    expect(warn.mock.calls.slice(2)).toEqual([
      [PENDING_RENAME_RECOVERED_MESSAGE, { environmentId: "env-2", failures: 1 }],
    ]);
  });
});
