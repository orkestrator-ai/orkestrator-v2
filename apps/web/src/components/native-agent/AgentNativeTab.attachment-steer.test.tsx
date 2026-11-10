/**
 * Steering messages that carry attachments, on the shared native tab.
 *
 * Steering carries text only. A message's files are already saved in the
 * workspace and its text names them in a marked path-reference block, so a
 * message whose every attachment is named there can still be steered: the
 * agent opens each file from its path. These cover the queue row, auto-steer,
 * `/steer`, and editing a queued message with attachments.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import type {
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { createNativeAgentSessionBackend } from "@/test/native-agent-session-backend";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { configStore } from "@/stores/configStore";
import { createSessionKey } from "@/lib/utils";
import { resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };

const shotPath = "/workspace/.orkestrator/attachments/a/shot.png";
const shot = { type: "image" as const, path: shotPath, filename: "shot.png" };
const BLOCK_OPEN = "<orkestrator-attachment-paths";
const referenced = {
  id: "queued-shot",
  text: buildInitialPromptWithAttachmentReferences("Compare against this screenshot", [
    { name: "shot.png", path: shotPath },
  ]),
  attachments: [shot],
};
const unreferenced = {
  id: "queued-bare",
  text: "Read this file",
  attachments: [{ type: "file" as const, path: "/workspace/notes.md", filename: "notes.md" }],
};

let queueItems: unknown[] = [];
let running = true;
let deliveredMessages: NativeMessage[] = [];

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: running ? "running" : "idle" },
    messages: deliveredMessages,
    interactions: [],
    composerControls: [],
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
      composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      actions: { steer: true },
    },
    queue: { items: queueItems },
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const configSnapshot = appCommandStore(configStore).getState().config;

const sessionProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
  projectionFor(input.agent),
);
const dispatchNativeAgentIntentMock = mock(async () => ({
  outcome: "accepted" as const,
  requestId: "unused",
}));
const enqueuePromptQueueMessageMock = mock(
  async (_queueKey: string, _environmentId: string, _item: { id: string; text: string }) => ({}),
);
const removePromptQueueMessageMock = mock(
  async (_queueKey: string, _environmentId: string, messageId: string) => {
    queueItems = queueItems.filter((item) => (item as { id: string }).id !== messageId);
    return {};
  },
);
const performNativeAgentSessionActionMock = mock(
  async (_input: { action: { kind: string; text?: string } }) => ({ outcome: "applied" as const }),
);
const steerNativeAgentQueuedPromptMock = mock(async (input: { messageId: string }) => {
  const item = queueItems.find((item) => (item as { id: string }).id === input.messageId) as
    typeof referenced | undefined;
  if (item) {
    // Fake the provider's persisted text-only steer echo, without structured files.
    deliveredMessages = [
      ...deliveredMessages,
      {
        id: `steered-${item.id}`,
        role: "user",
        content: item.text,
        parts: [{ type: "text", content: item.text }],
        createdAt: "2026-11-09T12:00:00Z",
      },
    ];
    queueItems = queueItems.filter((queued) => queued !== item);
  }
  return { outcome: "applied" as const };
});

mock.module("@/hooks/useNativeComposeBarPaste", () => ({
  useNativeComposeBarPaste: () => {},
}));
// The session as the fake backend holds it; every progressive read answers from it.
const sessionBackend = createNativeAgentSessionBackend({
  readProjection: (input) => sessionProjectionMock(input),
});
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
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  renameEnvironmentFromPrompt: async () => {},
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
  ...sessionBackend.api,
  getComposeDraft: async () => null,
  saveComposeDraft: async (
    draftKey: string,
    ownerType: string,
    ownerId: string,
    value: unknown,
  ) => ({ draftKey, ownerType, ownerId, value, updatedAt: "", revision: 1 }),
  deleteComposeDraft: async () => {},
  performNativeAgentSessionAction: performNativeAgentSessionActionMock,
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
  removePromptQueueMessage: removePromptQueueMessageMock,
  steerNativeAgentQueuedPrompt: steerNativeAgentQueuedPromptMock,
  refreshNativeAgentCommands: async (input: { agent: AgentPlatform }) => ({
    outcome: "reread" as const,
    projection: projectionFor(input.agent),
  }),
}));
mock.module("@/lib/pane-layout-persistence", () => ({
  ...realPaneLayoutPersistenceSnapshot,
  flushPaneLayoutNow: async () => {},
}));

// Happy DOM has no viewport measurements. Only replace virtualization: the
// controller's renderMessage still renders the real NativeMessage component.
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  VirtualizedMessageList: (props: {
    messages: NativeMessage[];
    renderMessage: (
      index: number,
      message: NativeMessage,
      previous: NativeMessage | null,
    ) => ReactNode;
    header?: ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      {props.header}
      {props.messages.map((message, index) => (
        <div key={message.id}>
          {props.renderMessage(index, message, props.messages[index - 1] ?? null)}
        </div>
      ))}
      {props.footer}
    </div>
  ),
}));

const { AgentNativeTab } = await import("./AgentNativeTab");

afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/pane-layout-persistence", () => realPaneLayoutPersistenceSnapshot);
  mock.module("@/hooks/useNativeComposeBarPaste", () => realNativeComposeBarPasteSnapshot);
});

function identity(platform: NativeAgentTabData["platform"]): NativeAgentTabData {
  return {
    platform,
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: `${platform}-session`,
    isLocal: false,
  };
}

function draft(tabId: string) {
  return appCommandStore(nativeComposeStore)
    .getState()
    .drafts.get(createSessionKey("env-1", tabId));
}

function setDraft(tabId: string, value: Record<string, unknown>) {
  appCommandStore(nativeComposeStore)
    .getState()
    .updateDraft(createSessionKey("env-1", tabId), value as never);
}

async function renderTab(tabId: string, platform: AgentPlatform = "cursor") {
  renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity(platform)} isActive />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return input;
}

function queueRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-queued-prompt-id="${id}"]`);
  if (!row) throw new Error(`No queue row ${id}`);
  return row;
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
  queueItems = [];
  running = true;
  deliveredMessages = [];
  resetSonnerMocks();
  appCommandStore(configStore).getState().setConfig(configSnapshot);
  sessionProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  removePromptQueueMessageMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  steerNativeAgentQueuedPromptMock.mockClear();
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("queued row with attachments", () => {
  for (const platform of ["claude", "codex", "pi", "cursor"] as const) {
    test(`${platform}: a path-referenced attachment offers Steer and steers the item`, async () => {
      queueItems = [referenced];
      await renderTab(`tab-row-${platform}`, platform);

      const row = queueRow(referenced.id);
      expect(row.textContent).toContain("Compare against this screenshot");
      expect(row.textContent).not.toContain(BLOCK_OPEN);
      expect(row.textContent).not.toContain(shotPath);
      expect(within(row).getByTestId("compose-queue-item-attachments").textContent).toBe(
        "shot.png",
      );
      expect(within(row).getByTestId("compose-queue-item-note").textContent).toBe(
        "Steering sends the attachment as a workspace file path.",
      );

      await act(async () => {
        fireEvent.click(within(row).getByRole("button", { name: /^Steer queued prompt/ }));
      });
      await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
      expect(steerNativeAgentQueuedPromptMock.mock.calls[0]![0]).toMatchObject({
        messageId: referenced.id,
      });
    });
  }

  test("an attachment the text does not name keeps the text-only note and no Steer", async () => {
    queueItems = [unreferenced];
    await renderTab("tab-row-bare");

    const row = queueRow(unreferenced.id);
    expect(within(row).queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    expect(within(row).getByTestId("compose-queue-item-note").textContent).toBe(
      "Steering carries text only, so this is sent with its attachments when the turn ends.",
    );
    expect(within(row).getByTestId("compose-queue-item-attachments").textContent).toBe("notes.md");
  });

  test("commands with named attachments are still refused", async () => {
    queueItems = [{ ...referenced, id: "queued-command", command: { kind: "typed" } }];
    await renderTab("tab-row-command");

    const row = queueRow("queued-command");
    expect(within(row).queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    expect(within(row).getByTestId("compose-queue-item-note").textContent).toContain("Commands");
  });
});

test("auto-steer steers a message whose attachments are named by path", async () => {
  appCommandStore(configStore).getState().updateGlobalConfig({ autoSteer: true });
  const tabId = "tab-auto-steer-attachment";
  setDraft(tabId, {
    text: "Compare against this screenshot",
    attachments: [{ id: "file-1", type: "image", path: shotPath, name: "shot.png" }],
  });
  const input = await renderTab(tabId);
  expect(screen.getByTitle("Steer the current Cursor Agent turn")).toBeTruthy();
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });

  await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
  const [, , queued] = enqueuePromptQueueMessageMock.mock.calls[0]!;
  expect(queued.text).toBe(referenced.text);
  expect(steerNativeAgentQueuedPromptMock.mock.calls[0]![0]).toMatchObject({
    messageId: queued.id,
  });
  expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
});

test("/steer carries an attachment as its path-reference block", async () => {
  const tabId = "tab-steer-command-attachment";
  setDraft(tabId, {
    text: "/steer Compare against this screenshot",
    attachments: [{ id: "file-1", type: "image", path: shotPath, name: "shot.png" }],
  });
  const input = await renderTab(tabId);
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });

  await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
  expect(performNativeAgentSessionActionMock.mock.calls[0]![0]).toMatchObject({
    action: { kind: "steer", text: referenced.text },
  });
  expect(screen.queryByText(/supports text only/) === null).toBe(true);
  await waitFor(() => expect(draft(tabId)?.attachments ?? []).toEqual([]));
  expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
});

test("editing a queued message with attachments and sending it again keeps one path block", async () => {
  queueItems = [referenced];
  const tabId = "tab-edit-round-trip";
  const input = await renderTab(tabId);

  await act(async () => {
    fireEvent.click(
      within(queueRow(referenced.id)).getByRole("button", { name: /^Edit queued prompt/ }),
    );
  });
  await waitFor(() => expect(removePromptQueueMessageMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(draft(tabId)?.text).toBe("Compare against this screenshot"));
  expect(draft(tabId)?.attachments).toMatchObject([
    { type: "image", path: shotPath, name: "shot.png" },
  ]);

  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1));
  const [, , queued] = enqueuePromptQueueMessageMock.mock.calls[0]!;
  expect(queued.text).toBe(referenced.text);
  expect(queued.text.split(BLOCK_OPEN).length - 1).toBe(1);
});

test("a successful path-only steer renders its attachment live and from a fresh snapshot", async () => {
  queueItems = [referenced];
  const tabId = "tab-steer-transcript";
  await renderTab(tabId);
  await act(async () => {
    fireEvent.click(
      within(queueRow(referenced.id)).getByRole("button", { name: /^Steer queued prompt/ }),
    );
  });
  const assertTranscript = async () => {
    await screen.findByText("Compare against this screenshot");
    await screen.findByRole("button", { name: /^Open full image: shot.png/ });
    expect(document.querySelector('[data-queued-prompt-id="queued-shot"]') === null).toBe(true);
    expect(document.body.textContent).not.toContain(BLOCK_OPEN);
    expect(document.body.textContent).not.toContain(shotPath);
  };
  await assertTranscript();
  expect(deliveredMessages).toHaveLength(1);
  expect(deliveredMessages[0]!.parts).toEqual([{ type: "text", content: referenced.text }]);

  // Drop the mounted tree and every projection cache; only the fake backend's
  // serialized snapshot survives, as it would after a renderer reload.
  cleanup();
  deliveredMessages = JSON.parse(JSON.stringify(deliveredMessages));
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  sessionProjectionMock.mockClear();
  await renderTab(tabId);
  await assertTranscript();
  expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1);
});
