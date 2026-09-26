import { describe, expect, test } from "bun:test";
import { ManualTime } from "./recurring-test-support.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";

describe("ElapsedPollGate", () => {
  test("clearing a progress scope gives a later idle stretch its own elapsed grace", () => {
    const time = new ManualTime(0);
    const gate = new ElapsedPollGate(1_000, { now: time.now });
    expect(gate.count("review\0idle", "periodic")).toBe(true);
    gate.clear("review\0idle");
    time.jump(10_000);
    expect(gate.count("review\0idle", "periodic")).toBe(true);
    expect(gate.count("review\0idle", "periodic")).toBe(true);
    expect(gate.exhausted("review\0idle", 2, 5)).toBe(false);
    time.jump(5_000);
    expect(gate.exhausted("review\0idle", 2, 5)).toBe(true);
  });
});
