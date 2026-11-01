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
  test("does not claim a recipient with no agent will pull", () => {
    for (const policy of ["off", "idle"]) {
      const hint = deliveryHint("stored", "recipient-cannot-inject", policy, false);
      expect(hint).toContain("not delivered");
      expect(hint).not.toContain("recipient pulls");
    }
    // A terminal tab cannot be injected into, but its agent can pull.
    expect(deliveryHint("stored", "recipient-cannot-inject", "off", true)).toBe(
      "stored, recipient pulls",
    );
  });
});
