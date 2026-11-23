import { describe, expect, test } from "bun:test";
import { hostRestartedAfter, SAME_BOOT_TOLERANCE_MS } from "./host-boot.js";

describe("hostRestartedAfter", () => {
  const firstBoot = "a".repeat(64);
  const secondBoot = "b".repeat(64);

  test("a boot after the run's last row can classify a run without boot metadata", () => {
    expect(hostRestartedAfter(10_000, {}, { bootAt: 20_000 })).toBe(true);
  });

  test("a boot at or before the last row says nothing about the run", () => {
    expect(hostRestartedAfter(10_000, {}, { bootAt: 10_000 })).toBe(false);
    expect(hostRestartedAfter(10_000, {}, { bootAt: 500 })).toBe(false);
    expect(hostRestartedAfter(10_000, {}, undefined)).toBe(false);
    expect(hostRestartedAfter(10_000, {}, { bootAt: Number.NaN })).toBe(false);
  });

  test("without both IDs the tolerance accounts for a small clock correction", () => {
    const run = { bootAt: 1_000, bootId: firstBoot };
    expect(hostRestartedAfter(61_000, run, { bootAt: 121_000 })).toBe(false);
    expect(hostRestartedAfter(61_000, run, { bootAt: 1_000 + SAME_BOOT_TOLERANCE_MS })).toBe(true);
  });

  test("distinct boot IDs confirm a reboot less than five minutes apart", () => {
    const run = { bootAt: 1_000, bootId: firstBoot };
    expect(hostRestartedAfter(121_000, run, { bootAt: 241_000, bootId: secondBoot })).toBe(true);
  });

  test("one boot ID survives a clock correction beyond the tolerance", () => {
    const run = { bootAt: 1_000, bootId: firstBoot };
    expect(hostRestartedAfter(121_000, run, { bootAt: 601_000, bootId: firstBoot })).toBe(false);
  });
});
