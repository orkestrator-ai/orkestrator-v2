import { describe, expect, test } from "bun:test";
import { hostRestartedAfter, SAME_BOOT_TOLERANCE_MS } from "./host-boot.js";

describe("hostRestartedAfter", () => {
  test("a boot after the run's last row means the host restarted under it", () => {
    expect(hostRestartedAfter(10_000, null, [20_000])).toBe(true);
    expect(hostRestartedAfter(10_000, 1_000, [null, 1_000, 20_000_000])).toBe(true);
  });

  test("a boot at or before the last row says nothing about the run", () => {
    expect(hostRestartedAfter(10_000, null, [10_000, 500])).toBe(false);
    expect(hostRestartedAfter(10_000, null, [])).toBe(false);
    expect(hostRestartedAfter(10_000, null, [null, undefined, Number.NaN])).toBe(false);
  });

  test("the run's own boot seen through a stepped clock is not a restart", () => {
    // Booted at 1 000, last seen at 61 000, then NTP stepped the clock forward
    // two minutes: the same boot now computes as 121 000.
    expect(hostRestartedAfter(61_000, 1_000, [121_000])).toBe(false);
    expect(hostRestartedAfter(61_000, 1_000, [1_000 + SAME_BOOT_TOLERANCE_MS])).toBe(true);
  });
});
