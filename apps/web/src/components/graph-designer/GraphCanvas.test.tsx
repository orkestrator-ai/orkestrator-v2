import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile } from "@orkestrator/protocol/graphs/compile";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { GraphCanvas, type GraphCanvasEditor } from "./GraphCanvas";
import { graphConnectionVerdict, type GraphConnectEnd } from "./graph-designer-connect";
import type { GraphPaletteItem } from "./graph-designer-edits";
import {
  buildGraphCanvasModel,
  GRAPH_TYPE_FAMILY_COLORS,
  graphTemplateTypeLibrary,
} from "./graph-designer-model";
import { installReactFlowDomStubs } from "./react-flow.test-support";

let restore: () => void;
beforeAll(() => {
  restore = installReactFlowDomStubs();
});
afterAll(() => restore());
afterEach(cleanup);

function pipeline(): GraphTemplateV1 {
  return graphBuiltInTemplate("build-pipeline")!.template;
}

function modelFor(template: GraphTemplateV1) {
  const result = compile(template);
  return buildGraphCanvasModel({ template, plan: result.plan, diagnostics: result.diagnostics });
}

function renderCanvas(
  template: GraphTemplateV1,
  selection: GraphDesignerSelection = null,
  onSelect = mock((_selection: GraphDesignerSelection) => {}),
) {
  const model = modelFor(template);
  const view = render(
    <div style={{ width: 1200, height: 800 }}>
      <GraphCanvas
        model={model}
        selection={selection}
        focusRequest={0}
        isActive
        onSelect={onSelect}
      />
    </div>,
  );
  return { ...view, model, onSelect };
}

describe("GraphCanvas", () => {
  test("draws every node with its face, ports coloured by type family, and the loop group", async () => {
    const template = pipeline();
    const { container } = renderCanvas(template);
    for (const node of template.nodes) {
      expect(container.querySelector(`[data-graph-node-id="${node.id}"]`)).not.toBeNull();
    }
    const build = container.querySelector('[data-graph-node-id="build"]')!;
    expect(build.querySelector("[data-graph-node-title]")!.textContent).toBe("Build");
    expect(build.querySelector("[data-graph-node-detail]")!.textContent).toBe("builder · builder");
    // Typed handles: `in:<port>` / `out:<port>`, coloured by the port's family.
    const ticket = build.querySelector('[data-graph-port="in:ticket"]')!;
    expect(ticket.getAttribute("data-graph-type-family")).toBe("ticket");
    const handle = ticket.querySelector(".react-flow__handle") as HTMLElement;
    expect(handle.getAttribute("data-handleid")).toBe("in:ticket");
    expect(handle.getAttribute("style")).toMatch(
      new RegExp(`${GRAPH_TYPE_FAMILY_COLORS.ticket}|251, 191, 36`),
    );
    // The review loop is a group with its bound.
    const loop = container.querySelector("[data-graph-loop]")!;
    expect(loop.querySelector('[data-graph-badge="loop"]')!.textContent).toContain("↻ ≤ 3");
    // Replicated reviewers carry a replication badge; read-only ones their floor.
    const review = container.querySelector('[data-graph-node-id="review"]')!;
    expect(review.querySelector('[data-graph-badge="replication"]')!.textContent).toMatch(/^×/);
    expect(review.querySelector('[data-graph-badge="enforcement"]')!.textContent).toContain(
      "Provider-configured",
    );
    // Edges appear once the stubbed observer has measured the nodes.
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__edge").length).toBeGreaterThan(10),
    );
  });

  test("marks nodes and edges that have errors", async () => {
    const template = pipeline();
    template.edges[0]!.to.port = "nope";
    const broken = structuredClone(template);
    const prepare = broken.nodes.find((node) => node.id === "prepare")!;
    // A type mismatch on an edge pins the error to the edge.
    const edge = broken.edges.find((candidate) => candidate.to.node === "prepare")!;
    const original = prepare.inputs!.find((port) => port.name === edge.to.port)!;
    original.type = "decision@1";
    const { container, model } = renderCanvas(broken);
    expect(model.undrawnEdges).toContain(broken.edges[0]!.id);
    const setup = container.querySelector(`[data-graph-node-id="${broken.edges[0]!.to.node}"]`)!;
    expect(setup.getAttribute("data-graph-diagnostics")).toBe("error");
    expect(setup.querySelector('[data-graph-chip="errors"]')).not.toBeNull();
    await waitFor(() =>
      expect(
        container.querySelectorAll(".react-flow__edge.graph-edge-error").length,
      ).toBeGreaterThan(0),
    );
  });

  test("keeps one tab stop and moves through nodes in topological order with the keyboard", async () => {
    const template = pipeline();
    const onSelect = mock((_selection: GraphDesignerSelection) => {});
    const { container, model, rerender } = renderCanvas(template, null, onSelect);
    const nodes = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".react-flow__node-graph-node"));
    const focusable = nodes().filter((node) => node.tabIndex === 0);
    expect(focusable.map((node) => node.dataset.id)).toEqual([model.order[0]!]);
    expect(focusable[0]!.getAttribute("role")).toBe("button");
    expect(focusable[0]!.getAttribute("aria-label")).toBe(
      model.nodes.find((node) => node.id === model.order[0])!.ariaLabel!,
    );

    const first = focusable[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "node", id: model.order[1] });
    fireEvent.keyDown(first, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "node", id: model.order.at(-1) });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "node", id: model.order[0] });

    // The selected node becomes the tab stop and is marked selected.
    rerender(
      <div style={{ width: 1200, height: 800 }}>
        <GraphCanvas
          model={model}
          selection={{ kind: "node", id: model.order[2]! }}
          focusRequest={0}
          isActive
          onSelect={onSelect}
        />
      </div>,
    );
    const stops = nodes().filter((node) => node.tabIndex === 0);
    expect(stops.map((node) => node.dataset.id)).toEqual([model.order[2]!]);
    expect(stops[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  test("clicking selects nodes, edges and loops", async () => {
    const template = pipeline();
    const onSelect = mock((_selection: GraphDesignerSelection) => {});
    const { container } = renderCanvas(template, null, onSelect);
    await act(async () => {
      fireEvent.click(container.querySelector('.react-flow__node[data-id="build"]')!);
    });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "node", id: "build" });
    await act(async () => {
      fireEvent.click(container.querySelector(".react-flow__node-graph-loop")!);
    });
    expect(onSelect.mock.calls.at(-1)![0]).toMatchObject({ kind: "loop" });
    await waitFor(() =>
      expect(
        container.querySelector(`.react-flow__edge[data-id="${template.edges[1]!.id}"]`),
      ).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.click(
        container.querySelector(`.react-flow__edge[data-id="${template.edges[1]!.id}"]`)!,
      );
    });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "edge", id: template.edges[1]!.id });
  });

  test("is read-only: nothing drags or connects", () => {
    const { container } = renderCanvas(pipeline());
    for (const handle of Array.from(container.querySelectorAll(".react-flow__handle"))) {
      expect(handle.classList.contains("connectable")).toBe(false);
    }
    for (const node of Array.from(container.querySelectorAll(".react-flow__node"))) {
      expect(node.classList.contains("draggable")).toBe(false);
    }
  });
});

describe("GraphCanvas, editable (item 212)", () => {
  function editableCanvas(template: GraphTemplateV1, selection: GraphDesignerSelection = null) {
    const library = graphTemplateTypeLibrary(template);
    const result = compile(template);
    const model = buildGraphCanvasModel({
      template,
      plan: result.plan,
      diagnostics: result.diagnostics,
      editable: true,
    });
    const editor = {
      verdict: mock((from: GraphConnectEnd, to: GraphConnectEnd) =>
        graphConnectionVerdict(template, library, from, to),
      ),
      connect: mock(() => {}),
      refuse: mock(() => {}),
      move: mock(() => {}),
      remove: mock(() => {}),
      add: mock((_item: GraphPaletteItem, _position: { x: number; y: number }) => {}),
      wrapInLoop: mock(() => {}),
      command: mock(() => {}),
    } satisfies GraphCanvasEditor;
    const onSelect = mock((_selection: GraphDesignerSelection) => {});
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <GraphCanvas
          model={model}
          editor={editor}
          selection={selection}
          focusRequest={0}
          isActive
          onSelect={onSelect}
        />
      </div>,
    );
    return { ...view, editor, onSelect, model };
  }

  test("handles connect and nodes drag; the I/O ends stay put and show + handles", () => {
    const { container } = editableCanvas(pipeline());
    const build = container.querySelector('.react-flow__node[data-id="build"]')!;
    expect(build.classList.contains("draggable")).toBe(true);
    expect(
      container
        .querySelector('.react-flow__node[data-id="$inputs"]')!
        .classList.contains("draggable"),
    ).toBe(false);
    const handle = container.querySelector(
      '[data-graph-node-id="build"] [data-graph-port="out:code"] .react-flow__handle',
    )!;
    expect(handle.classList.contains("connectable")).toBe(true);
    expect(
      container.querySelector('[data-graph-node-id="build"] [data-graph-port="in:+"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-graph-io="outputs"] [data-graph-port="in:+"]'),
    ).not.toBeNull();
  });

  test("dragging from a port lights up only the compatible targets and dims the rest", async () => {
    const template = pipeline();
    // Free pr.description (a port already fed by the same output refuses a duplicate).
    template.edges = template.edges.filter((edge) => edge.id !== "describe-pr-pr");
    const { container, editor } = editableCanvas(template);
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__edge").length).toBeGreaterThan(5),
    );
    const handle = container.querySelector(
      '[data-graph-node-id="describe-pr"] [data-graph-port="out:description"] .react-flow__handle',
    ) as HTMLElement;
    // Not inside act(): React Flow auto-pans with an animation-frame loop while connecting.
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 60, clientY: 60 });
    await waitFor(() => expect(container.querySelector("[data-graph-connect]")).not.toBeNull());
    const state = (node: string, port: string) =>
      container
        .querySelector(`[data-graph-node-id="${node}"] [data-graph-port="${port}"]`)!
        .getAttribute("data-graph-connect");
    // pr.description takes a pr-description@1; pr.code takes a workspace.
    expect(state("pr", "in:description")).toBe("compatible");
    expect(state("pr", "in:code")).toBe("incompatible");
    expect(state("build", "in:ticket")).toBe("incompatible");
    // An output never takes an output.
    expect(state("build", "out:code")).toBe("incompatible");
    // The + handle takes any typed value, but not one that would close a cycle.
    expect(state("push", "in:+")).toBe("compatible");
    expect(state("build", "in:+")).toBe("incompatible");
    expect(state("describe-pr", "out:description")).toBe("origin");
    const incompatible = container.querySelector(
      '[data-graph-node-id="pr"] [data-graph-port="in:code"] .react-flow__handle',
    )!;
    expect(incompatible.classList.contains("connectableend")).toBe(false);
    expect(editor.verdict).toHaveBeenCalled();
    fireEvent.mouseUp(document, { clientX: 60, clientY: 60 });
    await waitFor(() =>
      expect(container.querySelector("[data-graph-connect]") === null).toBe(true),
    );
  });

  test("keyboard: Delete, C, L and Shift+arrows on a focused node", () => {
    const { container, editor } = editableCanvas(pipeline());
    const build = container.querySelector('.react-flow__node[data-id="build"]') as HTMLElement;
    build.focus();
    fireEvent.keyDown(build, { key: "c" });
    expect(editor.command).toHaveBeenLastCalledWith("connect", "build");
    fireEvent.keyDown(build, { key: "L" });
    expect(editor.command).toHaveBeenLastCalledWith("loop", "build");
    fireEvent.keyDown(build, { key: "ArrowRight", shiftKey: true });
    expect(editor.move).toHaveBeenCalledTimes(1);
    const [positions, loops, options] = editor.move.mock.calls[0]! as unknown as [
      Record<string, { x: number; y: number }>,
      Record<string, string | null>,
      { coalesce: string },
    ];
    expect(Object.keys(positions)).toEqual(["build"]);
    expect(loops).toEqual({});
    expect(options.coalesce).toBe("nudge:build");
    fireEvent.keyDown(build, { key: "Delete" });
    expect(editor.remove).toHaveBeenLastCalledWith({ kind: "node", id: "build" });
  });

  test("Delete removes a selected edge; the palette adds at the canvas centre", async () => {
    const template = pipeline();
    const { container, editor } = editableCanvas(template, {
      kind: "edge",
      id: template.edges[1]!.id,
    });
    fireEvent.keyDown(container.querySelector("[data-graph-canvas]")!, { key: "Delete" });
    expect(editor.remove).toHaveBeenLastCalledWith({ kind: "edge", id: template.edges[1]!.id });
    const palette = container.querySelector("[data-graph-palette]") as HTMLElement;
    fireEvent.click(within(palette).getByRole("button", { name: /Gate/ }));
    expect(editor.add.mock.calls[0]![0]).toEqual({ kind: "gate" });
    // Loop region needs a selected node; sub-graphs wait for Phase 4.
    expect(
      (within(palette).getByRole("button", { name: /Loop region/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(palette).getByRole("button", { name: /Sub-graph/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a replicated node draws as a stacked card with its ×N badge (D9)", () => {
    const { container } = editableCanvas(pipeline());
    const review = container.querySelector('.react-flow__node[data-id="review"]')!;
    expect(review.querySelector("[data-graph-stack]")).not.toBeNull();
    expect(review.querySelector('[data-graph-badge="replication"]')!.textContent).toMatch(/^×/);
    const build = container.querySelector('.react-flow__node[data-id="build"]')!;
    expect(build.querySelector("[data-graph-stack]") === null).toBe(true);
  });
});
