import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import {
  GRAPH_SYSTEM_ACTIONS,
  type GraphSystemAction,
} from "@orkestrator/protocol/graphs/template";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import type { GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import { GraphPalette } from "./GraphPalette";
import type { GraphPaletteItem } from "./graph-designer-edits";
import { builtInDetail, fixtureSummary } from "./graph-designer.test-fixtures";

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

  test("the Sub-graph menu lists saved templates by scope; untrusted ones cannot be picked", () => {
    const onAddSubgraph = mock((_summary: GraphTemplateSummary) => {});
    const review = builtInDetail("multi-review").summary;
    const project = fixtureSummary(
      graphBuiltInTemplate("multi-review")!.template,
      { scope: "project", projectId: "p1", path: ".orkestrator/graphs/review.graph.json" },
      { trust: "untrusted" },
    );
    render(
      <GraphPalette
        onAdd={() => {}}
        wrapTarget={null}
        onWrapInLoop={() => {}}
        subgraphs={[{ summary: review }, { summary: project, disabled: "Not trusted" }]}
        onAddSubgraph={onAddSubgraph}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Sub-graph node" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("data-graph-subgraph-choice"))).toEqual([
      "builtin:multi-review",
      "project:multi-review",
    ]);
    expect(items[0]!.textContent).toContain("Runs here as a copy on the graph runtime");
    expect(items[1]!.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(items[0]!);
    expect(onAddSubgraph).toHaveBeenCalledWith(review);
  });

  test("with no saved template the Sub-graph menu is disabled", () => {
    render(<GraphPalette onAdd={() => {}} wrapTarget={null} onWrapInLoop={() => {}} />);
    expect(
      (screen.getByRole("button", { name: "Sub-graph node" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
