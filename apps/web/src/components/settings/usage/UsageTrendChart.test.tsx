import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyUsageTotals } from "@orkestrator/protocol/usage-history";
import type { UsageDayPoint } from "@/lib/backend";
import { UsageTrendChart, niceCeiling } from "./UsageTrendChart";

afterEach(() => {
  cleanup();
});

test("the scale tops out just above the busiest value, not far above it", () => {
  expect(niceCeiling(0)).toBe(1);
  expect(niceCeiling(-5)).toBe(1);
  expect(niceCeiling(Number.NaN)).toBe(1);
  expect(niceCeiling(1)).toBe(1);
  expect(niceCeiling(26_000_000)).toBe(30_000_000);
  expect(niceCeiling(9_400)).toBe(10_000);
  expect(niceCeiling(10_500)).toBe(12_000);
  expect(niceCeiling(0.42)).toBeCloseTo(0.5, 10);
  // Never below the value it has to hold.
  for (const value of [1, 7, 31, 260, 4_100, 55_000, 612_345, 9_999_999]) {
    expect(niceCeiling(value)).toBeGreaterThanOrEqual(value);
    // And never more than double it, so the chart keeps its height.
    expect(niceCeiling(value)).toBeLessThanOrEqual(value * 2);
  }
});

test("the day readout marks estimated spend and leaves billed spend plain", () => {
  const priced = (costUsd: number, costSource?: "provider" | "estimate") => ({
    ...emptyUsageTotals(),
    totalTokens: 1_000,
    costUsd,
    turns: 1,
    ...(costSource ? { costSource } : {}),
  });
  const days: UsageDayPoint[] = [
    {
      day: "2026-10-20",
      totals: priced(3, "estimate"),
      platforms: [
        { platform: "claude", totals: priced(2, "estimate") },
        { platform: "cursor", totals: priced(1, "provider") },
      ],
    },
  ];
  render(<UsageTrendChart days={days} platforms={["claude", "cursor"]} metric="cost" />);
  fireEvent.keyDown(screen.getByRole("group"), { key: "Home" });

  const readout = screen.getByTestId("usage-chart-readout");
  const marked = readout.querySelectorAll("[title='Estimated from token counts']");
  // Claude's line and the day's total, which contains it; Cursor's bill is plain.
  expect([...marked].map((element) => element.textContent)).toEqual([
    "~$2.00, estimated",
    "~$3.00, estimated",
  ]);
  expect(readout.querySelector("[data-cost-source='provider']")?.textContent).toBe("$1.00");
  expect(screen.getByText(/: \$3\.00, estimated$/)).toBeTruthy();
});
