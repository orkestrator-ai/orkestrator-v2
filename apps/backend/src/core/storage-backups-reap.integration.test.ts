import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
    owned.splice(owned.indexOf(pid!), 1);
  }, 20_000);
  for (const reason of ["deadline", "error"] as const) {
    test(`reaps after supervisor ${reason} settlement without changing the rejection`, async () => {
      const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-reap-"));
      directories.push(directory);
      let signals = 0;
      const untracked = (_command: string, _args: string[], options: SpawnOptions) => {
        const [, stdoutFd, stderrFd] = options.stdio as [unknown, number, number];
        const pid = spawnUntrackedChild(["sleep", "30"], { stdoutFd, stderrFd });
        owned.push(pid);
        const child = Object.assign(new EventEmitter(), {
          pid,
          exitCode: null,
          signalCode: null,
          // Error settlement closes the supervisor's liveness pipe too.
          stdin: {
            destroy: () => {
              process.kill(pid, "SIGKILL");
            },
          },
          kill: () => {
            signals++;
            process.kill(pid, "SIGKILL");
            return true;
          },
        });
        if (reason === "error")
          setTimeout(() => child.emit("error", new Error("supervisor transport error")), 20);
        return child as unknown as ChildProcess;
      };
      await expect(
        copyDatabaseInChildProcess(path.join(directory, "a"), path.join(directory, "b"), {
          spawn: untracked,
          timeoutMs: 50,
          settleGraceMs: 0,
        }),
      ).rejects.toThrow(
        reason === "deadline" ? "its process never reported an exit" : "supervisor transport error",
      );
      const pid = owned[0]!;
      const deadline = Date.now() + 10_000;
      while (processState(pid) !== undefined) {
        if (Date.now() > deadline) throw new Error("supervisor was not reaped");
        await Bun.sleep(50);
      }
      owned.splice(owned.indexOf(pid), 1);
      const signalsAtReap = signals;
      await Bun.sleep(100);
      expect(signals).toBe(signalsAtReap);
    }, 20_000);
  }
});
