import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DesignProjection } from "@/stores/designStore";
import { DesignToolbar, type DesignToolbarProps } from "./DesignToolbar";

const noop = () => {};

function projection(): DesignProjection {
  return {
    canvas: { name: "Landing page" },
    busy: { export: false },
    workspace: {
      history: { canUndo: true, undoLabel: "move frame", canRedo: false },
    },
  } as unknown as DesignProjection;
}

function props(overrides: Partial<DesignToolbarProps> = {}): DesignToolbarProps {
  return {
    projection: projection(),
    zoom: 0.53,
    mode: "inspect",
    narrow: true,
    compact: false,
    layersOpen: false,
    inspectorOpen: false,
    historyOpen: false,
    canEdit: true,
    hasSelection: false,
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

function toolbarButtons() {
  return within(screen.getByRole("toolbar", { name: "Design tools" })).getAllByRole("button");
}

/** The open tooltip's text, read through the accessible copy Radix renders. */
async function tooltipText(): Promise<string> {
  const tooltip = await screen.findByRole("tooltip");
  return tooltip.textContent ?? "";
}

async function closeTooltips() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
}

describe("DesignToolbar tooltips", () => {
  afterEach(() => {
    cleanup();
  });

  test("every toolbar button shows a tooltip when focused, and none uses a native title", async () => {
    render(<DesignToolbar {...props()} />);
    const buttons = toolbarButtons();
    // Layers, rename, 13 tools, inspector and shortcuts.
    expect(buttons.length).toBe(17);
    for (const button of buttons) {
      expect(button.getAttribute("title")).toBeNull();
      expect(button.closest("[data-design-tooltip-trigger]")).not.toBeNull();
    }

    const expected: Record<string, string> = {
      "Toggle layers": "Show layers",
      "Design name: Landing page. Rename": "Rename design",
      "Zoom out": "Zoom out-",
      "Zoom 53%. Reset to 100%": "Zoom to 100%Ctrl/⌘+0",
      "Zoom in": "Zoom in+",
      "Fit all frames": "Fit all framesShift+1",
      "Preview mode": "Preview: scroll and hover the mockupP",
      "Add frame": "Add frame",
      "Undo design change": "Undo move frameCtrl/⌘+Z",
      "Export design to repository": "Export a revision to the repository (Save As)",
      "Download orkdes": "Download the design as an .orkdes file",
      "Design history": "Design history",
      "Ask agent about the selection": "Ask agent about the selection",
      "Toggle inspector": "Show inspector",
      "Keyboard shortcuts": "Keyboard shortcuts?",
    };
    for (const [name, text] of Object.entries(expected)) {
      const button = screen.getByRole("button", { name });
      act(() => button.focus());
      expect(await tooltipText()).toBe(text);
      await closeTooltips();
    }
  });

  test("a disabled tool still explains itself on hover", async () => {
    render(<DesignToolbar {...props()} />);
    const fit = screen.getByRole("button", { name: "Zoom to selection" });
    expect(fit.hasAttribute("disabled")).toBe(true);
    // A disabled button takes no pointer events, so its wrapper is the trigger.
    const trigger = fit.closest("[data-design-tooltip-trigger]") as HTMLElement;
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(await tooltipText()).toBe("Zoom to selection (select a frame first)Shift+2");
  });

  test("the compact toolbar's overflow menu button has a tooltip", async () => {
    render(<DesignToolbar {...props({ compact: true, narrow: false })} />);
    const more = screen.getByRole("button", { name: "More design tools" });
    expect(more.getAttribute("title")).toBeNull();
    act(() => more.focus());
    expect(await tooltipText()).toBe("More design tools");
  });
});
