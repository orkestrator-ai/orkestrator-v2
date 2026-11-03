import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { UsagePanel } from "./AgentInfoButton.panels";

const planWindows = [{ window: "seven_day", label: "Weekly limit", usedPercent: 62 }];
afterEach(cleanup);

test("renders fallback windows with account attribution before any context usage arrives", () => {
  render(
    <UsagePanel
      usage={undefined}
      modelId="claude"
      planWindows={planWindows}
      accountLabel="Work"
      accountEmail="work@example.com"
    />,
  );
  const account = within(screen.getByRole("region", { name: "Account usage" }));
  expect(account.getByText("Weekly limit")).toBeTruthy();
  expect(account.getByText("62% used")).toBeTruthy();
  expect(account.getByText("(Work) (work@example.com)")).toBeTruthy();
  expect(screen.queryByText(/Usage will appear/) === null).toBe(true);
  expect(screen.getByText("Provider reported")).toBeTruthy();
});

test("appends fallback windows while preserving daily token buckets and context usage", () => {
  render(
    <UsagePanel
      usage={{
        usedTokens: 25000,
        totalTokens: 100000,
        percentUsed: 25,
        estimated: false,
        source: "claude",
        updatedAt: "2026-11-03T12:00:00Z",
        account: [{ window: "daily:2026-11-02", label: "2026-11-02", tokens: 60000000 }],
      }}
      modelId="claude"
      planWindows={planWindows}
    />,
  );
  const account = within(screen.getByRole("region", { name: "Account usage" }));
  expect(account.getByText("Weekly limit")).toBeTruthy();
  expect(account.getByText("62% used")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Daily tokens" })).toBeTruthy();
  expect(screen.getByText("25%")).toBeTruthy();
});
