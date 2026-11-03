/**
 * Auto-steer on the shared native tab (Settings → General → Auto-steer).
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline). With the setting on, a plain message sent while a turn runs is
 * queued and then steered out of the queue; with it off, it only queues.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NativeAgentSessionActionOutcome,
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useConfigStore } from "@/stores/configStore";
import { createSessionKey } from "@/lib/utils";
import {
  mockToastInfo,
  mockToastSuccess,
  resetSonnerMocks,
} from "../../../../../tests/mocks/sonner";

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
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const configSnapshot = useConfigStore.getState().config;

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
  projectionFor(input.agent),
);
const dispatchNativeAgentIntentMock = mock(async () => ({
  outcome: "accepted" as const,
  requestId: "unused",
}));
const enqueuePromptQueueMessageMock = mock(async () => ({}));
let steerOutcome: NativeAgentSessionActionOutcome | null = { outcome: "applied" };
const performNativeAgentSessionActionMock = mock(async () => ({ outcome: "applied" as const }));
const steerNativeAgentQueuedPromptMock = mock(
  async (_input: { messageId: string }) => steerOutcome,
);

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
  useConfigStore.getState().updateGlobalConfig({ autoSteer });
}

async function sendWhileRunning(tabId: string, text: string) {
  useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), { text });
  render(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.keyDown(input, { key: "Enter" });
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
  useEnvironmentStore.setState({
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
  steerOutcome = { outcome: "applied" };
  providerSteers = true;
  resetSonnerMocks();
  useConfigStore.getState().setConfig(configSnapshot);
  steerNativeAgentQueuedPromptMock.mockClear();
  getNativeAgentProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  useEnvironmentStore.setState({ environments: [] });
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
        "Steering is full for this turn. Your message was queued instead.",
      ),
    );
    expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("on: a provider that cannot steer still only queues", async () => {
    setAutoSteer(true);
    providerSteers = false;
    await sendWhileRunning("tab-auto-steer-unsupported", "also update the docs");

    expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });
});
