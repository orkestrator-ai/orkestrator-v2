import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  test("keeps stale quotas and explains the original reading time and failure", async () => {
    getPlanUsage.mockResolvedValue(
      snapshot({
        stale: true,
        fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
        message: "HTTP 429. Retrying in 5 minutes.",
        windows: [{ window: "weekly", label: "Weekly", usedPercent: 42 }],
      }),
    );
    render(<PlanUsageSection platform="opencode" />);
    expect(await screen.findByText("42% used")).toBeTruthy();
    expect(screen.getByText(/Last known usage, as of 1h ago\. HTTP 429/)).toBeTruthy();
    expect(screen.queryByText(/^Updated /) === null).toBe(true);
    expect(screen.getByLabelText("Refresh plan usage").hasAttribute("disabled")).toBe(false);
  });

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

  test("shows an error message from a resolved error snapshot", async () => {
    getPlanUsage.mockResolvedValue(
      snapshot({ status: "error", message: "Plan usage read failed" }),
    );
    render(<PlanUsageSection platform="opencode" />);
    expect(await screen.findByText("Plan usage read failed")).toBeTruthy();
  });

  test("treats an authoritative empty snapshot as no metered limits", async () => {
    getPlanUsage.mockResolvedValue(snapshot({ status: "ok", windows: [] }));
    render(<PlanUsageSection platform="opencode" />);
    expect(await screen.findByText(/does not report any metered plan limits/)).toBeTruthy();
  });

  test("reads every platform when the pane opens", async () => {
    getPlanUsage.mockResolvedValue(
      snapshot({
        platform: "claude",
        windows: [{ window: "five_hour", label: "5-hour limit", usedPercent: 37 }],
      }),
    );
    render(<PlanUsageSection platform="claude" />);
    expect(await screen.findByText("5-hour limit")).toBeTruthy();
    expect(getPlanUsage).toHaveBeenCalledWith("claude", { force: false }, undefined);
  });

  test("skips the cache after a credential save bumps the reload token", async () => {
    getPlanUsage.mockResolvedValue(snapshot({ platform: "cursor" }));
    const { rerender } = render(<PlanUsageSection platform="cursor" reloadToken={0} />);
    await waitFor(() =>
      expect(getPlanUsage).toHaveBeenCalledWith("cursor", { force: false }, undefined),
    );

    rerender(<PlanUsageSection platform="cursor" reloadToken={1} />);
    await waitFor(() =>
      expect(getPlanUsage).toHaveBeenCalledWith("cursor", { force: true }, undefined),
    );
  });

  test("re-reads past the cache when the refresh control is used", async () => {
    getPlanUsage.mockResolvedValue(snapshot({ platform: "claude" }));
    render(<PlanUsageSection platform="claude" />);
    await waitFor(() =>
      expect(getPlanUsage).toHaveBeenCalledWith("claude", { force: false }, undefined),
    );

    fireEvent.click(screen.getByLabelText("Refresh plan usage"));
    await waitFor(() =>
      expect(getPlanUsage).toHaveBeenCalledWith("claude", { force: true }, undefined),
    );
  });

  test("surfaces a failed read and keeps the pane usable", async () => {
    getPlanUsage.mockRejectedValueOnce(new Error("Plan usage is unavailable"));
    render(<PlanUsageSection platform="opencode" />);
    expect(await screen.findByText("Plan usage is unavailable")).toBeTruthy();
    expect(getPlanUsage).toHaveBeenCalledWith("opencode", { force: false }, undefined);
  });

  test("ignores a slow response once the platform has changed", async () => {
    let resolveFirst!: (value: PlanUsageSnapshot) => void;
    const firstRequest = new Promise<PlanUsageSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    getPlanUsage.mockImplementation((async (platform: string) => {
      return platform === "claude"
        ? firstRequest
        : snapshot({
            platform: "codex",
            windows: [{ window: "primary", label: "Primary limit", usedPercent: 5 }],
          });
    }) as unknown as () => Promise<PlanUsageSnapshot>);

    const { rerender } = render(<PlanUsageSection platform="claude" />);
    await waitFor(() =>
      expect(getPlanUsage).toHaveBeenCalledWith("claude", { force: false }, undefined),
    );

    rerender(<PlanUsageSection platform="codex" />);
    expect(await screen.findByText("Primary limit")).toBeTruthy();

    resolveFirst(
      snapshot({
        platform: "claude",
        windows: [{ window: "five_hour", label: "5-hour limit", usedPercent: 90 }],
      }),
    );
    await waitFor(() => expect(screen.queryByText("5-hour limit") === null).toBe(true));
  });
});
