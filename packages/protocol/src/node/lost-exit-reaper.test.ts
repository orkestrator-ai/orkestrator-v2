import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createLostExitReaper,
  createDarwinLostExitReaper,
  type LostExitReaper,
  type LostExitReaperSystem,
} from "./lost-exit-reaper.js";

import { configureLogger, resetLogger } from "../logger.js";
import { ManualClock } from "../testing/manual-clock.js";

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

/**
 * Longer than every check `fastReaper` makes: a 5 ms grace, then at most 50
 * checks 5 ms apart.
 */
const PAST_EVERY_CHECK_MS = 1_000;

describe("createLostExitReaper", () => {
  let reaper: LostExitReaper | undefined;
  let clock = new ManualClock();
  beforeEach(() => {
    clock = new ManualClock();
  });
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
      timers: clock,
      ...options,
    }));

  test("reaps this process's zombie after the grace period", () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    expect(waited).toEqual([]);
    clock.advance(4);
    expect(waited).toEqual([]);
    clock.advance(1);
    expect(waited).toEqual([100]);
    expect(table.has(100)).toBe(false);
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 1, abandoned: 0 });
  });

  test("does nothing once the runtime has reported the exit", () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    let reported = false;
    reaper.reap(100, () => reported);
    reported = true;
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([]);
    expect(table.has(100)).toBe(true);
    // Already reported when handed over: not even watched.
    reaper.reap(101, () => true);
    expect(reaper.stats().pending).toBe(0);
  });

  test("never waits on a zombie whose parent is another process", () => {
    const table = new Map([[100, { ppid: 7, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([]);
    expect(table.get(100)).toEqual({ ppid: 7, state: "Z" });
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 0 });
  });

  test("never waits on a child that is still running, and gives up after its checks", () => {
    const table = new Map([[100, { ppid: SELF, state: "S" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([]);
    expect(table.get(100)).toEqual({ ppid: SELF, state: "S" });
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 1 });
  });

  test("reaps a child that becomes a zombie between checks", () => {
    const table = new Map([[100, { ppid: SELF, state: "R" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system, { maxChecks: 50 });
    reaper.reap(100, () => false);
    // The grace and three more checks see a running child.
    clock.advance(20);
    expect(waited).toEqual([]);
    expect(reaper.stats().pending).toBe(1);
    table.set(100, { ppid: SELF, state: "Z" });
    clock.advance(5);
    expect(waited).toEqual([100]);
    expect(reaper.stats().reaped).toBe(1);
  });

  test("leaves a PID that names no process", () => {
    const { system, waited } = fakeSystem(new Map());
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([]);
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 0 });
  });

  test("never waits while ps cannot say what the PID is", () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table, true);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([]);
    expect(reaper.stats().abandoned).toBe(1);
  });

  test("refuses this process, init and invalid PIDs", () => {
    const { system, waited } = fakeSystem(
      new Map([
        [1, { ppid: 0, state: "Z" }],
        [SELF, { ppid: 1, state: "Z" }],
      ]),
    );
    const reaper = fastReaper(system);
    for (const pid of [0, -5, 1, SELF, 1.5, Number.NaN]) reaper.reap(pid, () => false);
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([]);
    expect(reaper.stats().pending).toBe(0);
  });

  test("bounds how many children it waits on", () => {
    const table = new Map([
      [100, { ppid: SELF, state: "Z" }],
      [101, { ppid: SELF, state: "Z" }],
      [102, { ppid: SELF, state: "Z" }],
    ]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system, { maxPending: 2 });
    for (const pid of [100, 101, 102]) reaper.reap(pid, () => false);
    expect(reaper.stats()).toEqual({ pending: 2, reaped: 0, abandoned: 1 });
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited.sort()).toEqual([100, 101]);
    expect(table.has(102)).toBe(true);
  });

  test("watches a PID once however often it is handed over", () => {
    const table = new Map([[100, { ppid: SELF, state: "Z" }]]);
    const { system, waited } = fakeSystem(table);
    const reaper = fastReaper(system);
    reaper.reap(100, () => false);
    reaper.reap(100, () => false);
    expect(reaper.stats().pending).toBe(1);
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([100]);
  });
  test("abandons a failed waitpid without waiting again on a released PID", () => {
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
    clock.advance(PAST_EVERY_CHECK_MS);
    expect(waited).toEqual([100]);
    expect(reaper.stats()).toEqual({ pending: 0, reaped: 0, abandoned: 1 });
    expect(events.some((line) => line.includes("reason=waitpid-failed"))).toBe(true);
  });

  for (const operation of ["inspect", "waitNoHang"] as const) {
    test(`retries after ${operation} throws, then reaps once`, () => {
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
      clock.advance(PAST_EVERY_CHECK_MS);
      expect(calls).toBe(2);
      expect(waited).toEqual([100]);
      expect(reaper.stats()).toEqual({ pending: 0, reaped: 1, abandoned: 0 });
    });

    test(`bounds retries when ${operation} keeps throwing`, () => {
      const { system } = fakeSystem(new Map([[100, { ppid: SELF, state: "Z" }]]));
      let calls = 0;
      system[operation] = () => {
        calls++;
        throw new Error("persistent failure");
      };
      const reaper = fastReaper(system);
      reaper.reap(100, () => false);
      clock.advance(PAST_EVERY_CHECK_MS);
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
