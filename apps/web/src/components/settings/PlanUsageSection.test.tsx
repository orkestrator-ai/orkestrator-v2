import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

const getPlanUsage = mock(async (): Promise<PlanUsageSnapshot> => {
  throw new Error("getPlanUsage was not configured for this test");
});

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getPlanUsage,
}));

const { PlanUsageSection } = await import("./PlanUsageSection");

function snapshot(overrides: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  return {
    platform: "opencode",
    status: "ok",
    windows: [],
    fetchedAt: new Date("2026-09-11T18:32:00.000Z").toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  getPlanUsage.mockReset();
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("PlanUsageSection", () => {
  test("renders a row per reported quota window", async () => {
    getPlanUsage.mockResolvedValue(
      snapshot({
        windows: [
          { window: "rolling", label: "Rolling", usedPercent: 9 },
          { window: "weekly", label: "Weekly", usedPercent: 12 },
        ],
      }),
    );
    render(<PlanUsageSection platform="opencode" />);
    expect(await screen.findByText("Rolling")).toBeTruthy();
    expect(screen.getByText("9.0% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("12% used")).toBeTruthy();
  });

  test("shows the backend's explanation when a key is missing", async () => {
    getPlanUsage.mockResolvedValue(
      snapshot({
        status: "unavailable",
        message: "Add an OpenCode Zen API key below to see your plan usage.",
      }),
    );
    render(<PlanUsageSection platform="opencode" />);
    expect(await screen.findByText(/Add an OpenCode Zen API key/)).toBeTruthy();
  });

  test("surfaces a failed read and keeps the pane usable", async () => {
    getPlanUsage.mockRejectedValueOnce(new Error("Plan usage is unavailable"));
    render(<PlanUsageSection platform="claude" />);
    expect(await screen.findByText("Plan usage is unavailable")).toBeTruthy();
    expect(getPlanUsage).toHaveBeenCalledWith("claude");
  });
});
