import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { EXEC_WORKER } from "./exec-worker.js";

// Execute the deployed script with a TERM-ignoring child and a stepped clock.
// This tests the real supervisor's signal timing without paying its grace period.
test.each([
  ["500", 500],
  ["1", 100],
  ["9000", 5000],
  [undefined, 5000],
  ["invalid", 5000],
])("exec worker applies TERM-to-KILL grace %s", async (configured, graceMs) => {
  let now = 0;
  const timers = new Map<object, { due: number; callback: () => void }>();
  const signals: Array<[number, string]> = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: () => {} }),
  });
  let alive = true;
  let state: Record<string, unknown> = {};
  const input = {
    directory: "/run",
    root: "/workspace",
    cwd: "/workspace",
    env: {},
    argv: ["ignore-term"],
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
  };
  const fs = {
    readFileSync: (file: string) => JSON.stringify(file.endsWith("input.json") ? input : state),
    unlinkSync: () => {},
    existsSync: () => false,
    openSync: () => 1,
    realpathSync: (file: string) => file,
    writeFileSync: (_file: string, contents: string) => {
      state = JSON.parse(contents);
    },
    renameSync: () => {},
    closeSync: () => {},
  };
  const completion = runInNewContext(EXEC_WORKER, {
    require: (name: string) => {
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:child_process") return { spawn: () => child };
      throw new Error(`Unexpected import: ${name}`);
    },
    process: {
      argv: ["worker", "/run/input.json"],
      env: configured === undefined ? {} : { ORKESTRATOR_TEST_EXEC_KILL_GRACE_MS: configured },
      on: () => {},
      kill: (_pid: number, signal: string | number) => {
        if (signal === 0) {
          if (!alive) throw new Error("ESRCH");
          return;
        }
        signals.push([now, String(signal)]);
        if (signal === "SIGKILL") {
          alive = false;
          child.emit("close", null, "SIGKILL");
        }
      },
    },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout: (callback: () => void, ms: number) => {
      const handle = {};
      timers.set(handle, { due: now + ms, callback });
      return handle;
    },
    clearTimeout: (handle: object) => {
      timers.delete(handle);
    },
    setInterval: () => ({}),
    clearInterval: () => {},
  }) as Promise<void>;
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of Array.from(timers)) {
      if (timer.due <= now) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  advance(input.timeoutMs);
  expect(signals).toEqual([[10_000, "SIGTERM"]]);
  advance(graceMs - 1);
  expect(signals).toHaveLength(1);
  advance(1);
  await completion;
  expect(signals).toEqual([
    [10_000, "SIGTERM"],
    [10_000 + graceMs, "SIGKILL"],
  ]);
  expect(state).toMatchObject({ status: "exited", timedOut: true, signal: "SIGKILL" });
  expect(timers.size).toBe(0);
});
