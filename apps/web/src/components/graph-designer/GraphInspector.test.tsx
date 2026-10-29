import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile } from "@orkestrator/protocol/graphs/compile";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { GraphInspector } from "./GraphInspector";
import { indexGraphDiagnostics } from "./graph-designer-model";

afterEach(cleanup);

function renderInspector(
  template: GraphTemplateV1,
  selection: GraphDesignerSelection,
  options: { providers?: readonly (typeof AGENT_PLATFORMS)[number][]; withPlan?: boolean } = {},
) {
  const result = compile(template);
  const onSelect = mock((_selection: GraphDesignerSelection) => {});
  const view = render(
    <GraphInspector
      template={template}
      plan={options.withPlan === false ? null : result.plan}
      diagnostics={indexGraphDiagnostics(result.diagnostics)}
      selection={selection}
      providers={options.providers ?? AGENT_PLATFORMS}
      onSelect={onSelect}
    />,
  );
  return { ...view, onSelect, result };
}

const pipeline = () => graphBuiltInTemplate("build-pipeline")!.template;

describe("GraphInspector", () => {
  test("summarises the template when nothing is selected", () => {
    const template = pipeline();
    renderInspector(template, null);
    expect(screen.getByRole("heading", { name: template.name })).toBeDefined();
    expect(screen.getByText("Select a node, edge or loop to inspect it.")).toBeDefined();
    expect(screen.getByText(`at most ${template.limits.maxAgentSessions}`)).toBeDefined();
  });

  test("shows an agent node's role, profile, compiled capabilities and the enforcement matrix", () => {
    const { container } = renderInspector(
      pipeline(),
      { kind: "node", id: "review" },
      {
        providers: ["claude", "codex"],
      },
    );
    expect(screen.getByRole("heading", { name: "Review" })).toBeDefined();
    expect(screen.getByText("Agent · review")).toBeDefined();
    expect(screen.getByText("reviewer", { selector: "dd" })).toBeDefined();
    expect(screen.getByText("read-only")).toBeDefined();
    expect(screen.getByText("Provider-configured", { selector: "dd" })).toBeDefined();
    const matrix = container.querySelector("[data-graph-enforcement-matrix]")!;
    const rows = Array.from(matrix.querySelectorAll("[data-graph-enforcement-provider]"));
    expect(rows.map((row) => row.getAttribute("data-graph-enforcement-provider"))).toEqual([
      ...AGENT_PLATFORMS,
    ]);
    // Disabled providers are marked, not hidden.
    const grok = rows.find(
      (row) => row.getAttribute("data-graph-enforcement-provider") === "grok",
    )!;
    expect(grok.textContent).toContain("(off)");
    const codex = rows.find(
      (row) => row.getAttribute("data-graph-enforcement-provider") === "codex",
    )!;
    expect(codex.textContent).not.toContain("(off)");
    expect(codex.textContent).toMatch(/Enforced|Provider-configured|Advisory/);
    // Ports with their types; the built-in prompt by id.
    expect(container.querySelector('[data-graph-inspector-port="package"]')!.textContent).toContain(
      "review-package@2",
    );
    expect(screen.getByText(/Built-in prompt/)).toBeDefined();
  });

  test("computes capabilities in the browser when the template has errors", () => {
    const template = pipeline();
    template.edges[0]!.to.port = "nope";
    const { container, result } = renderInspector(template, { kind: "node", id: "verify" });
    expect(result.plan).toBeNull();
    expect(container.querySelector("[data-graph-enforcement-matrix]")).not.toBeNull();
    expect(screen.getByText("may write")).toBeDefined();
  });

  test("shows a user prompt template, ports, render modes and execution settings", () => {
    const template = pipeline();
    const agent = template.nodes.find((node) => node.id === "review")!;
    if (agent.kind !== "agent") throw new Error("review is an agent node");
    agent.prompt = { template: "Review the package.\n\n{{> input.package}}" };
    const { container } = renderInspector(template, { kind: "node", id: agent.id });
    expect(container.querySelector("[data-graph-inspector-prompt]")!.textContent).toBe(
      "Review the package.\n\n{{> input.package}}",
    );
    expect(screen.getByText("On failure")).toBeDefined();
    expect(screen.getAllByText("Workspace", { selector: "dt" }).length).toBe(2);
  });

  test("lists a node's diagnostics and edges, and jumps to them", () => {
    const template = pipeline();
    const prepare = template.nodes.find((node) => node.id === "prepare")!;
    prepare.inputs![0]!.type = "decision@1";
    const { onSelect, container } = renderInspector(template, { kind: "node", id: "prepare" });
    expect(container.querySelectorAll("[data-graph-diagnostic]").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "build-prepare" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "edge", id: "build-prepare" });
  });

  test("shows an edge's delivered type and transforms", () => {
    const template = pipeline();
    const filtered = template.edges.find((edge) => (edge.transform?.length ?? 0) > 0)!;
    const { container } = renderInspector(template, { kind: "edge", id: filtered.id });
    expect(screen.getByRole("heading", { name: `Edge ${filtered.id}` })).toBeDefined();
    expect(screen.getByText("Delivered type")).toBeDefined();
    expect(container.textContent).toContain(`"op": "${filtered.transform![0]!.op}"`);
  });

  test("shows a loop's bound, members, condition and carries", () => {
    const template = pipeline();
    const loop = template.loops![0]!;
    const { onSelect } = renderInspector(template, { kind: "loop", id: loop.id });
    expect(screen.getByText(new RegExp(`at most ${loop.maxIterations} iterations`))).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: loop.nodes[0]! }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: loop.nodes[0] });
    expect(
      screen.getByText(
        `${loop.carry[0]!.from.node}.${loop.carry[0]!.from.port} → ${loop.carry[0]!.to.node}.${loop.carry[0]!.to.port}`,
      ),
    ).toBeDefined();
  });

  test("says so when the selection is no longer in the template", () => {
    renderInspector(pipeline(), { kind: "node", id: "ghost" });
    expect(screen.getByText("This node is not in the template any more.")).toBeDefined();
  });
});
