import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { spawn } from "node:child_process";
import {
  listenCode,
  waitCode,
  parseRunCount,
  resourceActivityCode,
  resourceQuietCode,
} from "../../e2e/agent-testing/local-gateway-transport-cpu-page";
import {
  withProfilers,
  withStartingProcess,
} from "../../e2e/agent-testing/local-gateway-transport-lifecycle";
import { ownProcessGroup, processAlive, stopProcessGroup } from "../../e2e/process-cleanup";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("run count rejects empty, invalid, fractional and unbounded measurements", () => {
  expect(parseRunCount(undefined)).toBe(3);
  expect(parseRunCount("1")).toBe(1);
  for (const value of ["", "abc", "0", "-1", "1.5", "Infinity", "11"]) {
    expect(() => parseRunCount(value)).toThrow("integer from 1 to 10");
  }
});

test("resource observer still postpones quiet time after the 250-entry buffer fills", () => {
  let now = 0;
  let delivered: ((list: { getEntries(): object[] }) => void) | undefined;
  const page = {
    performance: { now: () => now, getEntriesByType: () => Array(250).fill({}) },
    PerformanceObserver: class {
      constructor(callback: typeof delivered) {
        delivered = callback;
      }
      observe() {}
      takeRecords() {
        return [];
      }
    },
  };
  runInNewContext(resourceActivityCode, page);
  delivered!({ getEntries: () => Array(300).fill({}) });
  now = 2999;
  expect(runInNewContext(resourceQuietCode, page)).toBe(false);
  delivered!({ getEntries: () => [{}] });
  now = 5000;
  expect(runInNewContext(resourceQuietCode, page)).toBe(false);
  now = 6000;
  expect(runInNewContext(resourceQuietCode, page)).toBe(true);
});

test("initial direct stream readiness precedes snapshot acknowledgement and READY", async () => {
  const calls: string[] = [];
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const page = {
    window: {
      orkestratorDesktopHost: {},
      orkestrator: {
        listen: () => {
          calls.push("listen");
          return () => {};
        },
        eventStreamReady: async () => {
          calls.push("connecting");
          await ready;
        },
        invoke: async (command: string) => {
          calls.push(command);
          return { generation: 1, revision: 1 };
        },
      },
    },
  };
  const listening = runInNewContext(listenCode("test"), page) as Promise<void>;
  await tick();
  expect(calls).toEqual(["listen", "connecting"]);
  connected();
  await listening;
  calls.push("READY");
  expect(calls).toEqual([
    "listen",
    "connecting",
    "get_terminal_output_snapshot",
    "terminal_snapshot_applied",
    "READY",
  ]);
});

test("one desync recovers once and does not poll snapshots in later measurements", async () => {
  let callback!: (payload: object) => void;
  let snapshots = 0;
  const page = {
    window: {
      orkestrator: {
        listen: (_: string, listener: typeof callback) => {
          callback = listener;
          return () => {};
        },
        invoke: async (command: string) => {
          if (command === "get_terminal_output_snapshot") snapshots++;
          return { output: "", generation: 1, revision: 1 };
        },
      },
    },
  };
  await runInNewContext(listenCode("test"), page);
  const first = runInNewContext(waitCode("test", "FIRST"), page) as Promise<number>;
  callback({ desynced: true });
  await tick();
  await tick();
  expect(snapshots).toBe(1);
  callback({ text: "FIRST" });
  await first;
  const second = runInNewContext(waitCode("test", "SECOND"), page) as Promise<number>;
  await tick();
  expect(snapshots).toBe(1);
  callback({ text: "SECOND" });
  await second;
  expect(snapshots).toBe(1);
});

test("profilers both stop when work throws, even when stopping CPU fails", async () => {
  const calls: string[] = [];
  await expect(
    withProfilers(
      {
        startTrace: async () => {
          calls.push("trace start");
        },
        startCpu: async () => {
          calls.push("cpu start");
        },
        stopCpu: async () => {
          calls.push("cpu stop");
          throw new Error("stop failed");
        },
        stopTrace: async () => {
          calls.push("trace stop");
        },
      },
      async () => {
        throw new Error("work failed");
      },
    ),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(calls).toEqual(["trace start", "cpu start", "cpu stop", "trace stop"]);
});

test("trace stops if CPU startup fails", async () => {
  let stopped = false;
  await expect(
    withProfilers(
      {
        startTrace: async () => {},
        startCpu: async () => {
          throw new Error("start failed");
        },
        stopTrace: async () => {
          stopped = true;
        },
        stopCpu: async () => {},
      },
      async () => {},
    ),
  ).rejects.toThrow("start failed");
  expect(stopped).toBe(true);
});

test("failed readiness stops the spawned process group before returning failure", async () => {
  const child = ownProcessGroup(
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    }),
  );
  try {
    await expect(
      withStartingProcess(child, async () => {
        throw new Error("URL unavailable");
      }),
    ).rejects.toThrow("URL unavailable");
    expect(processAlive(-child.pid!)).toBe(false);
  } finally {
    await stopProcessGroup(child);
  }
});
