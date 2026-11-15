/**
 * The first prompt's pending view on an unassigned native tab: the sent
 * message and the step being waited on, from send until the backend answers,
 * through a failed save and its retry, and when the tab cannot be locked.
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline). Setup is shared through `AgentNativeTab.test-support`.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { createSessionKey } from "@/lib/utils";
import { appCommandStore } from "@/test/app-command-store";
import {
  dispatchNativeAgentIntentMock,
  flushPaneLayoutNowMock,
  installAgentNativeTabFixture,
  PaneBackedAgentNativeTab,
  seedUnassignedDefaultCatalog,
  seedUnassignedPane,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Dispatch waits on the returned gate, then accepts. */
function gateDispatch() {
  const dispatch = gate();
  dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
    await dispatch.promise;
    return { outcome: "accepted", requestId: input.requestId };
  });
  return dispatch;
}

async function sendFirstPrompt(text: string) {
  const input = await screen.findByRole("textbox");
  fireEvent.input(input, { target: { textContent: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

const pendingStatus = () =>
  within(screen.getByTestId("first-prompt-pending")).getByRole("status").textContent;
const pendingViewGone = () => screen.queryByTestId("first-prompt-pending") === null;

describe("AgentNativeTab first-prompt pending view", () => {
  test("shows the sent message and who the wait is on while the first dispatch is pending", async () => {
    seedUnassignedDefaultCatalog();
    const save = gate();
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      await save.promise;
    });
    const dispatch = gateDispatch();
    const tabId = "tab-first-prompt-pending-view";
    seedUnassignedPane(tabId);
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await sendFirstPrompt("Please look at the failing build");

    // The prompt is on screen as a sent message, not a bare centred label.
    const pending = await screen.findByTestId("first-prompt-pending");
    expect(pending.textContent).toContain("Please look at the failing build");
    // While the tab is being saved, the wait is Orkestrator's.
    expect(pendingStatus()).toBe("Saving your tab…");
    expect(screen.getByTestId("first-prompt-pending-detail").textContent).toContain(
      "recording your agent choice",
    );

    save.release();
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    // Once the tab is saved, the wait is named for the agent being started.
    await waitFor(() => expect(pendingStatus()).toMatch(/^Starting .+…$/));
    expect(screen.getByTestId("first-prompt-pending-detail").textContent).toContain(
      "Your tab is saved",
    );

    dispatch.release();
    await waitFor(() => expect(pendingViewGone()).toBe(true));
  });

  test("Retry save after a failed save shows the same message again through saving and starting", async () => {
    seedUnassignedDefaultCatalog();
    const tabId = "tab-first-prompt-retry-view";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      throw new Error("temporary save failure");
    });
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await sendFirstPrompt("Retry keeps this message");

    expect(
      await screen.findByText("The agent choice is locked, but could not be saved."),
    ).toBeTruthy();
    expect(pendingViewGone()).toBe(true);
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(0);

    const retrySave = gate();
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      await retrySave.promise;
    });
    const dispatch = gateDispatch();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    // The retained prompt is shown again, starting from the save step.
    const pending = await screen.findByTestId("first-prompt-pending");
    expect(pending.textContent).toContain("Retry keeps this message");
    expect(pendingStatus()).toBe("Saving your tab…");

    retrySave.release();
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Retry keeps this message",
    });
    // Not the generic label: the slow agent start is named and the message stays.
    await waitFor(() => expect(pendingStatus()).toMatch(/^Starting .+…$/));
    expect(screen.queryByText("Saving agent choice…") === null).toBe(true);
    expect(screen.getByTestId("first-prompt-pending").textContent).toContain(
      "Retry keeps this message",
    );

    dispatch.release();
    await waitFor(() => expect(pendingViewGone()).toBe(true));
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
  });

  test("a tab that cannot be locked drops the pending view and keeps the draft unsent", async () => {
    seedUnassignedDefaultCatalog();
    const tabId = "tab-first-prompt-lock-failure";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    const panes = appCommandStore(paneLayoutStore);
    const realLock = panes.getState().lockTabNativePlatform;
    panes.setState({ lockTabNativePlatform: () => null });
    try {
      renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
      await sendFirstPrompt("This tab will not lock");

      expect(await screen.findByText("This tab could not be locked to an agent.")).toBeTruthy();
      expect(pendingViewGone()).toBe(true);
      expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(0);
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(0);
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
      ).toBe(false);
    } finally {
      panes.setState({ lockTabNativePlatform: realLock });
    }
  });
});
