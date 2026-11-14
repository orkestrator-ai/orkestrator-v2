import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  PLAN_USAGE_DISPLAY_STALE_MS,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";

import {
  describePlanUsageReset,
  formatReadingTime,
  UsageReadingAge,
  UsageReadingBars,
} from "./UsageReading";

const NOW = Date.parse("2026-11-09T14:03:00.000Z");

function reading(ageMs: number, extra: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  return {
    platform: "claude",
    status: "ok",
    windows: [{ window: "five_hour", label: "5-hour limit", usedPercent: 31 }],
    fetchedAt: new Date(NOW - ageMs).toISOString(),
    ...extra,
  };
}

afterEach(cleanup);

describe("usage reading age", () => {
  test("a fresh reading says when it was taken, in local time and as an age", () => {
    const snapshot = reading(3 * 60_000);
    render(<UsageReadingBars snapshot={snapshot} now={NOW} />);
    const age = screen.getByTestId("usage-reading-age");
    expect(age.textContent).toBe(`Updated ${formatReadingTime(snapshot.fetchedAt)} (3m ago)`);
    expect(age.getAttribute("data-stale")).toBe("false");
    expect(
      within(age).getByText(formatReadingTime(snapshot.fetchedAt)).getAttribute("dateTime"),
    ).toBe(snapshot.fetchedAt);
    expect(screen.queryByText("Stale") === null).toBe(true);
    expect(screen.getByTestId("usage-reading-bars").getAttribute("data-stale")).toBe("false");
    expect(screen.getByText("31% used")).toBeTruthy();
  });

  test("past the display bound the reading is stale: muted bars and a label", () => {
    render(<UsageReadingBars snapshot={reading(PLAN_USAGE_DISPLAY_STALE_MS + 60_000)} now={NOW} />);
    expect(screen.getByTestId("usage-reading-age").textContent).toContain("(31m ago)");
    expect(screen.getByText("Stale")).toBeTruthy();
    const bars = screen.getByTestId("usage-reading-bars");
    expect(bars.getAttribute("data-stale")).toBe("true");
    expect(bars.className).toContain("opacity-50");
  });

  test("a last known reading is stale whatever its age, and says why", () => {
    render(
      <UsageReadingBars
        snapshot={reading(60_000, { stale: true, message: "Sign-in expired." })}
        now={NOW}
      />,
    );
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Sign-in expired.")).toBeTruthy();
  });

  test("a reading another machine took names that machine", () => {
    render(
      <UsageReadingBars
        snapshot={reading(2.5 * 24 * 60 * 60_000, {
          readOn: { nodeId: "bk_beelink", nodeName: "beelink" },
        })}
        now={NOW}
      />,
    );
    const age = screen.getByTestId("usage-reading-age");
    expect(age.textContent).toContain("(2d ago) on beelink");
    expect(within(age).getByText("Stale")).toBeTruthy();
  });

  test("a reading this machine took names no machine", () => {
    render(<UsageReadingAge snapshot={reading(0)} now={NOW} />);
    expect(screen.getByTestId("usage-reading-age").textContent).toMatch(/\(just now\)$/);
  });

  test("a reading never taken says so", () => {
    render(<UsageReadingAge snapshot={null} now={NOW} />);
    expect(screen.getByText("Usage has not been read yet.")).toBeTruthy();
  });

  test("a reading with no windows shows its fallback and its age", () => {
    render(
      <UsageReadingBars
        snapshot={reading(0, { windows: [] })}
        now={NOW}
        empty={<p>No metered plan limits reported.</p>}
      />,
    );
    expect(screen.getByText("No metered plan limits reported.")).toBeTruthy();
    expect(screen.queryByTestId("usage-reading-bars") === null).toBe(true);
    expect(screen.getByTestId("usage-reading-age")).toBeTruthy();
  });
});

describe("limit resets", () => {
  test("a reading with resets lists the count and each grant", () => {
    render(
      <UsageReadingBars
        snapshot={reading(60_000, {
          resets: {
            available: 3,
            items: [
              { count: 2, scope: "weekly", expiresAt: "2026-12-03T00:00:00.000Z" },
              { count: 1, label: "Fable reset" },
            ],
          },
        })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("usage-resets").textContent).toContain("3 limit resets available");
    const rows = screen.getAllByTestId("usage-reset-item").map((row) => row.textContent);
    expect(rows[0]).toStartWith("Weekly limit reset ×2 · use by ");
    expect(rows[1]).toBe("Fable reset");
  });

  test("a reading with none, or only lapsed ones, shows nothing", () => {
    render(<UsageReadingBars snapshot={reading(60_000)} now={NOW} />);
    expect(screen.queryByTestId("usage-resets") === null).toBe(true);
    cleanup();
    render(
      <UsageReadingBars
        snapshot={reading(60_000, {
          resets: { available: 1, items: [{ count: 1, expiresAt: "2026-11-01T00:00:00.000Z" }] },
        })}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("usage-resets") === null).toBe(true);
  });

  test("a single reset is singular and an unnamed one is just a reset", () => {
    expect(describePlanUsageReset({ count: 1 })).toBe("Reset");
    render(
      <UsageReadingBars
        snapshot={reading(0, { resets: { available: 1, items: [{ count: 1 }] } })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("usage-resets").textContent).toContain("1 limit reset available");
  });
});
