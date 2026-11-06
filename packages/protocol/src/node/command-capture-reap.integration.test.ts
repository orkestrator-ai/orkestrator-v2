import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanUpUntrackedChild,
  loseBunExitsEntirely,
  processState,
} from "../testing/untracked-child.js";
import { CommandFailedError, runCommand } from "./command-capture.js";
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
    if (lost) lost.pids.splice(lost.pids.indexOf(pid), 1);
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

  // Bun can still handle the exit after the reap; its waitpid then fails with
  // ECHILD and `exited` rejects. The capture has settled, so that changes nothing.
  test("a late ECHILD from Bun after the reap is ignored", async () => {
    lost = loseBunExitsEntirely({ lateEchildMs: 5_000 });
    const { stdout } = await runCommand("sh", ["-c", "printf done"]);
    expect(stdout).toBe("done");
    await untilGone(lost.pids[0]!, 10_000);
    // Outlive the rejection: an unhandled one fails the test run.
    await Bun.sleep(2_500);
  }, 20_000);

  test("a success is reaped the same way", async () => {
    lost = loseBunExitsEntirely();
    const { stdout } = await runCommand("sh", ["-c", "printf done"]);
    expect(stdout).toBe("done");
    await untilGone(lost.pids[0]!, 10_000);
  }, 20_000);
  for (const reason of ["abort", "timeout", "overflow", "error"] as const) {
    test(`reaps after ${reason} settlement and preserves its failure classification`, async () => {
      lost = loseBunExitsEntirely(reason === "error" ? { errorMs: 50 } : {});
      const before = lostExitReaperStats().reaped;
      const controller = new AbortController();
      const pending = runCommand(
        "sh",
        ["-c", reason === "overflow" ? "printf 123456789; exec sleep 30" : "exec sleep 30"],
        {
          signal: controller.signal,
          timeoutMs: reason === "timeout" ? 50 : 5_000,
          maxOutputBytes: reason === "overflow" ? 4 : 1_024,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (reason === "abort") controller.abort();
      const failure = await pending;
      expect(failure).toBeInstanceOf(CommandFailedError);
      const error = failure as CommandFailedError;
      expect(error.aborted).toBe(reason === "abort");
      expect(error.timedOut).toBe(reason === "abort" || reason === "timeout");
      expect(error.outputLimitExceeded).toBe(reason === "overflow");
      if (reason === "error") expect(error.message).toBe("fixture runtime error");
      await untilGone(lost.pids[0]!, 10_000);
      expect(lostExitReaperStats().reaped).toBe(before + 1);
      // A released PID is no longer a cleanup candidate.
      expect(lost.pids).toEqual([]);
    }, 20_000);
  }

  test("real Bun late ECHILD after manual reaping cannot change an aborted capture or another child", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../testing/tracked-child-reap.fixture.ts", import.meta.url).pathname,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    expect(await output).toBe("tracked late ECHILD preserved\n");
  }, 15_000);
});
