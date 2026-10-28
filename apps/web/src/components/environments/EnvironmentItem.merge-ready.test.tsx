import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import type { Environment } from "@/types";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { EnvironmentItem } from "./EnvironmentItem";

const PR = "https://github.com/acme/repo/pull/7";

function readyEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "ship-the-feature",
    branch: "feature/ship",
    containerId: null,
    status: "running",
    prUrl: PR,
    prState: "open",
    hasMergeConflicts: false,
    prMergeability: "clean",
    createdAt: "2026-10-28T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    agentActivityState: "idle",
    ...overrides,
  };
}

function monitorState(overrides: Partial<PrMonitorEnvironmentState> = {}) {
  return {
    environmentId: "env-1",
    mode: "normal" as const,
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-10-28T10:00:00.000Z",
    lastSuccessfulCheckAt: "2026-10-28T10:00:00.000Z",
    prUrl: PR,
    prState: "open" as const,
    hasMergeConflicts: false,
    checkSummary: { passed: 3, total: 3, pending: 0 },
    ...overrides,
  };
}

const callbacks = {
  onSelect: mock(() => undefined),
  onDelete: mock(() => undefined),
  onStart: mock(() => undefined),
  onStop: mock(() => undefined),
  onRestart: mock(() => undefined),
};

function renderItem(environment: Environment) {
  return render(<EnvironmentItem environment={environment} isSelected={false} {...callbacks} />);
}

function nameElement(): HTMLElement {
  return screen.getByText("ship-the-feature");
}

function row(): HTMLElement {
  // Exact: the ready state is a description, so the row's name never changes.
  return screen.getByRole("button", { name: "ship-the-feature" });
}

/** Text of the elements `aria-describedby` names, as assistive tech reads it. */
function description(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

beforeEach(() => {
  usePrMonitorStore.setState({ states: new Map(), syncStatus: "idle" });
});

afterEach(cleanup);

describe("EnvironmentItem ready-to-merge shimmer", () => {
  test("shimmers the name and describes the row while the PR is ready to merge", () => {
    usePrMonitorStore.getState().applySnapshot([monitorState()]);
    usePrMonitorStore.getState().setSyncStatus("current");
    renderItem(readyEnvironment());

    expect(nameElement().classList).toContain("text-shimmer");
    expect(nameElement().classList).toContain("merge-ready-name");
    // The name keeps its own truncation and the row its accessible name.
    expect(nameElement().classList).toContain("truncate");
    expect(description(row())).toBe("Ready to merge");
    // Hidden, so it never joins the row's name-from-content.
    expect(document.getElementById(row().getAttribute("aria-describedby")!)?.hidden).toBe(true);
  });

  test("reduced motion gets a static indicator; the hover card says it in words", async () => {
    usePrMonitorStore.getState().applySnapshot([monitorState()]);
    usePrMonitorStore.getState().setSyncStatus("current");
    renderItem(readyEnvironment());

    // The icon is CSS-gated: hidden unless prefers-reduced-motion (or forced
    // colours) applies, where the name's sweep becomes a static highlight.
    const indicator = screen.getByTestId("merge-ready-indicator");
    expect(indicator.getAttribute("aria-hidden")).toBe("true");
    expect(indicator.classList).toContain("hidden");
    expect(indicator.classList).toContain("motion-reduce:inline-block");

    fireEvent.mouseEnter(row());
    expect((await screen.findByTestId("environment-tooltip-ready-to-merge")).textContent).toBe(
      "Ready to merge",
    );
  });

  test("stops as soon as the PR is merged, conflicts, or a check fails", () => {
    usePrMonitorStore.getState().applySnapshot([monitorState()]);
    usePrMonitorStore.getState().setSyncStatus("current");
    const view = renderItem(readyEnvironment());
    expect(nameElement().classList).toContain("text-shimmer");

    view.rerender(
      <EnvironmentItem
        environment={readyEnvironment({ hasMergeConflicts: true, prMergeability: "dirty" })}
        isSelected={false}
        {...callbacks}
      />,
    );
    expect(nameElement().classList).not.toContain("text-shimmer");
    expect(screen.queryByTestId("merge-ready-indicator")).toBeNull();
    expect(row().hasAttribute("aria-describedby")).toBe(false);

    view.rerender(
      <EnvironmentItem environment={readyEnvironment()} isSelected={false} {...callbacks} />,
    );
    expect(nameElement().classList).toContain("text-shimmer");

    act(() => {
      usePrMonitorStore.getState().applyEvent({
        environmentId: "env-1",
        state: monitorState({ checkSummary: { passed: 2, total: 3, pending: 0 } }),
      });
    });
    expect(nameElement().classList).not.toContain("text-shimmer");

    act(() => {
      usePrMonitorStore.getState().applyEvent({ environmentId: "env-1", state: monitorState() });
    });
    expect(nameElement().classList).toContain("text-shimmer");

    view.rerender(
      <EnvironmentItem
        environment={readyEnvironment({ prState: "merged" })}
        isSelected={false}
        {...callbacks}
      />,
    );
    expect(nameElement().classList).not.toContain("text-shimmer");
  });

  test("does not shimmer while the PR reading is stale or unconfirmed", () => {
    usePrMonitorStore.getState().applySnapshot([monitorState()]);
    usePrMonitorStore.getState().setSyncStatus("stale");
    renderItem(readyEnvironment());
    expect(nameElement().classList).not.toContain("text-shimmer");

    act(() => usePrMonitorStore.getState().setSyncStatus("current"));
    expect(nameElement().classList).toContain("text-shimmer");

    act(() => {
      usePrMonitorStore.getState().applyEvent({
        environmentId: "env-1",
        state: monitorState({ consecutiveErrors: 1 }),
      });
    });
    expect(nameElement().classList).not.toContain("text-shimmer");
  });

  test("an environment without a PR never shimmers", () => {
    usePrMonitorStore.getState().setSyncStatus("current");
    renderItem(
      readyEnvironment({
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        prMergeability: null,
      }),
    );
    expect(nameElement().classList).not.toContain("text-shimmer");
    expect(nameElement().hasAttribute("data-merge-ready")).toBe(false);
  });
});
