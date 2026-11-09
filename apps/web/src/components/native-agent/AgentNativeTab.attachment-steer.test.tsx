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
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import type {
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
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

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: running ? "running" : "idle" },
    messages: [],
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

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
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
const steerNativeAgentQueuedPromptMock = mock(async (_input: { messageId: string }) => ({
  outcome: "applied" as const,
}));

mock.module("@/hooks/useNativeComposeBarPaste", () => ({
  useNativeComposeBarPaste: () => {},
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
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  renameEnvironmentFromPrompt: async () => {},
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
  getNativeAgentSyncCapabilities: async () => ({ projectionSyncVersions: [] }),
  getNativeAgentProjection: getNativeAgentProjectionMock,
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

const { AgentNativeTab } = await import("./AgentNativeTab");

afterAll(() => {
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
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
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
  resetSonnerMocks();
  appCommandStore(configStore).getState().setConfig(configSnapshot);
  getNativeAgentProjectionMock.mockClear();
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
    expect(within(row).queryByRole("button", { name: /^Steer queued prompt/ })).toBeNull();
    expect(within(row).getByTestId("compose-queue-item-note").textContent).toBe(
      "Steering carries text only, so this is sent with its attachments when the turn ends.",
    );
    expect(within(row).getByTestId("compose-queue-item-attachments").textContent).toBe("notes.md");
  });

  test("commands with named attachments are still refused", async () => {
    queueItems = [{ ...referenced, id: "queued-command", command: { kind: "typed" } }];
    await renderTab("tab-row-command");

    const row = queueRow("queued-command");
    expect(within(row).queryByRole("button", { name: /^Steer queued prompt/ })).toBeNull();
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
  expect(screen.queryByText(/supports text only/)).toBeNull();
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
