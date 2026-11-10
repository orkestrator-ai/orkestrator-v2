import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  parseAutoPipelineTicket,
  type AutoPipelineState,
} from "@orkestrator/protocol/build-pipeline";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { AutoPipelineTab, autoPipelineProblems } from "./AutoPipelineTab";

afterEach(cleanupNodeScopes);
const draft = {
  id: "draft-1",
  title: "Feature",
  description: "Summary: complete.\nProblem: missing feature.\nContext: fixture.",
  acceptanceCriteria: ["First check", "Second check"],
  notes: {
    summary: "Implemented fixture",
    workDone: ["fixture.ts"],
    tests: [],
    decisions: [],
    notDone: ["Review"],
  },
  uncommittedFiles: [" M fixture.ts"],
};
/** A backend whose state read answers whatever `holder.state` is now. */
function client(initial: AutoPipelineState) {
  const holder = { state: initial };
  const node = new FakeNodeClient({
    invoke: {
      get_auto_pipeline_state: () => holder.state,
      save_auto_pipeline_edits: undefined,
      draft_auto_pipeline: () => new Promise(() => undefined),
      cancel_auto_pipeline_draft: undefined,
      confirm_auto_pipeline: null,
    },
  });
  return { node, holder };
}
function render(node: FakeNodeClient, isActive = true) {
  return renderInNodeScope(
    <AutoPipelineTab
      environmentId="env"
      data={{ sourceTabId: "original", sourceLabel: "Original work" }}
      isActive={isActive}
    />,
    { client: node },
  );
}
const goTo = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

test("drafting shows progress in the tab and leaving it does not cancel the draft", async () => {
  const { node } = client({ phase: "drafting" });
  const view = render(node);
  expect(await screen.findByText(/Drafting ticket and Build notes/)).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Auto-pipeline steps" })).toBeTruthy();
  view.unmount();
  expect(node.calls("cancel_auto_pipeline_draft")).toHaveLength(0);
});

test("cancel drafting is an explicit action", async () => {
  const { node } = client({ phase: "drafting" });
  render(node);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel drafting" }));
  await waitFor(() => expect(node.calls("cancel_auto_pipeline_draft")).toHaveLength(1));
  expect(node.calls("cancel_auto_pipeline_draft")[0]!.args).toEqual({
    environmentId: "env",
    tabId: "original",
  });
});

test("the draft walks through details, acceptance criteria and confirm in one tab", async () => {
  const { node, holder } = client({ phase: "ready", draft });
  render(node);
  fireEvent.change(await screen.findByLabelText("Title"), {
    target: { value: "Reviewed feature" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Description, rendered/ }));
  const description = screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
  expect(description.value).toBe(draft.description);
  fireEvent.change(description, {
    target: { value: "## Summary\n\nReviewed **summary**\n\nProblem: gap.\n\nContext: fixture." },
  });
  fireEvent.blur(description);
  expect((await screen.findByText("summary")).tagName).toBe("STRONG");
  // Criteria are the next step, not on the same page.
  expect(screen.queryByLabelText("Criterion 1") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Move criterion 2 up" }));
  expect((screen.getByLabelText("Criterion 1") as HTMLTextAreaElement).value).toBe("Second check");
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
  fireEvent.change(screen.getByLabelText("Criterion 2"), { target: { value: "New check" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Implemented fixture")).toBeTruthy();
  expect(screen.getByText("Files to commit")).toBeTruthy();
  expect(screen.getByText(/closes this environment's terminal shells/)).toBeTruthy();
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
  holder.state = { phase: "promoted", pipelineId: "pipeline-1" };
  fireEvent.click(screen.getByRole("button", { name: "Confirm Auto-pipeline" }));
  await waitFor(() => expect(node.calls("confirm_auto_pipeline")).toHaveLength(1));
  const ticket = parseAutoPipelineTicket(node.calls("confirm_auto_pipeline")[0]!.args.ticket);
  expect(ticket.title).toBe("Reviewed feature");
  expect(ticket.acceptanceCriteria).toEqual(["Second check", "New check"]);
  // Edits reached the backend before the confirmation.
  const saves = node.calls("save_auto_pipeline_edits");
  expect(saves.length).toBeGreaterThan(0);
  expect((saves.at(-1)!.args.edits as { title: string }).title).toBe("Reviewed feature");
  expect(await screen.findByText(/Auto-pipeline started/)).toBeTruthy();
});

test("saved edits come back from the backend when the tab is shown again", async () => {
  const { node } = client({
    phase: "ready",
    draft,
    edits: { title: "Saved title", description: draft.description, acceptanceCriteria: ["Only"] },
  });
  render(node);
  expect(((await screen.findByLabelText("Title")) as HTMLInputElement).value).toBe("Saved title");
  goTo(/Acceptance criteria/);
  expect((screen.getByLabelText("Criterion 1") as HTMLTextAreaElement).value).toBe("Only");
});

test("leaving the tab hands unsaved edits to the backend", async () => {
  const { node } = client({ phase: "ready", draft });
  const view = render(node);
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Typed" } });
  view.unmount();
  await waitFor(() => expect(node.calls("save_auto_pipeline_edits")).toHaveLength(1));
  expect(node.calls("save_auto_pipeline_edits")[0]!.args).toMatchObject({
    draftId: "draft-1",
    edits: { title: "Typed" },
  });
});

test("criterion line breaks normalize and blank criteria block confirmation with a reason", async () => {
  const { node } = client({ phase: "ready", draft });
  render(node);
  await screen.findByLabelText("Title");
  goTo(/Acceptance criteria/);
  const criterion = screen.getByRole("textbox", { name: "Criterion 1" }) as HTMLTextAreaElement;
  fireEvent.change(criterion, { target: { value: "First\r\nsecond\nthird\rfourth" } });
  expect(criterion.value).toBe("First second third fourth");
  fireEvent.change(criterion, { target: { value: "\n\r\n" } });
  expect(criterion.getAttribute("aria-invalid")).toBe("true");
  goTo(/^4?\s*Confirm$/);
  const confirm = screen.getByRole("button", { name: "Confirm Auto-pipeline" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("list", { name: "Before confirming" }).textContent).toContain(
    "empty acceptance criterion",
  );
  fireEvent.click(confirm);
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
});

test("a refused confirmation keeps the draft and shows its reason beside the buttons", async () => {
  const { node } = client({
    phase: "ready",
    draft,
    confirmError: "A terminal in this environment did not close.",
  });
  render(node);
  expect((await screen.findByRole("alert")).textContent).toContain("did not close");
  expect(screen.getByLabelText("Title")).toBeTruthy();
});

test("a promotion in progress shows its status and locks the draft", async () => {
  const { node } = client({ phase: "promoting", draft });
  render(node);
  expect(await screen.findByText(/Promoting environment/)).toBeTruthy();
  expect(screen.getByText("Files to commit")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Confirm Auto-pipeline" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("a failed draft offers a retry that drafts again", async () => {
  const { node } = client({ phase: "failed", error: "Wait for this tab's turn to finish" });
  render(node);
  expect((await screen.findByRole("alert")).textContent).toContain("turn to finish");
  fireEvent.click(screen.getByRole("button", { name: "Retry drafting" }));
  await waitFor(() => expect(node.calls("draft_auto_pipeline")).toHaveLength(1));
});

test("an idle tab offers drafting, and a hidden tab does not poll", async () => {
  const { node } = client({ phase: "idle" });
  const view = render(node, false);
  // Effects have run once `render` returns; a hidden tab installed no read or poll.
  expect(node.calls("get_auto_pipeline_state")).toHaveLength(0);
  view.rerender(
    <AutoPipelineTab
      environmentId="env"
      data={{ sourceTabId: "original", sourceLabel: "Original work" }}
      isActive
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Draft ticket" }));
  await waitFor(() => expect(node.calls("draft_auto_pipeline")).toHaveLength(1));
});

test("problems name the step that needs attention", () => {
  expect(autoPipelineProblems({ title: " ", description: "x", acceptanceCriteria: ["a"] })).toEqual(
    { details: "Enter a title." },
  );
  expect(autoPipelineProblems({ title: "t", description: "d", acceptanceCriteria: [] })).toEqual({
    criteria: "Add at least one acceptance criterion.",
  });
});
