import { describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeElectronWithin } from "../../e2e/agent-testing/design-electron-cleanup";
import {
  ownedProcessGroupLeaders,
  ownProcessGroup,
  processAlive,
  signalProcess,
  stopOwnedProcessGroups,
  stopProcessGroup,
  waitForStopped,
} from "../../e2e/process-cleanup";

const processCleanupModule = fileURLToPath(
  new URL("../../e2e/process-cleanup.ts", import.meta.url),
);

/** `sh` that starts a `sleep` child, prints the child's pid, then waits on it. */
function spawnShellWithChild(detached: boolean): ChildProcess {
  return spawn("sh", ["-c", "sleep 600 & echo $!; wait"], {
    detached,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function firstLine(child: ChildProcess): Promise<string> {
  const lines = createInterface({ input: child.stdout! });
  try {
    for await (const line of lines) return line;
    throw new Error("Process exited before printing a line");
  } finally {
    lines.close();
  }
}

function killIfAlive(pid: number | undefined): void {
  if (pid && processAlive(pid)) signalProcess(pid, "SIGKILL");
}

describe("Electron spec process ownership", () => {
  test("an exiting process kills every detached group it still owns", async () => {
    // A worker that never reaches the spec's `finally` (Playwright abandoned a
    // timed-out test) and exits: the group and its members must not survive it.
    const source = `
      import { spawn } from "node:child_process";
      import { createInterface } from "node:readline";
      import { ownProcessGroup } from ${JSON.stringify(processCleanupModule)};
      const child = ownProcessGroup(
        spawn("sh", ["-c", "sleep 600 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] }),
      );
      for await (const member of createInterface({ input: child.stdout })) {
        process.stdout.write(JSON.stringify({ group: child.pid, member: Number(member) }));
        process.exit(0);
      }
    `;
    const { group, member } = JSON.parse(
      execFileSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 20_000 }),
    ) as { group: number; member: number };
    try {
      expect(member).toBeGreaterThan(0);
      await waitForStopped([-group], 5_000);
      expect(processAlive(member)).toBe(false);
    } finally {
      if (processAlive(-group)) signalProcess(-group, "SIGKILL");
    }
  }, 15_000);

  test("stopping an owned group releases it, and the teardown stops the rest", async () => {
    const released = ownProcessGroup(spawnShellWithChild(true));
    const remaining = [
      ownProcessGroup(spawnShellWithChild(true)),
      ownProcessGroup(spawnShellWithChild(true)),
    ];
    const members = await Promise.all([released, ...remaining].map(firstLine));
    try {
      expect(ownedProcessGroupLeaders()).toEqual(
        [released, ...remaining].map((child) => child.pid!),
      );

      await stopProcessGroup(released);
      expect(ownedProcessGroupLeaders()).toEqual(remaining.map((child) => child.pid!));

      await stopOwnedProcessGroups();
      expect(ownedProcessGroupLeaders()).toEqual([]);
      for (const child of [released, ...remaining]) expect(processAlive(-child.pid!)).toBe(false);
      for (const member of members) expect(processAlive(Number(member))).toBe(false);
    } finally {
      for (const child of [released, ...remaining]) {
        if (processAlive(-child.pid!)) signalProcess(-child.pid!, "SIGKILL");
      }
    }
  });

  test("a close that never settles is bounded and the Electron tree is killed", async () => {
    const electronProcess = spawnShellWithChild(false);
    const helper = Number(await firstLine(electronProcess));
    try {
      const app = { close: () => new Promise<void>(() => {}), process: () => electronProcess };
      expect(await closeElectronWithin(app as never, 100)).toBe("killed");
      expect(processAlive(electronProcess.pid!)).toBe(false);
      expect(processAlive(helper)).toBe(false);
    } finally {
      killIfAlive(helper);
      killIfAlive(electronProcess.pid);
    }
  });

  test.each([false, true])(
    "retains orphaned descendants when close exits the root (pending=%s)",
    async (pending) => {
      const electronProcess = spawn("sh", ["-c", "sleep 600 & echo $!; read command; exit 0"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const helper = Number(await firstLine(electronProcess));
      const exited = new Promise((resolve) => electronProcess.once("exit", resolve));
      let reaped = false;
      let orphanSurvived = false;
      try {
        const app = {
          close: async () => {
            electronProcess.stdin!.end("quit\n");
            await exited;
            reaped = true;
            orphanSurvived = !processAlive(electronProcess.pid!) && processAlive(helper);
            if (pending) await new Promise<void>(() => {});
          },
          process: () => {
            if (reaped) throw new Error("Playwright handle no longer exposes its process");
            return electronProcess;
          },
        };
        expect(await closeElectronWithin(app as never, 1_000)).toBe("killed");
        expect(reaped).toBe(true);
        expect(orphanSurvived).toBe(true);
        expect(processAlive(helper)).toBe(false);
      } finally {
        killIfAlive(helper);
        killIfAlive(electronProcess.pid);
      }
    },
  );

  test("retains descendants when an intermediate parent is reaped during a pending close", async () => {
    const electronProcess = spawn(
      process.execPath,
      [
        "--eval",
        `
      const { spawn } = require("node:child_process");
      const parent = spawn("sh", ["-c", 'sleep 600 & echo "$$ $!"; read command; exit 0'], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      parent.stdout.pipe(process.stdout);
      process.stdin.once("data", () => parent.stdin.end("quit\\n"));
      parent.once("exit", () => process.stdout.write("reaped\\n"));
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const [parent, helper] = (await firstLine(electronProcess)).split(" ").map(Number);
    let orphanSurvived = false;
    try {
      const app = {
        close: async () => {
          const reaped = firstLine(electronProcess);
          electronProcess.stdin!.write("quit\n");
          orphanSurvived =
            (await reaped) === "reaped" &&
            !processAlive(parent!) &&
            processAlive(electronProcess.pid!) &&
            processAlive(helper!);
          await new Promise<void>(() => {});
        },
        process: () => electronProcess,
      };
      expect(await closeElectronWithin(app as never, 1_000)).toBe("killed");
      expect(orphanSurvived).toBe(true);
      expect(processAlive(helper!)).toBe(false);
    } finally {
      killIfAlive(helper);
      killIfAlive(parent);
      killIfAlive(electronProcess.pid);
    }
  });

  test("a close that fails with Electron still running kills the tree", async () => {
    const electronProcess = spawnShellWithChild(false);
    const helper = Number(await firstLine(electronProcess));
    try {
      const app = {
        close: () => Promise.reject(new Error("Target closed")),
        process: () => electronProcess,
      };
      expect(await closeElectronWithin(app as never, 5_000)).toBe("killed");
      expect(processAlive(helper)).toBe(false);
    } finally {
      killIfAlive(helper);
      killIfAlive(electronProcess.pid);
    }
  });

  test("a close that stops Electron is left alone", async () => {
    // Not `sh -c`: dash forks the sleep instead of exec'ing it, and the
    // orphaned child would make a clean close look like a kill.
    const electronProcess = spawn("sleep", ["600"], { stdio: "ignore" });
    const exited = new Promise((resolve) => electronProcess.once("exit", resolve));
    try {
      const app = {
        close: async () => {
          electronProcess.kill("SIGTERM");
          await exited;
        },
        process: () => electronProcess,
      };
      expect(await closeElectronWithin(app as never, 5_000)).toBe("closed");
      expect(await closeElectronWithin(null)).toBe("closed");
    } finally {
      killIfAlive(electronProcess.pid);
    }
  });
});
