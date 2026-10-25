import { describe, expect, test } from "bun:test";
import { isNativeAgentPricingTier, normalizeNativeAgentSelectionPricing } from "./native-agent";

describe("native agent pricing", () => {
  test("accepts only the two pricing tiers", () => {
    expect(isNativeAgentPricingTier("standard")).toBe(true);
    expect(isNativeAgentPricingTier("premium")).toBe(true);
    expect(isNativeAgentPricingTier("max")).toBe(false);
    expect(isNativeAgentPricingTier(undefined)).toBe(false);
  });

  test("keeps a premium selection with a label and bounds its text", () => {
    expect(
      normalizeNativeAgentSelectionPricing({
        tier: "premium",
        label: "  Max mode ",
        description: "Billed at premium rates.",
        extra: true,
      }),
    ).toEqual({ tier: "premium", label: "Max mode", description: "Billed at premium rates." });
    const long = normalizeNativeAgentSelectionPricing({
      tier: "premium",
      label: "x".repeat(200),
      description: "y".repeat(2_000),
    });
    expect(long?.label).toHaveLength(64);
    expect(long?.description).toHaveLength(512);
  });

  test("drops anything that is not a labelled premium selection", () => {
    for (const value of [
      undefined,
      null,
      "premium",
      [],
      { tier: "standard", label: "Standard" },
      { tier: "premium" },
      { tier: "premium", label: "   " },
      { tier: "premium", label: 3 },
    ]) {
      expect(normalizeNativeAgentSelectionPricing(value)).toBeUndefined();
    }
    expect(
      normalizeNativeAgentSelectionPricing({ tier: "premium", label: "Max", description: " " }),
    ).toEqual({ tier: "premium", label: "Max" });
  });
});
