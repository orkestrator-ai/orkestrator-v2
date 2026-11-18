import { describe, expect, test } from "bun:test";
import {
  PARENT_PID_ENV,
  PARENT_WATCH_INTERVAL_MS,
  parseParentPid,
  startParentWatchdog,
  startReparentWatchdog,
} from "../../../packages/protocol/src/parent-watchdog";
import { FakeIntervals } from "../../../packages/protocol/src/testing/fake-intervals";
import { ManualClock } from "../../../packages/protocol/src/testing/manual-clock";

describe("PARENT_PID_ENV", () => {
  test("is the name the backend and both bridges agree on", () => {
    // The backend writes this variable and the bridges read it; a rename on one
    // side alone silently disables every watchdog.
    expect(PARENT_PID_ENV).toBe("ORKESTRATOR_PARENT_PID");
  });
});

describe("parseParentPid", () => {
  test("accepts only real PIDs", () => {
    expect(parseParentPid(undefined)).toBeNull();
    expect(parseParentPid("")).toBeNull();
    expect(parseParentPid("backend")).toBeNull();
    expect(parseParentPid("0")).toBeNull();
    // PID 1 is init/launchd — watching it would never fire.
    expect(parseParentPid("1")).toBeNull();
    expect(parseParentPid("-4")).toBeNull();
    expect(parseParentPid("4213")).toBe(4213);
  });

  test("never yields a non-integer or out-of-range PID", () => {
    expect(parseParentPid("abc42")).toBeNull();
    expect(parseParentPid("NaN")).toBeNull();
    expect(parseParentPid("Infinity")).toBeNull();
    // `parseInt` truncates these rather than rejecting them; the result is
    // still a usable integer PID, which is what the watchdog requires.
    expect(parseParentPid("42.9")).toBe(42);
    expect(parseParentPid(" 4213 ")).toBe(4213);
  });
});

describe("startParentWatchdog", () => {
  test("fires exactly once, after the parent disappears", () => {
    const clock = new ManualClock();
    let alive = true;
    let fired = 0;
    const stop = startParentWatchdog({
      parentPid: 4213,
      pollIntervalMs: 5,
      isAlive: () => alive,
      timers: clock,
      onParentExit: () => {
        fired += 1;
      },
    });

    try {
      // Four polls see a live parent.
      expect(clock.advance(20)).toBe(4);
      expect(fired).toBe(0);

      alive = false;
      clock.advance(5);
      expect(fired).toBe(1);
      // Firing disarms the poll, so later polls cannot fire again.
      expect(clock.pendingCount()).toBe(0);
      clock.advance(20);
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });

  test("stop() prevents any later firing", () => {
    const clock = new ManualClock();
    let fired = 0;
    const stop = startParentWatchdog({
      parentPid: 4213,
      pollIntervalMs: 5,
      isAlive: () => false,
      timers: clock,
      onParentExit: () => {
        fired += 1;
      },
    });
    stop();
    expect(clock.pendingCount()).toBe(0);
    clock.advance(20);
    expect(fired).toBe(0);
  });

  test("uses the caller's interval and ignores a callback that was already due at stop()", () => {
    const timers = new FakeIntervals();
    let fired = 0;
    const stop = startParentWatchdog({
      parentPid: 4213,
      pollIntervalMs: 5_000,
      isAlive: () => false,
      timers,
      onParentExit: () => {
        fired += 1;
      },
    });
    expect(timers.periods()).toEqual([5_000]);
    const [entry] = [...timers.armed.values()];

    stop();
    stop();
    entry!.callback();

    expect(fired).toBe(0);
    expect(timers.armed.size).toBe(0);
  });

  test("the built-in liveness probe treats a live, unsignalable parent as alive", () => {
    // No `isAlive` override: this exercises the real `process.kill(pid, 0)`
    // probe. PID 1 exists but is not ours to signal, so it must read as alive —
    // reporting EPERM as death would shut a healthy bridge down.
    const clock = new ManualClock();
    let fired = 0;
    const stop = startParentWatchdog({
      parentPid: 1,
      pollIntervalMs: 5,
      timers: clock,
      onParentExit: () => {
        fired += 1;
      },
    });
    try {
      expect(clock.advance(25)).toBe(5);
      expect(fired).toBe(0);
    } finally {
      stop();
    }
  });

  test("the built-in liveness probe fires for a PID that does not exist", () => {
    const clock = new ManualClock();
    let fired = 0;
    // PID 0x7FFFFFFF is above every platform's pid_max, so it can never exist.
    const stop = startParentWatchdog({
      parentPid: 0x7fffffff,
      pollIntervalMs: 5,
      timers: clock,
      onParentExit: () => {
        fired += 1;
      },
    });
    try {
      clock.advance(5);
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });
});

describe("startReparentWatchdog", () => {
  test("fires exactly once when the ppid changes", () => {
    const clock = new ManualClock();
    let ppid = 500;
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => ppid,
      timers: clock,
      onReparented: () => {
        fired += 1;
      },
    });
    expect(stop).not.toBeNull();

    try {
      expect(clock.advance(20)).toBe(4);
      expect(fired).toBe(0);

      // The parent died, so the OS reparented us to init.
      ppid = 1;
      clock.advance(5);
      expect(fired).toBe(1);
      expect(clock.pendingCount()).toBe(0);
      clock.advance(20);
      expect(fired).toBe(1);
    } finally {
      stop?.();
    }
  });

  test("declines to start when already parented to init", () => {
    const clock = new ManualClock();
    let fired = 0;
    // Under systemd/launchd/a container init the ppid is 1 for the process's
    // whole life, so a watchdog there could only ever be noise.
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => 1,
      timers: clock,
      onReparented: () => {
        fired += 1;
      },
    });

    expect(stop).toBeNull();
    expect(clock.pendingCount()).toBe(0);
    clock.advance(20);
    expect(fired).toBe(0);
  });

  test("detects reparenting that happened before the watchdog was installed", () => {
    const clock = new ManualClock();
    let fired = 0;
    const stop = startReparentWatchdog({
      initialParentPid: 500,
      pollIntervalMs: 5,
      // Startup awaited after capturing PID 500; by installation time the
      // parent has exited and the process is already owned by init.
      readParentPid: () => 1,
      timers: clock,
      onReparented: () => {
        fired += 1;
      },
    });
    expect(stop).not.toBeNull();

    try {
      clock.advance(5);
      expect(fired).toBe(1);
      clock.advance(20);
      expect(fired).toBe(1);
    } finally {
      stop?.();
    }
  });

  test("declines to start when the ppid is unavailable", () => {
    const clock = new ManualClock();
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => 0,
      timers: clock,
      onReparented: () => {
        fired += 1;
      },
    });

    expect(stop).toBeNull();
    expect(clock.pendingCount()).toBe(0);
    clock.advance(20);
    expect(fired).toBe(0);
  });

  test("stop() prevents any later firing", () => {
    const clock = new ManualClock();
    let ppid = 500;
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => ppid,
      timers: clock,
      onReparented: () => {
        fired += 1;
      },
    });
    stop?.();
    ppid = 1;
    expect(clock.pendingCount()).toBe(0);
    clock.advance(20);
    expect(fired).toBe(0);
  });

  test("does not fire for this process, whose parent is stable", () => {
    // No `readParentPid` override: exercises the real `process.ppid` read.
    const clock = new ManualClock();
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      timers: clock,
      onReparented: () => {
        fired += 1;
      },
    });
    try {
      expect(clock.advance(25)).toBe(5);
      expect(fired).toBe(0);
    } finally {
      stop?.();
    }
  });
});

describe("shared watchdog defaults", () => {
  test("PID watchers used by Claude and Codex poll after exactly one second", () => {
    const timers = new FakeIntervals();
    let exits = 0;
    const stop = startParentWatchdog({
      parentPid: 4213,
      timers,
      isAlive: () => false,
      onParentExit: () => {
        exits += 1;
      },
    });
    try {
      expect(PARENT_WATCH_INTERVAL_MS).toBe(1000);
      expect(timers.periods()).toEqual([1000]);
      timers.tick(999);
      expect(exits).toBe(0);
      timers.tick(1);
      expect(exits).toBe(1);
      expect(timers.armed.size).toBe(0);
      timers.tick(2000);
      expect(exits).toBe(1);
    } finally {
      stop();
    }
  });

  test("reparent watchers default to one second and ignore callbacks due after stop", () => {
    const timers = new FakeIntervals();
    let parent = 500;
    let exits = 0;
    const stop = startReparentWatchdog({
      timers,
      readParentPid: () => parent,
      onReparented: () => {
        exits += 1;
      },
    });
    try {
      expect(timers.periods()).toEqual([1000]);
      parent = 1;
      timers.tick(999);
      expect(exits).toBe(0);
      const entry = [...timers.armed.values()][0]!;
      timers.tick(1);
      expect(exits).toBe(1);
      entry.callback();
      expect(exits).toBe(1);
      expect(timers.armed.size).toBe(0);
    } finally {
      stop?.();
    }
  });
});
