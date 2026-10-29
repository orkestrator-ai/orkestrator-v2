import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GraphPredicate, GraphPredicateScope } from "@orkestrator/protocol/graphs/predicates";
import {
  formatGraphPredicateScalar,
  GraphPredicateEditor,
  parseGraphPredicateScalar,
} from "./GraphPredicateEditor";
import { gatedTemplate } from "./graph-designer-kinds.test-fixtures";
import { graphTemplateTypeLibrary } from "./graph-designer-model";
import { graphNodePredicateScopeFor } from "./graph-designer-scopes";

afterEach(cleanup);

function gateScope(): GraphPredicateScope {
  const template = gatedTemplate();
  const gate = template.nodes.find((node) => node.id === "check")!;
  return graphNodePredicateScopeFor(template, graphTemplateTypeLibrary(template), gate, null);
}

function renderEditor(initial: GraphPredicate | undefined, optional = false) {
  const state = { value: initial };
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <GraphPredicateEditor
        label="When"
        value={value}
        optional={optional}
        scope={gateScope()}
        onChange={(next) => {
          state.value = next;
          setValue(next);
        }}
      />
    );
  }
  const view = render(<Host />);
  return { ...view, state };
}

describe("GraphPredicateEditor", () => {
  test("parses and formats scalars so a quoted string survives", () => {
    expect(parseGraphPredicateScalar("3")).toBe(3);
    expect(parseGraphPredicateScalar("true")).toBe(true);
    expect(parseGraphPredicateScalar("null")).toBeNull();
    expect(parseGraphPredicateScalar('"true"')).toBe("true");
    expect(parseGraphPredicateScalar("ship")).toBe("ship");
    expect(formatGraphPredicateScalar("true")).toBe('"true"');
    expect(formatGraphPredicateScalar("ship")).toBe("ship");
  });

  test("an optional condition starts as 'always', and a leaf is built from path, operator and value", () => {
    const { state, container } = renderEditor(undefined, true);
    expect(screen.getByText("Always.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add condition/ }));
    expect(state.value).toEqual({ path: "report", op: "exists" });
    // Path suggestions come from the input schemas.
    const options = Array.from(container.querySelectorAll("datalist option")).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(options).toContain("report.issues");
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "decision.choice" } });
    fireEvent.change(screen.getByLabelText("Operator"), { target: { value: "eq" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "ship" } });
    expect(state.value).toEqual({ path: "decision.choice", op: "eq", value: "ship" });
    fireEvent.change(screen.getByLabelText("Operator"), { target: { value: "in" } });
    fireEvent.change(screen.getByLabelText("Values"), { target: { value: "ship, hold" } });
    expect(state.value).toEqual({ path: "decision.choice", op: "in", value: ["ship", "hold"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove condition" }));
    expect(state.value).toBeUndefined();
  });

  test("groups conditions with all/any/not and counts", () => {
    const { state, container } = renderEditor({ path: "report.issues", op: "nonEmpty" });
    fireEvent.change(screen.getByLabelText("Wrap in a group"), { target: { value: "any" } });
    expect(state.value).toEqual({ any: [{ path: "report.issues", op: "nonEmpty" }] });
    const group = container.querySelector('[data-graph-predicate-group="any"]') as HTMLElement;
    fireEvent.click(within(group).getByRole("button", { name: /^Condition$/ }));
    const leaves = container.querySelectorAll("[data-graph-predicate-leaf]");
    expect(leaves).toHaveLength(2);
    const second = leaves[1] as HTMLElement;
    fireEvent.change(within(second).getByLabelText("Path"), {
      target: { value: "report.testCoverageGaps" },
    });
    fireEvent.change(within(second).getByLabelText("Operator"), { target: { value: "count" } });
    fireEvent.change(within(second).getByLabelText("Count"), { target: { value: "2" } });
    expect(state.value).toEqual({
      any: [
        { path: "report.issues", op: "nonEmpty" },
        { path: "report.testCoverageGaps", op: "count", compare: "gte", value: 2 },
      ],
    });
    fireEvent.change(screen.getByLabelText("Group kind"), { target: { value: "all" } });
    expect(state.value && "all" in state.value).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove this condition" })[0]!);
    expect(state.value).toEqual({
      all: [{ path: "report.testCoverageGaps", op: "count", compare: "gte", value: 2 }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    expect(state.value).toEqual({
      path: "report.testCoverageGaps",
      op: "count",
      compare: "gte",
      value: 2,
    });
  });

  test("shows type problems live", () => {
    const { container } = renderEditor({ path: "report.nope", op: "exists" });
    expect(container.querySelector("[data-graph-predicate-problems]")?.textContent).toMatch(
      /nope|no field|not/i,
    );
  });

  test("the JSON fallback commits valid predicates and refuses malformed ones", () => {
    const { state } = renderEditor({ path: "report.issues", op: "nonEmpty" });
    fireEvent.click(screen.getByRole("button", { name: /JSON/ }));
    const text = screen.getByLabelText("When (JSON)");
    fireEvent.change(text, {
      target: { value: '{"not": {"path": "params.autoFix", "op": "eq", "value": true}}' },
    });
    expect(state.value).toEqual({ not: { path: "params.autoFix", op: "eq", value: true } });
    fireEvent.change(text, { target: { value: '{"path": "x", "op": "bogus"}' } });
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect(state.value).toEqual({ not: { path: "params.autoFix", op: "eq", value: true } });
    fireEvent.click(screen.getByRole("button", { name: /Form/ }));
    expect(screen.getByLabelText("Group kind")).toBeTruthy();
  });
});
