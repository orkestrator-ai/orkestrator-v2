import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import {
  GRAPH_SYSTEM_ACTIONS,
  type GraphGateNode,
  type GraphHumanNode,
  type GraphMergeNode,
  type GraphNodeSpec,
  type GraphSystemNode,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import {
  GraphGateEditor,
  GraphHumanEditor,
  GraphMergeEditor,
  GraphSystemEditor,
} from "./GraphKindEditors";
import { graphSystemParamsProblem } from "./GraphSystemParamsEditor";
import { gatedTemplate, kindsTemplate } from "./graph-designer-kinds.test-fixtures";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

function nodeOf<N extends GraphNodeSpec>(template: GraphTemplateV1, id: string): N {
  return template.nodes.find((node) => node.id === id) as N;
}

function commit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("GraphSystemEditor", () => {
  test("switches the action, shows the compiler's port messages and offers the spec's default ports", () => {
    const { harness, container } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphSystemEditor node={nodeOf<GraphSystemNode>(template, "pr")} />
    ));
    expect(container.querySelector("[data-graph-system-port-issues]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use default ports" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "wait-for-checks" } });
    expect(nodeOf<GraphSystemNode>(harness.current(), "pr").action).toBe("wait-for-checks");
    const issues = container.querySelector("[data-graph-system-port-issues]") as HTMLElement;
    expect(issues.textContent).toContain("wait-for-checks does not read pr-description@1");
    expect(issues.textContent).toContain("wait-for-checks does not produce pr-result@1");
    expect(issues.textContent).toContain("pr needs an input of type pr-result@1");
    fireEvent.click(screen.getByRole("button", { name: "Use default ports" }));
    const node = nodeOf<GraphSystemNode>(harness.current(), "pr");
    // The spec's required inputs and its outputs, named as the built-ins name them.
    expect(node.inputs).toEqual([{ name: "pr", type: "pr-result@1" }]);
    expect(node.outputs).toEqual([{ name: "checks", type: "check-summary@1" }]);
    expect(container.querySelector("[data-graph-system-port-issues]")).toBeNull();
    expect(harness.edits.map((entry) => entry.label)).toEqual([
      "Change action",
      "Use the default ports of Wait for checks",
    ]);
  });

  test("labels, side effect and idempotency come from the action's spec", () => {
    const { container } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphSystemEditor node={nodeOf<GraphSystemNode>(template, "pr")} />
    ));
    const action = screen.getByLabelText("Action") as HTMLSelectElement;
    const labels = Array.from(action.options).map((option) => option.text);
    expect(labels).toEqual(GRAPH_SYSTEM_ACTIONS.map((id) => GRAPH_SYSTEM_ACTION_SPECS[id].label));
    const spec = GRAPH_SYSTEM_ACTION_SPECS["open-pull-request"];
    expect(screen.getByText(spec.description)).toBeTruthy();
    const header = within(screen.getByRole("region", { name: "System action" }));
    expect(header.getByText("side effect")).toBeTruthy();
    expect(container.querySelector("[data-graph-system-idempotency]")!.textContent).toContain(
      spec.idempotency,
    );
    // wait-for-checks only reads.
    fireEvent.change(action, { target: { value: "wait-for-checks" } });
    expect(container.querySelector('[data-graph-badge="side-effect"]')).toBeNull();
  });

  test("lists the types the action reads and produces and adds a missing port", () => {
    const { harness, container } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphSystemEditor node={nodeOf<GraphSystemNode>(template, "pr")} />
    ));
    const row = (key: string) =>
      container.querySelector(`[data-graph-system-port="${key}"]`) as HTMLElement;
    expect(row("input:workspace@1").textContent).toContain("required");
    expect(row("input:workspace@1").textContent).toContain("on code");
    expect(row("output:pr-result@1").textContent).toContain("on pr");
    fireEvent.click(screen.getByRole("button", { name: "Add output pull-request-state@1" }));
    expect(nodeOf<GraphSystemNode>(harness.current(), "pr").outputs).toEqual([
      { name: "pr", type: "pr-result@1" },
      { name: "state", type: "pull-request-state@1" },
    ]);
    expect(row("output:pull-request-state@1").textContent).toContain("on state");
    // An optional input of another action.
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "wait-for-checks" } });
    expect(row("input:workspace@1").textContent).toContain("optional");
    expect(harness.edits.map((entry) => entry.label)).toEqual([
      "Add output pull-request-state@1",
      "Change action",
    ]);
  });

  test("the params JSON fallback commits objects within the template bounds; the spec's rules show", () => {
    const { harness, container } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphSystemEditor node={nodeOf<GraphSystemNode>(template, "pr")} />
    ));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const text = screen.getByLabelText("Params (JSON)");
    fireEvent.change(text, { target: { value: '{"draft": true, "labels": ["a", "b"]}' } });
    expect(nodeOf<GraphSystemNode>(harness.current(), "pr").params).toEqual({
      draft: true,
      labels: ["a", "b"],
    });
    expect(container.querySelector("[data-graph-system-param-issues]")!.textContent).toBe(
      "open-pull-request takes no parameter labels (it takes targetBranch, draft)",
    );
    fireEvent.change(text, { target: { value: '{"Bad-Key": 1}' } });
    expect(screen.getByRole("alert").textContent).toContain("identifier");
    expect(graphSystemParamsProblem({ nested: { a: 1 } })).toMatch(/nested/);
    expect(
      graphSystemParamsProblem(
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
      ),
    ).toMatch(/At most 16/);
    // Back in the form, the unknown key is listed with its problem and can be removed.
    fireEvent.click(screen.getByRole("button", { name: "Form" }));
    const labels = container.querySelector('[data-graph-system-param="labels"]') as HTMLElement;
    expect(labels.querySelector('[data-graph-param-issue="unknown"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove param labels" }));
    expect(nodeOf<GraphSystemNode>(harness.current(), "pr").params).toEqual({ draft: true });
    // Switching action drops the params the new action does not take.
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "push-branch" } });
    expect(nodeOf<GraphSystemNode>(harness.current(), "pr").params).toBeUndefined();
    expect(screen.getByText("Push branch takes no params.")).toBeTruthy();
  });

  test("execution fields: retry, timeout and failure policy", () => {
    const { harness } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphSystemEditor node={nodeOf<GraphSystemNode>(template, "pr")} />
    ));
    const node = () => nodeOf<GraphSystemNode>(harness.current(), "pr");
    commit(screen.getByLabelText("Attempts"), "3");
    expect(node().retry).toEqual({ attempts: 3, on: ["provider-error"] });
    fireEvent.click(screen.getByLabelText("Retry on timeouts"));
    expect(node().retry).toEqual({ attempts: 3, on: ["provider-error", "timeout"] });
    commit(screen.getByLabelText("Attempts"), "1");
    expect(node().retry).toBeUndefined();
    commit(screen.getByLabelText("Timeout (seconds)"), "90");
    expect(node().timeoutMs).toBe(90_000);
    commit(screen.getByLabelText("Timeout (seconds)"), "0");
    expect(screen.getByRole("alert").textContent).toContain("At least 1");
    commit(screen.getByLabelText("Timeout (seconds)"), "");
    expect(node().timeoutMs).toBeUndefined();
    fireEvent.change(screen.getByLabelText("On failure"), { target: { value: "skip" } });
    expect(node().onFailure).toBe("skip");
    fireEvent.change(screen.getByLabelText("On failure"), { target: { value: "fail-run" } });
    expect(node().onFailure).toBeUndefined();
  });
});

describe("GraphGateEditor", () => {
  test("renames an outlet (edges follow), edits conditions and adds, orders and removes branches", () => {
    const { harness, container } = renderWithGraphEditor(gatedTemplate(), (template) => (
      <GraphGateEditor node={nodeOf<GraphGateNode>(template, "check")} />
    ));
    const gate = () => nodeOf<GraphGateNode>(harness.current(), "check");
    const branch = (to: string) =>
      container.querySelector(`[data-graph-gate-branch="${to}"]`)!.parentElement as HTMLElement;
    commit(within(branch("findings")).getByLabelText("Outlet"), "issues");
    expect(gate().branches[0]!.to).toBe("issues");
    expect(harness.current().edges.find((edge) => edge.id === "check-approve")!.from).toEqual({
      node: "check",
      outlet: "issues",
      port: "report",
    });
    // A duplicate outlet name is refused.
    commit(within(branch("issues")).getByLabelText("Outlet"), "clean");
    expect(screen.getByRole("alert").textContent).toContain("already has an outlet clean");
    fireEvent.keyDown(within(branch("issues")).getByLabelText("Outlet"), { key: "Escape" });

    fireEvent.change(within(branch("issues")).getByLabelText("Operator"), {
      target: { value: "empty" },
    });
    expect(gate().branches[0]!.when).toEqual({ path: "report.issues", op: "empty" });

    fireEvent.click(screen.getByRole("button", { name: /^Branch$/ }));
    expect(gate().branches.map((entry) => entry.to)).toEqual(["issues", "branch"]);
    fireEvent.click(screen.getByRole("button", { name: "Move branch up" }));
    expect(gate().branches.map((entry) => entry.to)).toEqual(["branch", "issues"]);
    // Removing the branch whose outlet feeds approve drops that edge.
    fireEvent.click(screen.getByRole("button", { name: "Remove branch issues" }));
    expect(gate().branches.map((entry) => entry.to)).toEqual(["branch"]);
    expect(harness.current().edges.some((edge) => edge.id === "check-approve")).toBe(false);
  });

  test("toggles and renames the otherwise outlet", () => {
    const { harness } = renderWithGraphEditor(gatedTemplate(), (template) => (
      <GraphGateEditor node={nodeOf<GraphGateNode>(template, "check")} />
    ));
    commit(screen.getByLabelText("Otherwise outlet"), "ok");
    expect(nodeOf<GraphGateNode>(harness.current(), "check").otherwise).toBe("ok");
    expect(harness.current().outputs![0]!.from.outlet).toBe("ok");
    fireEvent.click(screen.getByLabelText("An outlet when no branch holds"));
    expect(nodeOf<GraphGateNode>(harness.current(), "check").otherwise).toBeUndefined();
    expect(harness.current().outputs).toEqual([]);
    fireEvent.click(screen.getByLabelText("An outlet when no branch holds"));
    expect(nodeOf<GraphGateNode>(harness.current(), "check").otherwise).toBe("otherwise");
  });
});

describe("GraphMergeEditor", () => {
  test("switches strategies with sensible defaults and edits dedupe keys", () => {
    const { harness, container } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphMergeEditor node={nodeOf<GraphMergeNode>(template, "merge")} />
    ));
    const strategy = () => nodeOf<GraphMergeNode>(harness.current(), "merge").strategy;
    fireEvent.change(screen.getByLabelText("Strategy"), { target: { value: "dedupe" } });
    const first = strategy();
    expect(first.kind).toBe("dedupe");
    // Findings carry file, line and title: the default key folds on them.
    expect(first.kind === "dedupe" && first.key).toEqual(["file", "line", "title"]);
    expect(screen.getByText(/deterministic default for a fan-in/i)).toBeTruthy();
    const options = Array.from(container.querySelectorAll("datalist option")).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(options).toContain("title");
    fireEvent.click(screen.getByRole("button", { name: "Remove key field line" }));
    fireEvent.change(screen.getByLabelText("Key field 2"), { target: { value: "severity" } });
    expect(strategy()).toEqual({ kind: "dedupe", key: ["file", "severity"] });
    fireEvent.change(screen.getByLabelText("Strategy"), { target: { value: "vote" } });
    expect(strategy()).toEqual({ kind: "vote", tie: "fail" });
    fireEvent.change(screen.getByLabelText("On a tie"), { target: { value: "first" } });
    fireEvent.change(screen.getByLabelText("Choice field"), { target: { value: "verdict" } });
    expect(strategy()).toEqual({ kind: "vote", tie: "first", path: "verdict" });
    fireEvent.change(screen.getByLabelText("Strategy"), { target: { value: "best" } });
    fireEvent.change(screen.getByLabelText("Prefer"), { target: { value: "lowest" } });
    expect(strategy()).toMatchObject({ kind: "best", prefer: "lowest" });
  });
});

describe("GraphHumanEditor", () => {
  test("switching to choose drops edges from the approval outlets; options take outlets", () => {
    const { harness, container } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphHumanEditor node={nodeOf<GraphHumanNode>(template, "approve")} />
    ));
    const human = () => nodeOf<GraphHumanNode>(harness.current(), "approve");
    fireEvent.change(screen.getByLabelText("Instructions for the person"), {
      target: { value: "Check it." },
    });
    expect(human().form).toEqual({ kind: "approve", instructions: "Check it." });
    fireEvent.change(screen.getByLabelText("Form"), { target: { value: "choose" } });
    expect(human().form.kind).toBe("choose");
    expect(harness.current().edges.map((edge) => edge.id)).toEqual(["merge-approve"]);
    fireEvent.click(screen.getByRole("button", { name: /^Option$/ }));
    const form = () => human().form as Extract<GraphHumanNode["form"], { kind: "choose" }>;
    expect(form().options.map((option) => option.to)).toEqual(["option1", "option2", "option"]);
    const option = container.querySelector('[data-graph-human-option="option"]')!
      .parentElement as HTMLElement;
    commit(within(option).getByLabelText("Outlet"), "later");
    const renamed = container.querySelector('[data-graph-human-option="later"]')!
      .parentElement as HTMLElement;
    fireEvent.change(within(renamed).getByLabelText("Label"), { target: { value: "Later" } });
    expect(form().options[2]).toEqual({ to: "later", label: "Later" });
    fireEvent.click(screen.getByRole("button", { name: "Remove option later" }));
    expect(form().options).toHaveLength(2);
    // Two options is the minimum.
    expect(screen.queryByRole("button", { name: /Remove option/ })).toBeNull();
  });

  test("edit form names an input; timeout explains waiting", () => {
    const { harness } = renderWithGraphEditor(kindsTemplate(), (template) => (
      <GraphHumanEditor node={nodeOf<GraphHumanNode>(template, "approve")} />
    ));
    fireEvent.change(screen.getByLabelText("Form"), { target: { value: "edit" } });
    expect(nodeOf<GraphHumanNode>(harness.current(), "approve").form).toEqual({
      kind: "edit",
      edit: "report",
    });
    // The approval outlets survive the switch between approve and edit.
    expect(harness.current().edges).toHaveLength(3);
    expect(screen.getByText(/paused rather than failed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), { target: { value: "3600" } });
    fireEvent.blur(screen.getByLabelText("Timeout (seconds)"));
    expect(nodeOf<GraphHumanNode>(harness.current(), "approve").timeoutMs).toBe(3_600_000);
  });
});
