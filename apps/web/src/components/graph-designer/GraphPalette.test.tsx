import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import {
  GRAPH_SYSTEM_ACTIONS,
  type GraphSystemAction,
} from "@orkestrator/protocol/graphs/template";
import { GraphPalette } from "./GraphPalette";
import type { GraphPaletteItem } from "./graph-designer-edits";

afterEach(cleanup);

describe("GraphPalette", () => {
  test("the System submenu lists each action from its spec and marks side effects", () => {
    const onAdd = mock((_item: GraphPaletteItem) => {});
    render(<GraphPalette onAdd={onAdd} wrapTarget={null} onWrapInLoop={() => {}} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "System node" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("data-graph-system-action"))).toEqual([
      ...GRAPH_SYSTEM_ACTIONS,
    ]);
    for (const item of items) {
      const action = item.getAttribute("data-graph-system-action") as GraphSystemAction;
      const spec = GRAPH_SYSTEM_ACTION_SPECS[action];
      expect(item.textContent).toContain(spec.label);
      expect(item.textContent).toContain(spec.description);
      expect(item.querySelector('[data-graph-badge="side-effect"]') !== null).toBe(spec.sideEffect);
    }
    fireEvent.click(screen.getByRole("menuitem", { name: /Wait for checks/ }));
    expect(onAdd).toHaveBeenCalledWith({ kind: "system", action: "wait-for-checks" });
  });
});
