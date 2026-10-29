import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION } from "@orkestrator/protocol/graphs/prompts";
import type { GraphAgentNode, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphPromptEditor } from "./GraphPromptEditor";
import {
  applyGraphPromptCompletion,
  filterGraphPromptSuggestions,
  graphPromptCompletionAt,
} from "./graph-designer-prompt";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function bakeOff(): GraphTemplateV1 {
  return graphTemplateExample("design-bake-off");
}

function agent(template: GraphTemplateV1, id: string): GraphAgentNode {
  return template.nodes.find((node) => node.id === id) as GraphAgentNode;
}

function renderPrompt(template: GraphTemplateV1, id: string) {
  return renderWithGraphEditor(template, (current) => (
    <GraphPromptEditor node={agent(current, id)} />
  ));
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("combobox", { name: /^Template/ }) as HTMLTextAreaElement;
}

describe("graph prompt completion", () => {
  test("finds the open tag at the caret and completes it, closing the braces", () => {
    const text = "Read {{inp";
    const completion = graphPromptCompletionAt(text, text.length)!;
    expect(completion).toEqual({ start: 5, sigil: "", prefix: "inp" });
    expect(graphPromptCompletionAt("{{done}} after", 14)).toBeNull();
    expect(graphPromptCompletionAt("{{! comment", 11)).toBeNull();
    const applied = applyGraphPromptCompletion(text, text.length, completion, {
      insert: "input.ticket.title",
      label: "",
      detail: "",
    });
    expect(applied).toEqual({ text: "Read {{input.ticket.title}}", caret: 27 });
    const partial = graphPromptCompletionAt("{{> in", 6)!;
    expect(
      filterGraphPromptSuggestions(
        [
          { insert: "> input.ticket", label: "", detail: "" },
          { insert: "input.ticket", label: "", detail: "" },
        ],
        partial,
      ).map((entry) => entry.insert),
    ).toEqual(["> input.ticket"]);
  });
});

describe("GraphPromptEditor", () => {
  test("autocompletes variables from the input schemas and the node's lens", () => {
    const { harness } = renderPrompt(bakeOff(), "design");
    const area = textarea();
    fireEvent.change(area, { target: { value: "Focus: {{lens.", selectionStart: 14 } });
    const list = screen.getByRole("listbox", { name: "Variables" });
    const options = within(list)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options.some((text) => text?.startsWith("lens.label"))).toBe(true);
    fireEvent.change(area, { target: { value: "{{input.ticket.", selectionStart: 15 } });
    const fields = within(screen.getByRole("listbox", { name: "Variables" }))
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");
    // ticket@1's schema fields.
    expect(fields.some((text) => text.startsWith("input.ticket.title"))).toBe(true);
    fireEvent.keyDown(area, { key: "Enter" });
    expect((agent(harness.current(), "design").prompt as { template: string }).template).toMatch(
      /^\{\{input\.ticket\.[A-Za-z]+\}\}$/,
    );
  });

  test("previews the whole prompt with the locked system contract, from type examples or a fixture", () => {
    const { container } = renderPrompt(bakeOff(), "design");
    const contract = container.querySelector("[data-graph-prompt-contract]")!;
    expect(contract.textContent).toContain(GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION.slice(0, 40));
    expect(contract.textContent).toContain("submit_brief");
    const preview = container.querySelector("[data-graph-prompt-preview] pre")!;
    // The first lens fills {{lens.label}}.
    expect(preview.textContent).toContain("Focus: Simplicity.");

    fireEvent.click(screen.getByLabelText("Use a pasted fixture instead of the types' examples"));
    const fixture = screen.getByLabelText(/Fixture/) as HTMLTextAreaElement;
    fireEvent.change(fixture, { target: { value: "{" } });
    expect(container.textContent).toContain("JSON");
    fireEvent.change(fixture, {
      target: {
        value: JSON.stringify({
          ticket: { id: "T-9", title: "Fixture ticket", description: "From the fixture" },
        }),
      },
    });
    expect(container.querySelector("[data-graph-prompt-preview] pre")!.textContent).toContain(
      "Fixture ticket",
    );
  });

  test("shows lints inline, with a link to their place in the template", () => {
    const template = bakeOff();
    agent(template, "judge").prompt = { template: "Pick one.\n\n{{lens.label}} {{nope.value}}" };
    const { container } = renderPrompt(template, "judge");
    const lints = container.querySelector("[data-graph-prompt-lints]")!;
    expect(
      lints.querySelector('[data-graph-prompt-lint="prompt-unbound-variable"]'),
    ).not.toBeNull();
    const link = within(lints as HTMLElement).getAllByRole("button")[0]!;
    expect(link.textContent).toMatch(/^3:\d+$/);
    fireEvent.click(link);
    expect(document.activeElement).toBe(textarea());
  });

  test("sizes the rendered inputs against the 160 KiB ceiling", () => {
    const template = bakeOff();
    const { container } = renderPrompt(template, "judge");
    const size = container.querySelector("[data-graph-prompt-size]")!;
    // Three briefs at their budgets plus a ticket exceed the ceiling.
    expect(size.getAttribute("data-graph-prompt-size")).toBe("over");
    expect(size.textContent).toContain("160 KiB");
  });

  test("switches between a built-in prompt and the user's template", () => {
    const { harness } = renderPrompt(bakeOff(), "design");
    fireEvent.change(screen.getByLabelText("Prompt source"), {
      target: { value: "builtin:build" },
    });
    expect(agent(harness.current(), "design").prompt).toEqual({ builtIn: "build" });
    expect(screen.queryByRole("combobox", { name: /^Template/ })).toBeNull();
  });
});
