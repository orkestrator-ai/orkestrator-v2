import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanUpUntrackedChild,
  processState,
  spawnUntrackedChild,
  untilZombie,
} from "../testing/untracked-child.js";
import {
  createLostExitReaper,
  darwinReaperSystem,
  type LostExitReaper,
  type LostExitReaperSystem,
} from "./lost-exit-reaper.js";

/** Real processes and the real `waitpid`, with a short grace so the suite stays fast. */
describe.skipIf(process.platform !== "darwin")("lost-exit reaper against the kernel", () => {
  const owned: number[] = [];
  let reaper: LostExitReaper | undefined;
  afterEach(() => {
    reaper?.stop();
    reaper = undefined;
    for (const pid of owned.splice(0)) cleanUpUntrackedChild(pid);
  });

  function realReaper(): { reaper: LostExitReaper; waited: number[] } {
    const system = darwinReaperSystem();
    if (!system) throw new Error("waitpid did not load");
    const waited: number[] = [];
    const recording: LostExitReaperSystem = {
      ...system,
      waitNoHang(pid) {
        waited.push(pid);
        return system.waitNoHang(pid);
      },
    };
    reaper = createLostExitReaper({
      system: recording,
      graceMs: 20,
      maxCheckMs: 20,
      maxChecks: 10,
    });
    return { reaper, waited };
  }

  async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await Bun.sleep(10);
    }
  }

  test("reaps a child of this process left as a zombie, so none remains", async () => {
    const pid = spawnUntrackedChild(["sh", "-c", "exit 3"]);
    owned.push(pid);
    await untilZombie(pid);
    expect(processState(pid)).toEqual({ ppid: process.pid, state: expect.stringMatching(/^Z/) });
    const { reaper, waited } = realReaper();
    reaper.reap(pid, () => false);
    await until(() => reaper.stats().reaped === 1);
    expect(waited).toEqual([pid]);
    owned.splice(owned.indexOf(pid), 1);
    expect(processState(pid)).toBeUndefined();
  });

  test("cleanup kills and reaps a running child and safely ignores another cleanup", () => {
    const pid = spawnUntrackedChild(["sleep", "30"]);
    owned.push(pid);
    cleanUpUntrackedChild(pid);
    owned.splice(owned.indexOf(pid), 1);
    expect(processState(pid)).toBeUndefined();
    expect(darwinReaperSystem()!.waitNoHang(pid)).toBe(-1);
    cleanUpUntrackedChild(pid);
  });

  test("leaves a child of this process that is still running", async () => {
    const pid = spawnUntrackedChild(["sleep", "30"]);
    owned.push(pid);
    await until(() => processState(pid) !== undefined);
    const { reaper, waited } = realReaper();
    reaper.reap(pid, () => false);
    await until(() => reaper.stats().abandoned === 1);
    expect(waited).toEqual([]);
    const state = processState(pid);
    expect(state?.ppid).toBe(process.pid);
    expect(state?.state).not.toMatch(/^Z/);
  });

  test("leaves a zombie the runtime has since reported", async () => {
    const pid = spawnUntrackedChild(["sh", "-c", "exit 0"]);
    owned.push(pid);
    await untilZombie(pid);
    const { reaper, waited } = realReaper();
    let reported = false;
    reaper.reap(pid, () => reported);
    reported = true;
    await Bun.sleep(100);
    expect(waited).toEqual([]);
    expect(processState(pid)?.state).toMatch(/^Z/);
  });

  test("never touches another process's zombie or that process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-reaper-"));
    const pidFile = path.join(directory, "pid");
    // The shell execs into a `sleep` that never waits, leaving its child a zombie of the sleep.
    const parent = spawn(
      "sh",
      ["-c", `sh -c 'sleep 0.1; exit 0' & echo $! > "$1"; exec sleep 30`, "sh", pidFile],
      { detached: true, stdio: "ignore" },
    );
    try {
      let zombie = 0;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        zombie = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (zombie && processState(zombie)?.state.startsWith("Z")) break;
        await Bun.sleep(10);
      }
      expect(processState(zombie)).toEqual({
        ppid: parent.pid!,
        state: expect.stringMatching(/^Z/),
      });
      const { reaper, waited } = realReaper();
      reaper.reap(zombie, () => false);
      await Bun.sleep(150);
      expect(waited).toEqual([]);
      expect(reaper.stats().reaped).toBe(0);
      expect(processState(zombie)).toEqual({
        ppid: parent.pid!,
        state: expect.stringMatching(/^Z/),
      });
      expect(processState(parent.pid!)?.state).not.toMatch(/^Z/);
      // And the kernel would refuse even if asked: it is not this process's child.
      expect(darwinReaperSystem()!.waitNoHang(zombie)).toBe(-1);
      expect(processState(zombie)?.state).toMatch(/^Z/);
    } finally {
      reaper?.stop();
      parent.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
