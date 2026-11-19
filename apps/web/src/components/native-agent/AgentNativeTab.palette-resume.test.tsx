/**
 * A tab the ⌘K palette opened to resume a past conversation
 * (`native-agent-resume-requests`): it resumes through the picker's own
 * handler once the tab is saved, without opening the picker or starting a
 * conversation of its own, and offers a retry when the save failed.
 *
 * Setup is shared with the sibling suites through `AgentNativeTab.test-support`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { NativeAgentTabData } from "@orkestrator/protocol/native-agent";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { appCommandScope } from "@/lib/node-scope-slots";
import {
  parkNativeAgentResumeRequest,
  peekNativeAgentResumeRequest,
  resetNativeAgentResumeRequests,
} from "@/lib/native-agent-resume-requests";
import {
  AgentNativeTab,
  ensureNativeAgentSessionMock,
  flushPaneLayoutNowMock,
  identity,
  installAgentNativeTabFixture,
  listNativeAgentResumableSessionsMock,
  resumeNativeAgentSessionMock,
  seedEnvTab,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

afterEach(() => resetNativeAgentResumeRequests());

function freshCursorTab(tabId: string): NativeAgentTabData {
  const data: NativeAgentTabData = { ...identity("cursor") };
  delete data.sessionId;
  seedEnvTab({ id: tabId, type: "agent-native", nativeAgentData: data });
  return data;
}

describe("AgentNativeTab opened to resume a past conversation", () => {
  test("resumes the chosen conversation once the tab is saved, without the picker", async () => {
    const tabId = "tab-palette-resume";
    const data = freshCursorTab(tabId);
    let saved: (value: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      saved = resolve;
    });
    const ref = { nodeId: appCommandScope().nodeId, environmentId: "env-1", tabId };
    parkNativeAgentResumeRequest(ref, { platform: "cursor", sessionId: "past-1", ready });

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={data} isActive />);
    // The request survives an unmount while the tab is waiting for its save.
    expect(peekNativeAgentResumeRequest(ref)).not.toBeNull();
    expect(resumeNativeAgentSessionMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Resume session" }) === null).toBe(true);
    // While it waits, the tab starts no conversation of its own.
    expect(ensureNativeAgentSessionMock).not.toHaveBeenCalled();

    saved(true);
    await waitFor(() => expect(resumeNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(resumeNativeAgentSessionMock.mock.calls[0]![0]).toMatchObject({
      agent: "cursor",
      environmentId: "env-1",
      providerSessionId: "past-1",
    });
    expect(listNativeAgentResumableSessionsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Resume session" }) === null).toBe(true);
  });

  for (const rejects of [false, true]) {
    test(`retries the same conversation after the initial save ${rejects ? "rejects" : "returns false"}`, async () => {
      const tabId = "tab-palette-unsaved";
      const data = freshCursorTab(tabId);
      const ready = rejects ? Promise.reject(new Error("save failed")) : Promise.resolve(false);
      parkNativeAgentResumeRequest(
        { nodeId: appCommandScope().nodeId, environmentId: "env-1", tabId },
        { platform: "cursor", sessionId: "past-2", ready },
      );
      flushPaneLayoutNowMock.mockRejectedValueOnce(new Error("still offline"));

      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={data} isActive />);
      const retry = () => screen.findByRole("button", { name: "Retry saving tab and resume" });
      fireEvent.click(await retry());
      expect(await retry()).toBeTruthy();
      expect(resumeNativeAgentSessionMock).not.toHaveBeenCalled();

      fireEvent.click(await retry());
      await waitFor(() => expect(resumeNativeAgentSessionMock).toHaveBeenCalledTimes(1));
      expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(2);
      expect(resumeNativeAgentSessionMock.mock.calls[0]![0]).toMatchObject({
        providerSessionId: "past-2",
      });
      expect(listNativeAgentResumableSessionsMock).not.toHaveBeenCalled();
    });
  }

  test("closing the tab while its save is pending cancels the parked resume", async () => {
    const tabId = "tab-palette-closed";
    const data = freshCursorTab(tabId);
    let saved!: (value: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      saved = resolve;
    });
    const scope = appCommandScope();
    const ref = { nodeId: scope.nodeId, environmentId: "env-1", tabId };
    parkNativeAgentResumeRequest(ref, { platform: "cursor", sessionId: "past-closed", ready });
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={data} isActive />);

    const panes = scope.store(paneLayoutStore).getState();
    act(() => panes.removeTab(panes.findPaneWithTab(tabId, "env-1")!.id, tabId, "env-1"));
    await act(async () => saved(true));
    expect(peekNativeAgentResumeRequest(ref)).toBeNull();
    expect(resumeNativeAgentSessionMock).not.toHaveBeenCalled();
  });

  test("an unmounted tab resumes once when its save completes", async () => {
    const tabId = "tab-palette-hidden";
    const data = freshCursorTab(tabId);
    const ref = { nodeId: appCommandScope().nodeId, environmentId: "env-1", tabId };
    let saved!: (value: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      saved = resolve;
    });
    parkNativeAgentResumeRequest(ref, { platform: "cursor", sessionId: "past-hidden", ready });

    const view = renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={data} isActive />);
    view.unmount();
    expect(peekNativeAgentResumeRequest(ref)).not.toBeNull();
    saved(true);
    await waitFor(() => expect(resumeNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(peekNativeAgentResumeRequest(ref)).toBeNull();
  });

  test("a request for another platform is ignored", async () => {
    const tabId = "tab-palette-other";
    const data = freshCursorTab(tabId);
    parkNativeAgentResumeRequest(
      { nodeId: appCommandScope().nodeId, environmentId: "env-1", tabId },
      { platform: "codex", sessionId: "past-3", ready: Promise.resolve(true) },
    );
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={data} isActive />);
    await screen.findByRole("textbox");
    expect(resumeNativeAgentSessionMock).not.toHaveBeenCalled();
  });
});
