import { describe, expect, test } from "bun:test";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
  startReparentWatchdog,
} from "../../../packages/protocol/src/parent-watchdog";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  test("fires exactly once, after the parent disappears", async () => {
    let alive = true;
    let fired = 0;
    let resolveFired!: () => void;
    const firedOnce = new Promise<void>((resolve) => {
      resolveFired = resolve;
    });
    const stop = startParentWatchdog({
      parentPid: 4213,
      pollIntervalMs: 5,
      isAlive: () => alive,
      onParentExit: () => {
        fired += 1;
        resolveFired();
      },
    });

    try {
      await tick(20);
      expect(fired).toBe(0);

      alive = false;
      await firedOnce;
      // Give further polls a chance to (incorrectly) fire again.
      await tick(20);
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });

  test("stop() prevents any later firing", async () => {
    let fired = 0;
    const stop = startParentWatchdog({
      parentPid: 4213,
      pollIntervalMs: 5,
      isAlive: () => false,
      onParentExit: () => {
        fired += 1;
      },
    });
    stop();
    await tick(20);
    expect(fired).toBe(0);
  });

  test("the built-in liveness probe treats a live, unsignalable parent as alive", async () => {
    // No `isAlive` override: this exercises the real `process.kill(pid, 0)`
    // probe. PID 1 exists but is not ours to signal, so it must read as alive —
    // reporting EPERM as death would shut a healthy bridge down.
    let fired = 0;
    const stop = startParentWatchdog({
      parentPid: 1,
      pollIntervalMs: 5,
      onParentExit: () => {
        fired += 1;
      },
    });
    try {
      await tick(25);
      expect(fired).toBe(0);
    } finally {
      stop();
    }
  });

  test("the built-in liveness probe fires for a PID that does not exist", async () => {
    let fired = 0;
    let resolveFired!: () => void;
    const firedOnce = new Promise<void>((resolve) => {
      resolveFired = resolve;
    });
    // PID 0x7FFFFFFF is above every platform's pid_max, so it can never exist.
    const stop = startParentWatchdog({
      parentPid: 0x7fffffff,
      pollIntervalMs: 5,
      onParentExit: () => {
        fired += 1;
        resolveFired();
      },
    });
    try {
      await firedOnce;
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });
});

describe("startReparentWatchdog", () => {
  test("fires exactly once when the ppid changes", async () => {
    let ppid = 500;
    let fired = 0;
    let resolveFired!: () => void;
    const firedOnce = new Promise<void>((resolve) => {
      resolveFired = resolve;
    });
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => ppid,
      onReparented: () => {
        fired += 1;
        resolveFired();
      },
    });
    expect(stop).not.toBeNull();

    try {
      await tick(20);
      expect(fired).toBe(0);

      // The parent died, so the OS reparented us to init.
      ppid = 1;
      await firedOnce;
      await tick(20);
      expect(fired).toBe(1);
    } finally {
      stop?.();
    }
  });

  test("declines to start when already parented to init", async () => {
    let fired = 0;
    // Under systemd/launchd/a container init the ppid is 1 for the process's
    // whole life, so a watchdog there could only ever be noise.
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => 1,
      onReparented: () => {
        fired += 1;
      },
    });

    expect(stop).toBeNull();
    await tick(20);
    expect(fired).toBe(0);
  });

  test("declines to start when the ppid is unavailable", async () => {
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => 0,
      onReparented: () => {
        fired += 1;
      },
    });

    expect(stop).toBeNull();
    await tick(20);
    expect(fired).toBe(0);
  });

  test("stop() prevents any later firing", async () => {
    let ppid = 500;
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      readParentPid: () => ppid,
      onReparented: () => {
        fired += 1;
      },
    });
    stop?.();
    ppid = 1;
    await tick(20);
    expect(fired).toBe(0);
  });

  test("does not fire for this process, whose parent is stable", async () => {
    // No `readParentPid` override: exercises the real `process.ppid` read.
    let fired = 0;
    const stop = startReparentWatchdog({
      pollIntervalMs: 5,
      onReparented: () => {
        fired += 1;
      },
    });
    try {
      await tick(25);
      expect(fired).toBe(0);
    } finally {
      stop?.();
    }
  });
});
