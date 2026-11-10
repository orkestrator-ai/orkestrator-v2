/**
 * Steering a busy Coordinator from its chat.
 *
 * The Coordinator page mounts the shared native tab with the read-only
 * coordinator policy on a `coordinator:` runtime id, so a message typed while
 * it works follows Auto-steer exactly as in an environment's agent tab: on,
 * it is steered into the running turn; off, its queued row offers Steer; and
 * when steering is refused or the provider cannot steer, the row stays queued
 * and says why.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentSessionActionOutcome,
  NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realAgentHandoff from "@/hooks/useAgentHandoff";
import { createNativeAgentSessionBackend } from "@/test/native-agent-session-backend";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { configStore } from "@/stores/configStore";
import { createSessionKey } from "@/lib/utils";
import { mockToastSuccess, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const ENV_ID = "coordinator:workspace-1:conversation-1";
const realHandoffSnapshot = { ...realAgentHandoff };
const emptyMessages: NativeMessage[] = [];
let pendingHistory: string | undefined;
let steerError: Error | undefined;
let refreshError = false;
const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };

let providerSteers = true;
let parked = false;
let running = true;
/** The durable queue the fake backend holds: enqueue adds, an applied steer drains. */
let queuedItems: Array<{ id: string; text: string }> = [];

let projectionRevision = 1;

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  return {
    platform: agent,
    environmentId: ENV_ID,
    sessionId: `${agent}-session`,
    connection: "connected",
    turn: { phase: running ? "running" : "idle" },
    ...(parked
      ? {
          recoverableDispatch: {
            requestId: "parked-1",
            status: "action-required",
            createdAt: "2026-11-04T09:00:00Z",
          },
        }
      : {}),
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
    queue: { items: [...queuedItems] },
    revision: projectionRevision++,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const configSnapshot = appCommandStore(configStore).getState().config;

const sessionProjectionMock = mock(async (input: { agent: AgentPlatform }) => {
  if (refreshError && steerNativeAgentQueuedPromptMock.mock.calls.length)
    throw new Error("Refresh unavailable");
  return projectionFor(input.agent);
});
const dispatchNativeAgentIntentMock = mock(async () => ({
  outcome: "accepted" as const,
  requestId: "unused",
}));
const enqueuePromptQueueMessageMock = mock(
  async (_queueKey: string, _environmentId: string, message: { id: string; text: string }) => {
    queuedItems.push({ id: message.id, text: message.text });
    return {};
  },
);
let steerOutcome: NativeAgentSessionActionOutcome | null = { outcome: "applied" };
const performNativeAgentSessionActionMock = mock(async () => ({ outcome: "applied" as const }));
const steerNativeAgentQueuedPromptMock = mock(async (input: { messageId: string }) => {
  if (steerError) throw steerError;
  if (steerOutcome?.outcome === "applied") {
    queuedItems = queuedItems.filter((item) => item.id !== input.messageId);
  }
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

const TAB_ID = "coordinator-conversation-1";

function draftText() {
  return appCommandStore(nativeComposeStore).getState().drafts.get(createSessionKey(ENV_ID, TAB_ID))
    ?.text;
}

function setAutoSteer(autoSteer: boolean) {
  appCommandStore(configStore).getState().updateGlobalConfig({ autoSteer });
}

/** Mount the tab the way `CoordinatorPanel` does, then send while it works. */
async function sendToWorkingCoordinator(text: string) {
  appCommandStore(nativeComposeStore)
    .getState()
    .updateDraft(createSessionKey(ENV_ID, TAB_ID), { text });
  renderInAppCommandScope(
    <AgentNativeTab
      tabId={TAB_ID}
      data={{
        platform: "claude",
        environmentId: ENV_ID,
        isLocal: true,
        sessionId: "claude-session",
      }}
      isActive
      executionPolicy="coordinator-read-only"
      coordinatorProjectId="project-1"
      coordinatorWorkspacePath="/projects/checkout"
      composerPlaceholder="What would you like to get done?"
    />,
  );
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
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

const queuedRows = () => screen.queryAllByTestId("compose-queue-item");

afterEach(() => {
  cleanup();
  steerError = undefined;
  pendingHistory = undefined;
  refreshError = false;
  steerOutcome = { outcome: "applied" };
  providerSteers = true;
  parked = false;
  running = true;
  queuedItems = [];
  resetSonnerMocks();
  appCommandStore(configStore).getState().setConfig(configSnapshot);
  steerNativeAgentQueuedPromptMock.mockClear();
  sessionProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("Coordinator chat steering", () => {
  test("Auto-steer on: the message is steered into the running turn and leaves no queued row", async () => {
    setAutoSteer(true);
    await sendToWorkingCoordinator("also check the open pull requests");

    await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
    expect(steerNativeAgentQueuedPromptMock.mock.calls[0]![0]).toMatchObject({
      environmentId: ENV_ID,
      agent: "claude",
      messageId: enqueuedId(),
    });
    await waitFor(() =>
      expect(mockToastSuccess.mock.calls.map((call) => call[0])).toContain(
        "Steered the active Claude turn",
      ),
    );
    await waitFor(() => expect(queuedRows()).toHaveLength(0));
    expect(draftText() ?? "").toBe("");
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("Auto-steer off: the message queues and its row's Steer sends it into the turn", async () => {
    setAutoSteer(false);
    await sendToWorkingCoordinator("also check the open pull requests");

    expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
    const steer = await screen.findByRole("button", {
      name: "Steer queued prompt 1 of 1: also check the open pull requests",
    });
    expect(screen.queryByTestId("compose-queue-item-note") === null).toBe(true);
    await act(async () => {
      fireEvent.click(steer);
    });
    await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
    expect(steerNativeAgentQueuedPromptMock.mock.calls[0]![0]).toMatchObject({
      environmentId: ENV_ID,
      messageId: enqueuedId(),
    });
    await waitFor(() => expect(queuedRows()).toHaveLength(0));
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("a refused auto-steer keeps the message queued and its row says why", async () => {
    setAutoSteer(true);
    steerOutcome = {
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "steer-1",
      message: "Steering is full for this turn.",
    };
    await sendToWorkingCoordinator("also check the open pull requests");

    await waitFor(() =>
      expect(screen.getByTestId("compose-queue-item-note").textContent).toBe(
        "The last steer attempt was refused because steering was full at the time. This message remains queued.",
      ),
    );
    expect(queuedRows()).toHaveLength(1);
    expect(queuedItems.map((item) => item.id)).toEqual([enqueuedId()]);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    // The turn ends and the backend's queue drain sends it as the next turn
    // (native-agent-prompt-queue-dispatcher.test.ts covers that drain for a
    // coordinator). The tab only reflects it: no second send from here.
    running = false;
    queuedItems = [];
    await publishProjection();
    await waitFor(() => expect(queuedRows()).toHaveLength(0));
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
    expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1);
  });

  test("a refused Steer from the row leaves it queued with the reason", async () => {
    setAutoSteer(false);
    steerOutcome = { outcome: "mismatch" };
    await sendToWorkingCoordinator("also check the open pull requests");

    const steer = await screen.findByRole("button", { name: /^Steer queued prompt 1 of 1/ });
    await act(async () => {
      fireEvent.click(steer);
    });
    await waitFor(() =>
      expect(screen.getByTestId("compose-queue-item-note").textContent).toBe(
        "The last steer attempt missed the active turn. This message remains queued.",
      ),
    );
    expect(queuedRows()).toHaveLength(1);
  });

  test("a provider that cannot steer queues the message with no Steer and says why", async () => {
    setAutoSteer(true);
    providerSteers = false;
    await sendToWorkingCoordinator("also check the open pull requests");

    await waitFor(() =>
      expect(screen.getByTestId("compose-queue-item-note").textContent).toBe(
        "Claude cannot be steered here, so this is sent when the turn ends.",
      ),
    );
    expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
    expect(steerNativeAgentQueuedPromptMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    running = false;
    queuedItems = [];
    await publishProjection();
    await waitFor(() => expect(queuedRows()).toHaveLength(0));
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });
});

async function publishProjection() {
  await act(async () => {
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(createSessionKey(ENV_ID, TAB_ID), projectionFor("claude"));
  });
}

for (const reason of [
  "steer-capacity-exceeded",
  "steer-history-unavailable",
  "steer-not-recorded",
] as const) {
  test(`Coordinator retains one copy after ${reason} without provider text`, async () => {
    setAutoSteer(true);
    steerOutcome = { outcome: "rejected", reason, requestId: "r" };
    await sendToWorkingCoordinator("check pull requests");
    await waitFor(() =>
      expect(screen.getByTestId("compose-queue-item-note").textContent).toContain("remains queued"),
    );
    expect(queuedItems).toHaveLength(1);
    expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^Steer queued prompt/ })).toBeTruthy();
    running = false;
    await publishProjection();
    await waitFor(() =>
      expect(screen.queryByTestId("compose-queue-item-note") === null).toBe(true),
    );
    running = true;
    await publishProjection();
    await waitFor(() =>
      expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
        "last steer attempt",
      ),
    );
  });
}

test("recovery guidance wins while parked and disappears once recovery clears, including dialog metadata", async () => {
  setAutoSteer(false);
  await sendToWorkingCoordinator("check pull requests");
  parked = true;
  providerSteers = false;
  await publishProjection();
  await waitFor(() =>
    expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
      "recovery controls",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "View queued prompts (1)" }));
  expect(screen.getByRole("dialog").textContent).toContain("recovery controls");
  parked = false;
  providerSteers = true;
  await publishProjection();
  await waitFor(() =>
    expect(screen.getByRole("dialog").textContent).not.toContain("recovery controls"),
  );
});

for (const outcome of ["rejected", "applied"] as const) {
  test(`a ${outcome} steer retains its outcome when projection refresh fails`, async () => {
    setAutoSteer(true);
    refreshError = true;
    steerOutcome =
      outcome === "applied"
        ? { outcome }
        : { outcome, reason: "steer-not-recorded", requestId: "r" };
    await sendToWorkingCoordinator("check pull requests");
    if (outcome === "rejected") {
      // A failed session-state read withdraws the queue's authority, so the
      // row (and its note) waits for the next good read; the refusal itself
      // must survive the failure.
      await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
      expect(queuedItems).toHaveLength(1);
    } else {
      await waitFor(() =>
        expect(mockToastSuccess.mock.calls.map((call) => call[0])).toContain(
          "Steered the active Claude turn",
        ),
      );
      expect(queuedItems).toHaveLength(0);
    }
    refreshError = false;
    await publishProjection();
    await waitFor(() => expect(queuedRows()).toHaveLength(outcome === "applied" ? 0 : 1));
    if (outcome === "rejected") {
      await waitFor(() =>
        expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
          "could not be recorded",
        ),
      );
    }
    expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
  });
}

test("a transport error retains the durable queued copy", async () => {
  setAutoSteer(true);
  steerError = new Error("Steer unavailable");
  await sendToWorkingCoordinator("check pull requests");
  await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
  expect(queuedItems).toHaveLength(1);
  expect(queuedRows()).toHaveLength(1);
  expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
});

test("a retained refusal yields to the new turn's provider gate after an earlier row drains", async () => {
  setAutoSteer(true);
  steerOutcome = { outcome: "rejected", reason: "steer-capacity-exceeded", requestId: "r" };
  await sendToWorkingCoordinator("retained message");
  await waitFor(() =>
    expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
      "last steer attempt",
    ),
  );
  const retained = queuedItems[0]!;
  running = false;
  queuedItems = [{ id: "earlier", text: "earlier message" }, retained];
  await publishProjection();
  expect(screen.queryAllByTestId("compose-queue-item-note")).toHaveLength(0);
  // The backend sends the earlier row as the next turn; this row still waits.
  queuedItems = [retained];
  running = true;
  providerSteers = false;
  await publishProjection();
  await waitFor(() =>
    expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
      "cannot be steered",
    ),
  );
  expect(screen.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
  expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1);
  expect(queuedItems).toEqual([retained]);
});

test("a successful retry clears the prior refusal for the same queue id", async () => {
  setAutoSteer(true);
  steerOutcome = { outcome: "mismatch" };
  await sendToWorkingCoordinator("retry this message");
  await waitFor(() =>
    expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
      "missed the active turn",
    ),
  );
  const retained = queuedItems[0]!;
  steerOutcome = { outcome: "applied" };
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Steer queued prompt/ }));
  });
  await waitFor(() => expect(queuedRows()).toHaveLength(0));
  // Re-publish that id to expose any stale client history after success.
  queuedItems = [retained];
  await publishProjection();
  await waitFor(() => expect(queuedRows()).toHaveLength(1));
  expect(screen.queryByTestId("compose-queue-item-note") === null).toBe(true);
});

test("a later applied auto-steer clears history for the same id", async () => {
  setAutoSteer(true);
  steerOutcome = { outcome: "mismatch" };
  await sendToWorkingCoordinator("first attempt");
  await waitFor(() =>
    expect(screen.getByTestId("compose-queue-item-note").textContent).toContain(
      "missed the active turn",
    ),
  );
  const retained = queuedItems[0]!;
  queuedItems = [];
  await publishProjection();
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(
    retained.id as ReturnType<typeof crypto.randomUUID>,
  );
  try {
    steerOutcome = { outcome: "applied" };
    await act(async () => {
      appCommandStore(nativeComposeStore)
        .getState()
        .updateDraft(createSessionKey(ENV_ID, TAB_ID), { text: "retry" });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    });
    await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queuedRows()).toHaveLength(0));
    queuedItems = [retained];
    await publishProjection();
    await waitFor(() => expect(queuedRows()).toHaveLength(1));
    expect(screen.queryByTestId("compose-queue-item-note") === null).toBe(true);
  } finally {
    uuid.mockRestore();
  }
});
