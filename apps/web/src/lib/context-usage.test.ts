import { describe, expect, test } from "bun:test";
import { formatTokenCount } from "./context-usage";

describe("context-usage formatTokenCount", () => {
  test.each([
    ["renders sub-thousand counts verbatim", 0, "0"],
    ["renders sub-thousand counts verbatim", 999, "999"],
    ["renders thousands with one decimal", 1_000, "1.0k"],
    ["renders thousands with one decimal", 9_999, "10.0k"],
    ["drops the decimal from ten thousands", 10_000, "10k"],
    ["drops the decimal from ten thousands", 999_999, "1000k"],
    ["renders millions with one decimal", 1_000_000, "1.0M"],
    ["renders millions with one decimal", 9_500_000, "9.5M"],
    ["drops the decimal from ten millions", 10_000_000, "10M"],
    ["drops the decimal from ten millions", 999_000_000, "999M"],
    ["trims trailing zeros from billions", 1_000_000_000, "1B"],
    ["trims trailing zeros from billions", 1_901_000_000, "1.9B"],
    ["renders billions with two decimals", 1_910_000_000, "1.91B"],
    ["renders billions with two decimals", 1_880_400_000, "1.88B"],
    ["renders billions with two decimals", 12_345_000_000, "12.35B"],
  ])("%s (%p)", (_label, tokens, expected) => {
    expect(formatTokenCount(tokens as number)).toBe(expected);
  });
});
