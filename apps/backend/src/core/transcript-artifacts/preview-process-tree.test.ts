import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

import { resolveDesignChromiumPath } from "../design/index.js";
import { isAlive, killTree, listProcesses } from "./preview-process-tree.js";
import { superviseWorker } from "./preview-supervisor.js";

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
    const renderedMarker = marker.replace(/\t/g, process.platform === "darwin" ? "\\011" : "?");
    const shell = entries.find((entry) => entry.command?.includes(renderedMarker));
    const children = shell ? entries.filter((entry) => entry.ppid === shell.pid) : [];
    if (shell && children.length > 0) return [shell.pid, ...children.map((entry) => entry.pid)];
    if (Date.now() > deadline) throw new Error("the marked process tree did not start");
    await Bun.sleep(20);
  }
}

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn("[preview-process-tree.test] browser case skipped: no Chromium executable");
const browserTest = CHROMIUM ? test : test.skip;

describe("killTree", () => {
  test("lists command lines only when asked", async () => {
    const plain = await listProcesses();
    const withCommands = await listProcesses({ commands: true });
    expect(plain.find((entry) => entry.pid === process.pid)?.command).toBeUndefined();
    expect(withCommands.find((entry) => entry.pid === process.pid)?.command).toBeTruthy();
  });

  for (const whitespace of ["", "two  spaces", "a\ttab"]) {
    test(`kills an escaped process tree with a literal ${JSON.stringify(whitespace)} marker`, async () => {
      const marker = path.join(
        tmpdir(),
        `ork-artifact-preview-${process.pid}-${randomUUID()}-${whitespace}`,
      );
      const child = spawnEscaped(marker);
      try {
        const pids = await waitForMarked(marker);
        const commands = await listProcesses({ commands: true });
        const renderedMarker = marker.replace(/\t/g, process.platform === "darwin" ? "\\011" : "?");
        expect(commands.find((entry) => entry.pid === child.pid)?.command).toContain(
          renderedMarker,
        );

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
    }, 10_000);
  }

  test("finds and kills an escaped tree whose tabbed marker follows a long command line", async () => {
    const marker = `${path.join(tmpdir(), `ork-preview-${randomUUID()}`)}-two  spaces-a\ttab`;
    // Beyond normal ps display widths: exercise actual BSD/procps rendering,
    // rather than only a mocked row or a marker at the beginning of argv.
    const child = spawnEscaped(`${"padding-".repeat(700)}${marker}`);
    try {
      const pids = await waitForMarked(marker);
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
  }, 10_000);

  // Python provides a real fork/setsid/stop boundary without running unsafe
  // post-fork JavaScript in Bun's multithreaded runtime.
  const python = "/usr/bin/python3";
  const forkTest =
    spawnSync(python, ["-c", "import os; assert hasattr(os, 'fork')"]).status === 0
      ? test
      : test.skip;
  forkTest(
    "kills an orphan held before exec beyond the empty-scan window",
    async () => {
      const worker = superviseWorker(
        {
          isolation: "process",
          command: python,
          args: [
            "-c",
            `
import os, signal, time
pid = os.fork()
if pid == 0:
    os.setsid()
    for fd in (0, 1, 2):
        os.close(fd)
    os.kill(os.getpid(), signal.SIGSTOP)
    os.execl('/bin/sleep', 'sleep', '30')
os.waitpid(pid, os.WUNTRACED)
with open('child.pid.tmp', 'w') as output:
    output.write(str(pid))
os.rename('child.pid.tmp', 'child.pid')
while True:
    time.sleep(1)
`,
          ],
        },
        {} as Parameters<typeof superviseWorker>[1],
        { workerWallMs: 10_000, readinessHardMs: 3000, mermaidRenderMs: 3000, cleanupGraceMs: 0 },
      );
      let childPid: number | undefined;
      try {
        const pidFile = path.join(worker.scratchDir()!, "child.pid");
        const deadline = Date.now() + 5000;
        while (!existsSync(pidFile)) {
          if (Date.now() > deadline) throw new Error("pre-exec child did not stop");
          await Bun.sleep(10);
        }
        childPid = Number(readFileSync(pidFile, "utf8"));
        // Hold the child longer than the old two-scan heuristic. It cannot exec
        // or acquire Chromium's profile argument during termination either.
        await Bun.sleep(350);
        process.kill(worker.workerPid()!, "SIGKILL");
        const report = await worker.exited;
        expect(report.verified).toBe(true);
        expect(report.pids).toContain(childPid);
        expect(isAlive(childPid, await listProcesses())).toBe(false);
        expect(existsSync(worker.scratchDir()!)).toBe(false);
      } finally {
        if (childPid) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* Already gone. */
          }
        }
        worker.cancel();
        await worker.exited;
        await worker.reap();
      }
    },
    15_000,
  );

  test("preserves command whitespace after the fixed ps columns", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "ork-literal-ps-"));
    const originalPath = process.env.PATH;
    const command = "browser --user-data-dir=/scratch/two  spaces/with\ttab/back\\011slash";
    writeFileSync(
      path.join(bin, "ps"),
      `#!/bin/sh\nprintf '%s\\n' '   42  1  42  12 S  ${command}'\n`,
    );
    chmodSync(path.join(bin, "ps"), 0o755);
    try {
      process.env.PATH = bin;
      expect(await listProcesses({ commands: true })).toEqual([
        { pid: 42, ppid: 1, pgid: 42, rssKiB: 12, zombie: false, command },
      ]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  for (const failure of ["exit", "timeout"]) {
    test(`does not verify exit when ps fails by ${failure}`, async () => {
      const bin = mkdtempSync(path.join(tmpdir(), "ork-failed-ps-"));
      const originalPath = process.env.PATH;
      writeFileSync(
        path.join(bin, "ps"),
        failure === "exit" ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\nexec /bin/sleep 30\n",
      );
      chmodSync(path.join(bin, "ps"), 0o755);
      try {
        process.env.PATH = bin;
        expect(await listProcesses({ commands: true })).toEqual([]);
        const report = await killTree([], [], 0, `missing-${randomUUID()}`);
        expect(report).toEqual({ pids: [], verified: false });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(bin, { recursive: true, force: true });
      }
    }, 10_000);
  }

  browserTest(
    "kills real Chromium and its helpers by their private profile marker",
    async () => {
      const profile = mkdtempSync(path.join(tmpdir(), "ork-chromium-two  spaces-"));
      let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
      try {
        context = await chromium.launchPersistentContext(profile, {
          executablePath: CHROMIUM!,
          headless: true,
        });
        await context.pages()[0]!.setContent("<p>owned preview</p>");
        const entries = await listProcesses({ commands: true });
        const browser = entries.find((entry) =>
          entry.command?.includes(`--user-data-dir=${profile}`),
        );
        expect(browser).toBeDefined();
        const report = await killTree([], [], 5_000, profile);
        expect(report.verified).toBe(true);
        expect(report.pids).toContain(browser!.pid);
        const remaining = await listProcesses({ commands: true });
        expect(
          remaining.filter((entry) => !entry.zombie && entry.command?.includes(profile)),
        ).toEqual([]);
        for (const pid of report.pids) expect(isAlive(pid, remaining)).toBe(false);
      } finally {
        await context?.close().catch(() => undefined);
        rmSync(profile, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
