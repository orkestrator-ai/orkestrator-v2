import { describe, expect, test } from "bun:test";
import { projectEssentialRecord } from "@orkestrator/protocol/log-essential";
import { configureLogger, type LogRecord, resetLogger } from "@orkestrator/protocol/logger";
import {
  BackendExitWatch,
  cgroupPathOf,
  logBackendExit,
  oomKillCount,
} from "../electron/backend-exit-diagnosis";

const CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-orkestrator.scope";
const EVENTS = `${"/sys/fs/cgroup"}${CGROUP}/memory.events`;
const memoryEvents = (oomKills: number) =>
  `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${oomKills}\noom_group_kill 0\n`;

function linuxWatch(files: Map<string, string>, clock = { now: 1_000 }) {
  return new BackendExitWatch({
    platform: "linux",
    now: () => clock.now,
    readText: (file) => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return text;
    },
  });
}

describe("cgroup parsing", () => {
  test("reads the unified hierarchy path and the oom_kill counter", () => {
    expect(cgroupPathOf(`0::${CGROUP}\n`)).toBe(CGROUP);
    expect(cgroupPathOf("12:memory:/legacy\n")).toBeNull();
    expect(oomKillCount(memoryEvents(3))).toBe(3);
    expect(oomKillCount("low 0\n")).toBeNull();
  });
});

describe("BackendExitWatch", () => {
  test("captures uptime and shared cgroup evidence at exit without attributing the OOM kill", () => {
    const files = new Map([
      ["/proc/42/cgroup", `0::${CGROUP}\n`],
      [EVENTS, memoryEvents(2)],
    ]);
    const clock = { now: 1_000 };
    const watch = linuxWatch(files, clock);
    watch.ready(42);
    // The process is gone by now; the cgroup it ran in is not.
    files.delete("/proc/42/cgroup");
    // Another process in the desktop scope was the OOM victim.
    files.set(EVENTS, memoryEvents(3));
    clock.now = 61_000;
    watch.captureExit();
    files.set(EVENTS, memoryEvents(4));
    clock.now = 62_000;
    expect(watch.diagnose({ exitCode: null, signal: "SIGKILL" })).toEqual({
      exitCause: "killed",
      ranForMs: 60_000,
      oomKills: 1,
      crashReport: false,
    });
  });

  test("a SIGKILL with no new OOM kill is a kill", () => {
    const files = new Map([
      ["/proc/42/cgroup", `0::${CGROUP}\n`],
      [EVENTS, memoryEvents(2)],
    ]);
    const watch = linuxWatch(files);
    watch.ready(42);
    watch.captureExit();
    expect(watch.diagnose({ exitCode: null, signal: "SIGKILL" })).toMatchObject({
      exitCause: "killed",
      oomKills: 0,
    });
  });

  test("an unreadable cgroup leaves the OOM count unknown and never throws", () => {
    const watch = linuxWatch(new Map());
    watch.ready(42);
    watch.captureExit();
    expect(watch.diagnose({ exitCode: null, signal: "SIGKILL" })).toMatchObject({
      exitCause: "killed",
      oomKills: null,
    });
  });

  test("off Linux there is no OOM count, and Bun's crash report marks a crash", () => {
    const watch = new BackendExitWatch({
      platform: "darwin",
      readText: () => {
        throw new Error("must not read");
      },
    });
    watch.ready(42);
    watch.captureExit();
    watch.stderrLine("[backend] runtime.stalled lagMs=1");
    watch.stderrLine("oh no: Bun has crashed. This indicates a bug in Bun, not your code.");
    expect(watch.diagnose({ exitCode: 133, signal: null })).toMatchObject({
      exitCause: "crashed",
      oomKills: null,
      crashReport: true,
    });
  });
});

test("both desktop exit events carry the diagnosis and observed signal", () => {
  const records: LogRecord[] = [];
  configureLogger({ essentialSink: (record) => records.push(record), sink: () => undefined });
  try {
    const error = Object.assign(new Error("Backend exited"), { signal: "SIGKILL" });
    const exit = { exitCause: "killed", ranForMs: 123, oomKills: 1, crashReport: false } as const;
    logBackendExit(error, exit, false);
    logBackendExit(error, exit, true);
    expect(records.map((record) => record.event)).toEqual([
      "backend.exited",
      "backend.exited-recovering",
    ]);
    for (const record of records) {
      expect(projectEssentialRecord(record, record.ts)?.fields).toEqual({
        "error.name": "Error",
        "error.signal": "SIGKILL",
        ...exit,
      });
    }
  } finally {
    resetLogger();
  }
});
