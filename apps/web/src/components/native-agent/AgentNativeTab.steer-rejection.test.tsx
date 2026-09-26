/**
 * A definitive steer refusal on the shared native tab.
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline). The bridge refused the instruction before delivery, so the
 * composer shows its actionable message and keeps the text for a resend once
 * the turn finishes; nothing is queued behind the user's back.
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
import { createSessionKey } from "@/lib/utils";

const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };

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
      actions: { steer: true },
    },
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
  projectionFor(input.agent),
);
const dispatchNativeAgentIntentMock = mock(async () => ({
  outcome: "accepted" as const,
  requestId: "unused",
}));
const enqueuePromptQueueMessageMock = mock(async () => ({}));
let steerOutcome: NativeAgentSessionActionOutcome = { outcome: "applied" };
const performNativeAgentSessionActionMock = mock(
  async (_input: { agent: string; action: { kind: string } }) => steerOutcome,
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

async function steerFrom(tabId: string, text: string) {
  useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), { text });
  render(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
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

describe("AgentNativeTab steer rejection", () => {
  test("shows the bridge's refusal and keeps the steering text for a resend", async () => {
    steerOutcome = {
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "steer-1",
      message: "Steering is full for this turn. Wait for it to finish, then send again.",
    };
    const tabId = "tab-steer-rejected";
    await steerFrom(tabId, "/steer keep the diff small");

    await screen.findByText(
      "Steering is full for this turn. Wait for it to finish, then send again.",
    );
    expect(performNativeAgentSessionActionMock.mock.calls[0]![0]).toMatchObject({
      action: { kind: "steer", text: "keep the diff small" },
    });
    expect(draftText(tabId)).toBe("/steer keep the diff small");
    // A refusal is not silently converted into a queued follow-up.
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("falls back to actionable text when the refusal carries no message", async () => {
    steerOutcome = {
      outcome: "rejected",
      reason: "steer-history-unavailable",
      requestId: "steer-2",
    };
    const tabId = "tab-steer-history-unavailable";
    await steerFrom(tabId, "/steer narrow the scope");

    await screen.findByText(/Steering is unavailable for this turn/);
    expect(draftText(tabId)).toBe("/steer narrow the scope");
  });
});
