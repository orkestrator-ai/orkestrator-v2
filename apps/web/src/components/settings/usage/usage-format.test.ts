import { expect, test } from "bun:test";
import { formatCost, formatDayLabel, formatShare, formatTokens } from "./usage-format";

test("scales token counts to three significant digits", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(842)).toBe("842");
  expect(formatTokens(338_000)).toBe("338K");
  expect(formatTokens(6_160_000)).toBe("6.16M");
  expect(formatTokens(45_200_000)).toBe("45.2M");
  expect(formatTokens(4_930_000_000)).toBe("4.93B");
});

test("money never rounds a real charge down to nothing", () => {
  expect(formatCost(0)).toBe("$0.00");
  expect(formatCost(0.004)).toBe("<$0.01");
  expect(formatCost(1268.942)).toBe("$1,268.94");
});

test("shares stay readable at both ends", () => {
  expect(formatShare(0, 100)).toBe("0%");
  expect(formatShare(1, 0)).toBe("0%");
  expect(formatShare(1, 100_000)).toBe("<0.1%");
  expect(formatShare(59.2, 100)).toBe("59.2%");
});

test("day keys read as dates", () => {
  expect(formatDayLabel("2026-10-20")).toBe(
    new Date(2026, 9, 20).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
  );
  expect(formatDayLabel("nonsense")).toBe("nonsense");
});
