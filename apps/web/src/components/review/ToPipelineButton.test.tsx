import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { ToPipelineButton } from "./ToPipelineButton";

afterEach(cleanupNodeScopes);

type Source = { tabId: string; label: string; disabledReason?: string };
const original: Source = { tabId: "original", label: "Original work" };

function client(sources: Source[] = [original], available = true) {
  return new FakeNodeClient({
    invoke: {
      auto_pipeline_sources: { available, sources: available ? sources : [] },
      // Drafting answers only when it finishes; the toolbar never waits for it.
      draft_auto_pipeline: () => new Promise(() => undefined),
    },
  });
}

/** Renders the button with `activeTabId` active in the environment's only pane. */
function render(
  node: FakeNodeClient,
  createTab: Parameters<typeof ToPipelineButton>[0]["createTab"],
  activeTabId = "original",
) {
  const view = renderInNodeScope(<ToPipelineButton environmentId="env" createTab={createTab} />, {
    client: node,
  });
  act(() => {
    view.scope.store(paneLayoutStore).setState({
      environments: new Map([
        [
          "env",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: "original", type: "agent-native" },
                { id: "other", type: "agent-native" },
                { id: "terminal", type: "plain" },
              ],
              activeTabId,
            },
            activePaneId: "default",
            containerId: null,
            backendRevision: 0,
          },
        ],
      ]) as never,
    });
  });
  return view;
}

test("opens the Auto-pipeline tab for the active tab and asks its agent to draft", async () => {
  const node = client();
  const opened: unknown[] = [];
  render(node, (type, options) => {
    opened.push([type, options]);
    return true;
  });
  fireEvent.click(await screen.findByRole("button", { name: "To pipeline" }));
  expect(opened).toEqual([
    ["auto-pipeline", { autoPipeline: { sourceTabId: "original", sourceLabel: "Original work" } }],
  ]);
  await waitFor(() => expect(node.calls("draft_auto_pipeline")).toHaveLength(1));
  expect(node.calls("draft_auto_pipeline")[0]!.args).toEqual({
    environmentId: "env",
    tabId: "original",
  });
  // Drafting never creates anything: confirming stays the user's click in the tab.
  expect(node.calls("confirm_auto_pipeline")).toHaveLength(0);
});

test("acts on the active tab, not on another agent tab of the environment", async () => {
  const node = client([original, { tabId: "other", label: "Other work" }]);
  render(node, () => true, "other");
  fireEvent.click(await screen.findByRole("button", { name: "To pipeline" }));
  await waitFor(() => expect(node.calls("draft_auto_pipeline")).toHaveLength(1));
  expect(node.calls("draft_auto_pipeline")[0]!.args).toEqual({
    environmentId: "env",
    tabId: "other",
  });
});

test("is absent when the active tab is not one the backend offers", async () => {
  const node = client();
  render(node, () => true, "terminal");
  await waitFor(() => expect(node.calls("auto_pipeline_sources").length).toBeGreaterThan(0));
  expect(screen.queryByRole("button", { name: "To pipeline" }) === null).toBe(true);
});

test("is absent in an environment that is not a prompt environment", async () => {
  const node = client([], false);
  render(node, () => true);
  await waitFor(() => expect(node.calls("auto_pipeline_sources")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "To pipeline" }) === null).toBe(true);
});

test("a running tab explains why it is disabled, and enables when the turn finishes", async () => {
  const node = client([{ ...original, disabledReason: "Wait for this tab's turn to finish" }]);
  render(node, () => true);
  const button = await screen.findByRole("button", { name: "To pipeline" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.getAttribute("title")).toBe("Wait for this tab's turn to finish");
  expect(button.getAttribute("aria-describedby")).toBeTruthy();
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toContain(
    "finish",
  );
  node.respond("auto_pipeline_sources", { available: true, sources: [original] });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false), { timeout: 4000 });
});

test("a tab that cannot open, such as at the tab limit, starts no drafting", async () => {
  const node = client();
  let asked = 0;
  render(node, () => {
    asked += 1;
    return false;
  });
  fireEvent.click(await screen.findByRole("button", { name: "To pipeline" }));
  expect(asked).toBe(1);
  // `start` issues the command synchronously from the click, so had it been
  // sent it would already be recorded.
  expect(node.calls("draft_auto_pipeline")).toHaveLength(0);
});

test("a refused drafting request is shown as a toast", async () => {
  const node = client().respond("draft_auto_pipeline", () => {
    throw new Error("Backend unreachable");
  });
  render(node, () => true);
  fireEvent.click(await screen.findByRole("button", { name: "To pipeline" }));
  await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
  expect(mockToastError.mock.calls[0]?.[0]).toBe("Auto-pipeline drafting did not start");
  expect(mockToastError.mock.calls[0]?.[1]).toEqual({ description: "Backend unreachable" });
});

test("stops polling when it unmounts", async () => {
  const node = client();
  const view = render(node, () => true);
  await screen.findByRole("button", { name: "To pipeline" });
  view.unmount();
  const calls = node.calls("auto_pipeline_sources").length;
  await new Promise((resolve) => setTimeout(resolve, 2300));
  expect(node.calls("auto_pipeline_sources")).toHaveLength(calls);
});

test("reads nothing while the window is hidden and reads again once it is shown", async () => {
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const setVisibility = (value: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  try {
    setVisibility("hidden");
    const node = client();
    render(node, () => true);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(node.calls("auto_pipeline_sources")).toHaveLength(0);
    act(() => setVisibility("visible"));
    expect(await screen.findByRole("button", { name: "To pipeline" })).toBeTruthy();
    expect(node.calls("auto_pipeline_sources")).toHaveLength(1);
  } finally {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  }
});
