import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { validateGraphSchemaSubset } from "@orkestrator/protocol/graphs/schema-subset";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphTypesEditor } from "./GraphTypeEditor";
import { addGraphNode, blankGraphTemplate, updateGraphNode } from "./graph-designer-edits";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function templateUsing(ref: string): GraphTemplateV1 {
  const { template, nodeId } = addGraphNode(
    blankGraphTemplate(),
    { kind: "agent" },
    { x: 0, y: 0 },
  );
  return updateGraphNode(template, nodeId, (node) => ({
    ...node,
    inputs: [{ name: "briefs", type: `list<${ref}>` }],
    outputs: [{ name: "brief", type: ref }],
  }));
}

function commit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function field(container: HTMLElement, path: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-graph-schema-field="${path}"]`);
  if (!element) throw new Error(`no schema field ${path}`);
  return element;
}

describe("GraphTypesEditor", () => {
  test("adds a type and edits its schema with the subset form, keeping required in step", () => {
    const { container, harness } = renderWithGraphEditor(blankGraphTemplate(), () => (
      <GraphTypesEditor />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Add type" }));
    expect(harness.current().types).toHaveLength(1);
    expect(harness.current().types![0]!.name).toBe("custom-type");
    expect(container.querySelector('[data-graph-type-form="custom-type@1"]')).not.toBeNull();

    // A new field joins `required` at once.
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    let schema = harness.current().types![0]!.schema;
    expect(schema.required).toEqual(["summary", "field"]);

    // Rename it, make it a nullable list of objects.
    commit(within(field(container, "field")).getByLabelText("Field name"), "risks");
    const risks = () => field(container, "risks");
    fireEvent.change(within(risks()).getAllByLabelText("Type")[0]!, { target: { value: "array" } });
    fireEvent.click(within(risks()).getAllByLabelText("May be null")[0]!);
    const items = risks().querySelector<HTMLElement>('[data-graph-schema-items="risks"]')!;
    fireEvent.change(within(items).getAllByLabelText("Type")[0]!, { target: { value: "object" } });

    schema = harness.current().types![0]!.schema;
    expect(schema.required).toEqual(["summary", "risks"]);
    expect((schema.properties as Record<string, unknown>).risks).toEqual({
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        { type: "null" },
      ],
    });
    expect(validateGraphSchemaSubset(schema).ok).toBe(true);
    expect(container.querySelector("[data-graph-schema-valid]")).not.toBeNull();

    // Removing a field drops it from `required` too.
    fireEvent.click(screen.getByRole("button", { name: "Remove field summary" }));
    expect(harness.current().types![0]!.schema.required).toEqual(["risks"]);
    expect(harness.edits.every((entry) => entry.label.length > 0)).toBe(true);
  });

  test("drafts the schema from the example, as the design bake-off's brief", () => {
    const expected = graphTemplateExample("design-bake-off").types![0]!;
    const { container, harness } = renderWithGraphEditor(blankGraphTemplate(), () => (
      <GraphTypesEditor />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Add type" }));
    fireEvent.change(screen.getByLabelText("Example payload"), {
      target: { value: JSON.stringify(expected.example) },
    });
    expect(harness.current().types![0]!.example).toEqual(expected.example);
    fireEvent.click(screen.getByRole("button", { name: /Schema from example/ }));
    const schema = harness.current().types![0]!.schema;
    expect(schema).toEqual(expected.schema);
    expect(container.querySelector("[data-graph-schema-draft-notes]")).not.toBeNull();
    expect(container.querySelector("[data-graph-type-valid]")).not.toBeNull();
    // The form now shows the drafted fields.
    expect(container.querySelector('[data-graph-schema-field="filesTouched"]')).not.toBeNull();
  });

  test("renaming a type or its version rewrites the ports that name it", () => {
    const template = {
      ...templateUsing("brief@1"),
      types: [{ ...graphTemplateExample("design-bake-off").types![0]!, name: "brief" }],
    };
    const { harness } = renderWithGraphEditor(template, () => <GraphTypesEditor />);
    commit(screen.getByLabelText("Name"), "proposal");
    let node = harness.current().nodes[0]!;
    expect(node.inputs![0]!.type).toBe("list<proposal@1>");
    expect("outputs" in node && node.outputs![0]!.type).toBe("proposal@1");
    commit(screen.getByLabelText("Version"), "2");
    node = harness.current().nodes[0]!;
    expect(node.inputs![0]!.type).toBe("list<proposal@2>");
    expect(harness.current().types![0]!.version).toBe(2);
    // Built-in names are refused before they are committed.
    commit(screen.getByLabelText("Name"), "ticket");
    expect(screen.getByText(/is a built-in type/)).toBeTruthy();
    expect(harness.current().types![0]!.name).toBe("proposal");
  });

  test("shows live issues for an example that does not fit and for a keyword outside the subset", () => {
    const { container, harness } = renderWithGraphEditor(blankGraphTemplate(), () => (
      <GraphTypesEditor />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Add type" }));
    fireEvent.change(screen.getByLabelText("Example payload"), {
      target: { value: '{"summary": 3}' },
    });
    expect(container.querySelector("[data-graph-type-issues]")!.textContent).toContain("example");

    fireEvent.click(screen.getByRole("button", { name: "Edit as JSON" }));
    const json = {
      type: "object",
      properties: { summary: { type: "string", pattern: "^x" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const editor = container.querySelector<HTMLElement>("[data-graph-schema-editor]")!;
    fireEvent.change(within(editor).getByLabelText("Schema"), {
      target: { value: JSON.stringify(json) },
    });
    expect(harness.current().types![0]!.schema).toEqual(json);
    expect(container.querySelector("[data-graph-schema-errors]")!.textContent).toContain("pattern");
    expect(container.querySelector('[data-graph-type-issue="unsupported_keyword"]')).not.toBeNull();
  });

  test("warns before removing a type a port still uses", () => {
    const template = {
      ...templateUsing("brief@1"),
      types: [{ ...graphTemplateExample("design-bake-off").types![0]!, name: "brief" }],
    };
    const { harness } = renderWithGraphEditor(template, () => <GraphTypesEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Remove type brief@1" }));
    expect(screen.getByRole("alert").textContent).toContain("agent.briefs");
    expect(harness.current().types).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove type brief@1" }));
    expect(harness.current().types).toBeUndefined();
  });
});
