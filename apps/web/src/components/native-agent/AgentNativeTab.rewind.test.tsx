/**
 * "Rewind to before this prompt" on the shared native tab: offered where the
 * platform reports `actions.rewindMessages`, confirmed, sent as the
 * `rewind-messages` session action, and the prompt's text restored.
 *
 * Kept apart from the main tab suite, which is already very large.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

function row(id: string, role: "user" | "assistant", content: string): NativeMessage {
  return {
    id,
    role,
    content,
    turnId: `turn-${id.slice(1)}`,
    parts: [{ type: "text", content }],
    createdAt: "2026-11-09T10:00:00.000Z",
  };
}

const MESSAGES = [
  row("p1", "user", "first prompt"),
  row("r1", "assistant", "first reply"),
  row("p2", "user", "second prompt"),
  row("r2", "assistant", "second reply"),
];

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: "idle" },
    messages: MESSAGES,
    interactions: [],
    composerControls: [],
    slashCommands: [],
    composer: {
      models: [{ platform: agent, id: "model-a", label: "Model A" }],
      selectedModelId: "model-a",
      fastModeEnabled: false,
      fastModeAvailable: false,
      selectedModeId: "build",
      modes: [{ id: "build", label: "Build" }],
    },
    capabilities: {
      attachments: { files: true, images: true },
      queue: true,
      resume: false,
      fork: false,
      slashCommands: true,
      backgroundTasks: false,
      composer: { provider: true, model: true, reasoning: true, speed: true, mode: false },
      actions: { rewindMessages: agent !== "claude" },
    },
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
  projectionFor(input.agent),
);
const performNativeAgentSessionActionMock = mock(async (_input: Record<string, unknown>) => ({
  outcome: "applied" as const,
}));

mock.module("@/hooks/useNativeComposeBarPaste", () => ({
  useNativeComposeBarPaste: () => {},
}));
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  // The real list renders only what is in its viewport, which a test has none of.
  VirtualizedMessageList: ({
    messages,
    renderMessage,
  }: {
    messages: NativeMessage[];
    renderMessage: (
      index: number,
      message: NativeMessage,
      previous: NativeMessage | null,
    ) => unknown;
  }) => (
    <div data-testid="transcript">
      {messages.map((message, index) => (
        <div key={message.id} data-row={message.id}>
          {renderMessage(index, message, messages[index - 1] ?? null) as never}
        </div>
      ))}
    </div>
  ),
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentModelCatalog: async () => [],
  awaitBridgeReady: async () => ({ status: "ready" as const, port: 4099, authToken: "token" }),
  adoptNativeAgentSession: async (input: Record<string, unknown>) => ({ ...input }),
  ensureNativeAgentSession: async (input: {
    agent: string;
    logicalSessionKey: string;
    environmentId: string;
  }) => ({ ...input, providerSessionId: `${input.agent}-session` }),
  listNativeAgentResumableSessions: async () => [],
  getAgentHandoff: async () => null,
  deleteAgentHandoff: async () => true,
  renameEnvironmentFromPrompt: async () => {},
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
  getNativeAgentSyncCapabilities: async () => ({ projectionSyncVersions: [] }),
  getNativeAgentProjection: getNativeAgentProjectionMock,
  performNativeAgentSessionAction: performNativeAgentSessionActionMock,
  getComposeDraft: async () => null,
  saveComposeDraft: async (
    draftKey: string,
    ownerType: string,
    ownerId: string,
    value: unknown,
  ) => ({ draftKey, ownerType, ownerId, value, updatedAt: "", revision: 1 }),
  deleteComposeDraft: async () => {},
}));
mock.module("@/lib/pane-layout-persistence", () => ({
  ...realPaneLayoutPersistenceSnapshot,
  flushPaneLayoutNow: async () => {},
}));

const { AgentNativeTab } = await import("./AgentNativeTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/pane-layout-persistence", () => realPaneLayoutPersistenceSnapshot);
  mock.module("@/hooks/useNativeComposeBarPaste", () => realNativeComposeBarPasteSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

function identity(platform: AgentPlatform): NativeAgentTabData {
  return {
    platform,
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: `${platform}-session`,
    isLocal: false,
  };
}

function draftText(tabId: string) {
  return appCommandStore(nativeComposeStore).getState().drafts.get(createSessionKey("env-1", tabId))
    ?.text;
}

async function renderTab(tabId: string, platform: AgentPlatform, text?: string) {
  if (text !== undefined) {
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", tabId), { text });
  }
  const view = renderInAppCommandScope(
    <AgentNativeTab tabId={tabId} data={identity(platform)} isActive />,
  );
  await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  appCommandStore(environmentStore).setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "Native agent test",
        order: 0,
        setupPhase: "ready",
      } as never,
    ],
  });
});

afterEach(() => {
  cleanup();
  getNativeAgentProjectionMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

const REWIND = /^Rewind .+ session to before this prompt$/;

describe("message rewind in the native tab", () => {
  test("offers rewind on each prompt, confirms, rewinds and restores the prompt", async () => {
    const tabId = "tab-codex-rewind";
    await renderTab(tabId, "codex");
    const buttons = await screen.findAllByRole("button", { name: REWIND });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);

    const dialog = await screen.findByTestId("message-rewind-dialog");
    expect(dialog.textContent).toContain("This removes this prompt and Codex's response");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));

    await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
    expect(performNativeAgentSessionActionMock.mock.calls[0]![0]).toMatchObject({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: createSessionKey("env-1", tabId),
      action: { kind: "rewind-messages", messageId: "p2" },
    });
    await waitFor(() => expect(draftText(tabId)).toBe("second prompt"));
  });

  test("Pi's confirmation says the removed turns stay reachable as a branch", async () => {
    await renderTab("tab-pi-rewind", "pi");
    fireEvent.click((await screen.findAllByRole("button", { name: REWIND }))[0]!);
    const dialog = await screen.findByTestId("message-rewind-dialog");
    expect(dialog.textContent).toContain("2 turns");
    expect(dialog.textContent).toContain("another branch");
  });

  test("a draft in the composer is kept", async () => {
    const tabId = "tab-cursor-rewind-draft";
    await renderTab(tabId, "cursor", "my newer draft");
    await screen.findByText("second prompt");
    fireEvent.click((await screen.findAllByRole("button", { name: REWIND }))[0]!);
    await screen.findByTestId("message-rewind-dialog");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("message-rewind-dialog")).toBeNull());
    expect(draftText(tabId)).toBe("my newer draft");
  });

  test("a platform that reports no rewind gets no action", async () => {
    // Claude rewinds files, not messages: it reports no `rewindMessages`.
    await renderTab("tab-no-rewind", "claude");
    await screen.findByText("second prompt");
    expect(screen.queryAllByRole("button", { name: REWIND })).toHaveLength(0);
  });
});
