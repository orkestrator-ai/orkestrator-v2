import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile, type GraphCompileDiagnostic } from "@orkestrator/protocol/graphs/compile";
import type { GraphDesignerCompile, GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { GraphCompilePanel, graphDiagnosticTarget } from "./GraphCompilePanel";

afterEach(cleanup);

function compiled(mutate?: (template: ReturnType<typeof pipeline>) => void): GraphDesignerCompile {
  const template = pipeline();
  mutate?.(template);
  const result = compile(template);
  return {
    source: "backend",
    ok: result.ok,
    launchable: result.launchable,
    diagnostics: result.diagnostics,
    omittedDiagnostics: result.omittedDiagnostics,
    cost: result.cost,
    pendingAcknowledgements: result.pendingAcknowledgements,
    plan: result.plan,
  };
}

function pipeline() {
  return graphBuiltInTemplate("build-pipeline")!.template;
}

function renderPanel(compile: GraphDesignerCompile | null, status: "ready" | "loading" = "ready") {
  const onSelect = mock((_selection: GraphDesignerSelection, _focus?: boolean) => {});
  const view = render(
    <GraphCompilePanel compile={compile} status={status} error={null} onSelect={onSelect} />,
  );
  return { ...view, onSelect };
}

describe("GraphCompilePanel", () => {
  test("a clean template shows no diagnostics and its cost estimate", () => {
    const result = compiled();
    const { container } = renderPanel(result);
    expect(container.querySelector("[data-graph-compile-clean]")).not.toBeNull();
    const cost = container.querySelector("[data-graph-cost]")!.textContent!;
    expect(cost).toContain(
      `Sessions ${result.cost!.agentSessions.best}–${result.cost!.agentSessions.worst}`,
    );
    expect(cost).toContain(`Peak parallelism ${result.cost!.peakParallelism}`);
    expect(screen.getByText("Compiled by the backend under the project's ceiling")).toBeDefined();
  });

  test("lists diagnostics pinned to nodes and edges; clicking selects and focuses them", () => {
    const result = compiled((template) => {
      template.nodes.find((node) => node.id === "prepare")!.inputs![0]!.type = "decision@1";
    });
    const { container, onSelect } = renderPanel(result);
    expect(container.querySelector("[data-graph-compile-counts]")!.textContent).toContain(
      "3 errors",
    );
    const rows = Array.from(container.querySelectorAll("[data-graph-diagnostic]"));
    expect(rows.map((row) => row.getAttribute("data-graph-diagnostic"))).toContain(
      "edge-type-mismatch",
    );
    const edgeRow = container.querySelector('[data-graph-diagnostic="edge-type-mismatch"] button')!;
    fireEvent.click(edgeRow);
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "edge", id: "build-prepare" }, true);
    const nodeRow = container.querySelector('[data-graph-diagnostic="workspace-unpinned"] button')!;
    fireEvent.click(nodeRow);
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "node", id: "prepare" }, true);
    expect(screen.getByRole("button", { name: /error: .*\(edge build-prepare\)/ })).toBeDefined();
  });

  test("a diagnostic with no location is listed but not clickable", () => {
    const diagnostic: GraphCompileDiagnostic = {
      code: "template-invalid",
      severity: "error",
      message: "nodes must be an array",
      path: "nodes",
    };
    expect(graphDiagnosticTarget(diagnostic)).toBeNull();
    const { container } = renderPanel({
      source: "browser",
      ok: false,
      launchable: false,
      diagnostics: [diagnostic],
      omittedDiagnostics: 3,
      cost: null,
      pendingAcknowledgements: [],
      plan: null,
    });
    const row = container.querySelector('[data-graph-diagnostic="template-invalid"]')!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.textContent).toContain("nodes must be an array");
    expect(screen.getByText("3 more not shown.")).toBeDefined();
    expect(screen.getByText("Draft, compiled in the browser")).toBeDefined();
  });

  test("loop diagnostics select the loop; trust blocks are explained", () => {
    const result = compiled((template) => {
      template.loops![0]!.maxIterations = 11;
    });
    const { container, onSelect } = renderPanel({ ...result, blockedBy: "changed" });
    fireEvent.click(
      container.querySelector('[data-graph-diagnostic="loop-bound-exceeded"] button')!,
    );
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "loop", id: "rounds" }, true);
    expect(screen.getByText(/launch blocked: template changed since approval/)).toBeDefined();
  });

  test("shows progress before the first result", () => {
    renderPanel(null, "loading");
    expect(screen.getByText("Compiling…")).toBeDefined();
  });
});
