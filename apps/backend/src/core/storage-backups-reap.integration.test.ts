import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanUpUntrackedChild,
  processState,
  spawnUntrackedChild,
} from "@orkestrator/protocol/testing/untracked-child";
import { copyDatabaseInChildProcess } from "./storage-backups.js";

/**
 * The database copy's supervisor, when Bun loses its exit on macOS: the watchdog
 * settles the copy from the zombie's status and the shared reaper then reaps it.
 * Waits on the production timings (1 s watchdog, 2 s grace), so it is in the slow tier.
 */
describe.skipIf(process.platform !== "darwin")("a database copy whose exit Bun lost", () => {
  const owned: number[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const pid of owned.splice(0)) cleanUpUntrackedChild(pid);
    for (const directory of directories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("settles with its verdict, then leaves no zombie", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-reap-"));
    directories.push(directory);
    // A supervisor Bun does not track: no exit event ever arrives for it.
    const untracked = (_command: string, _args: string[], options: SpawnOptions) => {
      const [, stdoutFd, stderrFd] = options.stdio as [unknown, number, number];
      const pid = spawnUntrackedChild(["sh", "-c", "printf sound"], { stdoutFd, stderrFd });
      owned.push(pid);
      const child = {
        pid,
        exitCode: null,
        signalCode: null,
        stdin: { destroy: () => undefined },
        on: () => child,
        once: () => child,
        kill: () => true,
      };
      return child as unknown as ChildProcess;
    };
    expect(
      await copyDatabaseInChildProcess(path.join(directory, "a"), path.join(directory, "b"), {
        spawn: untracked,
      }),
    ).toBe(true);
    const [pid] = owned;
    const deadline = Date.now() + 10_000;
    while (processState(pid!) !== undefined) {
      if (Date.now() > deadline) throw new Error(`pid ${pid} was not reaped`);
      await Bun.sleep(50);
    }
  }, 20_000);
});
