import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { invoke } from "@/lib/native/backend";
import { resetNodeEventsForTests } from "@/lib/federation/node-events";
import { RELAYED_NODE_EVENT } from "@orkestrator/protocol/node-events";
import { AGENT_USAGE_READINGS_CHANGED_EVENT } from "@orkestrator/protocol/agent-account-shared-usage";
import { AccountMachineProvider } from "./account-machine";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

const getPlanUsage = mock(
  async (..._args: Parameters<typeof realBackend.getPlanUsage>): Promise<PlanUsageSnapshot> => {
    throw new Error("getPlanUsage was not configured for this test");
  },
);

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

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
function emit(event: string, payload?: unknown) {
  for (const handler of listeners.get(event) ?? []) handler({ payload });
}
beforeEach(() => {
  resetNodeEventsForTests();
  listeners.clear();
  (listen as ReturnType<typeof mock>).mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
  );
  (invoke as ReturnType<typeof mock>).mockImplementation(
    async (command: string, args: Record<string, unknown>) =>
      command === "watch_node_events"
        ? { watchId: args.watchId, expiresAt: Date.now() + 90_000, renewed: true }
        : { removed: true },
  );
  getPlanUsage.mockReset();
});

afterEach(() => {
  cleanup();
  resetNodeEventsForTests();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("PlanUsageSection", () => {
  test("updates from a selected leaf event, recovers a gap and releases the old machine", async () => {
    const first = snapshot({
      platform: "codex",
      windows: [{ window: "primary", usedPercent: 11 }],
    });
    getPlanUsage.mockResolvedValue(first);
    const view = render(
      <AccountMachineProvider value={{ machine: "bk_leaf", name: "Leaf" }}>
        <PlanUsageSection platform="codex" />
      </AccountMachineProvider>,
    );
    await screen.findByText("11% used");
    await waitFor(() => expect(listeners.has(RELAYED_NODE_EVENT)).toBe(true));
    const newer = {
      ...first,
      fetchedAt: new Date().toISOString(),
      windows: [{ window: "primary", usedPercent: 89 }],
      readOn: { nodeId: "bk_reader", nodeName: "reader" },
    };
    getPlanUsage.mockResolvedValue(newer);
    await act(async () =>
      emit(RELAYED_NODE_EVENT, {
        nodeId: "bk_leaf",
        kind: "event",
        event: AGENT_USAGE_READINGS_CHANGED_EVENT,
        payload: { platform: "codex", origin: "shared" },
      }),
    );
    await screen.findByText("89% used");
    expect(screen.getByTestId("usage-reading-age").textContent).toContain("on reader");
    expect(getPlanUsage.mock.calls.at(-1)).toEqual([
      "codex",
      { force: false, cacheOnly: true },
      "bk_leaf",
    ]);
    getPlanUsage.mockResolvedValue({ ...newer, windows: [{ window: "primary", usedPercent: 95 }] });
    await act(async () => emit(RELAYED_NODE_EVENT, { nodeId: "bk_leaf", kind: "resync" }));
    await screen.findByText("95% used");
    view.rerender(
      <AccountMachineProvider value={{ machine: null, name: null }}>
        <PlanUsageSection platform="codex" />
      </AccountMachineProvider>,
    );
    await waitFor(() => expect(getPlanUsage.mock.calls.at(-1)?.[2]).toBe(null));
    const before = getPlanUsage.mock.calls.length;
    await act(async () =>
      emit(RELAYED_NODE_EVENT, {
        nodeId: "bk_leaf",
        kind: "event",
        event: AGENT_USAGE_READINGS_CHANGED_EVENT,
        payload: { platform: "codex" },
      }),
    );
    expect(getPlanUsage.mock.calls.length).toBe(before);
    getPlanUsage.mockResolvedValue({ ...newer, windows: [{ window: "primary", usedPercent: 97 }] });
    await act(async () => emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT));
    await screen.findByText("97% used");
    view.unmount();
    // A fresh mount rereads the authoritative backend snapshot.
    render(<PlanUsageSection platform="codex" />);
    await screen.findByText("97% used");
  });

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
    const age = screen.getByTestId("usage-reading-age");
    expect(age.textContent).toMatch(/Updated .+ \(1h ago\)/);
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("HTTP 429. Retrying in 5 minutes.")).toBeTruthy();
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

  test("lists quota windows in label order whatever order they were reported in", async () => {
    getPlanUsage.mockResolvedValue(
      snapshot({
        windows: [
          { window: "weekly_fable", label: "Weekly Fable limit", usedPercent: 1 },
          { window: "weekly", label: "Weekly limit", usedPercent: 2 },
          { window: "five_hour", label: "5-hour limit", usedPercent: 3 },
        ],
      }),
    );
    render(<PlanUsageSection platform="opencode" />);
    await screen.findByText("5-hour limit");
    const labels = screen.getAllByText(/limit$/).map((element) => element.textContent);
    expect(labels).toEqual(["5-hour limit", "Weekly Fable limit", "Weekly limit"]);
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
    expect(screen.getByText("Usage has not been read yet.")).toBeTruthy();
    expect(screen.queryByText(/^Updated /) === null).toBe(true);
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
