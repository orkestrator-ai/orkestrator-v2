import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import * as backend from "@/lib/backend";
import type { UsageHistoryReport, UsageTotals } from "@/lib/backend";
import { UsageSettings, usagePlatformFilterOptions } from "./UsageSettings";

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 7_000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 10_000,
    costUsd: 4,
    unpricedTokens: 0,
    turns: 5,
    ...overrides,
  };
}

function report(overrides: Partial<UsageHistoryReport> = {}): UsageHistoryReport {
  return {
    generatedAt: "2026-10-20T12:00:00.000Z",
    fromDay: "2026-10-19",
    toDay: "2026-10-20",
    days: [
      {
        day: "2026-10-19",
        totals: totals({ totalTokens: 4_000, costUsd: 1 }),
        platforms: [{ platform: "claude", totals: totals({ totalTokens: 4_000, costUsd: 1 }) }],
      },
      {
        day: "2026-10-20",
        totals: totals({ totalTokens: 6_000, costUsd: 3 }),
        platforms: [
          { platform: "claude", totals: totals({ totalTokens: 4_000, costUsd: 3 }) },
          { platform: "codex", totals: totals({ totalTokens: 2_000, costUsd: 0 }) },
        ],
      },
    ],
    totals: totals(),
    sessions: 3,
    platforms: [
      { platform: "claude", totals: totals({ totalTokens: 8_000, costUsd: 4 }), sessions: 2 },
      {
        platform: "codex",
        totals: totals({ totalTokens: 2_000, costUsd: 0, unpricedTokens: 2_000 }),
        sessions: 1,
      },
    ],
    models: [
      {
        modelId: "claude-opus-5-5",
        platform: "claude",
        totals: totals({ totalTokens: 8_000, costUsd: 4 }),
        sessions: 2,
      },
      {
        modelId: "gpt-6.1",
        platform: "codex",
        totals: totals({ totalTokens: 2_000, costUsd: 0, unpricedTokens: 2_000 }),
        sessions: 1,
      },
    ],
    environments: [
      {
        environmentId: "env-1",
        name: "Feature branch",
        projectName: "Orkestrator",
        totals: totals(),
        sessions: 3,
      },
    ],
    recordingSince: "2026-09-01",
    recordedPlatforms: ["claude", "codex"],
    ...overrides,
  };
}

let history: ReturnType<typeof spyOn<typeof backend, "getUsageHistory">>;

beforeEach(() => {
  history = spyOn(backend, "getUsageHistory").mockResolvedValue(report());
});

afterEach(() => {
  cleanup();
  mock.restore();
});

/** The headline card above the chart, which carries the range total. */
async function headline() {
  return within(await screen.findByRole("region", { name: "Daily usage" }));
}

test("shows the recorded range, its headline and the model breakdown", async () => {
  render(<UsageSettings />);
  expect(await screen.findByText(/recorded since/i)).toBeTruthy();
  expect((await screen.findByTestId("usage-total")).textContent).toBe("10.0K");
  expect((await headline()).getByText(/3 sessions/)).toBeTruthy();
  expect(screen.getByRole("cell", { name: "claude-opus-5-5" })).toBeTruthy();
  // The default range is 30 days and asks for every platform.
  expect(history).toHaveBeenCalledWith({ days: 30 });
});

test("a model the provider never priced reads as unpriced, not free", async () => {
  render(<UsageSettings />);
  const row = (await screen.findByRole("cell", { name: "gpt-6.1" })).closest("tr");
  expect(row).toBeTruthy();
  expect(within(row as HTMLElement).getByText("Unpriced")).toBeTruthy();
});

test("the cost view reports money without asking the backend again", async () => {
  render(<UsageSettings />);
  await headline();
  fireEvent.click(screen.getByRole("button", { name: "Cost" }));
  await waitFor(() => expect(screen.getByTestId("usage-total").textContent).toBe("$4.00"));
  expect(history).toHaveBeenCalledTimes(1);
});

test("changing the range re-reads and keeps the last report on screen", async () => {
  render(<UsageSettings />);
  await headline();
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  expect(history.mock.calls[1]?.[0]).toEqual({ days: 7 });
  expect(screen.getByTestId("usage-total").textContent).toBe("10.0K");
});

test("selecting a platform from the list filters the read", async () => {
  render(<UsageSettings />);
  await headline();
  fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
  await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  expect(history.mock.calls[1]?.[0]).toEqual({ days: 30, platform: "claude" });
});

test("the arrow keys read one day of the chart", async () => {
  render(<UsageSettings />);
  await headline();
  const plot = screen.getByRole("group", { name: /Daily processed tokens/ });
  fireEvent.keyDown(plot, { key: "ArrowLeft" });
  const readout = await screen.findByTestId("usage-chart-readout");
  expect(within(readout).getByText(/Oct/)).toBeTruthy();
  expect(within(readout).getByText("4.00K")).toBeTruthy();
});

test("an empty recording says so rather than drawing nothing", async () => {
  history.mockResolvedValue(
    report({
      days: [
        {
          day: "2026-10-20",
          totals: totals({ totalTokens: 0, costUsd: 0, turns: 0 }),
          platforms: [],
        },
      ],
      totals: totals({
        totalTokens: 0,
        costUsd: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      }),
      sessions: 0,
      platforms: [],
      models: [],
      environments: [],
      recordingSince: undefined,
      recordedPlatforms: [],
    }),
  );
  render(<UsageSettings />);
  expect(await screen.findByText("No usage recorded in this range.")).toBeTruthy();
  expect(screen.getByText("Nothing recorded in this range yet.")).toBeTruthy();
});

test("a failed read is reported and does not blank the pane", async () => {
  history.mockRejectedValue(new Error("backend unavailable"));
  render(<UsageSettings />);
  expect(await screen.findByText("backend unavailable")).toBeTruthy();
});

test("the limits view asks each enabled platform for its plan", async () => {
  const plan = spyOn(backend, "getPlanUsage").mockResolvedValue({
    platform: "claude",
    status: "ok",
    fetchedAt: "2026-10-20T12:00:00.000Z",
    windows: [],
  });
  render(<UsageSettings />);
  await headline();
  fireEvent.click(screen.getByRole("button", { name: "Limits" }));
  await waitFor(() => expect(plan).toHaveBeenCalled());
  expect(screen.getAllByRole("region", { name: "Plan usage" }).length).toBeGreaterThan(0);
});

test("a failed refresh keeps the report that was already on screen", async () => {
  render(<UsageSettings />);
  await headline();
  history.mockRejectedValue(new Error("backend unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  expect(await screen.findByText("backend unavailable")).toBeTruthy();
  // The numbers that did load stay readable under the error.
  expect(screen.getByTestId("usage-total").textContent).toBe("10.0K");
});

test("the cost view ranks environments by spend, not by tokens", async () => {
  history.mockResolvedValue(
    report({
      environments: [
        ...Array.from({ length: 6 }, (_, index) => ({
          environmentId: `bulk-${index}`,
          name: `Bulk ${index}`,
          totals: totals({ totalTokens: 9_000_000, costUsd: 0, unpricedTokens: 9_000_000 }),
          sessions: 1,
        })),
        {
          environmentId: "spender",
          name: "Big spender",
          totals: totals({ totalTokens: 1_000, costUsd: 900 }),
          sessions: 1,
        },
      ],
    }),
  );
  render(<UsageSettings />);
  await headline();
  // Token order puts the only environment that cost anything last, where the
  // six-row limit cuts it off.
  expect(
    within(screen.getByRole("region", { name: "Environments" })).queryByText("Big spender") ===
      null,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cost" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Environments" })).getByText("Big spender"),
    ).toBeTruthy(),
  );
  expect(
    within(screen.getByRole("region", { name: "Environments" })).getByText("$900.00"),
  ).toBeTruthy();
});

test("the cost view calls unpriced tokens unpriced, not absent", async () => {
  const unpriced = totals({ totalTokens: 6_000, costUsd: 0, unpricedTokens: 6_000 });
  history.mockResolvedValue(
    report({
      days: [
        {
          day: "2026-10-20",
          totals: unpriced,
          platforms: [{ platform: "codex", totals: unpriced }],
        },
      ],
      totals: unpriced,
      platforms: [{ platform: "codex", totals: unpriced, sessions: 1 }],
      models: [{ modelId: "gpt-6.1", platform: "codex", totals: unpriced, sessions: 1 }],
      recordedPlatforms: ["codex"],
    }),
  );
  render(<UsageSettings />);
  await headline();
  fireEvent.click(screen.getByRole("button", { name: "Cost" }));
  expect(await screen.findByText("No priced spend in this range.")).toBeTruthy();
  expect(screen.queryByText("No usage recorded in this range.") === null).toBe(true);
});

test("the platform filter always offers whatever is selected", () => {
  expect(usagePlatformFilterOptions(["claude"], "all")).toEqual(["claude"]);
  // A report that no longer lists the selected platform must not drop its
  // option: the trigger would go blank with the filter still applied.
  expect(usagePlatformFilterOptions([], "codex")).toEqual(["codex"]);
  expect(usagePlatformFilterOptions(["codex"], "claude")).toEqual(["claude", "codex"]);
  expect(usagePlatformFilterOptions(["codex", "claude"], "claude")).toEqual(["claude", "codex"]);
});
