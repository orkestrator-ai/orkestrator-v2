import { describe, expect, test } from "bun:test";
import type { cpus } from "node:os";
import { parseProcStat, readHostCpuTimes } from "./host-cpu-times.js";

const PROC_STAT = [
  "cpu  400 10 200 9000 50 5 5 0 0 0",
  "cpu0 200 5 100 4500 40 3 2 0 0 0",
  "cpu1 200 5 100 4500 10 2 3 7 0 0",
  "intr 123456 0 0",
  "ctxt 987654",
  "btime 1794000000",
].join("\n");

function cpu(times: { user: number; nice: number; sys: number; idle: number; irq: number }) {
  return { model: "test", speed: 0, times };
}

describe("parseProcStat", () => {
  test("totals every state of each CPU, I/O wait and steal included, in ms", () => {
    // cpu0: 200+5+100+4500+40+3+2+0 = 4850 ticks; cpu1: 4827 ticks, steal 7 included.
    expect(parseProcStat(PROC_STAT)).toEqual([48_500, 48_270]);
  });

  test("is null for text with no CPU lines or with a malformed one", () => {
    expect(parseProcStat("intr 1\n")).toBeNull();
    expect(parseProcStat("cpu0 1 2 x 4\n")).toBeNull();
    expect(parseProcStat("cpu0 1 2\n")).toBeNull();
  });
});

describe("readHostCpuTimes", () => {
  test("reads /proc/stat on Linux", () => {
    expect(
      readHostCpuTimes(
        "linux",
        () => PROC_STAT,
        () => {
          throw new Error("not used on Linux");
        },
      ),
    ).toEqual([48_500, 48_270]);
  });

  test("sums every os.cpus() state elsewhere", () => {
    const list = [
      cpu({ user: 100, nice: 0, sys: 50, idle: 1_000, irq: 0 }),
      cpu({ user: 10, nice: 1, sys: 5, idle: 1_200, irq: 4 }),
    ] as ReturnType<typeof cpus>;
    expect(
      readHostCpuTimes(
        "darwin",
        () => "",
        () => list,
      ),
    ).toEqual([1_150, 1_220]);
  });

  test("is null rather than throwing when the counters cannot be read", () => {
    const unreadable = () => {
      throw new Error("EACCES");
    };
    expect(readHostCpuTimes("linux", unreadable, unreadable)).toBeNull();
    expect(readHostCpuTimes("darwin", unreadable, unreadable)).toBeNull();
    expect(readHostCpuTimes("darwin", unreadable, () => [])).toBeNull();
  });
});
