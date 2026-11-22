import { expect, test } from "bun:test";
import { KEY_PHASE_SPREAD_MS, keyPhaseOffsetMs } from "../../e2e/agent-testing/terminal-echo-probe";

test("key gaps spread over every phase of a frame", () => {
  const offsets = Array.from({ length: 200 }, (_, index) => keyPhaseOffsetMs(index));
  expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...offsets)).toBeLessThan(KEY_PHASE_SPREAD_MS);
  // Every quarter of the frame gets a quarter of the keys, within a few.
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const inQuarter = offsets.filter(
      (offset) => Math.floor((offset / KEY_PHASE_SPREAD_MS) * 4) === quarter,
    ).length;
    expect(Math.abs(inQuarter - 50)).toBeLessThanOrEqual(3);
  }
});
