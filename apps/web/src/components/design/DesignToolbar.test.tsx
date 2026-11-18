import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DesignProjection } from "@/stores/designStore";
import { DesignToolbar, type DesignToolbarProps } from "./DesignToolbar";

afterEach(() => cleanup());

const noop = () => {};

function projection(): DesignProjection {
  return {
    canvas: { name: "Landing page" },
    busy: { export: false },
    workspace: {
      history: {
        revision: 1,
        undoCount: 1,
        redoCount: 0,
        canUndo: true,
        undoLabel: "move frame",
        canRedo: false,
      },
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

function expectDescription(button: HTMLElement, text: string) {
  const descriptionId = button.getAttribute("aria-describedby");
  expect(typeof descriptionId).toBe("string");
  const description = document.getElementById(descriptionId!);
  expect(description?.textContent?.replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
}

async function closeTooltips() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
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
      expect(button.closest("[data-design-tooltip-trigger]") !== null).toBe(true);
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
      "Export design to repository": "Export a revision to the repository (Save as)",
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
      expectDescription(button, text);
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
    expectDescription(more, "More design tools");
  });

  test("redo and preview expose their current description and shortcut", async () => {
    const current = projection();
    current.workspace!.history = {
      ...current.workspace!.history,
      canUndo: false,
      canRedo: true,
      redoLabel: "resize frame",
    };
    render(<DesignToolbar {...props({ projection: current, mode: "preview" })} />);
    for (const [name, text] of [
      ["Redo design change", "Redo resize frameCtrl/⌘+Shift+Z"],
      ["Exit preview mode", "Back to inspectP or Esc"],
    ] as const) {
      const button = screen.getByRole("button", { name });
      act(() => button.focus());
      expect(await tooltipText()).toBe(text);
      expectDescription(button, text);
      await closeTooltips();
    }
  });

  test("a blocked undo explains why it is disabled on hover", async () => {
    const current = projection();
    current.workspace!.history = {
      ...current.workspace!.history,
      canUndo: false,
      canRedo: false,
      undoLabel: undefined,
      undoBlockedReason: "Another client changed this frame",
    };
    render(<DesignToolbar {...props({ projection: current })} />);
    const undo = screen.getByRole("button", { name: "Undo design change" });
    expect(undo.hasAttribute("disabled")).toBe(true);
    fireEvent.pointerMove(undo.closest("[data-design-tooltip-trigger]")!, { pointerType: "mouse" });
    expect(await tooltipText()).toBe("Another client changed this frameCtrl/⌘+Z");
    expectDescription(undo, "Another client changed this frame Ctrl/⌘+Z");
  });

  test("disabling a tool keeps its button and accessible description mounted for focus restoration", () => {
    const current = projection();
    const view = render(<DesignToolbar {...props({ projection: current })} />);
    const button = screen.getByRole("button", { name: "Export design to repository" });
    const descriptionId = button.getAttribute("aria-describedby");
    view.rerender(
      <DesignToolbar
        {...props({ projection: { ...current, busy: { ...current.busy, export: true } } })}
      />,
    );
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Export design to repository" }) === button).toBe(
      true,
    );
    view.rerender(<DesignToolbar {...props({ projection: current })} />);
    expect(screen.getByRole("button", { name: "Export design to repository" }) === button).toBe(
      true,
    );
    expect(button.getAttribute("aria-describedby")).toBe(descriptionId);
  });

  test("the compact menu repeats zoom and defers dialog actions until it closes", async () => {
    const onZoomIn = mock(() => {});
    const onAddFrame = mock(() => {
      expect(screen.queryByRole("menu") === null).toBe(true);
    });
    render(<DesignToolbar {...props({ compact: true, onZoomIn, onAddFrame })} />);
    const more = screen.getByRole("button", { name: "More design tools" });
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const zoom = await screen.findByRole("menuitem", { name: "Zoom in" });
    fireEvent.click(zoom);
    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu") !== null).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add frame" }));
    await waitFor(() => expect(onAddFrame).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement === more).toBe(true));
  });
});

describe("DesignToolbar", () => {
  test("fit all and zoom to selection have different icons", () => {
    render(<DesignToolbar {...props({ hasSelection: true })} />);
    const fitAll = screen.getByRole("button", { name: "Fit all frames" });
    const fitSelection = screen.getByRole("button", { name: "Zoom to selection" });
    expect(fitAll.querySelector("svg.lucide-maximize")).toBeTruthy();
    // Zoom to selection draws a target inside the frame corners.
    expect(fitSelection.querySelector("svg.lucide-focus")).toBeTruthy();
    expect(fitSelection.querySelector("svg")?.innerHTML).not.toBe(
      fitAll.querySelector("svg")?.innerHTML,
    );
  });

  test("the agent panel toggle shows only for a design tab with a panel", async () => {
    const onToggleAgentPanel = mock(() => {});
    render(<DesignToolbar {...props({ agentPanelOpen: true, onToggleAgentPanel })} />);
    const toggle = screen.getByRole("button", { name: "Hide agent panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("title")).toBeNull();
    act(() => toggle.focus());
    expect(await tooltipText()).toBe("Hide agent panelCtrl/⌘+.");
    expectDescription(toggle, "Hide agent panel Ctrl/⌘+.");
    await closeTooltips();
    fireEvent.click(toggle);
    expect(onToggleAgentPanel).toHaveBeenCalledTimes(1);
    cleanup();
    render(<DesignToolbar {...props({ hasSelection: true })} />);
    expect(screen.queryByRole("button", { name: /agent panel/ }) === null).toBe(true);
  });
});
