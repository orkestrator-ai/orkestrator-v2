import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphAgentNode, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import { GraphReplicateEditor, graphItemsInputPorts } from "./GraphExecutionEditor";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function diagnose(template: GraphTemplateV1): GraphAgentNode {
  return template.nodes.find((node) => node.id === "diagnose") as GraphAgentNode;
}

describe("replicate over items (item 401)", () => {
  test("only list ports and ports of a type that declares items can be fanned out over", () => {
    const template = graphTemplateExample("failure-diagnosis");
    const library = new GraphTypeLibrary(template.types ?? []);
    expect(graphItemsInputPorts(diagnose(template), library)).toEqual(["failures"]);
    const typed = structuredClone(diagnose(template));
    typed.inputs![1]!.type = "validation-results@1";
    typed.inputs![0]!.type = "validation-failure@1";
    expect(graphItemsInputPorts(typed, library)).toEqual(["failures"]);
  });

  test("the form edits the input, the bound and the truncation policy", () => {
    const start = graphTemplateExample("failure-diagnosis");
    delete diagnose(start).replicate;
    const { harness } = renderWithGraphEditor(start, (template) => (
      <GraphReplicateEditor node={diagnose(template)} />
    ));
    const mode = screen.getByLabelText("Run as") as HTMLSelectElement;
    const option = Array.from(mode.options).find((entry) => entry.value === "items")!;
    expect(option.disabled).toBe(false);
    fireEvent.change(mode, { target: { value: "items" } });
    expect(diagnose(harness.current()).replicate).toEqual({
      over: "items",
      input: "failures",
      maxBranches: 8,
    });
    const bound = screen.getByLabelText("Most branches") as HTMLInputElement;
    fireEvent.change(bound, { target: { value: "12" } });
    fireEvent.blur(bound);
    fireEvent.change(screen.getByLabelText("More items than that"), {
      target: { value: "fail" },
    });
    expect(diagnose(harness.current()).replicate).toEqual({
      over: "items",
      input: "failures",
      maxBranches: 12,
      truncate: "fail",
    });
    const input = screen.getByLabelText("Items of") as HTMLSelectElement;
    expect(Array.from(input.options).map((entry) => entry.value)).toEqual(["failures"]);
  });
});
