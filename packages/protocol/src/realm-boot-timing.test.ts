import { describe, expect, test } from "bun:test";
import { parseRealmBootTimingMessage, REALM_BOOT_STEPS } from "./realm-boot-timing.js";

describe("parseRealmBootTimingMessage", () => {
  test("accepts every step with rounded durations and the optional fixed fields", () => {
    for (const step of REALM_BOOT_STEPS) {
      expect(parseRealmBootTimingMessage({ type: "bootTiming", step, durationMs: 12.6 })).toEqual({
        type: "bootTiming",
        step,
        durationMs: 13,
      });
    }
    expect(
      parseRealmBootTimingMessage({
        type: "bootTiming",
        step: "fan-out-complete",
        durationMs: 3_700,
        sinceStartMs: 5_200.4,
        outcome: "ok",
        requests: 42,
      }),
    ).toEqual({
      type: "bootTiming",
      step: "fan-out-complete",
      durationMs: 3_700,
      sinceStartMs: 5_200,
      outcome: "ok",
      requests: 42,
    });
  });

  test("refuses anything that could carry free text or nonsense numbers", () => {
    const base = { type: "bootTiming", step: "first-render", durationMs: 10 } as const;
    for (const message of [
      null,
      "bootTiming",
      { ...base, type: "selection" },
      { ...base, step: "/Users/someone/project" },
      { ...base, durationMs: -1 },
      { ...base, durationMs: Number.NaN },
      { ...base, durationMs: 2 * 60 * 60_000 },
      { ...base, sinceStartMs: "soon" },
      { ...base, outcome: "token=abc" },
      { ...base, requests: 1.5 },
      { ...base, requests: -3 },
    ]) {
      expect(parseRealmBootTimingMessage(message)).toBeNull();
    }
    // Extra fields are dropped rather than carried through.
    expect(parseRealmBootTimingMessage({ ...base, prompt: "secret" })).toEqual(base);
  });
});
