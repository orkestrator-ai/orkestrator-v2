import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TabInfo } from "@/types/paneLayout";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  buildTabInitialPromptQueueMessage,
  handTabInitialPromptToBackend,
  tabInitialPromptRequestId,
} from "./tab-initial-prompt";

const initialLayoutState = usePaneLayoutStore.getState();

function seedTab(tab: TabInfo) {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        "env-1",
        {
          root: { kind: "leaf", id: "pane-1", tabs: [tab], activeTabId: tab.id },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
    activeEnvironmentId: "env-1",
  });
}

const tabPrompt = (tabId: string) =>
  usePaneLayoutStore
    .getState()
    .getAllTabs("env-1")
    .find((tab) => tab.id === tabId)?.initialPrompt;

afterEach(() => {
  usePaneLayoutStore.setState(initialLayoutState, true);
});

describe("tab initial prompt hand-off", () => {
  test("uses the request id the mounted tab sends under", () => {
    expect(tabInitialPromptRequestId("env-1", "design-agent-1")).toBe(
      "initial-prompt:env-1:design-agent-1",
    );
  });

  test("builds each provider's queue shape", () => {
    const options = {
      model: "m",
      reasoningEffort: "high",
      fastMode: true,
      attachments: [{ type: "image" as const, path: ".orkestrator/a.png", filename: "a.png" }],
    };
    expect(buildTabInitialPromptQueueMessage("claude", "id-1", "Brief", options)).toEqual({
      id: "id-1",
      requestId: "id-1",
      text: "Brief",
      attachments: [{ type: "image", path: ".orkestrator/a.png", filename: "a.png" }],
      model: "m",
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: true,
    });
    expect(buildTabInitialPromptQueueMessage("codex", "id-1", "Brief", options)).toMatchObject({
      reasoningEffort: "high",
      mode: "build",
      fastMode: true,
    });
    expect(buildTabInitialPromptQueueMessage("opencode", "id-1", "Brief", options)).toMatchObject({
      variant: "high",
      mode: "build",
    });
    expect(
      buildTabInitialPromptQueueMessage("claude", "id-1", "Brief", { mode: "plan" }),
    ).toMatchObject({ planModeEnabled: true, attachments: [] });
  });

  test("queues durably under the tab's session, then drops the renderer fallback", async () => {
    seedTab({
      id: "tab-a",
      type: "agent-native",
      nativeAgentData: { platform: "codex", environmentId: "env-1", isLocal: true },
      initialPrompt: "Brief",
    });
    const enqueue = mock(async () => ({}) as never);

    await handTabInitialPromptToBackend(
      { environmentId: "env-1", tabId: "tab-a", agent: "codex", prompt: "Brief" },
      enqueue,
    );

    expect(enqueue).toHaveBeenCalledWith(
      "codex\u0000env-env-1:tab-a",
      "env-1",
      expect.objectContaining({
        id: "initial-prompt:env-1:tab-a",
        requestId: "initial-prompt:env-1:tab-a",
        text: "Brief",
      }),
    );
    expect(tabPrompt("tab-a")).toBeUndefined();
  });

  test("keeps the renderer fallback when the queue write fails", async () => {
    seedTab({
      id: "tab-b",
      type: "agent-native",
      nativeAgentData: { platform: "claude", environmentId: "env-1", isLocal: true },
      initialPrompt: "Brief",
    });
    const enqueue = mock(async () => {
      throw new Error("backend offline");
    });

    await expect(
      handTabInitialPromptToBackend(
        { environmentId: "env-1", tabId: "tab-b", agent: "claude", prompt: "Brief" },
        enqueue,
      ),
    ).rejects.toThrow("backend offline");
    expect(tabPrompt("tab-b")).toBe("Brief");
  });
});
