import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphNodeSpec, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphMockPinsEditor } from "./GraphMockPinsEditor";
import { removeGraphNode, renameGraphNode } from "./graph-designer-edits";
import { graphMockPreview, setGraphMockPins } from "./graph-designer-mock";
import { graphTemplateTypeLibrary } from "./graph-designer-model";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function nodeOf(template: GraphTemplateV1, id: string): GraphNodeSpec {
  return template.nodes.find((node) => node.id === id)!;
}

function bakeOff(): GraphTemplateV1 {
  return graphTemplateExample("design-bake-off");
}

describe("GraphMockPinsEditor", () => {
  test("builds fail, fail, pass for an agent and stores it on the template", () => {
    const template = graphTemplateExample("build-pipeline-loop");
    const { harness, container } = renderWithGraphEditor(template, (current) => (
      <GraphMockPinsEditor node={nodeOf(current, "verify")} />
    ));
    expect(container.querySelector("[data-graph-mock-pins-hint]")!.textContent).toContain(
      "example",
    );
    const add = screen.getByRole("button", { name: /Add run/ });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);
    expect(harness.current().mockPins).toEqual({ verify: ["example", "example", "example"] });
    fireEvent.change(screen.getByLabelText("Run 1"), { target: { value: "custom" } });
    // A custom entry starts from the examples of every output port.
    const custom = harness.current().mockPins!.verify![0] as { outputs: Record<string, unknown> };
    expect(Object.keys(custom.outputs).sort()).toEqual(["code", "verdict"]);
    const json = screen.getByLabelText("Outputs by port") as HTMLTextAreaElement;
    fireEvent.change(json, {
      target: {
        value: JSON.stringify({
          verdict: { complete: false, rationale: "Not yet.", acceptanceCriteria: [] },
        }),
      },
    });
    fireEvent.change(screen.getByLabelText("Run 3 and later"), { target: { value: "generated" } });
    expect(harness.current().mockPins!.verify).toEqual([
      { outputs: { verdict: { complete: false, rationale: "Not yet.", acceptanceCriteria: [] } } },
      "example",
      "generated",
    ]);
    expect(container.querySelector('[data-graph-mock-preview="generated"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove run 2" }));
    expect(harness.current().mockPins!.verify).toHaveLength(2);
    expect(harness.edits.map((entry) => entry.label)).toContain("Add mock pin");
  });

  test("shows why a pinned value does not fit its port", () => {
    const template = setGraphMockPins(bakeOff(), "judge", [
      { outputs: { decision: { choice: "speed", rationale: "fast" } } },
    ]);
    const { container } = renderWithGraphEditor(template, (current) => (
      <GraphMockPinsEditor node={nodeOf(current, "judge")} />
    ));
    expect(
      container.querySelector('[data-graph-mock-pin-issue="mock-pin-value"]')!.textContent,
    ).toContain("decision@1");
  });

  test("a failure takes a cause, and a human node takes outlets or a pause", () => {
    const { harness } = renderWithGraphEditor(bakeOff(), (current) => (
      <>
        <GraphMockPinsEditor node={nodeOf(current, "design")} />
        <GraphMockPinsEditor node={nodeOf(current, "approve")} />
      </>
    ));
    const [addDesign, addApprove] = screen.getAllByRole("button", { name: /Add run/ });
    fireEvent.click(addDesign!);
    fireEvent.change(screen.getAllByLabelText("Run 1")[0]!, { target: { value: "fail" } });
    fireEvent.change(screen.getByLabelText("Cause"), { target: { value: "timeout" } });
    fireEvent.click(addApprove!);
    const human = screen.getAllByLabelText("Run 1")[1] as HTMLSelectElement;
    expect(Array.from(human.options).map((option) => option.value)).toEqual([
      "example",
      "outlet",
      "pause",
      "fail",
    ]);
    fireEvent.change(human, { target: { value: "outlet" } });
    fireEvent.change(screen.getByLabelText("Outlet"), { target: { value: "rejected" } });
    expect(harness.current().mockPins).toEqual({
      design: [{ fail: "timeout" }],
      approve: [{ outlet: "rejected" }],
    });
  });

  test("gates and merges take no pins", () => {
    const template = graphTemplateExample("multi-review");
    const { container } = renderWithGraphEditor(template, (current) => (
      <GraphMockPinsEditor node={nodeOf(current, "has-findings")} />
    ));
    expect(container.textContent).toBe("");
  });
});

describe("mock pins follow node edits", () => {
  test("a rename moves the pins and a removal drops them", () => {
    const pinned = setGraphMockPins(bakeOff(), "judge", ["generated"]);
    expect(renameGraphNode(pinned, "judge", "referee").mockPins).toEqual({
      referee: ["generated"],
    });
    expect(removeGraphNode(pinned, "judge").mockPins).toBeUndefined();
    expect(setGraphMockPins(pinned, "judge", []).mockPins).toBeUndefined();
  });

  test("pins on nodes inlined from a sub-graph follow the sub-graph node", () => {
    const pinned = {
      ...bakeOff(),
      mockPins: {
        judge: ["generated" as const],
        "review/fix": [{ fail: "provider-error" as const }],
      },
    };
    expect(renameGraphNode(pinned, "review", "check").mockPins).toEqual({
      judge: ["generated"],
      "check/fix": [{ fail: "provider-error" }],
    });
    expect(removeGraphNode(pinned, "review").mockPins).toEqual({ judge: ["generated"] });
  });

  test("previews answer every output with a value of its type", () => {
    const template = bakeOff();
    const preview = graphMockPreview(
      nodeOf(template, "judge"),
      graphTemplateTypeLibrary(template),
      "example",
    );
    expect(preview).toMatchObject({ decision: { choice: "simplicity" } });
    expect(Object.keys(preview).sort()).toEqual(["brief", "decision"]);
  });
});
