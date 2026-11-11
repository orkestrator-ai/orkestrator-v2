import { describe, expect, test } from "bun:test";
import { confirmFloor, floorGrowth, peakGrowth } from "../../e2e/perf/design-canvas-leak-verdict";

const LOW = 100;
const HIGH = 155;

/** Deterministic PRNG so the simulation is reproducible. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("design canvas leak verdict", () => {
  test("peakGrowth applies the absolute and relative slack", () => {
    expect(peakGrowth([10, 12], [13, 14], 2, 0)).toBeNull();
    expect(peakGrowth([10, 12], [13, 15], 2, 0)).toEqual({ from: 12, to: 15 });
    expect(peakGrowth([100], [105], 0, 0.05)).toBeNull();
    expect(peakGrowth([100], [106], 0, 0.05)).toEqual({ from: 100, to: 106 });
    expect(peakGrowth([], [1], 0, 0)).toBeNull();
  });

  test("floorGrowth ignores a high peak that only lands in the second half", () => {
    expect(floorGrowth([LOW, LOW, LOW], [LOW, HIGH, LOW], 2)).toBeNull();
  });

  test("an all-high second half fails without confirmations and clears with one low reading", () => {
    const early = [LOW, HIGH, LOW];
    const late = [HIGH, HIGH, HIGH];
    expect(floorGrowth(early, late, 2)).toEqual({ from: LOW, to: HIGH });
    expect(floorGrowth(early, late, 2, [HIGH, LOW])).toBeNull();
  });

  test("a leak keeps failing whatever the confirming readings", async () => {
    // One listener per cycle on top of the two-state noise.
    const early = [LOW + 1, HIGH + 2, LOW + 3, HIGH + 4, LOW + 5];
    const late = [LOW + 6, HIGH + 7, LOW + 8, HIGH + 9, LOW + 10, HIGH + 11];
    let reads = 0;
    const result = await confirmFloor(early, late, 2, 8, async () => {
      reads++;
      return reads % 2 ? LOW + 11 : HIGH + 11;
    });
    expect(result.growth).toEqual({ from: LOW + 1, to: LOW + 6 });
    expect(result.confirmations).toHaveLength(8);
  });

  test("confirmFloor reads nothing when the floor has not risen", async () => {
    let reads = 0;
    const result = await confirmFloor([LOW, HIGH], [HIGH, LOW], 2, 8, async () => {
      reads++;
      return LOW;
    });
    expect(result).toEqual({ growth: null, confirmations: [] });
    expect(reads).toBe(0);
  });

  test("confirmFloor stops at the first reading back on the floor", async () => {
    const readings = [HIGH, HIGH, LOW, HIGH];
    const result = await confirmFloor([LOW], [HIGH, HIGH], 2, 8, async () => readings.shift()!);
    expect(result).toEqual({ growth: null, confirmations: [HIGH, HIGH, LOW] });
  });

  test("random two-state noise without a leak almost never fails (12 cycles, 8 confirmations)", async () => {
    const random = mulberry32(7440);
    const runs = 20_000;
    let withoutConfirmation = 0;
    let withConfirmation = 0;
    for (let run = 0; run < runs; run++) {
      const pHigh = 0.5;
      const read = () => (random() < pHigh ? HIGH : LOW);
      // 12 cycles minus the warm-up: 11 settled samples, 5 early and 6 late.
      const early = Array.from({ length: 5 }, read);
      const late = Array.from({ length: 6 }, read);
      if (floorGrowth(early, late, 2)) withoutConfirmation++;
      const result = await confirmFloor(early, late, 2, 8, async () => read());
      if (result.growth) withConfirmation++;
    }
    // Floor rule alone: P(early has a low) * 0.5^6 ≈ 1.5% of runs.
    expect(withoutConfirmation).toBeGreaterThan(runs * 0.005);
    // With confirmations: ≈ 0.5^14 ≈ 0.006%, about one run in 16,000.
    expect(withConfirmation).toBeLessThanOrEqual(5);
  });
});
