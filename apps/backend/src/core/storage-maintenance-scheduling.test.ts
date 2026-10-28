import { expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as backups from "./storage-backups.js";
import { StorageContext } from "./storage-context.js";
import { createHarness } from "./change-tracking/service-test-support.js";

test("snapshot scheduling delays the first check, prevents overlap and stops on close", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ork-snapshot-timers-"));
  const context = new StorageContext(directory, { snapshots: true });
  const stale = path.join(
    directory,
    backups.BACKUP_DIRECTORY,
    `.hourly-2026-10-27T12-00-00-000Z.${2 ** 30}.tmp`,
  );
  mkdirSync(path.dirname(stale), { recursive: true });
  writeFileSync(stale, "interrupted");
  let finish!: (file: string | null) => void;
  const copy = spyOn(backups, "takeHourlySnapshotIfDue").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  jest.useFakeTimers();
  try {
    context.startSnapshots();
    context.startSnapshots();
    expect(existsSync(stale)).toBe(false);
    jest.advanceTimersByTime(backups.BACKUP_FIRST_CHECK_DELAY_MS - 1);
    expect(copy).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1);
    expect(copy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(backups.BACKUP_CHECK_INTERVAL_MS);
    expect(copy).toHaveBeenCalledTimes(1);
    finish(null);
    await Promise.resolve();
    jest.advanceTimersByTime(backups.BACKUP_CHECK_INTERVAL_MS);
    expect(copy).toHaveBeenCalledTimes(2);
    finish(null);
    await Promise.resolve();
    context.close();
    jest.advanceTimersByTime(backups.BACKUP_CHECK_INTERVAL_MS * 3);
    expect(copy).toHaveBeenCalledTimes(2);
    // Closing before the initial deadline clears that timeout too.
    context.startSnapshots();
    context.close();
    jest.advanceTimersByTime(backups.BACKUP_FIRST_CHECK_DELAY_MS);
    expect(copy).toHaveBeenCalledTimes(2);
  } finally {
    context.close();
    copy.mockRestore();
    jest.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retention runs first at two minutes and shutdown clears initial and periodic timers", () => {
  const h = createHarness();
  h.service.shutdown();
  // A separate non-manual harness schedules the production timers.
  jest.useFakeTimers();
  const scheduled = createHarness({ manualScheduling: false });
  const run = spyOn(scheduled.service.retention, "run").mockImplementation(
    () => new Promise(() => {}),
  );
  try {
    scheduled.service.start();
    jest.advanceTimersByTime(2 * 60_000 - 1);
    expect(run).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(58 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduled.service.shutdown();
    jest.advanceTimersByTime(2 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    const stopped = createHarness({ manualScheduling: false });
    const never = spyOn(stopped.service.retention, "run");
    try {
      stopped.service.shutdown();
      jest.advanceTimersByTime(2 * 60_000);
      expect(never).not.toHaveBeenCalled();
    } finally {
      never.mockRestore();
      stopped.cleanup();
    }
  } finally {
    scheduled.cleanup();
    h.cleanup();
    run.mockRestore();
    jest.useRealTimers();
  }
});
