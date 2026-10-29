import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { graphCompetingImplementationsTemplate } from "@orkestrator/protocol/graphs/isolation-template";
import type { GraphAgentNode, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphNodeEditor } from "./GraphNodeEditor";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function bakeOff(): GraphTemplateV1 {
  return graphTemplateExample("design-bake-off");
}

function node(template: GraphTemplateV1, id: string) {
  return template.nodes.find((entry) => entry.id === id)!;
}

function renderNode(template: GraphTemplateV1, id: string) {
  return renderWithGraphEditor(template, (current) => {
    const shown = current.nodes.find((entry) => entry.id === id);
    return shown ? <GraphNodeEditor node={shown} diagnostics={[]} /> : <p>gone</p>;
  });
}

function tab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("GraphNodeEditor", () => {
  test("renames a node on commit, rewriting the edges and selecting the new id", () => {
    const { harness } = renderNode(bakeOff(), "judge");
    const id = screen.getByLabelText("Id") as HTMLInputElement;
    fireEvent.change(id, { target: { value: "Not An Id" } });
    fireEvent.blur(id);
    expect(screen.getByRole("alert").textContent).toContain("Lower-case");
    expect(node(harness.current(), "judge")).toBeDefined();
    fireEvent.change(id, { target: { value: "referee" } });
    fireEvent.keyDown(id, { key: "Enter" });
    const current = harness.current();
    expect(current.nodes.some((entry) => entry.id === "referee")).toBe(true);
    expect(current.edges.some((edge) => edge.to.node === "referee")).toBe(true);
    expect(harness.selections.at(-1)).toEqual({ kind: "node", id: "referee" });
  });

  test("Connect to…, Loop… and Delete are keyboard-reachable buttons", () => {
    const { harness } = renderNode(bakeOff(), "judge");
    fireEvent.click(screen.getByRole("button", { name: /Connect to/ }));
    fireEvent.click(screen.getByRole("button", { name: /Loop/ }));
    expect(harness.commands).toEqual([
      { command: "connect", nodeId: "judge" },
      { command: "loop", nodeId: "judge" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(harness.current().nodes.some((entry) => entry.id === "judge")).toBe(false);
    expect(harness.selections.at(-1)).toBeNull();
  });

  test("Inputs/Outputs: rename a port (edges follow), change its type, render mode and collect policy", () => {
    const { harness, container } = renderNode(bakeOff(), "judge");
    tab("Inputs/Outputs");
    const briefs = container.querySelector('[data-graph-port-editor="in:briefs"]')!.parentElement!;
    const name = within(briefs).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "candidates" } });
    fireEvent.blur(name);
    let current = harness.current();
    expect(node(current, "judge").inputs!.map((port) => port.name)).toContain("candidates");
    expect(current.edges.find((edge) => edge.id === "design-judge")!.to.port).toBe("candidates");

    const card = container.querySelector(
      '[data-graph-port-editor="in:candidates"]',
    )!.parentElement!;
    fireEvent.change(within(card).getByLabelText("Render as"), { target: { value: "summary" } });
    // A list input has a collect policy (the example sets one).
    expect((within(card).getByLabelText("Custom collect policy") as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.change(within(card).getByLabelText("Wait for"), { target: { value: "quorum" } });
    current = harness.current();
    const port = node(current, "judge").inputs!.find((entry) => entry.name === "candidates")!;
    expect(port.render).toBe("summary");
    expect(port.collect).toMatchObject({ wait: "quorum", count: 1 });

    // Output choices only for decision types.
    const decision = container.querySelector(
      '[data-graph-port-editor="out:decision"]',
    )!.parentElement!;
    const choices = within(decision).getByLabelText("Choices") as HTMLInputElement;
    expect(choices.value).toBe("simplicity, performance, security");
    fireEvent.change(choices, { target: { value: "simplicity, security" } });
    fireEvent.blur(choices);
    expect((node(harness.current(), "judge") as GraphAgentNode).outputs![0]!.choices).toEqual([
      "simplicity",
      "security",
    ]);
  });

  test("Capabilities: profile, overrides, and a lowered floor asks for an acknowledgement (D4)", () => {
    const { harness, container } = renderNode(bakeOff(), "design");
    tab("Capabilities");
    expect(container.querySelector("[data-graph-enforcement-matrix]")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("shell override"), { target: { value: "deny" } });
    expect((node(harness.current(), "design") as GraphAgentNode).capabilities.deny).toEqual([
      "shell",
    ]);
    fireEvent.change(screen.getByLabelText("Providers must hold this node at least at"), {
      target: { value: "advisory" },
    });
    expect((node(harness.current(), "design") as GraphAgentNode).minEnforcement).toBe("advisory");
    const note = container.querySelector("[data-graph-floor-lowered]")!;
    expect(note.getAttribute("data-graph-floor-lowered")).toBe("pending");
    fireEvent.click(within(note as HTMLElement).getByRole("button", { name: /Acknowledge/ }));
    expect(
      harness.current().acknowledgements?.some((entry) => entry.kind === "enforcement-floor"),
    ).toBe(true);
    expect(
      container
        .querySelector("[data-graph-floor-lowered]")!
        .getAttribute("data-graph-floor-lowered"),
    ).toBe("acknowledged");
  });

  test("Capabilities: a replicated writer opts into a worktree per branch, and back (item 403)", () => {
    const { harness } = renderNode(graphCompetingImplementationsTemplate(), "implement");
    tab("Capabilities");
    const isolation = screen.getByLabelText("Isolation") as HTMLSelectElement;
    expect(isolation.value).toBe("worktree");
    expect(screen.getByText(/Each branch writes its own Git worktree/)).toBeDefined();
    fireEvent.change(isolation, { target: { value: "shared" } });
    expect("isolation" in node(harness.current(), "implement")).toBe(false);
    fireEvent.change(screen.getByLabelText("Isolation"), { target: { value: "worktree" } });
    expect((node(harness.current(), "implement") as GraphAgentNode).isolation).toBe("worktree");
  });

  test("Execution: replicate over lenses with the lens editor, samples, a new role, retry and ask_human", () => {
    const { harness, container } = renderNode(bakeOff(), "design");
    tab("Execution");
    const lenses = container.querySelector("[data-graph-lens-editor]")!;
    expect(within(lenses as HTMLElement).getAllByLabelText("Label")).toHaveLength(3);
    fireEvent.click(within(lenses as HTMLElement).getByRole("button", { name: /Add lens/ }));
    let replicate = (node(harness.current(), "design") as GraphAgentNode).replicate!;
    expect(replicate.over === "lenses" && replicate.lenses.map((lens) => lens.key)).toEqual([
      "simplicity",
      "performance",
      "security",
      "focus",
    ]);
    fireEvent.change(screen.getByLabelText("Run as"), { target: { value: "samples" } });
    replicate = (node(harness.current(), "design") as GraphAgentNode).replicate!;
    expect(replicate).toEqual({ over: "samples", count: 3 });

    fireEvent.change(screen.getByLabelText("Role (model slot)"), { target: { value: "+new" } });
    const current = harness.current();
    expect((node(current, "design") as GraphAgentNode).role).toBe("design");
    expect(current.roles.some((role) => role.key === "design")).toBe(true);

    fireEvent.click(screen.getByLabelText("May ask a person (ask_human)"));
    expect((node(harness.current(), "design") as GraphAgentNode).askHuman).toBe(true);
    const attempts = screen.getByLabelText("Attempts") as HTMLInputElement;
    fireEvent.change(attempts, { target: { value: "3" } });
    fireEvent.blur(attempts);
    expect((node(harness.current(), "design") as GraphAgentNode).retry?.attempts).toBe(3);
  });
});
