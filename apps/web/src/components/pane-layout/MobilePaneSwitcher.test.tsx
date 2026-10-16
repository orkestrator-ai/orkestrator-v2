import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PaneSplit } from "@/types/paneLayout";
import { MULTI_REVIEW_LEGACY_FIX_TAB_TITLE } from "@orkestrator/protocol/multi-review";
import { collectPaneLeaves, mobilePaneOptions } from "./PaneTree";
import { MobilePaneSwitcher } from "./MobilePaneSwitcher";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";

afterEach(cleanup);

/** Shown means in the accessibility tree and not inert; hidden panes stay laid out. */
function isShown(panel: HTMLElement): boolean {
  return !panel.hasAttribute("inert") && panel.style.visibility !== "hidden";
}

describe("MobilePaneSwitcher", () => {
  test("keeps every pane mounted and switches the visible pane", () => {
    const onSelect = mock((_paneId: string) => undefined);
    function Harness() {
      const [activePaneId, setActivePaneId] = useState("left");
      return (
        <MobilePaneSwitcher
          panes={[
            { id: "left", label: "Terminal" },
            { id: "right", label: "Codex" },
          ]}
          activePaneId={activePaneId}
          onSelect={(paneId) => {
            onSelect(paneId);
            setActivePaneId(paneId);
          }}
          renderPane={(paneId, active) => (
            <div>
              {paneId}:{String(active)}
            </div>
          )}
        />
      );
    }
    render(<Harness />);

    expect(screen.getByText("left:true")).toBeTruthy();
    expect(screen.getByText("right:false")).toBeTruthy();
    expect(isShown(screen.getByRole("tabpanel", { name: "1. Terminal" }))).toBe(true);
    expect(isShown(document.getElementById("mobile-pane-panel-right")!)).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "2. Codex" }));
    expect(onSelect).toHaveBeenCalledWith("right");
    expect(screen.getByText("right:true")).toBeTruthy();
    expect(isShown(document.getElementById("mobile-pane-panel-left")!)).toBe(false);
  });

  test("keeps a hidden pane laid out but out of reach of pointer, keyboard and assistive tech", () => {
    render(
      <MobilePaneSwitcher
        panes={[
          { id: "left", label: "Terminal" },
          { id: "right", label: "Codex" },
        ]}
        activePaneId="left"
        onSelect={() => undefined}
        renderPane={(paneId) => <button type="button">Control in {paneId}</button>}
      />,
    );
    const shown = document.getElementById("mobile-pane-panel-left")!;
    const hidden = document.getElementById("mobile-pane-panel-right")!;

    // Laid out at full size: never `display: none` and never the `hidden` attribute.
    for (const panel of [shown, hidden]) {
      expect(panel.hasAttribute("hidden")).toBe(false);
      expect(getComputedStyle(panel).display).not.toBe("none");
      expect(panel.className).toContain("absolute inset-0");
    }
    expect(hidden.hasAttribute("inert")).toBe(true);
    expect(hidden.style.visibility).toBe("hidden");
    expect(hidden.style.opacity).toBe("0");
    expect(hidden.style.pointerEvents).toBe("none");
    expect(shown.hasAttribute("inert")).toBe(false);
    expect(shown.getAttribute("style")).toBeNull();

    // Only the shown pane is in the accessibility tree.
    expect(screen.getAllByRole("tabpanel")).toEqual([shown]);
    expect(screen.getByRole("button", { name: "Control in left" })).toBeTruthy();
    expectDomAbsent(screen.queryByRole("button", { name: "Control in right" }));
    // Still mounted: a hidden pane keeps receiving backend updates.
    expect(hidden.contains(screen.getByText("Control in right"))).toBe(true);
  });

  test("falls back to the first pane when the stored active id is stale", () => {
    render(
      <MobilePaneSwitcher
        panes={[
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ]}
        activePaneId="removed"
        onSelect={() => undefined}
        renderPane={(paneId) => <div>{paneId}</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: "1. First" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  test("collects nested pane leaves in visual order", () => {
    const split: PaneSplit = {
      kind: "split",
      id: "root",
      direction: "horizontal",
      depth: 0,
      sizes: [50, 50],
      children: [
        { kind: "leaf", id: "left", tabs: [], activeTabId: null },
        {
          kind: "split",
          id: "right",
          direction: "vertical",
          depth: 1,
          sizes: [50, 50],
          children: [
            { kind: "leaf", id: "top", tabs: [], activeTabId: null },
            { kind: "leaf", id: "bottom", tabs: [], activeTabId: null },
          ],
        },
      ],
    };

    expect(collectPaneLeaves(split).map((pane) => pane.id)).toEqual(["left", "top", "bottom"]);
  });

  test("normalizes a restored Multi Review fix title in the mobile pane selector", () => {
    const split: PaneSplit = {
      kind: "split",
      id: "root",
      direction: "horizontal",
      depth: 0,
      sizes: [50, 50],
      children: [
        {
          kind: "leaf",
          id: "left",
          activeTabId: "fix-tab",
          tabs: [
            {
              id: "fix-tab",
              type: "agent-native",
              displayTitle: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
              isReviewTab: true,
            },
          ],
        },
        { kind: "leaf", id: "right", tabs: [], activeTabId: null },
      ],
    };

    render(
      <MobilePaneSwitcher
        panes={mobilePaneOptions(split)}
        activePaneId="left"
        onSelect={() => undefined}
        renderPane={() => null}
      />,
    );

    expect(screen.getByRole("tab", { name: "1. Fix" })).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: `1. ${MULTI_REVIEW_LEGACY_FIX_TAB_TITLE}` }) === null,
    ).toBe(true);
  });
});
