import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import type { AutoPipelineTabData } from "@/types/paneLayout";
import { AutoPipelineLaunch } from "./AutoPipelineLaunch";
import { MultiReviewLaunchDialog } from "./MultiReviewLaunchDialog";

afterEach(cleanupNodeScopes);
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
      // Drafting answers only when it finishes; the launcher never waits for it.
      draft_auto_pipeline: () => new Promise(() => undefined),
    },
  });
}

test("Auto-pipeline starts drafting and opens the draft in its own tab without a modal", async () => {
  const node = client();
  const opened: AutoPipelineTabData[] = [];
  renderInNodeScope(
    <AutoPipelineLaunch
      environmentId="env"
      onOpenTab={(target) => {
        opened.push(target);
        return true;
      }}
    />,
    { client: node },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  await waitFor(() => expect(node.calls("draft_auto_pipeline")).toHaveLength(1));
  expect(node.calls("draft_auto_pipeline")[0]!.args).toEqual({
    environmentId: "env",
    tabId: "original",
  });
  expect(opened).toEqual([{ sourceTabId: "original", sourceLabel: "Original work" }]);
  expect(screen.queryByRole("dialog") === null).toBe(true);
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
});

test("running tab explains why drafting is disabled", async () => {
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onOpenTab={() => true} />, {
    client: client(true, true),
  });
  expect(
    (await screen.findByRole("button", { name: "Auto-pipeline" })).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("finish");
});

test("linked pipeline environment omits Auto-pipeline", async () => {
  const node = client(false);
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onOpenTab={() => true} />, {
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

test("opening the Auto-pipeline tab closes the Multi Review dialog", async () => {
  const changes: boolean[] = [];
  renderInNodeScope(
    <MultiReviewLaunchDialog
      open
      onOpenChange={(open) => changes.push(open)}
      onConfirm={() => undefined}
      defaultAgent="codex"
      catalog={{ claude: [], codex: [], opencode: [] }}
      autoPipelineEnvironmentId="env"
      onOpenAutoPipelineTab={() => true}
    />,
    { client: client() },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Auto-pipeline" }));
  expect(changes).toEqual([false]);
});

test("running source refreshes to idle without remounting", async () => {
  const node = client(true, true);
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onOpenTab={() => true} />, {
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

test("multiple sources permit explicit selection and preserve it across refresh", async () => {
  const node = client().respond("auto_pipeline_sources", {
    available: true,
    sources: [
      { tabId: "active", label: "Active work" },
      { tabId: "other", label: "Other work" },
    ],
  });
  renderInNodeScope(<AutoPipelineLaunch environmentId="env" onOpenTab={() => true} />, {
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

test("the Build transcript dropdown shares the reviewer Focus dropdown's theme", async () => {
  renderInNodeScope(
    <MultiReviewLaunchDialog
      open
      onOpenChange={() => undefined}
      onConfirm={() => undefined}
      defaultAgent="codex"
      catalog={{ claude: [], codex: [], opencode: [] }}
      autoPipelineEnvironmentId="env"
      onOpenAutoPipelineTab={() => true}
    />,
    { client: client() },
  );
  const transcript = await screen.findByRole("combobox", { name: "Build transcript" });
  const focus = screen.getByRole("combobox", { name: "Reviewer 1 focus" });
  for (const select of [transcript, focus]) {
    expect(select.getAttribute("data-slot")).toBe("native-select");
    expect(select.className).toContain("bg-input-surface");
  }
  expect(transcript.className).toBe(focus.className);
});
