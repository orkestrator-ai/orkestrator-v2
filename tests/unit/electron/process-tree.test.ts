import { describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  parseProcessTable,
  terminateProcessTree,
  type ProcessTreeRuntime,
  type ProcessTreeSignal,
} from "../../../apps/backend/src/core/process-tree";

function createChild(pid = 100): ChildProcessWithoutNullStreams {
  return {
    pid,
    exitCode: null,
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

  test("treats an already-exited child with no descendants as drained", async () => {
    const child = createChild();
    child.exitCode = 0;
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
});
