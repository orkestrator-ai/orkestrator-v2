import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { TO_PIPELINE_POLL_MS, ToPipelineButton } from "./ToPipelineButton";

/**
 * Holds the button's poll interval so a test advances it by hand rather than
 * waiting on the wall clock. Only intervals at the poll delay are captured;
 * everything else (Testing Library, promises) stays on the real clock. The
 * button is the delay's only owner in this tree, so a second live interval at
 * it is reported rather than silently shared.
 */
function controlPolling() {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const live = new Map<object, () => void>();
  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof callback !== "function" || delay !== TO_PIPELINE_POLL_MS)
      return originalSetInterval(callback, delay, ...args);
    if (live.size > 0) throw new Error("controlPolling: a second poll interval was scheduled");
    const handle = { unref: () => handle };
    live.set(handle, () => (callback as (...callbackArgs: unknown[]) => void)(...args));
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (handle && live.delete(handle as unknown as object)) return;
    originalClearInterval(handle);
  }) as typeof globalThis.clearInterval;
  return {
    /** Fires every live poll interval once, as if the poll delay had elapsed. */
    tick() {
      act(() => {
        for (const poll of Array.from(live.values())) poll();
      });
    },
    liveCount: () => live.size,
    restore() {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

let polling: ReturnType<typeof controlPolling>;
beforeEach(() => {
  polling = controlPolling();
});
afterEach(() => {
  cleanupNodeScopes();
  polling.restore();
});

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
  polling.tick();
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
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
  const calls = node.calls("auto_pipeline_sources").length;
  // While mounted, each elapsed poll delay reads again.
  polling.tick();
  await waitFor(() => expect(node.calls("auto_pipeline_sources")).toHaveLength(calls + 1));
  expect(polling.liveCount()).toBe(1);
  view.unmount();
  // Unmounting clears the interval and the visibility listener, so neither an
  // elapsed delay nor the window being shown reads again.
  expect(polling.liveCount()).toBe(0);
  polling.tick();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(node.calls("auto_pipeline_sources")).toHaveLength(calls + 1);
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
    // The poll is armed, yet elapsed delays read nothing while hidden. Each
    // read is issued synchronously from the poll, so a read would already be
    // recorded here.
    expect(polling.liveCount()).toBe(1);
    polling.tick();
    polling.tick();
    expect(node.calls("auto_pipeline_sources")).toHaveLength(0);
    act(() => setVisibility("visible"));
    expect(await screen.findByRole("button", { name: "To pipeline" })).toBeTruthy();
    expect(node.calls("auto_pipeline_sources")).toHaveLength(1);
  } finally {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  }
});
