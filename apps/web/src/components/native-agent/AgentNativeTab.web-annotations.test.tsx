/**
 * Web annotation behaviour on the shared native tab.
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline). Covers the two ways web annotations reach a native chat:
 *
 * - migrated legacy browser notes (`migratedTo`) left in a compose draft are
 *   display-only links, never prompt content: they neither make a draft
 *   sendable nor block `/steer` or a slash command;
 * - annotation requests in the prompt queue keep their typed `origin` through
 *   the projection and are rendered as frozen requests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NativeAgentDispatchOutcome,
  NativeAgentSessionProjection,
  NativeAgentSlashCommand,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore, type NativeComposeDraft } from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";

const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };

const REVIEW: NativeAgentSlashCommand = {
  name: "/review",
  id: "codex:/review",
  source: "project",
  description: "Review the diff",
  executionKind: "bridge-template",
  bindingRevision: "rev-1",
  inputPolicy: { arguments: "optional", attachments: "images", busy: "queue" },
};

const MIGRATED: TranscriptAnnotation = {
  id: "legacy-note-1",
  text: "Moved to a web annotation thread",
  comment: "",
  source: "browser",
  migratedTo: "annotation-1",
};
const LIVE: TranscriptAnnotation = { id: "live-1", text: "Selected answer", comment: "" };

interface ProjectionOptions {
  phase?: NativeAgentSessionProjection["turn"]["phase"];
  actions?: NativeAgentSessionProjection["capabilities"]["actions"];
  commands?: NativeAgentSlashCommand[];
  queue?: NativeAgentSessionProjection["queue"];
}
let projectionOptions: ProjectionOptions = {};

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  const commands = projectionOptions.commands ?? [];
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: projectionOptions.phase ?? "idle" },
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
      actions: projectionOptions.actions ?? {},
    },
    ...(commands.length > 0
      ? {
          slashCommands: commands,
          slashCommandCatalogue: { status: "ready", revision: 1, enhanced: true },
        }
      : {}),
    ...(projectionOptions.queue ? { queue: projectionOptions.queue } : {}),
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
  projectionFor(input.agent),
);
const dispatchNativeAgentIntentMock = mock(
  async (
    input: Parameters<typeof realBackend.dispatchNativeAgentIntent>[0],
  ): Promise<NativeAgentDispatchOutcome> => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }),
);
const enqueuePromptQueueMessageMock = mock(
  async (_queueKey: string, _environmentId: string, _message: unknown) => ({}),
);
const removePromptQueueMessageMock = mock(
  async (_queueKey: string, _environmentId: string, _messageId: string) => ({
    removed: null,
    queue: null,
  }),
);
const performNativeAgentSessionActionMock = mock(
  async (_input: { agent: string; action: { kind: string } }) => ({ outcome: "applied" as const }),
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
  removePromptQueueMessage: removePromptQueueMessageMock,
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

function draftFor(tabId: string) {
  return useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", tabId));
}

function seedDraft(tabId: string, update: Partial<NativeComposeDraft>) {
  useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), update);
}

async function renderTab(tabId: string, platform: AgentPlatform = "codex") {
  const view = render(<AgentNativeTab tabId={tabId} data={identity(platform)} isActive />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, input };
}

beforeEach(() => {
  projectionOptions = {};
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
  getNativeAgentProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  removePromptQueueMessageMock.mockClear();
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

describe("AgentNativeTab migrated legacy annotation references", () => {
  test("a draft holding only migrated references has nothing to send", async () => {
    const tabId = "tab-migrated-only";
    seedDraft(tabId, { annotations: [MIGRATED] });
    const { input } = await renderTab(tabId);

    await waitFor(() =>
      expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(draftFor(tabId)?.annotations).toEqual([MIGRATED]);

    act(() => seedDraft(tabId, { annotations: [MIGRATED, LIVE] }));
    await waitFor(() =>
      expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  test("a migrated reference is never sent as prompt content", async () => {
    const tabId = "tab-migrated-text";
    seedDraft(tabId, { text: "Tidy the header", annotations: [MIGRATED] });
    const { input } = await renderTab(tabId);

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const sent = dispatchNativeAgentIntentMock.mock.calls[0]![0];
    expect(sent.prompt).toBe("Tidy the header");
    expect(sent.prompt).not.toContain("orkestrator_transcript_annotations");
  });

  test("/steer is not refused because of a migrated reference", async () => {
    projectionOptions = { phase: "running", actions: { steer: true } };
    const tabId = "tab-migrated-steer";
    seedDraft(tabId, { text: "/steer keep the diff small", annotations: [MIGRATED] });
    const { input } = await renderTab(tabId);

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
    expect(performNativeAgentSessionActionMock.mock.calls[0]![0]).toMatchObject({
      action: { kind: "steer", text: "keep the diff small" },
    });
    expect(screen.queryByText(/Remove transcript annotations and retry/) === null).toBe(true);
  });

  test("/steer still refuses a live transcript annotation", async () => {
    projectionOptions = { phase: "running", actions: { steer: true } };
    const tabId = "tab-live-steer";
    seedDraft(tabId, { text: "/steer keep the diff small", annotations: [MIGRATED, LIVE] });
    const { input } = await renderTab(tabId);

    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByText(/Remove transcript annotations and retry/);
    expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
  });

  test("a slash command does not count migrated references as annotations", async () => {
    projectionOptions = { commands: [REVIEW] };
    const tabId = "tab-migrated-command";
    seedDraft(tabId, {
      text: "/review src/a.ts",
      commandSelection: {
        commandId: "codex:/review",
        bindingRevision: "rev-1",
        token: "/review",
        platform: "codex",
        sessionId: "codex-session",
      },
      annotations: [MIGRATED],
    });
    const { input } = await renderTab(tabId);

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
      prompt: "/review src/a.ts",
      command: { kind: "selected", commandId: "codex:/review" },
    });
    expect(screen.queryByText(/can't include transcript annotations/) === null).toBe(true);
  });
});

describe("AgentNativeTab web annotation queue items", () => {
  test("keeps the typed origin from the projection and renders a frozen request", async () => {
    projectionOptions = {
      phase: "running",
      queue: {
        items: [
          { id: "prompt-1", text: "Ordinary follow-up" },
          {
            id: "annotation-item",
            text: "Fix the header spacing",
            origin: { kind: "web-annotation", requestId: "req-1", bodyHash: "hash-1" },
          },
        ],
      },
    };
    await renderTab("tab-queue");

    fireEvent.click(await screen.findByTitle("View queued prompts"));

    expect(await screen.findByText("Web annotation request")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open note" })).toBeTruthy();
    // Only the ordinary prompt is editable.
    expect(screen.getByRole("button", { name: "Ordinary follow-up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix the header spacing" }) === null).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove and cancel the web annotation request" }),
    );
    expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(removePromptQueueMessageMock).toHaveBeenCalledTimes(1));
    expect(removePromptQueueMessageMock.mock.calls[0]![2]).toBe("annotation-item");
  });
});
