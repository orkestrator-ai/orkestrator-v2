import { describe, expect, test } from "bun:test";
import {
  dockFromArrowKey,
  dockFromPointer,
  isAgentPanelShortcut,
  keyboardPanelSize,
  resizedPanelSize,
} from "./design-agent-dock";

const rect = { left: 100, top: 50, width: 1000, height: 600 };

describe("design agent dock geometry", () => {
  test("a dragged panel docks to the nearest edge of the design tab", () => {
    expect(dockFromPointer(rect, 150, 350)).toBe("left");
    expect(dockFromPointer(rect, 1050, 350)).toBe("right");
    expect(dockFromPointer(rect, 600, 70)).toBe("top");
    expect(dockFromPointer(rect, 600, 640)).toBe("bottom");
    // Outside the tab clamps to its edge.
    expect(dockFromPointer(rect, -500, 350)).toBe("left");
    expect(dockFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 1, 1)).toBe("left");
  });

  test("arrow keys on the move handle dock to that edge", () => {
    expect(dockFromArrowKey("ArrowLeft")).toBe("left");
    expect(dockFromArrowKey("ArrowRight")).toBe("right");
    expect(dockFromArrowKey("ArrowUp")).toBe("top");
    expect(dockFromArrowKey("ArrowDown")).toBe("bottom");
    expect(dockFromArrowKey("Enter")).toBeNull();
  });

  test("dragging the separator toward the canvas grows the panel, within bounds", () => {
    expect(resizedPanelSize({ dock: "left", startSize: 30, deltaPx: 100, containerPx: 1000 })).toBe(
      40,
    );
    expect(
      resizedPanelSize({ dock: "right", startSize: 30, deltaPx: -100, containerPx: 1000 }),
    ).toBe(40);
    expect(
      resizedPanelSize({ dock: "bottom", startSize: 30, deltaPx: 600, containerPx: 600 }),
    ).toBe(15);
    expect(resizedPanelSize({ dock: "top", startSize: 30, deltaPx: 900, containerPx: 600 })).toBe(
      80,
    );
  });

  test("separator keys step toward the canvas or away from it", () => {
    expect(keyboardPanelSize("left", 30, "ArrowRight")).toBe(32);
    expect(keyboardPanelSize("left", 30, "ArrowLeft")).toBe(28);
    expect(keyboardPanelSize("right", 30, "ArrowLeft")).toBe(32);
    expect(keyboardPanelSize("top", 30, "ArrowDown")).toBe(32);
    expect(keyboardPanelSize("bottom", 30, "ArrowUp")).toBe(32);
    expect(keyboardPanelSize("left", 30, "Home")).toBe(15);
    expect(keyboardPanelSize("left", 30, "End")).toBe(80);
    expect(keyboardPanelSize("left", 30, "ArrowUp")).toBeNull();
  });

  test("Ctrl or ⌘ plus . is the panel shortcut", () => {
    const key = { key: ".", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(isAgentPanelShortcut({ ...key, ctrlKey: true })).toBe(true);
    expect(isAgentPanelShortcut({ ...key, metaKey: true })).toBe(true);
    expect(isAgentPanelShortcut(key)).toBe(false);
    expect(isAgentPanelShortcut({ ...key, ctrlKey: true, shiftKey: true })).toBe(false);
  });
});
