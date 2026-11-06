import { afterEach, describe, expect, test } from "bun:test";
import {
  createLostExitReaper,
  createDarwinLostExitReaper,
  type LostExitReaper,
  type LostExitReaperSystem,
} from "./lost-exit-reaper.js";

import { configureLogger, resetLogger } from "../logger.js";

const SELF = 4242;

type FakeProcess = { ppid: number; state: string };

/** A process table and a `waitpid` that only answers this process's zombies, as the kernel does. */
function fakeSystem(table: Map<number, FakeProcess>, inspectFails = false) {
  const waited: number[] = [];
  const system: LostExitReaperSystem = {
    selfPid: SELF,
    inspect: (pid) => (inspectFails ? undefined : (table.get(pid) ?? "gone")),
    waitNoHang(pid) {
      waited.push(pid);
      const found = table.get(pid);
      if (!found || found.ppid !== SELF) return -1;
      if (!found.state.startsWith("Z")) return 0;
      table.delete(pid);
      return pid;
    },
  };
  return { system, waited };
}

const settle = (ms = 40) => Bun.sleep(ms);

describe("createLostExitReaper", () => {
  let reaper: LostExitReaper | undefined;
  afterEach(() => {
    reaper?.stop();
    resetLogger();
  });

  const fastReaper = (system: LostExitReaperSystem, options = {}) =>
    (reaper = createLostExitReaper({
      system,
      graceMs: 5,
      maxCheckMs: 5,
      maxChecks: 4,
      ...options,
    }));

  test("reaps this process's zombie after the grace period", async () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    expect(waited).toEqual([]);
    await settle();
    expect(waited).toEqual([100]);
    expect(table.has(100)).toBe(false);
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 1, abandoned: 0 });
  });

  test("does nothing once the runtime has reported the exit", async () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    let reported = false;
    reaper.reap(100, () => reported);
    reported = true;
    await settle();
    expect(waited).toEqual([]);
    expect(table.has(100)).toBe(true);
    // Already reported when handed over: not even watched.
    reaper.reap(101, () => true);
    expect(reaper.stats().pending).toBe(0);
  });

  test("never waits on a zombie whose parent is another process", async () => {
    const table = new Map([[100, { ppid: 7, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    await settle();
    expect(waited).toEqual([]);
    expect(table.get(100)).toEqual({ ppid: 7, state: "Z" });
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 0 });
  });

  test("never waits on a child that is still running, and gives up after its checks", async () => {
    const table = new Map([[100, { ppid: SELF, state: "S" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    await settle(80);
    expect(waited).toEqual([]);
    expect(table.get(100)).toEqual({ ppid: SELF, state: "S" });
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 1 });
  });

  test("reaps a child that becomes a zombie between checks", async () => {
    const table = new Map([[100, { ppid: SELF, state: "R" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system, { maxChecks: 50 });
    reaper.reap(100, () => false);
    await settle(20);
    expect(waited).toEqual([]);
    table.set(100, { ppid: SELF, state: "Z" });
    await settle();
    expect(waited).toEqual([100]);
    expect(reaper.stats().reaped).toBe(1);
  });

  test("leaves a PID that names no process", async () => {
    const { system, waited } = fakeSystem(new Map());
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    await settle();
    expect(waited).toEqual([]);
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 0 });
  });

  test("never waits while ps cannot say what the PID is", async () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table, true);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    await settle(80);
    expect(waited).toEqual([]);
    expect(reaper.stats().abandoned).toBe(1);
  });

  test("refuses this process, init and invalid PIDs", async () => {
    const { system, waited } = fakeSystem(
      new Map([
        [1, { ppid: 0, state: "Z" }],
        [SELF, { ppid: 1, state: "Z" }],
      ]),
    );
    const reaper = fastReaper(system);
    for (const pid of [0, -5, 1, SELF, 1.5, Number.NaN]) reaper.reap(pid, () => false);
    await settle();
    expect(waited).toEqual([]);
    expect(reaper.stats().pending).toBe(0);
  });

  test("bounds how many children it waits on", async () => {
    const table = new Map([
      [100, { ppid: SELF, state: "Z" }],
      [101, { ppid: SELF, state: "Z" }],
      [102, { ppid: SELF, state: "Z" }],
    ]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system, { maxPending: 2 });
    for (const pid of [100, 101, 102]) reaper.reap(pid, () => false);
    expect(reaper.stats()).toEqual({ pending: 2, reaped: 0, abandoned: 1 });
    await settle();
    expect(waited.sort()).toEqual([100, 101]);
    expect(table.has(102)).toBe(true);
  });

  test("watches a PID once however often it is handed over", async () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    reaper.reap(100, () => false);
    expect(reaper.stats().pending).toBe(1);
    await settle();
    expect(waited).toEqual([100]);
  });
  test("abandons a failed waitpid without waiting again on a released PID", async () => {
    const { system, waited } = fakeSystem(new Map([[100, { ppid: SELF, state: "Z" }]]));
    system.waitNoHang = (pid) => {
      waited.push(pid);
      return -1;
    };
    const events: string[] = [];
    configureLogger({
      sink: (output) => {
        events.push(output.line);
      },
    });
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    await settle();
    expect(waited).toEqual([100]);
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 1 });
    expect(events.some((line) => line.includes("reason=waitpid-failed"))).toBe(true);
  });

  for (const operation of ["inspect", "waitNoHang"] as const) {
    test(`retries after ${operation} throws, then reaps once`, async () => {
      const { system, waited } = fakeSystem(new Map([[100, { ppid: SELF, state: "Z" }]]));
      let calls = 0;
      const failOnce = () => {
        if (++calls === 1) throw new Error("temporary kernel failure");
      };
      if (operation === "inspect") {
        const original = system.inspect;
        system.inspect = (pid) => {
          failOnce();
          return original(pid);
        };
      } else {
        const original = system.waitNoHang;
        system.waitNoHang = (pid) => {
          failOnce();
          return original(pid);
        };
      }
      const reaper = fastReaper(system);
      reaper.reap(100, () => false);
      await settle();
      expect(calls).toBe(2);
      expect(waited).toEqual([100]);
      expect(reaper.stats()).toEqual({ pending: 0, reaped: 1, abandoned: 0 });
    });

    test(`bounds retries when ${operation} keeps throwing`, async () => {
      const { system } = fakeSystem(new Map([[100, { ppid: SELF, state: "Z" }]]));
      let calls = 0;
      system[operation] = () => {
        calls++;
        throw new Error("persistent failure");
      };
      const reaper = fastReaper(system);
      reaper.reap(100, () => false);
      await settle(80);
      expect(calls).toBe(4);
      expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 1 });
    });
  }

  for (const stage of ["require", "dlopen"] as const) {
    test(`logs unavailable and disables reaping when ${stage} fails`, () => {
      const events: string[] = [];
      configureLogger({
        sink: (output) => {
          events.push(output.line);
        },
      });
      const load = () => {
        if (stage === "require") throw new Error("no bun:ffi");
        return {
          FFIType: { i32: 1, ptr: 2 },
          dlopen: () => {
            throw new Error("no libSystem");
          },
        };
      };
      expect(createDarwinLostExitReaper(load)).toBeNull();
      expect(events).toEqual(["[process] child.reap-unavailable"]);
    });
  }
});
