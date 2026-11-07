/**
 * Auto-steer on the shared native tab (Settings → General → Auto-steer).
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline). With the setting on, a plain message sent while a turn runs is
 * queued and then steered out of the queue; with it off, it only queues.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentSessionActionOutcome,
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realAgentHandoff from "@/hooks/useAgentHandoff";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { environmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { configStore } from "@/stores/configStore";
import { createSessionKey } from "@/lib/utils";
import {
  mockToastInfo,
  mockToastSuccess,
  resetSonnerMocks,
} from "../../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const realHandoffSnapshot = { ...realAgentHandoff };
const emptyMessages: NativeMessage[] = [];
let pendingHistory: string | undefined;
let steerError: Error | undefined;
let refreshError = false;
const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };

let providerSteers = true;

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: "running" },
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
      actions: { steer: providerSteers },
    },
    slashCommandCatalogue: { status: "ready", revision: 1, enhanced: true },
    slashCommands: [
      {
        name: "/review",
        id: "cursor:review",
        source: "project",
        executionKind: "bridge-template",
        bindingRevision: "v1",
      },
      {
        name: "$deploy",
        id: "cursor:deploy",
        source: "skill",
        executionKind: "structured-skill",
        bindingRevision: "v1",
      },
    ],
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const configSnapshot = appCommandStore(configStore).getState().config;

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) => {
  if (refreshError && steerNativeAgentQueuedPromptMock.mock.calls.length)
    throw new Error("Refresh unavailable");
  return projectionFor(input.agent);
});
const dispatchNativeAgentIntentMock = mock(async () => ({
  outcome: "accepted" as const,
  requestId: "unused",
}));
const enqueuePromptQueueMessageMock = mock(async () => ({}));
let steerOutcome: NativeAgentSessionActionOutcome | null = { outcome: "applied" };
const performNativeAgentSessionActionMock = mock(async () => ({ outcome: "applied" as const }));
const steerNativeAgentQueuedPromptMock = mock(async (_input: { messageId: string }) => {
  if (steerError) throw steerError;
  return steerOutcome;
});

mock.module("@/hooks/useAgentHandoff", () => ({
  ...realHandoffSnapshot,
  useAgentHandoff: () => ({
    ready: true,
    pendingHistory,
    displayMessages: emptyMessages,
    backendDelivers: true,
  }),
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
  mock.module("@/hooks/useAgentHandoff", () => realHandoffSnapshot);
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

function draftText(tabId: string) {
  return useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", tabId))?.text;
}

function setAutoSteer(autoSteer: boolean) {
  appCommandStore(configStore).getState().updateGlobalConfig({ autoSteer });
}

async function sendWhileRunning(tabId: string, text: string) {
  useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), { text });
  renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1));
}

function enqueuedId(): string {
  const calls = enqueuePromptQueueMessageMock.mock.calls as unknown as Array<
    [string, string, { id: string; text: string }]
  >;
  return calls[0]![2].id;
}

function enqueuedText(): string {
  const calls = enqueuePromptQueueMessageMock.mock.calls as unknown as Array<
    [string, string, { id: string; text: string }]
  >;
  return calls[0]![2].text;
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
  steerError = undefined;
  pendingHistory = undefined;
  refreshError = false;
  steerOutcome = { outcome: "applied" };
  providerSteers = true;
  resetSonnerMocks();
  appCommandStore(configStore).getState().setConfig(configSnapshot);
  steerNativeAgentQueuedPromptMock.mockClear();
  getNativeAgentProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  appCommandStore(environmentStore).setState({ environments: [] });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeComposeStore.setState({ drafts: new Map() });
  useNativeAgentProjectionStore.getState().reset();
});

describe("AgentNativeTab auto-steer", () => {
  test("off: a message sent during a turn is only queued", async () => {
    setAutoSteer(false);
    const tabId = "tab-auto-steer-off";
    await sendWhileRunning(tabId, "also update the docs");

    expect(enqueuedText()).toBe("also update the docs");
    await waitFor(() => expect(draftText(tabId) ?? "").toBe(""));
    expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
    expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("on: the queued message is steered into the running turn", async () => {
    setAutoSteer(true);
    const tabId = "tab-auto-steer-on";
    await sendWhileRunning(tabId, "also update the docs");

    await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
    expect(steerNativeAgentQueuedPromptMock.mock.calls[0]![0]).toMatchObject({
      messageId: enqueuedId(),
    });
    await waitFor(() =>
      expect(mockToastSuccess.mock.calls.map((call) => call[0])).toContain(
        "Steered the active Cursor Agent turn",
      ),
    );
    expect(draftText(tabId) ?? "").toBe("");
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("on: a refused steer leaves the message queued and says so", async () => {
    setAutoSteer(true);
    steerOutcome = {
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "steer-1",
      message: "Steering is full for this turn.",
    };
    await sendWhileRunning("tab-auto-steer-refused", "also update the docs");

    await waitFor(() =>
      expect(mockToastInfo.mock.calls.map((call) => call[0])).toContain(
        "The last steer attempt was refused because steering was full at the time. Your message remains queued.",
      ),
    );
    expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("on: a provider that cannot steer still only queues", async () => {
    setAutoSteer(true);
    providerSteers = false;
    await sendWhileRunning("tab-auto-steer-unsupported", "also update the docs");

    await waitFor(() => expect(draftText("tab-auto-steer-unsupported") ?? "").toBe(""));
    expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });
});

for (const outcome of ["thrown", "unknown", "null", "refresh-failed"] as const) {
  test(`auto-steer ${outcome} keeps delivery ownership and releases the composer`, async () => {
    setAutoSteer(true);
    if (outcome === "thrown") steerError = new Error("Transport unavailable");
    if (outcome === "unknown") steerOutcome = { outcome: "unknown", requestId: "steer-1" };
    if (outcome === "null") steerOutcome = null;
    if (outcome === "refresh-failed") refreshError = true;
    const tabId = `tab-${outcome}`;
    await sendWhileRunning(tabId, "also update the docs");
    await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(draftText(tabId) ?? "").toBe("");
    expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    if (outcome === "thrown")
      expect(mockToastInfo.mock.calls[0]?.[0]).toContain("saved to the queue");
    if (outcome === "null")
      expect(mockToastInfo.mock.calls[0]?.[0]).toContain("sent as the next turn");
    if (outcome === "unknown") {
      expect(mockToastInfo).not.toHaveBeenCalled();
      expect(mockToastSuccess).not.toHaveBeenCalled();
    }
    if (outcome === "refresh-failed")
      expect(mockToastSuccess.mock.calls[0]?.[0]).toBe("Steered the active Cursor Agent turn");
    refreshError = false;
    const input = screen.getByRole("textbox");
    await act(async () => {
      useNativeComposeStore
        .getState()
        .updateDraft(createSessionKey("env-1", tabId), { text: "a separate follow-up" });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(2));
  });
}

test("pending handoff only queues", async () => {
  setAutoSteer(true);
  pendingHistory = "Transferred context";
  await sendWhileRunning("tab-handoff", "continue this work");
  await waitFor(() => expect(draftText("tab-handoff") ?? "").toBe(""));
  expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
});

test.each(["$deploy now", "/review changes"])(
  "command %s does not promise auto-steering",
  async (text) => {
    setAutoSteer(true);
    useNativeComposeStore
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-command"), { text });
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-command" data={identity("cursor")} isActive />,
    );
    await screen.findByRole("textbox");
    await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTitle("Steer the current Cursor Agent turn") === null).toBe(true);
    expect(screen.getByTitle("Add to queue")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    });
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1));
    expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
  },
);

test("attachments only queue", async () => {
  setAutoSteer(true);
  const tabId = "tab-attachment";
  useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), {
    attachments: [{ id: "file-1", type: "image", path: "/workspace/image.png", name: "image.png" }],
  });
  await sendWhileRunning(tabId, "read this file");
  await waitFor(() => expect(draftText(tabId) ?? "").toBe(""));
  expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
  expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
});

test("a prepared initial prompt waits for idle without auto-steering", async () => {
  setAutoSteer(true);
  renderInAppCommandScope(
    <AgentNativeTab
      tabId="tab-prepared"
      data={identity("cursor")}
      initialPrompt="Review this work"
      isActive
    />,
  );
  await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
  expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
  expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
});

test("an unknown auto-steer rehydrates backend recovery without restoring or resending the draft", async () => {
  setAutoSteer(true);
  steerOutcome = { outcome: "unknown", requestId: "steer-1" };
  const tabId = "tab-unknown-recovery";
  await sendWhileRunning(tabId, "also update the docs");
  await waitFor(() => expect(draftText(tabId) ?? "").toBe(""));
  const sessionKey = createSessionKey("env-1", tabId);
  const current = useNativeAgentProjectionStore.getState().projections.get(sessionKey)!;
  await act(async () => {
    useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
      ...current,
      revision: current.revision + 1,
      recoverableDispatch: {
        requestId: "steer-1",
        kind: "steer",
        createdAt: "2026-11-03T12:00:00Z",
      },
    });
  });
  expect(await screen.findByRole("button", { name: "Retry steer" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  expect(mockToastSuccess).not.toHaveBeenCalled();
  expect(mockToastInfo).not.toHaveBeenCalled();
  expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
  expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1);
  expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  expect(draftText(tabId) ?? "").toBe("");
});
