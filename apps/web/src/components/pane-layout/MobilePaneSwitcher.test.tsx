import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PaneSplit } from "@/types/paneLayout";
import { collectPaneLeaves } from "./PaneSplitContainer";
import { MobilePaneSwitcher } from "./MobilePaneSwitcher";

afterEach(cleanup);

describe("MobilePaneSwitcher", () => {
  test("keeps every pane mounted and switches the visible pane", () => {
    const onSelect = mock((_paneId: string) => undefined);
    function Harness() {
      const [activePaneId, setActivePaneId] = useState("left");
      return (
        <MobilePaneSwitcher
          panes={[{ id: "left", label: "Terminal" }, { id: "right", label: "Codex" }]}
          activePaneId={activePaneId}
          onSelect={(paneId) => {
            onSelect(paneId);
            setActivePaneId(paneId);
          }}
          renderPane={(paneId, active) => <div>{paneId}:{String(active)}</div>}
        />
      );
    }
    render(<Harness />);

    expect(screen.getByText("left:true")).toBeTruthy();
    expect(screen.getByText("right:false")).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: "1. Terminal" }).hidden).toBe(false);
    expect(document.getElementById("mobile-pane-panel-right")?.hidden).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "2. Codex" }));
    expect(onSelect).toHaveBeenCalledWith("right");
    expect(screen.getByText("right:true")).toBeTruthy();
    expect(document.getElementById("mobile-pane-panel-left")?.hidden).toBe(true);
  });

  test("falls back to the first pane when the stored active id is stale", () => {
    render(
      <MobilePaneSwitcher
        panes={[{ id: "first", label: "First" }, { id: "second", label: "Second" }]}
        activePaneId="removed"
        onSelect={() => undefined}
        renderPane={(paneId) => <div>{paneId}</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: "1. First" }).getAttribute("aria-selected")).toBe("true");
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
});
