/**
 * A tab the ⌘K palette opened to resume a past conversation
 * (`native-agent-resume-requests`): it resumes through the picker's own
 * handler once the tab is saved, without opening the picker or starting a
 * conversation of its own, and offers the picker when the save failed.
 *
 * Setup is shared with the sibling suites through `AgentNativeTab.test-support`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import type { NativeAgentTabData } from "@orkestrator/protocol/native-agent";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import {
  parkNativeAgentResumeRequest,
  peekNativeAgentResumeRequest,
  resetNativeAgentResumeRequests,
} from "@/lib/native-agent-resume-requests";
import {
  AgentNativeTab,
  ensureNativeAgentSessionMock,
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
    // The request is consumed once read, and nothing runs before the save.
    await waitFor(() => expect(peekNativeAgentResumeRequest(ref)).toBeNull());
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

  test("offers the picker when the tab could not be saved", async () => {
    const tabId = "tab-palette-unsaved";
    const data = freshCursorTab(tabId);
    parkNativeAgentResumeRequest(
      { nodeId: appCommandScope().nodeId, environmentId: "env-1", tabId },
      { platform: "cursor", sessionId: "past-2", ready: Promise.resolve(false) },
    );

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={data} isActive />);
    expect(await screen.findByRole("dialog", { name: "Resume session" })).toBeTruthy();
    expect(resumeNativeAgentSessionMock).not.toHaveBeenCalled();
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
