import { describe, expect, test } from "bun:test";
import { deliveryHint } from "./agent-tools-messaging.js";

describe("mail delivery hints", () => {
  test("explains delegation and budget holds independently of inherited policy", () => {
    for (const policy of ["off", "idle"]) {
      expect(deliveryHint("inject-held", "delegation-running", policy)).toContain(
        "worker turn ends",
      );
      expect(deliveryHint("inject-held", "loop-budget-exhausted", policy)).toContain("budget");
      expect(deliveryHint("inject-held", "hourly-limit", policy)).toContain(
        "resumes automatically",
      );
    }
  });
  test("distinguishes pull-only isolated mail and queued stopped recipients", () => {
    expect(deliveryHint("stored", "isolated-route", "off")).toBe("stored, recipient pulls");
    expect(deliveryHint("pending-inject", "environment_stopped", "off")).toBe(
      "queued, delivers when idle",
    );
  });
});
