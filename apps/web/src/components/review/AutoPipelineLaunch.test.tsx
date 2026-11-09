import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { AutoPipelineLaunch } from "./AutoPipelineLaunch";
import { MultiReviewLaunchDialog } from "./MultiReviewLaunchDialog";

afterEach(cleanupNodeScopes);
const draft = {
  id: "draft-1",
  title: "Feature",
  description: "Summary, problem and context",
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
  fireEvent.click(screen.getByRole("button", { name: "Move criterion 2 up" }));
  expect((screen.getByLabelText("Criterion 1") as HTMLInputElement).value).toBe("Second check");
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
  fireEvent.change(screen.getByLabelText("Criterion 2"), { target: { value: "New check" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm Auto-pipeline" }));
  await waitFor(() => expect(node.calls("confirm_auto_pipeline")).toHaveLength(1));
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
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
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
