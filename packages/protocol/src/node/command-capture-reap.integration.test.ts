import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanUpUntrackedChild,
  loseBunExitsEntirely,
  processState,
} from "../testing/untracked-child.js";
import { runCommand } from "./command-capture.js";
import { lostExitReaperStats } from "./lost-exit-reaper.js";

/**
 * The whole path on macOS: Bun loses the exit, the watchdog settles the command
 * from the zombie's status, and the shared reaper reaps it after its grace.
 * Waits on the production timings (1 s watchdog, 2 s grace), so it is in the
 * slow tier.
 */
describe.skipIf(process.platform !== "darwin")("a child whose exit Bun lost", () => {
  let lost: ReturnType<typeof loseBunExitsEntirely> | undefined;
  afterEach(() => {
    lost?.restore();
    for (const pid of lost?.pids ?? []) cleanUpUntrackedChild(pid);
    lost = undefined;
  });

  async function untilGone(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (processState(pid) !== undefined) {
      if (Date.now() > deadline) throw new Error(`pid ${pid} is still ${processState(pid)?.state}`);
      await Bun.sleep(50);
    }
  }

  test("is settled with its real outcome and then reaped, leaving no zombie", async () => {
    lost = loseBunExitsEntirely();
    const before = lostExitReaperStats().reaped;
    const failure = await runCommand("sh", ["-c", "printf out; exit 4"]).then(
      () => undefined,
      (error: { exitCode?: number; stdout?: string }) => error,
    );
    expect(failure?.exitCode).toBe(4);
    expect(failure?.stdout).toBe("out");
    const [pid] = lost.pids;
    // Settled, but Bun never reaped it.
    expect(processState(pid!)).toEqual({ ppid: process.pid, state: expect.stringMatching(/^Z/) });
    await untilGone(pid!, 10_000);
    expect(lostExitReaperStats().reaped).toBe(before + 1);
  }, 20_000);

  test("a success is reaped the same way", async () => {
    lost = loseBunExitsEntirely();
    const { stdout } = await runCommand("sh", ["-c", "printf done"]);
    expect(stdout).toBe("done");
    await untilGone(lost.pids[0]!, 10_000);
  }, 20_000);
});
