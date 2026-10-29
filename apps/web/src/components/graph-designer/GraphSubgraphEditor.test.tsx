import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphSubgraphNode } from "@orkestrator/protocol/graphs/template";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import { GraphNodeEditor } from "./GraphNodeEditor";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

beforeEach(() => {
  useGraphDesignerStore.setState({ subgraphTemplates: new Map() });
});

const reviewOf = (template: { nodes: { id: string }[] }) =>
  template.nodes.find((node) => node.id === "review") as GraphSubgraphNode;

describe("GraphSubgraphEditor (item 402)", () => {
  test("shows the child, its bindings and the plan nodes it became; binds a parameter", async () => {
    const { harness } = renderWithGraphEditor(
      graphTemplateExample("design-bake-off"),
      (template) => <GraphNodeEditor node={reviewOf(template)} diagnostics={[]} />,
    );
    await waitFor(() => screen.getByRole("region", { name: "Parameters" }));
    expect(screen.getByText(/Not pinned/)).toBeTruthy();
    expect(screen.getByText(/runs on its own engine when launched alone/)).toBeTruthy();
    expect(
      document.querySelector("[data-graph-subgraph-nodes]")!.textContent!.split(", "),
    ).toContain("review/consolidate");

    // autoFix passes this template's parameter through; autoPr is a value.
    const autoFix = screen.getByLabelText("Fix automatically") as HTMLSelectElement;
    expect(autoFix.value).toBe("param:autoFix");
    fireEvent.change(autoFix, { target: { value: "default" } });
    expect(reviewOf(harness.current()).params).toEqual({ autoPr: false });

    // Roles bind by name unless the node maps them.
    const fixer = screen.getByLabelText(/^Fix \(one model\)/) as HTMLSelectElement;
    expect(fixer.value).toBe("builder");
    fireEvent.change(fixer, { target: { value: "describer" } });
    expect(reviewOf(harness.current()).roles!.fixer).toBe("describer");
  });

  test("pins the current version, which a compile then holds it to", async () => {
    const { harness } = renderWithGraphEditor(
      graphTemplateExample("design-bake-off"),
      (template) => <GraphNodeEditor node={reviewOf(template)} diagnostics={[]} />,
    );
    const pin = await waitFor(() => {
      const button = screen.getByRole("button", { name: "Pin current version" });
      if ((button as HTMLButtonElement).disabled) throw new Error("not ready");
      return button;
    });
    fireEvent.click(pin);
    const ref = reviewOf(harness.current()).template;
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.revision).toBe(1);
    await waitFor(() => screen.getByText(/Pinned to revision 1/));
  });
});
