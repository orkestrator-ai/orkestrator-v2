import { describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProcessTable,
  reapProcessGroup,
  terminateProcessTree,
  type ProcessTreeRuntime,
  type ProcessTreeSignal,
} from "../src/core/process-tree";

function createChild(pid = 100, exitCode: number | null = null): ChildProcessWithoutNullStreams {
  return {
    pid,
    exitCode,
    signalCode: null,
    kill: mock(() => true),
  } as unknown as ChildProcessWithoutNullStreams;
}

function createRuntime(
  options: {
    descendants?: number[];
    exitOn?: ProcessTreeSignal;
  } = {},
): {
  runtime: ProcessTreeRuntime;
  signals: Array<[target: string | number, signal: ProcessTreeSignal]>;
} {
  let clock = 0;
  const running = new Set(options.descendants ?? [101, 102]);
  const signals: Array<[target: string | number, signal: ProcessTreeSignal]> = [];
  const runtime: ProcessTreeRuntime = {
    listDescendants: mock(async () => [...running]),
    signalGroup: mock((pid, signal) => {
      signals.push([`group:${pid}`, signal]);
    }),
    signalPid: mock((pid, signal) => {
      signals.push([pid, signal]);
      if (signal === options.exitOn) running.delete(pid);
    }),
    signalChild: mock((child, signal) => {
      signals.push([`child:${child.pid}`, signal]);
      if (signal === options.exitOn) {
        (child as { signalCode: NodeJS.Signals | null }).signalCode = signal;
      }
    }),
    isPidRunning: (pid) => running.has(pid),
    now: () => clock,
    sleep: async (timeoutMs) => {
      clock += timeoutMs;
    },
  };
  return { runtime, signals };
}

describe("process-tree termination", () => {
  test("parses every recursive descendant and ignores malformed process rows", () => {
    expect(
      parseProcessTable(
        `
      10 1
      11 10
      malformed
      12 11
      13 10
      14 999
    `,
        10,
      ),
    ).toEqual([11, 13, 12]);
  });

  test("stops the direct child, its process group, and detached descendants with SIGTERM", async () => {
    const child = createChild();
    const { runtime, signals } = createRuntime({ exitOn: "SIGTERM" });

    await expect(
      terminateProcessTree(child, {
        graceMs: 10,
        killWaitMs: 10,
        pollIntervalMs: 1,
        runtime,
      }),
    ).resolves.toBe(true);

    expect(signals).toContainEqual(["group:100", "SIGTERM"]);
    expect(signals).toContainEqual([101, "SIGTERM"]);
    expect(signals).toContainEqual([102, "SIGTERM"]);
    expect(signals).toContainEqual(["child:100", "SIGTERM"]);
    expect(signals.some(([, signal]) => signal === "SIGKILL")).toBe(false);
  });

  test("rescans and escalates the full tree to SIGKILL after the grace deadline", async () => {
    const child = createChild();
    const { runtime, signals } = createRuntime({ exitOn: "SIGKILL" });

    await expect(
      terminateProcessTree(child, {
        graceMs: 2,
        killWaitMs: 2,
        pollIntervalMs: 1,
        runtime,
      }),
    ).resolves.toBe(true);

    expect(runtime.listDescendants).toHaveBeenCalledTimes(2);
    expect(signals).toContainEqual(["group:100", "SIGKILL"]);
    expect(signals).toContainEqual([101, "SIGKILL"]);
    expect(signals).toContainEqual([102, "SIGKILL"]);
    expect(signals).toContainEqual(["child:100", "SIGKILL"]);
  });

  test("reports failure when the process tree survives both deadlines", async () => {
    const child = createChild();
    const { runtime } = createRuntime();

    await expect(
      terminateProcessTree(child, {
        graceMs: 1,
        killWaitMs: 1,
        pollIntervalMs: 1,
        runtime,
      }),
    ).resolves.toBe(false);
  });

  test("treats a child that never spawned as drained without waiting", async () => {
    const child = createChild();
    (child as { pid?: number }).pid = undefined;
    const { runtime, signals } = createRuntime();

    await expect(
      terminateProcessTree(child, {
        graceMs: 1_000,
        killWaitMs: 1_000,
        pollIntervalMs: 1,
        runtime,
      }),
    ).resolves.toBe(true);
    expect(signals).toEqual([]);
    expect(runtime.listDescendants).not.toHaveBeenCalled();
  });

  test("treats an already-exited child with no descendants as drained", async () => {
    const child = createChild(100, 0);
    const { runtime, signals } = createRuntime({ descendants: [] });

    await expect(
      terminateProcessTree(child, {
        graceMs: 1,
        killWaitMs: 1,
        runtime,
      }),
    ).resolves.toBe(true);
    expect(signals).toEqual([]);
  });

  test("drains a real missing-executable spawn without polling or signalling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ork-process-tree-spawn-"));
    try {
      const child = spawn(join(directory, "missing-executable"), [], { stdio: "pipe" });
      const error = await new Promise<NodeJS.ErrnoException>((resolve) =>
        child.once("error", resolve),
      );
      expect(error.code).toBe("ENOENT");
      expect(child.pid).toBeUndefined();
      const { runtime, signals } = createRuntime();
      await expect(
        terminateProcessTree(child, { graceMs: 1000, killWaitMs: 1000, runtime }),
      ).resolves.toBe(true);
      expect(runtime.listDescendants).not.toHaveBeenCalled();
      expect(signals).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("process-group reaping after the leader exited", () => {
  function groupSignaller(options: { members: number; leaveOn?: ProcessTreeSignal }) {
    let members = options.members;
    const signals: Array<ProcessTreeSignal | 0> = [];
    const signalGroup = (_pgid: number, signal: ProcessTreeSignal | 0) => {
      signals.push(signal);
      if (members === 0) return false;
      if (signal !== 0 && signal === options.leaveOn) members = 0;
      return true;
    };
    let clock = 0;
    return {
      signals,
      options: {
        graceMs: 1_000,
        killWaitMs: 500,
        signalGroup,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      },
    };
  }

  test("an empty group answers empty after one signal", async () => {
    const { signals, options } = groupSignaller({ members: 0 });
    await expect(reapProcessGroup(4242, options)).resolves.toBe("empty");
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("members that leave on SIGTERM are never killed", async () => {
    const { signals, options } = groupSignaller({ members: 1, leaveOn: "SIGTERM" });
    await expect(reapProcessGroup(4242, options)).resolves.toBe("stopped");
    expect(signals).not.toContain("SIGKILL");
  });

  test("members that outlast the grace are killed, and a survivor is reported", async () => {
    const killed = groupSignaller({ members: 1, leaveOn: "SIGKILL" });
    await expect(reapProcessGroup(4242, killed.options)).resolves.toBe("stopped");
    expect(killed.signals[0]).toBe("SIGTERM");
    expect(killed.signals).toContain("SIGKILL");
    const stuck = groupSignaller({ members: 1 });
    await expect(reapProcessGroup(4242, stuck.options)).resolves.toBe("survived");
  });

  test("never signals a missing pid or the init and session groups", async () => {
    for (const pgid of [undefined, 0, 1]) {
      const { signals, options } = groupSignaller({ members: 1 });
      await expect(reapProcessGroup(pgid, options)).resolves.toBe("empty");
      expect(signals).toEqual([]);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a real orphan left by a SIGKILLed detached leader is stopped",
    async () => {
      // The leader starts a child that ignores stdin EOF, as an agent CLI with
      // a request in flight does, then is killed the way a crashed bridge is.
      const leader = spawn("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const orphan = Number(
        await new Promise<string>((resolve) =>
          leader.stdout.once("data", (data) => resolve(String(data))),
        ),
      );
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const exited = new Promise((resolve) => leader.once("exit", resolve));
        leader.kill("SIGKILL");
        await exited;
        expect(alive(orphan)).toBe(true);
        await expect(
          reapProcessGroup(leader.pid, { graceMs: 2_000, killWaitMs: 1_000 }),
        ).resolves.toBe("stopped");
        expect(alive(orphan)).toBe(false);
        await expect(
          reapProcessGroup(leader.pid, { graceMs: 2_000, killWaitMs: 1_000 }),
        ).resolves.toBe("empty");
      } finally {
        // Only this test's own child, by the pid it reported.
        if (alive(orphan)) process.kill(orphan, "SIGKILL");
      }
    },
  );
});
