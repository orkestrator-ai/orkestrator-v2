/**
 * `/goal` and the goal surface on the shared native tab.
 *
 * Kept apart from the main tab suite. Everything here reads the session
 * snapshot, so these are also what a tab opened or reloaded mid-goal shows.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  renderGoalCarrier,
  type NativeAgentGoal,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import type {
  NativeAgentSessionProjection,
  NativeAgentSlashCommand,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { NativeMessage as NativeMessageRow } from "@/components/chat/NativeMessage";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";
import { mockToastSuccess } from "../../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

const SET_AT = "2026-10-31T10:00:00.000Z";
const GOAL_COMMAND: NativeAgentSlashCommand = {
  name: "/goal",
  id: "orkestrator:goal",
  source: "orkestrator",
  executionKind: "session-action",
  bindingRevision: "orkestrator:goal",
  inputPolicy: { arguments: "optional", attachments: "none" },
};

function fullGoal(overrides: Partial<NativeAgentGoal> = {}): NativeAgentGoal {
  return {
    goalId: "goal-1",
    objective: "Make the build green",
    status: "active",
    providerSessionId: "provider-1",
    iterations: 2,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: SET_AT,
    updatedAt: SET_AT,
    ...overrides,
  };
}

function goalView(overrides: Partial<NativeAgentGoalView> = {}): NativeAgentGoalView {
  return {
    goalId: "goal-1",
    objective: "Make the build green",
    status: "active",
    iterations: 2,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: SET_AT,
    updatedAt: SET_AT,
    ...overrides,
  };
}

let projectionOverrides: Partial<NativeAgentSessionProjection<NativeMessage>> = {};
let goalCapability = true;

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: "idle" },
    messages: [],
    interactions: [],
    composerControls: [],
    slashCommands: goalCapability ? [GOAL_COMMAND] : [],
    slashCommandCatalogue: { status: "ready", revision: 1, enhanced: true },
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
      actions: { steer: true, ...(goalCapability ? { goal: true } : {}) },
    },
    revision: 1,
    generation: "generation-1",
    ...projectionOverrides,
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
const runNativeAgentGoalCommandMock = mock(
  async (_input: { text: string; environmentId: string; agent: string }) =>
    ({ message: "Goal set." }) as { message: string },
);
const getNativeAgentGoalMock = mock(async () => ({ history: [] }));

mock.module("@/hooks/useNativeComposeBarPaste", () => ({
  useNativeComposeBarPaste: () => {},
}));
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  // The real list renders only what is in its viewport, which a test has none of.
  VirtualizedMessageList: ({ messages }: { messages: NativeMessage[] }) => (
    <div data-testid="transcript">
      {messages.map((message) => (
        <NativeMessageRow key={message.id} message={message} />
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
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
  runNativeAgentGoalCommand: runNativeAgentGoalCommandMock,
  getNativeAgentGoal: getNativeAgentGoalMock,
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
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

function identity(): NativeAgentTabData {
  return {
    platform: "claude",
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: "claude-session",
    isLocal: false,
  };
}

function draftText(tabId: string) {
  return useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", tabId))?.text;
}

async function renderTab(tabId: string, text?: string) {
  if (text !== undefined) {
    useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), { text });
  }
  const view = render(<AgentNativeTab tabId={tabId} data={identity()} isActive />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, input };
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
  projectionOverrides = {};
  goalCapability = true;
  getNativeAgentProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  runNativeAgentGoalCommandMock.mockReset();
  runNativeAgentGoalCommandMock.mockImplementation(async () => ({ message: "Goal set." }));
  getNativeAgentGoalMock.mockClear();
  mockToastSuccess.mockClear();
  useEnvironmentStore.setState({ environments: [] });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeComposeStore.setState({ drafts: new Map() });
  useNativeAgentProjectionStore.getState().reset();
});

describe("/goal in the composer", () => {
  test("goes straight to the backend, never through send or the queue", async () => {
    const tabId = "tab-goal-set";
    const { input } = await renderTab(tabId, "/goal ship it --check bun test");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runNativeAgentGoalCommandMock).toHaveBeenCalledTimes(1));
    expect(runNativeAgentGoalCommandMock.mock.calls[0]![0]).toMatchObject({
      environmentId: "env-1",
      agent: "claude",
      logicalSessionKey: createSessionKey("env-1", tabId),
      text: "ship it --check bun test",
      model: "model-a",
    });
    await waitFor(() => expect(draftText(tabId) ?? "").toBe(""));
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("Goal set.");
  });

  test("works while a turn is running, and still does not queue", async () => {
    projectionOverrides = { turn: { phase: "running" } as never };
    const tabId = "tab-goal-busy";
    const { input } = await renderTab(tabId, "/goal pause");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runNativeAgentGoalCommandMock).toHaveBeenCalledTimes(1));
    expect(runNativeAgentGoalCommandMock.mock.calls[0]![0].text).toBe("pause");
    await waitFor(() => expect(draftText(tabId) ?? "").toBe(""));
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("the send button runs it during a turn, and says so", async () => {
    projectionOverrides = { turn: { phase: "running" } as never };
    await renderTab("tab-goal-button", "/goal clear");
    const send = await screen.findByTitle("Run /goal now; it never queues");
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(runNativeAgentGoalCommandMock).toHaveBeenCalledTimes(1));
  });

  test("a refusal keeps the draft and shows the backend's message", async () => {
    runNativeAgentGoalCommandMock.mockImplementation(async () => {
      throw new Error("A goal is already running. Run /goal clear first to replace it.");
    });
    const tabId = "tab-goal-refused";
    const { input } = await renderTab(tabId, "/goal ship it");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("A goal is already running. Run /goal clear first to replace it.");
    expect(draftText(tabId)).toBe("/goal ship it");
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("arguments the parser refuses never reach the backend", async () => {
    const tabId = "tab-goal-bad-args";
    const { input } = await renderTab(tabId, "/goal x --max-iterations 999");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("--max-iterations can be at most 100.");
    expect(runNativeAgentGoalCommandMock).not.toHaveBeenCalled();
    expect(draftText(tabId)).toBe("/goal x --max-iterations 999");
  });

  test("with no arguments it opens the panel, with no toast and no backend call", async () => {
    const tabId = "tab-goal-panel";
    const { input } = await renderTab(tabId, "/goal");
    // Enter first takes the row from the open `/` menu, then submits.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(draftText(tabId)).toBe("/goal "));
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("dialog")).textContent).toContain("Set a goal");
    expect(runNativeAgentGoalCommandMock).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(draftText(tabId) ?? "").toBe("");
  });

  test("with the capability off it is an ordinary prompt and nothing is offered", async () => {
    goalCapability = false;
    const { input } = await renderTab("tab-goal-off", "/goal ship it");
    expect(screen.queryByTestId("goal-open-button")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(runNativeAgentGoalCommandMock).not.toHaveBeenCalled();
  });
});

describe("the goal surface", () => {
  test("no goal: a quiet button opens the form", async () => {
    await renderTab("tab-goal-none");
    expect(screen.queryByTestId("goal-pill")).toBeNull();
    fireEvent.click(screen.getByTestId("goal-open-button"));
    expect((await screen.findByRole("dialog")).textContent).toContain("Set a goal");
  });

  test("a goal in the snapshot shows the pill on first render, as after a reload", async () => {
    projectionOverrides = { goal: goalView({ status: "checking", check: "bun test" }) };
    await renderTab("tab-goal-pill");
    const pill = await screen.findByTestId("goal-pill");
    expect(pill.dataset.goalStatus).toBe("checking");
    expect(pill.textContent).toContain("2/20");
    expect(screen.queryByTestId("goal-open-button")).toBeNull();
    fireEvent.click(pill);
    expect((await screen.findByRole("dialog")).textContent).toContain("bun test");
  });

  test("warns about approvals when the session's mode will stop for them", async () => {
    projectionOverrides = {
      composer: {
        models: [{ platform: "claude", id: "model-a", label: "Model A" }],
        selectedModelId: "model-a",
        fastModeEnabled: false,
        fastModeAvailable: false,
        selectedModeId: "build",
        modes: [{ id: "build", label: "Build" }],
        selectedApprovalModeId: "default",
        approvalModes: [
          { id: "default", label: "Ask", description: "Ask first", kind: "ask" },
          { id: "bypassPermissions", label: "Bypass", description: "Never", kind: "auto-approve" },
        ],
      } as never,
    };
    await renderTab("tab-goal-warning");
    fireEvent.click(screen.getByTestId("goal-open-button"));
    const warning = await screen.findByTestId("goal-approval-warning");
    expect(warning.textContent).toContain("A goal never changes the mode.");
    expect(screen.getByTestId("goal-approval-mode-picker")).toBeTruthy();
  });

  test("the panel's actions run the command directly", async () => {
    projectionOverrides = { goal: goalView() };
    await renderTab("tab-goal-pause");
    fireEvent.click(await screen.findByTestId("goal-pill"));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(runNativeAgentGoalCommandMock.mock.calls[0]![0].text).toBe("pause"));
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
  });
});

describe("goal turns in the transcript", () => {
  const carrier = renderGoalCarrier(fullGoal());
  const row = (id: string, role: "user" | "assistant", content: string): NativeMessage => ({
    id,
    role,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-10-31T10:01:00.000Z",
  });

  test("a carrier is a tile, and only the user's words are user rows", async () => {
    const quoted = `Why does ${carrier} show up here?`;
    projectionOverrides = {
      goal: goalView(),
      messages: [row("carrier", "user", carrier), row("mine", "user", quoted)],
    };
    const { container } = await renderTab("tab-goal-transcript");
    const tiles = await waitFor(() => {
      const found = container.querySelectorAll("[data-goal-turn-tile]");
      expect(found.length).toBe(1);
      return found;
    });
    expect(tiles[0]!.textContent).toContain("Goal turn 3 of 20");
    expect(screen.getAllByText("You")).toHaveLength(1);
    expect(screen.getByTestId("transcript").textContent).toContain("Why does");
  });

  test("a queued goal turn cannot be recalled with the up arrow, edited or steered", async () => {
    projectionOverrides = {
      goal: goalView(),
      queue: {
        items: [
          { id: "goal:goal-1:3", text: carrier, requestId: "goal:goal-1:3" },
          { id: "mine", text: "my own next step" },
        ],
      } as never,
      turn: { phase: "running" } as never,
    };
    const { container, input } = await renderTab("tab-goal-queue");
    await screen.findByText("my own next step");
    expect(container.textContent).not.toContain("orkestrator-goal");
    expect(screen.getByText("1 queued")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.textContent ?? "").not.toContain("orkestrator-goal");
  });

  test("a blocked goal turn still shows its error, with nothing to recall", async () => {
    projectionOverrides = {
      goal: goalView(),
      queue: {
        items: [{ id: "goal:goal-1:3", text: carrier }],
        blocked: { error: "The provider refused the prompt." },
      } as never,
    };
    const { container } = await renderTab("tab-goal-blocked");
    await screen.findByText(/The provider refused the prompt/);
    expect(container.textContent).not.toContain("orkestrator-goal");
  });

  test("a suggestion that echoes a goal turn is not offered back", async () => {
    projectionOverrides = { suggestedPrompt: carrier, messages: [row("a", "assistant", "done")] };
    const { container } = await renderTab("tab-goal-suggestion");
    await waitFor(() => expect(screen.getByTestId("transcript").textContent).toContain("done"));
    expect(container.textContent).not.toContain("Suggested:");
  });
});
