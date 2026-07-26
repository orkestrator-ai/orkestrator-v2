import { describe, expect, test } from "bun:test";
import { parseParentPid, startParentWatchdog } from "./parent-watchdog.js";

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
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fired).toBe(0);

      alive = false;
      await firedOnce;
      // Give further polls a chance to (incorrectly) fire again.
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(0);
  });
});
