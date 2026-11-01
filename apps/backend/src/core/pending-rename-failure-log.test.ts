import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  PENDING_RENAME_RETRY_MAX_MS,
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
  let logs: LogCapture;
  const entries = () => logs.records().map((record) => [record.event, record.fields]);

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => logs.restore());

  test("returns the consecutive failure count for the intent", () => {
    const log = new PendingRenameFailureLog();
    expect(log.failed("env-1", PROMPT, codexFailure())).toBe(1);
    expect(log.failed("env-1", PROMPT, codexFailure())).toBe(2);
    expect(log.failed("env-2", PROMPT, codexFailure())).toBe(1);
    expect(log.failed("env-1", "A different first prompt", codexFailure())).toBe(1);
    log.succeeded("env-1");
    expect(log.failed("env-1", "A different first prompt", codexFailure())).toBe(1);
  });

  test("logs the first failure in full, then counts at powers of two, never the prompt", () => {
    const log = new PendingRenameFailureLog();
    for (let attempt = 0; attempt < 9; attempt += 1) log.failed("env-1", PROMPT, codexFailure());

    expect(entries()).toEqual([
      [
        "rename.failed",
        {
          environmentId: "env-1",
          reason: "command-failed",
          error: "CommandFailedError",
          exitCode: 1,
          signal: null,
        },
      ],
      ["rename.still-failing", { environmentId: "env-1", failures: 2, reason: "command-failed" }],
      ["rename.still-failing", { environmentId: "env-1", failures: 4, reason: "command-failed" }],
      ["rename.still-failing", { environmentId: "env-1", failures: 8, reason: "command-failed" }],
    ]);
    expect(logs.lines.join("\n")).not.toContain("OAuth");
    expect(logs.outputs.every((output) => output.method === "warn")).toBe(true);
  });

  test("a new intent or environment logs its first failure again", () => {
    const log = new PendingRenameFailureLog();
    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-2", PROMPT, codexFailure());
    log.failed("env-1", "A different first prompt", codexFailure());

    expect(logs.records().map((record) => record.event)).toEqual([
      "rename.failed",
      "rename.failed",
      "rename.failed",
    ]);
  });

  test("a success after failures logs the count once and resets the streak", () => {
    const log = new PendingRenameFailureLog();
    log.succeeded("env-1");
    expect(logs.records()).toEqual([]);

    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-1", PROMPT, codexFailure());
    log.succeeded("env-1");
    log.succeeded("env-1");
    expect(entries().at(-1)).toEqual(["rename.recovered", { environmentId: "env-1", failures: 3 }]);
    expect(logs.records()).toHaveLength(3);

    log.failed("env-1", PROMPT, codexFailure());
    expect(entries().at(-1)?.[0]).toBe("rename.failed");
  });

  test("forgets environments that no longer hold an intent", () => {
    const log = new PendingRenameFailureLog();
    log.failed("env-1", PROMPT, codexFailure());
    log.failed("env-2", PROMPT, codexFailure());
    log.retainOnly(new Set(["env-2"]));
    log.succeeded("env-1");
    log.succeeded("env-2");

    expect(entries().slice(2)).toEqual([
      ["rename.recovered", { environmentId: "env-2", failures: 1 }],
    ]);
  });
});
