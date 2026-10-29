import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile, type GraphPlanAcknowledgementRef } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphDesignerCompile } from "@/stores/graphDesignerStore";
import { GraphCompilePanel } from "./GraphCompilePanel";
import { GraphEdgeEditor, GraphLoopEditor } from "./GraphStructureEditors";
import { GraphTemplateEditor } from "./GraphTemplateEditor";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function pipeline(): GraphTemplateV1 {
  const template = structuredClone(graphBuiltInTemplate("build-pipeline")!.template);
  delete template.engine;
  return template;
}

describe("GraphTemplateEditor", () => {
  test("edits name, limits and parameters; renaming a parameter follows its conditions", () => {
    const template = graphTemplateExample("multi-review");
    const { harness, container } = renderWithGraphEditor(template, () => (
      <GraphTemplateEditor idEditable={false} />
    ));
    expect((screen.getByLabelText("Template id") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "My review" } });
    expect(harness.current().name).toBe("My review");
    expect(harness.edits.at(-1)).toEqual({ label: "Template name", coalesce: "template:name" });

    const sessions = screen.getByLabelText("Agent sessions at most") as HTMLInputElement;
    fireEvent.change(sessions, { target: { value: "500" } });
    fireEvent.blur(sessions);
    expect(screen.getByText("At most 200")).toBeDefined();
    fireEvent.change(sessions, { target: { value: "40" } });
    fireEvent.blur(sessions);
    expect(harness.current().limits.maxAgentSessions).toBe(40);

    const parameters = within(container.querySelector('[aria-label="Parameters"]') as HTMLElement);
    const key = parameters.getAllByLabelText("Key")[0] as HTMLInputElement;
    expect(key.value).toBe("autoFix");
    fireEvent.change(key, { target: { value: "fixAutomatically" } });
    fireEvent.blur(key);
    const current = harness.current();
    expect(current.parameters[0]!.key).toBe("fixAutomatically");
    expect(JSON.stringify(current.nodes.find((node) => node.id === "fix")!.when)).toContain(
      "params.fixAutomatically",
    );
  });

  test("roles: rename follows the nodes, panel roles take additional reviewers last", () => {
    const template = graphTemplateExample("multi-review");
    const { harness, container } = renderWithGraphEditor(template, () => (
      <GraphTemplateEditor idEditable={false} />
    ));
    const roles = within(container.querySelector('[aria-label="Roles"]') as HTMLElement);
    const reviewerKey = roles
      .getAllByLabelText("Key")
      .find((input) => (input as HTMLInputElement).value === "reviewer") as HTMLInputElement;
    fireEvent.change(reviewerKey, { target: { value: "critic" } });
    fireEvent.blur(reviewerKey);
    const current = harness.current();
    const review = current.nodes.find((node) => node.id === "review")!;
    expect(review.kind === "agent" && review.role).toBe("critic");
    expect(review.kind === "agent" && review.replicate).toEqual({ over: "panel", role: "critic" });
  });

  test("run inputs: add, rename (edges follow) and type", () => {
    const template = pipeline();
    const { harness } = renderWithGraphEditor(template, () => <GraphTemplateEditor idEditable />);
    const input = document.querySelector('[data-graph-run-input="ticket"]') as HTMLElement;
    const name = within(input).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "issue" } });
    fireEvent.blur(name);
    const current = harness.current();
    expect(current.inputs[0]!.name).toBe("issue");
    expect(JSON.stringify(current.edges)).toContain('"input":"issue"');
    fireEvent.click(screen.getByRole("button", { name: /Add run input/ }));
    expect(harness.current().inputs.at(-1)).toEqual({ name: "input", type: "workspace@1" });
  });
});

describe("GraphEdgeEditor and GraphLoopEditor", () => {
  test("an edge can be zipped, given transforms as JSON, and deleted", () => {
    const template = pipeline();
    const { harness } = renderWithGraphEditor(template, () => (
      <GraphEdgeEditor edgeId="build-prepare" diagnostics={[]} />
    ));
    fireEvent.click(screen.getByLabelText("Zip: branch k feeds branch k"));
    expect(harness.current().edges.find((edge) => edge.id === "build-prepare")!.zip).toBe(true);
    const transforms = screen.getByLabelText(/^Transforms/) as HTMLTextAreaElement;
    fireEvent.change(transforms, { target: { value: '[{"nope": 1}]' } });
    expect(screen.getByRole("alert").textContent).toContain('"op"');
    fireEvent.change(transforms, { target: { value: '[{"op": "limit", "count": 2}]' } });
    expect(harness.current().edges.find((edge) => edge.id === "build-prepare")!.transform).toEqual([
      { op: "limit", count: 2 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Delete edge/ }));
    expect(harness.current().edges.some((edge) => edge.id === "build-prepare")).toBe(false);
  });

  test("a loop's bound, members and carries are editable; deleting it keeps its nodes", () => {
    const template = pipeline();
    const { harness } = renderWithGraphEditor(template, () => (
      <GraphLoopEditor loopId="rounds" diagnostics={[]} />
    ));
    const bound = screen.getByLabelText("At most iterations") as HTMLInputElement;
    fireEvent.change(bound, { target: { value: "5" } });
    fireEvent.blur(bound);
    expect(harness.current().loops![0]!.maxIterations).toBe(5);
    fireEvent.click(screen.getAllByRole("button", { name: /Remove carry/ })[0]!);
    expect(harness.current().loops![0]!.carry.length).toBe(template.loops![0]!.carry.length - 1);
    // Taking a node out drops the carries that touch it.
    fireEvent.click(screen.getAllByRole("button", { name: "Take out" })[0]!);
    expect(harness.current().loops![0]!.nodes).not.toContain("fix");
    expect(harness.current().loops![0]!.carry).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Delete loop/ }));
    expect(harness.current().loops).toEqual([]);
    expect(harness.current().nodes).toHaveLength(template.nodes.length);
  });
});

describe("GraphCompilePanel acknowledgements", () => {
  test("lists pending acknowledgements with an Acknowledge action", () => {
    const template = graphTemplateExample("design-bake-off");
    delete template.acknowledgements;
    const result = compile(template);
    expect(result.pendingAcknowledgements.length).toBeGreaterThan(0);
    const value: GraphDesignerCompile = {
      source: "browser",
      ok: result.ok,
      launchable: result.launchable,
      diagnostics: result.diagnostics,
      omittedDiagnostics: result.omittedDiagnostics,
      cost: result.cost,
      pendingAcknowledgements: result.pendingAcknowledgements,
      plan: result.plan,
    };
    const onAcknowledge = mock((_ref: GraphPlanAcknowledgementRef) => {});
    const onSelect = mock(() => {});
    const { container } = render(
      <GraphCompilePanel
        compile={value}
        status="ready"
        error={null}
        onSelect={onSelect}
        onAcknowledge={onAcknowledge}
      />,
    );
    const section = container.querySelector("[data-graph-pending-acknowledgements]") as HTMLElement;
    expect(section.textContent).toContain("taint-reaches-side-effect");
    const first = result.pendingAcknowledgements[0]!;
    fireEvent.click(
      within(section).getByRole("button", { name: `Acknowledge ${first.code} on ${first.nodeId}` }),
    );
    expect(onAcknowledge).toHaveBeenCalledWith(first);
    // Without an editor (a stored template) there is nothing to acknowledge here.
    cleanup();
    const readOnly = render(
      <GraphCompilePanel compile={value} status="ready" error={null} onSelect={onSelect} />,
    );
    expect(readOnly.container.querySelector("[data-graph-pending-acknowledgements]")).toBeNull();
  });
});
