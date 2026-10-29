import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { checkGraphSystemParams } from "@orkestrator/protocol/graphs/system-actions";
import type {
  GraphSystemAction,
  GraphSystemNode,
  GraphSystemParamValue,
  GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { GraphSystemParamsEditor, graphSystemParamValueIssue } from "./GraphSystemParamsEditor";
import { kindsTemplate } from "./graph-designer-kinds.test-fixtures";
import { renderWithGraphEditor } from "./graph-editor.test-support";

afterEach(cleanup);

/** The kinds fixture with its system node `pr` set to `action` and `params`. */
function systemTemplate(
  action: GraphSystemAction,
  params?: Record<string, GraphSystemParamValue>,
): GraphTemplateV1 {
  const template = kindsTemplate();
  return {
    ...template,
    nodes: template.nodes.map((node) =>
      node.id === "pr"
        ? { ...(node as GraphSystemNode), action, ...(params ? { params } : {}) }
        : node,
    ),
  };
}

function render(template: GraphTemplateV1) {
  const result = renderWithGraphEditor(template, (draft) => (
    <GraphSystemParamsEditor
      node={draft.nodes.find((node) => node.id === "pr") as GraphSystemNode}
    />
  ));
  const params = () =>
    (result.harness.current().nodes.find((node) => node.id === "pr") as GraphSystemNode).params;
  const issues = (key: string) =>
    Array.from(
      result.container.querySelectorAll(
        `[data-graph-system-param="${key}"] [data-graph-param-issue]`,
      ),
    ).map((issue) => issue.textContent);
  const nodeIssues = () =>
    Array.from(
      result.container.querySelectorAll(
        "[data-graph-system-param-issues] [data-graph-param-issue]",
      ),
    ).map((issue) => issue.textContent);
  return { ...result, params, issues, nodeIssues };
}

function commit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function optionLabels(select: HTMLElement) {
  return Array.from((select as HTMLSelectElement).options).map((option) => option.text);
}

describe("GraphSystemParamsEditor", () => {
  test("a boolean param selects default, yes or no; clearing drops the key", () => {
    const { harness, params } = render(systemTemplate("open-pull-request"));
    const draft = screen.getByLabelText("draft");
    expect(optionLabels(draft)).toEqual(["Default (no)", "Yes", "No"]);
    expect(screen.getByText("Open a new pull request as a draft.")).toBeTruthy();
    fireEvent.change(draft, { target: { value: "true" } });
    expect(params()).toEqual({ draft: true });
    fireEvent.change(draft, { target: { value: "false" } });
    expect(params()).toEqual({ draft: false });
    fireEvent.change(draft, { target: { value: "" } });
    expect(params()).toBeUndefined();
    expect(harness.edits.map((entry) => entry.label)).toEqual([
      "Edit param draft",
      "Edit param draft",
      "Clear param draft",
    ]);
  });

  test("a branch param refuses an invalid name with the compiler's message", () => {
    const { params } = render(systemTemplate("open-pull-request"));
    const branch = screen.getByLabelText("targetBranch");
    expect(screen.getByText(/a branch name, at most 200 characters/)).toBeTruthy();
    commit(branch, "feature..x");
    expect(screen.getByRole("alert").textContent).toBe("targetBranch is not a valid branch name");
    expect(params()).toBeUndefined();
    commit(branch, "release/1.2");
    expect(params()).toEqual({ targetBranch: "release/1.2" });
    commit(branch, "");
    expect(params()).toBeUndefined();
  });

  test("an integer param shows its default and range and refuses values outside it", () => {
    const { params } = render(systemTemplate("wait-for-checks"));
    const minutes = screen.getByLabelText("timeoutMinutes") as HTMLInputElement;
    expect(minutes.placeholder).toBe("60");
    expect(screen.getByText(/\(1–360\)$/)).toBeTruthy();
    commit(minutes, "0");
    expect(screen.getByRole("alert").textContent).toBe("timeoutMinutes is from 1 to 360");
    commit(minutes, "2.5");
    expect(screen.getByRole("alert").textContent).toBe("timeoutMinutes is a whole number");
    commit(minutes, "soon");
    expect(screen.getByRole("alert").textContent).toBe("timeoutMinutes is a whole number");
    expect(params()).toBeUndefined();
    commit(minutes, "90");
    expect(params()).toEqual({ timeoutMinutes: 90 });
    commit(minutes, "");
    expect(params()).toBeUndefined();
  });

  test("a stored invalid value shows the same message and detail as the compiler's system-param-invalid", () => {
    const template = systemTemplate("wait-for-checks", { timeoutMinutes: 999 });
    const { container, issues } = render(template);
    const diagnostic = compile(template).diagnostics.find(
      (entry) => entry.code === "system-param-invalid",
    )!;
    expect(diagnostic.path).toEndWith(".params.timeoutMinutes");
    expect(issues("timeoutMinutes")).toEqual([diagnostic.message]);
    const issue = container.querySelector(
      '[data-graph-system-param="timeoutMinutes"] [data-graph-param-issue]',
    )!;
    expect(issue.getAttribute("data-graph-param-issue")).toBe(diagnostic.detail!);
    expect(graphSystemParamValueIssue("wait-for-checks", "timeoutMinutes", 999)).toEqual(
      checkGraphSystemParams("wait-for-checks", { timeoutMinutes: 999 })[0]!,
    );
  });

  test("enum params, the at-least-one rule and the lifecycle conflict (update-ticket)", () => {
    const { params, issues, nodeIssues } = render(systemTemplate("update-ticket"));
    expect(nodeIssues()).toEqual([
      "update-ticket needs at least one of lifecycle, status, comment or record",
    ]);
    const lifecycle = screen.getByLabelText("lifecycle");
    expect(optionLabels(lifecycle)).toEqual([
      "Not set",
      "build-started",
      "validation-complete",
      "pr-raised",
      "complete",
      "failed",
    ]);
    fireEvent.change(lifecycle, { target: { value: "pr-raised" } });
    expect(params()).toEqual({ lifecycle: "pr-raised" });
    expect(nodeIssues()).toEqual([]);
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "Done." } });
    expect(params()).toEqual({ lifecycle: "pr-raised", comment: "Done." });
    expect(issues("comment")).toEqual([
      "`lifecycle` sets the column and comment itself; drop `comment`",
    ]);
    fireEvent.change(lifecycle, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("record"), { target: { value: "criteria" } });
    expect(params()).toEqual({ comment: "Done.", record: "criteria" });
    expect(issues("comment")).toEqual([]);
  });

  test("notify: required and conditional params, ids and free text", () => {
    const { params, issues, harness } = render(systemTemplate("notify"));
    expect(issues("to")).toEqual(["notify needs `to`"]);
    expect(issues("message")).toEqual(["notify needs a `message`"]);
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "tab" } });
    expect(issues("tabId")).toEqual(["Mailing a tab needs `tabId`"]);
    commit(screen.getByLabelText("tabId"), "two words");
    expect(screen.getByRole("alert").textContent).toBe("tabId is one word without spaces");
    commit(screen.getByLabelText("tabId"), "startup-agent");
    const message = screen.getByLabelText("message");
    expect(message.tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("subject").tagName).toBe("INPUT");
    fireEvent.change(message, { target: { value: "Build" } });
    fireEvent.change(message, { target: { value: "Build done" } });
    expect(params()).toEqual({ to: "tab", tabId: "startup-agent", message: "Build done" });
    expect(issues("to")).toEqual([]);
    expect(issues("tabId")).toEqual([]);
    // Free text commits as typed, one undo step per field.
    expect(harness.edits.at(-1)).toEqual({
      label: "Edit param message",
      coalesce: "node:pr:param:message",
    });
    // Longer than a template stores: refused, and said so.
    fireEvent.change(message, { target: { value: "x".repeat(3_000) } });
    expect(screen.getByRole("alert").textContent).toContain("at most 2048 bytes");
    expect(params()!.message).toBe("Build done");
    // Switching to the coordinator makes tabId a conflict.
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "coordinator" } });
    expect(issues("tabId")).toEqual([
      "`tabId` is only for `to: tab`; the coordinator has its own address",
    ]);
  });
});
