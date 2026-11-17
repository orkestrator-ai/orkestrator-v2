import { expect, test } from "bun:test";
import { readHostCpuTimes } from "./host-cpu-times.js";

// Real awake-host qualification. OS suspend/resume still requires hardware
// evidence; a timer wait here leaves the host awake and exercises idle counters.
test("real host counters advance at wall-clock rate while the process waits", async () => {
  const start = performance.now();
  const before = readHostCpuTimes();
  expect(before).not.toBeNull();
  await Bun.sleep(1_000);
  const after = readHostCpuTimes();
  const elapsed = performance.now() - start;
  // A positive check: the wait is the measurement, not a window for something to not happen.
  expect(after).toBeArray();
  expect(after!.length).toBe(before!.length);
  const advances = after!.map((time, index) => time - before![index]!);
  expect(advances.every((advance) => Number.isFinite(advance) && advance >= 0)).toBe(true);
  // The monitor uses the longest-advancing CPU. Allow scheduling/read skew,
  // but reject a reader with frozen counters or the wrong unit.
  const rate = Math.max(...advances) / elapsed;
  expect(rate).toBeGreaterThan(0.5);
  expect(rate).toBeLessThan(1.5);
}, 10_000);
