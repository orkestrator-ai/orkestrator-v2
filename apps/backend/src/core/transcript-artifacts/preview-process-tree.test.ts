import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { isAlive, killTree, listProcesses } from "./preview-process-tree.js";

/**
 * A process outside every root and owned group, as Chromium is when the
 * worker that launched it (in its own process group) is killed first. Only
 * its command line names the job's scratch. `; :` stops the shell from
 * exec'ing `sleep`, so the marked shell keeps a child of its own.
 */
function spawnEscaped(marker: string): ChildProcess {
  const child = spawn("sh", ["-c", "sleep 30; :", marker], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function waitForMarked(marker: string): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const entries = await listProcesses({ commands: true });
    const shell = entries.find((entry) => entry.command?.includes(marker));
    const children = shell ? entries.filter((entry) => entry.ppid === shell.pid) : [];
    if (shell && children.length > 0) return [shell.pid, ...children.map((entry) => entry.pid)];
    if (Date.now() > deadline) throw new Error("the marked process tree did not start");
    await Bun.sleep(20);
  }
}

describe("killTree", () => {
  test("lists command lines only when asked", async () => {
    const plain = await listProcesses();
    const withCommands = await listProcesses({ commands: true });
    expect(plain.find((entry) => entry.pid === process.pid)?.command).toBeUndefined();
    expect(withCommands.find((entry) => entry.pid === process.pid)?.command).toBeTruthy();
  });

  test("kills an escaped process tree that carries the scratch marker", async () => {
    const marker = path.join(tmpdir(), `ork-artifact-preview-${process.pid}-${randomUUID()}`);
    const child = spawnEscaped(marker);
    try {
      const pids = await waitForMarked(marker);

      // Without the marker the escaped tree is invisible: the pass reports a
      // verified exit while the process is still running (the 0247 leak).
      const blind = await killTree([], []);
      expect(blind.verified).toBe(true);
      expect(isAlive(pids[0]!)).toBe(true);

      const report = await killTree([], [], 3_000, marker);
      expect(report.verified).toBe(true);
      expect(report.pids).toEqual(expect.arrayContaining(pids));
      const entries = await listProcesses();
      for (const pid of pids) expect(isAlive(pid, entries)).toBe(false);
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});
