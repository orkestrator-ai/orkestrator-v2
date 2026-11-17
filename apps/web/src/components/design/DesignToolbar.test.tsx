import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DesignToolbar, type DesignToolbarProps } from "./DesignToolbar";

afterEach(() => cleanup());

const noop = () => {};

function props(overrides: Partial<DesignToolbarProps> = {}): DesignToolbarProps {
  return {
    projection: undefined,
    zoom: 1,
    mode: "inspect",
    narrow: false,
    compact: false,
    layersOpen: false,
    inspectorOpen: false,
    historyOpen: false,
    canEdit: true,
    hasSelection: true,
    onToggleLayers: noop,
    onToggleInspector: noop,
    onToggleHistory: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoom100: noop,
    onFitAll: noop,
    onFitSelection: noop,
    onAddFrame: noop,
    onUndo: noop,
    onRedo: noop,
    onExport: noop,
    onDownload: noop,
    onToggleMode: noop,
    onRename: noop,
    onAskAgent: noop,
    onShortcuts: noop,
    ...overrides,
  };
}

describe("DesignToolbar", () => {
  test("fit all and zoom to selection have different icons", () => {
    render(<DesignToolbar {...props()} />);
    const fitAll = screen.getByRole("button", { name: "Fit all frames" });
    const fitSelection = screen.getByRole("button", { name: "Zoom to selection" });
    expect(fitAll.querySelector("svg.lucide-maximize")).toBeTruthy();
    // Zoom to selection draws a target inside the frame corners.
    expect(fitSelection.querySelector("svg.lucide-focus")).toBeTruthy();
    expect(fitSelection.querySelector("svg")?.innerHTML).not.toBe(
      fitAll.querySelector("svg")?.innerHTML,
    );
  });

  test("the agent panel toggle shows only for a design tab with a panel", () => {
    const onToggleAgentPanel = mock(() => {});
    render(<DesignToolbar {...props({ agentPanelOpen: true, onToggleAgentPanel })} />);
    const toggle = screen.getByRole("button", { name: "Hide agent panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggleAgentPanel).toHaveBeenCalledTimes(1);
    cleanup();
    render(<DesignToolbar {...props()} />);
    expect(screen.queryByRole("button", { name: /agent panel/ }) === null).toBe(true);
  });
});
