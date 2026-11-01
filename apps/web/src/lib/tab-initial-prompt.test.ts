import { afterEach, describe, expect, mock, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import { createSessionKey } from "@/lib/utils";
import { beginTabInitialPromptFallback } from "./tab-initial-prompt";
import type { TabInfo } from "@/types/paneLayout";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { handTabInitialPromptToBackend, tabInitialPromptRequestId } from "./tab-initial-prompt";

const invokeMock = invoke as unknown as Mock<(command: string, args?: unknown) => Promise<unknown>>;
const originalInvoke = invokeMock.getMockImplementation()!;
const initialComposeState = useNativeComposeStore.getState();
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
  useNativeComposeStore.setState(initialComposeState, true);
  invokeMock.mockImplementation(originalInvoke);
});

describe("tab initial prompt hand-off", () => {
  // The request id and queue shapes are covered by the protocol contract's own
  // tests (`packages/protocol/src/tab-initial-prompt.test.ts`).
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

  test("hand-off marks only live fallback attempts as backend-owned", async () => {
    const requestId = tabInitialPromptRequestId("env-1", "ownership");
    const pending = beginTabInitialPromptFallback(requestId);
    const other = beginTabInitialPromptFallback("another-request");
    try {
      await handTabInitialPromptToBackend(
        { environmentId: "env-1", tabId: "ownership", agent: "codex", prompt: "Brief" },
        mock(async () => ({}) as never),
      );
      expect(pending.backendOwned).toBe(true);
      expect(other.backendOwned).toBe(false);
    } finally {
      pending.release();
      other.release();
    }
  });

  test("cleans a failed opening fallback durably and preserves unrelated input", async () => {
    const tabId = "cleanup";
    const sessionKey = createSessionKey("env-1", tabId);
    const requestId = tabInitialPromptRequestId("env-1", tabId);
    const seeded = { id: "seeded", type: "image" as const, path: "same.png", name: "seeded.png" };
    const userImage = { ...seeded, id: "user", name: "user.png" };
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      text: "My follow-up",
      attachments: [seeded, userImage],
    });
    const saved = {
      draftKey: "cleanup",
      ownerType: "environment",
      ownerId: "env-1",
      revision: 3,
      value: {
        text: "Brief",
        mentions: [{ id: "user-mention" }],
        attachments: [seeded, userImage],
        annotations: [{ id: "keep-note" }],
        metadata: { requestId, modelId: "keep-model" },
      },
    };
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "get_compose_draft") return saved;
      if (command === "save_compose_draft") {
        const input = args as { value: typeof saved.value; expectedRevision: number };
        expect(input.expectedRevision).toBe(3);
        saved.value = input.value;
        return { ...saved, revision: 4 };
      }
      throw new Error(`Unexpected ${command}`);
    });
    await handTabInitialPromptToBackend(
      {
        environmentId: "env-1",
        tabId,
        agent: "claude",
        prompt: "Brief",
        options: { attachments: [seeded] },
      },
      mock(async () => ({}) as never),
    );
    expect(nativeComposeDraft(useNativeComposeStore.getState(), sessionKey)).toMatchObject({
      text: "My follow-up",
      attachments: [userImage],
    });
    expect(saved.value).toMatchObject({
      text: "",
      mentions: [{ id: "user-mention" }],
      attachments: [userImage],
      annotations: [{ id: "keep-note" }],
      metadata: {
        modelId: "keep-model",
        requestId: undefined,
        pendingTranscriptConfirmation: undefined,
      },
    });
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
