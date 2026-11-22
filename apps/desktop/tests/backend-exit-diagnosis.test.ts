import { describe, expect, test } from "bun:test";
import { BackendExitWatch, cgroupPathOf, oomKillCount } from "../electron/backend-exit-diagnosis";

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
  test("counts the OOM kills since the backend became ready and calls the SIGKILL an OOM kill", () => {
    const files = new Map([
      ["/proc/42/cgroup", `0::${CGROUP}\n`],
      [EVENTS, memoryEvents(2)],
    ]);
    const clock = { now: 1_000 };
    const watch = linuxWatch(files, clock);
    watch.ready(42);
    // The process is gone by now; the cgroup it ran in is not.
    files.delete("/proc/42/cgroup");
    files.set(EVENTS, memoryEvents(3));
    clock.now = 61_000;
    expect(watch.diagnose({ exitCode: null, signal: "SIGKILL" })).toEqual({
      exitCause: "oom-killed",
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
    expect(watch.diagnose({ exitCode: null, signal: "SIGKILL" })).toMatchObject({
      exitCause: "killed",
      oomKills: 0,
    });
  });

  test("an unreadable cgroup leaves the OOM count unknown and never throws", () => {
    const watch = linuxWatch(new Map());
    watch.ready(42);
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
    watch.stderrLine("[backend] runtime.stalled lagMs=1");
    watch.stderrLine("oh no: Bun has crashed. This indicates a bug in Bun, not your code.");
    expect(watch.diagnose({ exitCode: 133, signal: null })).toMatchObject({
      exitCause: "crashed",
      oomKills: null,
      crashReport: true,
    });
  });
});
