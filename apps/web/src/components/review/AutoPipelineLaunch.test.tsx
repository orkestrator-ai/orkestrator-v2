import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { AutoPipelineLaunch } from "./AutoPipelineLaunch";
import { MultiReviewLaunchDialog } from "./MultiReviewLaunchDialog";
import { parseAutoPipelineTicket } from "@orkestrator/protocol/build-pipeline";

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
function client(available = true, running = false) {
  return new FakeNodeClient({
    invoke: {
      auto_pipeline_sources: {
        available,
        sources: available
          ? [
              {
                tabId: "original",
                label: "Original work",
                ...(running ? { disabledReason: "Wait for this tab's turn to finish" } : {}),
              },
            ]
          : [],
      },
      draft_auto_pipeline: draft,
      confirm_auto_pipeline: null,
      cancel_auto_pipeline_draft: undefined,
    },
  });
}
test("idle prompt tab offers Auto-pipeline and reviews editable criteria before confirming", async () => {
  const node = client();
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await screen.findByText("Files to commit");
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
  expect(screen.getByText("Implemented fixture")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reviewed feature" } });
  // The description opens as rendered Markdown and turns into the raw text on activation.
  expect(screen.queryByRole("textbox", { name: "Description" }) === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^Description, rendered/ }));
  const description = screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
  expect(description.value).toBe(draft.description);
  fireEvent.change(description, { target: { value: "## Summary\n\nReviewed **summary**" } });
  fireEvent.blur(description);
  expect(screen.queryByRole("textbox", { name: "Description" }) === null).toBe(true);
  expect(await screen.findByRole("heading", { name: "Summary" })).toBeTruthy();
  expect(screen.getByText("summary").tagName).toBe("STRONG");
  // Criteria live on their own tab.
  expect(screen.queryByLabelText("Criterion 1") === null).toBe(true);
  const criteriaTab = screen.getByRole("tab", { name: "Acceptance criteria (2)" });
  fireEvent.mouseDown(criteriaTab, { button: 0 });
  fireEvent.click(criteriaTab);
  fireEvent.click(screen.getByRole("button", { name: "Move criterion 2 up" }));
  expect((screen.getByLabelText("Criterion 1") as HTMLTextAreaElement).value).toBe("Second check");
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
  fireEvent.change(screen.getByLabelText("Criterion 2"), { target: { value: "New check" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm Auto-pipeline" }));
  await waitFor(() => expect(node.calls("confirm_auto_pipeline")).toHaveLength(1));
});

test("criterion line breaks normalize and blank criteria explain why confirmation is disabled", async () => {
  const node = client().respond(
    "confirm_auto_pipeline",
    (args: Readonly<Record<string, unknown>>) => {
      parseAutoPipelineTicket(args.ticket);
      return null;
    },
  );
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  const tab = await screen.findByRole("tab", { name: "Acceptance criteria (2)" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
  const criterion = screen.getByRole("textbox", { name: "Criterion 1" }) as HTMLTextAreaElement;
  fireEvent.change(criterion, { target: { value: "First\r\nsecond\nthird\rfourth" } });
  expect(criterion.value).toBe("First second third fourth");
  fireEvent.change(criterion, { target: { value: "\n\r\n" } });
  expect(criterion.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("Enter an acceptance criterion.").id).toBe(
    criterion.getAttribute("aria-describedby")!,
  );
  const confirm = screen.getByRole("button", { name: "Confirm Auto-pipeline" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(confirm);
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
  fireEvent.change(criterion, { target: { value: "First\nsecond" } });
  expect(confirm.hasAttribute("disabled")).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => expect(node.calls("confirm_auto_pipeline")).toHaveLength(1));
  expect(
    parseAutoPipelineTicket(node.calls("confirm_auto_pipeline")[0]!.args.ticket).acceptanceCriteria,
  ).toEqual(["First second", "Second check"]);
});

test("Escape leaves the description editor open as a preview and preserves all draft edits", async () => {
  const node = client();
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Edited title" } });
  fireEvent.click(screen.getByRole("button", { name: /^Description, rendered/ }));
  const editor = screen.getByRole("textbox", { name: "Description" });
  const edited = "Summary: **Edited**.\nProblem: missing feature.\nContext: fixture.";
  fireEvent.change(editor, { target: { value: edited } });
  fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Description" }) === null).toBe(true);
  expect((await screen.findByText("Edited")).tagName).toBe("STRONG");
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Edited title");
  expect(node.calls("draft_auto_pipeline")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /^Description, rendered/ }));
  expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe(
    edited,
  );
});
test("running tab explains why drafting is disabled", async () => {
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: client(true, true),
  });
  expect(
    (await screen.findByRole("button", { name: "Auto-pipeline" })).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("finish");
});
test("linked pipeline environment omits Auto-pipeline", async () => {
  const node = client(false);
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  await waitFor(() => expect(node.calls("auto_pipeline_sources")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "Auto-pipeline" }) === null).toBe(true);
});
test("coordinator and pipeline review dialog callers without a manual prompt target omit Auto-pipeline", () => {
  renderInNodeScope(
    <MultiReviewLaunchDialog
      open
      onOpenChange={() => undefined}
      onConfirm={() => undefined}
      defaultAgent="codex"
      catalog={{ claude: [], codex: [], opencode: [] }}
    />,
    { client: client() },
  );
  expect(screen.queryByRole("button", { name: "Auto-pipeline" }) === null).toBe(true);
});
test("cancel never sends a confirmation", async () => {
  const node = client();
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await screen.findByLabelText("Title");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
});

test("running source refreshes to idle without remounting", async () => {
  const node = client(true, true);
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  const button = await screen.findByRole("button", { name: "Auto-pipeline" });
  expect(button.hasAttribute("disabled")).toBe(true);
  node.respond("auto_pipeline_sources", {
    available: true,
    sources: [{ tabId: "original", label: "Original work" }],
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false), { timeout: 4000 });
});
test("a hanging draft can be dismissed without confirmation", async () => {
  const node = client().respond("draft_auto_pipeline", () => new Promise(() => {}));
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await screen.findByText("Drafting ticket and Build notes…");
  // The working state shows a spinner beside the status text, hidden from assistive tech.
  const spinner = screen.getByRole("status").querySelector('[data-testid="auto-pipeline-spinner"]');
  expect(spinner?.getAttribute("class")).toContain("animate-spin");
  expect(spinner?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
  await waitFor(() => expect(node.calls("cancel_auto_pipeline_draft")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
});
test("a pending confirmation shows the spinner with the promotion status", async () => {
  const node = client().respond("confirm_auto_pipeline", () => new Promise(() => {}));
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await screen.findByLabelText("Title");
  expect(screen.queryByTestId("auto-pipeline-spinner") === null).toBe(true);
  expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Confirm Auto-pipeline" }));
  await screen.findByText("Promoting environment…");
  expect(
    screen.getByRole("status").querySelector('[data-testid="auto-pipeline-spinner"]'),
  ).toBeTruthy();
});
test("a second draft clears the cancelled draft and remains dismissible", async () => {
  const node = client();
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await screen.findByLabelText("Title");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));

  node.respond("draft_auto_pipeline", () => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Auto-pipeline" }));
  await waitFor(() => expect(node.calls("draft_auto_pipeline")).toHaveLength(2));
  expect(screen.getByRole("status").textContent).toContain("Drafting ticket and Build notes…");
  expect(screen.queryByLabelText("Title") === null).toBe(true);
  expect(screen.queryByRole("button", { name: "Confirm Auto-pipeline" }) === null).toBe(true);
  expect(screen.getByTestId("auto-pipeline-spinner")).toBeTruthy();
  expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(cancel.hasAttribute("disabled")).toBe(false);
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  expect(node.calls("cancel_auto_pipeline_draft")).toHaveLength(1);
  expect(node.calls("cancel_auto_pipeline_draft")[0]!.args).toEqual({
    environmentId: "env",
    tabId: "original",
  });
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
});
test("draft failure offers retry and plain review; confirmation errors retain the draft", async () => {
  const node = client().respond("draft_auto_pipeline", () => {
    throw new Error("draft unavailable");
  });
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await screen.findByText("draft unavailable");
  expect(screen.getByRole("button", { name: "Plain Multi Review" })).toBeTruthy();
  node.respond("draft_auto_pipeline", draft).respond("confirm_auto_pipeline", () => {
    throw new Error("confirmation unavailable");
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry drafting" }));
  await screen.findByLabelText("Title");
  fireEvent.click(screen.getByRole("button", { name: "Confirm Auto-pipeline" }));
  await screen.findByText("confirmation unavailable");
  expect(screen.getByLabelText("Title")).toBeTruthy();
});

test("multiple sources permit explicit selection and preserve it across refresh", async () => {
  const node = client().respond("auto_pipeline_sources", {
    available: true,
    sources: [
      { tabId: "active", label: "Active work" },
      { tabId: "other", label: "Other work" },
    ],
  });
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onPromoted={() => undefined} />, {
    client: node,
  });
  const picker = await screen.findByRole("combobox", { name: "Build transcript" });
  expect((picker as HTMLSelectElement).value).toBe("active");
  fireEvent.change(picker, { target: { value: "other" } });
  await waitFor(() => expect(node.calls("auto_pipeline_sources").length).toBeGreaterThan(1), {
    timeout: 4000,
  });
  expect((picker as HTMLSelectElement).value).toBe("other");
});
