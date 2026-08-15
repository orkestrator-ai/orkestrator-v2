/**
 * Contract suite for the single pane-level native agent tab.
 *
 * Every provider exercises the shared authoritative-projection path.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentSessionProjection, NativeAgentTabData } from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { getNativeAgentData, type TabInfo } from "@/types/paneLayout";
import { createSessionKey } from "@/lib/utils";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { dispatchResourceChange } from "@/lib/resource-sync";

// Snapshot before installing the stubs so the real modules are restored for
// any suite that runs after this file in the same module registry.
const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const flushPaneLayoutNowMock = mock(async () => {});
const getNativeAgentModelCatalogMock = mock(
  async (_environmentId: string): ReturnType<typeof realBackend.getNativeAgentModelCatalog> => [],
);
const awaitBridgeReadyMock = mock(async () => ({
  status: "ready" as const,
  port: 4099,
  authToken: "token",
}));
const adoptNativeAgentSessionMock = mock(async (input: {
  agent: string;
  providerSessionId: string;
  logicalSessionKey: string;
  environmentId: string;
}) => ({
  providerSessionId: input.providerSessionId,
  logicalSessionKey: input.logicalSessionKey,
  environmentId: input.environmentId,
  agent: input.agent,
}));
const ensureNativeAgentSessionMock = mock(async (input: {
  agent: string;
  logicalSessionKey: string;
  environmentId: string;
}) => ({
  providerSessionId: `${input.agent}-session`,
  logicalSessionKey: input.logicalSessionKey,
  environmentId: input.environmentId,
  agent: input.agent,
}));
const listNativeAgentResumableSessionsMock = mock(async () => []);
const getAgentHandoffMock = mock(
  async (_handoffId: string): Promise<unknown> => null,
);
const performNativeAgentSessionActionMock = mock(async (_input: {
  agent: string;
  action: { kind: string; text?: string };
}) => ({ outcome: "applied" as const }));
const enqueuePromptQueueMessageMock = mock(async () => {});
const removePromptQueueMessageMock = mock(async () => {});
const movePromptQueueMessageMock = mock(async () => {});
const dismissNativeAgentSuggestedPromptMock = mock(
  async () => getNativeAgentProjectionMock({ agent: "claude", environmentId: "env-1" }),
);
const updateNativeAgentControlsMock = mock(
  async (_input: { update: Record<string, unknown> }) =>
    getNativeAgentProjectionMock({ agent: "codex", environmentId: "env-1" }),
);
const dispatchNativeAgentIntentMock = mock(async (input: { requestId: string }) => ({
  outcome: "accepted" as const,
  requestId: input.requestId,
}));
const retryNativeAgentDispatchMock = mock(async () => ({
  outcome: "accepted" as const,
  requestId: "recoverable-1",
}));
const renameEnvironmentFromPromptMock = mock(async () => {});
const resumeNativeAgentSessionMock = mock(async (input: {
  agent: NativeAgentTabData["platform"];
  environmentId: string;
  providerSessionId: string;
}) => ({
  ...(await defaultProjection({
    agent: input.agent!,
    environmentId: input.environmentId,
  })),
  sessionId: input.providerSessionId,
  generation: `resumed:${input.providerSessionId}`,
}));
const stopNativeAgentSessionMock = mock(async () => getNativeAgentProjectionMock({
  agent: "claude",
  environmentId: "env-1",
}));
const defaultProjection = async (input: {
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  environmentId: string;
  messageLimit?: number;
}): Promise<NativeAgentSessionProjection<NativeMessage>> => ({
  platform: input.agent,
  environmentId: input.environmentId,
  sessionId: `${input.agent}-session`,
  connection: "connected" as const,
  turn: { phase: "idle" as const },
  messages: [] as NativeMessage[],
  interactions: [],
  composerControls: [],
  composer: {
    models: [],
    fastModeEnabled: false,
    fastModeAvailable: false,
    selectedModeId: "build" as const,
    modes: [{ id: "build" as const, label: "Build" }],
  },
  capabilities: {
    attachments: { files: false, images: false },
    queue: false,
    resume: false,
    fork: false,
    slashCommands: false,
    backgroundTasks: false,
    composer: {
      provider: true,
      model: true,
      reasoning: true,
      speed: true,
      mode: true,
    },
  },
  revision: 1,
  generation: "test-generation",
});
const getNativeAgentProjectionMock = mock(defaultProjection);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentModelCatalog: getNativeAgentModelCatalogMock,
  awaitBridgeReady: awaitBridgeReadyMock,
  adoptNativeAgentSession: adoptNativeAgentSessionMock,
  ensureNativeAgentSession: ensureNativeAgentSessionMock,
  listNativeAgentResumableSessions: listNativeAgentResumableSessionsMock,
  getAgentHandoff: getAgentHandoffMock,
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  retryNativeAgentDispatch: retryNativeAgentDispatchMock,
  renameEnvironmentFromPrompt: renameEnvironmentFromPromptMock,
  resumeNativeAgentSession: resumeNativeAgentSessionMock,
  stopNativeAgentSession: stopNativeAgentSessionMock,
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
  getNativeAgentProjection: getNativeAgentProjectionMock,
  performNativeAgentSessionAction: performNativeAgentSessionActionMock,
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
  removePromptQueueMessage: removePromptQueueMessageMock,
  movePromptQueueMessage: movePromptQueueMessageMock,
  dismissNativeAgentSuggestedPrompt: dismissNativeAgentSuggestedPromptMock,
  updateNativeAgentControls: updateNativeAgentControlsMock,
}));
mock.module("@/lib/pane-layout-persistence", () => ({
  ...realPaneLayoutPersistenceSnapshot,
  flushPaneLayoutNow: flushPaneLayoutNowMock,
}));

const { AgentNativeTab } = await import("./AgentNativeTab");
const { useNativeAgentSession } = await import("@/hooks/useNativeAgentSession");

// Favorites and enabled platforms live in the shared config store, which no
// other hook resets between files. Snapshot it so a test that seeds either one
// cannot change what a later test's model picker renders.
let configSnapshot: ReturnType<typeof useConfigStore.getState>["config"];

beforeEach(() => {
  configSnapshot = useConfigStore.getState().config;
  useAgentModelCatalogStore.setState({ cursorModels: [], grokModels: [] });
  useEnvironmentStore.setState({
    environments: [{
      id: "env-1",
      projectId: "project-1",
      name: "Native agent test",
      order: 0,
      setupPhase: "ready",
    } as never],
  });
});

afterEach(() => {
  cleanup();
  useConfigStore.getState().setConfig(configSnapshot);
  flushPaneLayoutNowMock.mockClear();
  getNativeAgentModelCatalogMock.mockReset();
  getNativeAgentModelCatalogMock.mockImplementation(async () => []);
  awaitBridgeReadyMock.mockReset();
  awaitBridgeReadyMock.mockImplementation(async () => ({
    status: "ready" as const,
    port: 4099,
    authToken: "token",
  }));
  adoptNativeAgentSessionMock.mockClear();
  ensureNativeAgentSessionMock.mockClear();
  listNativeAgentResumableSessionsMock.mockClear();
  getAgentHandoffMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  retryNativeAgentDispatchMock.mockClear();
  renameEnvironmentFromPromptMock.mockReset();
  renameEnvironmentFromPromptMock.mockImplementation(async () => {});
  resumeNativeAgentSessionMock.mockClear();
  stopNativeAgentSessionMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  removePromptQueueMessageMock.mockClear();
  movePromptQueueMessageMock.mockClear();
  dismissNativeAgentSuggestedPromptMock.mockClear();
  updateNativeAgentControlsMock.mockClear();
  getNativeAgentProjectionMock.mockClear();
  getNativeAgentProjectionMock.mockImplementation(defaultProjection);
  useEnvironmentStore.setState({ environments: [] });
  useConfigStore.getState().updateGlobalConfig({
    enabledAgentPlatforms: ["claude", "codex", "opencode"],
    claudeModel: "claude-sonnet-5",
    claudeNativeFastModeDefault: false,
  });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeComposeStore.setState({ drafts: new Map() });
  useNativeAgentProjectionStore.getState().reset();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/pane-layout-persistence", () => realPaneLayoutPersistenceSnapshot);
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

function PaneBackedAgentNativeTab({ tabId = "tab-resume" }: { tabId?: string }) {
  const tab = usePaneLayoutStore((state) => {
    const root = state.environments.get("env-1")?.root;
    if (!root || root.kind !== "leaf") return undefined;
    return root.tabs.find((candidate) => candidate.id === tabId);
  });
  const data = tab ? getNativeAgentData(tab) : undefined;
  if (!data) return null;
  return (
    <AgentNativeTab
      tabId={tabId}
      data={data}
      isActive
      initialPrompt={tab?.initialPrompt}
      initialAgentModel={tab?.initialAgentModel}
      initialReasoningEffort={tab?.initialReasoningEffort}
      initialConversationMode={tab?.initialConversationMode}
      initialFastMode={tab?.initialFastMode}
    />
  );
}

function NativeSessionHarness({ isActive = true }: { isActive?: boolean } = {}) {
  const session = useNativeAgentSession<NativeMessage>({
    platform: "claude",
    environmentId: "env-1",
    tabId: "tab-hook-race",
    initialProviderSessionId: "session-a",
    isActive,
  });
  return (
    <div>
      <output data-testid="hook-session-id">{session.projection?.sessionId}</output>
      <output data-testid="hook-message">
        {(session.projection?.messages[0] as NativeMessage | undefined)?.content}
      </output>
      <button type="button" onClick={() => { void session.refresh(); }}>Refresh</button>
      <button type="button" onClick={() => { void session.resume("session-b"); }}>Resume B</button>
    </div>
  );
}

function seedUnassignedPane(tabId: string) {
  usePaneLayoutStore.setState({
    environments: new Map([
      ["env-1", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{
            id: tabId,
            type: "agent-native",
            nativeAgentData: { environmentId: "env-1" },
          }],
          activeTabId: tabId,
        },
        activePaneId: "default",
        containerId: null,
      }],
    ]),
    hydration: new Map([["env-1", "done"]]),
    activeEnvironmentId: "env-1",
  });
}

function seedAssignedPane(
  tabId: string,
  initial: Pick<TabInfo, "initialConversationMode" | "initialFastMode">,
) {
  usePaneLayoutStore.setState({
    environments: new Map([
      ["env-1", {
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{
            id: tabId,
            type: "agent-native",
            nativeAgentData: identity("claude"),
            ...initial,
          }],
          activeTabId: tabId,
        },
        activePaneId: "default",
        containerId: "container-1",
      }],
    ]),
    hydration: new Map([["env-1", "done"]]),
    activeEnvironmentId: "env-1",
  });
}

describe("AgentNativeTab", () => {
  test.each(AGENT_PLATFORMS.map((platform) => [platform] as const))(
    "does not render a context-window control in the %s compose bar before usage arrives",
    async (platform) => {
      render(
        <AgentNativeTab
          tabId={`tab-context-${platform}`}
          data={identity(platform)}
          isActive
        />,
      );

      await screen.findByTestId("shared-native-compose-bar");
      const sendButton = screen.getByTitle("Send");

      expect(screen.queryByRole("button", { name: /Context window/ }) === null).toBe(true);
      expect(sendButton).toBeTruthy();
    },
  );

  test.each(AGENT_PLATFORMS.map((platform) => [platform] as const))(
    "renders the context-window control in the %s compose bar once usage arrives",
    async (platform) => {
      getNativeAgentProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input)),
        contextUsage: { usedTokens: 4_000, maximumTokens: 16_000, percentage: 25 },
      }));

      render(
        <AgentNativeTab
          tabId={`tab-context-present-${platform}`}
          data={identity(platform)}
          isActive
        />,
      );

      // The control is conditional, so absence before usage arrives must not be
      // allowed to become permanent absence after it does.
      const contextButton = await screen.findByRole("button", {
        name: "Context window 25% used",
      });
      expect(contextButton.nextElementSibling).toBe(screen.getByTitle("Send"));
    },
  );

  test("keeps an unassigned tab composer-only without loading a bridge controller", () => {
    const { container } = render(
      <AgentNativeTab
        tabId="tab-unassigned"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    const input = container.querySelector<HTMLElement>(".native-compose-input")!;
    expect(input.className).toContain("native-compose-input");
    expect(input.style.minHeight).toBe("28px");
    expect(screen.getByText("Ask an agent anything…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeTruthy();
    expect(screen.getByText("Ready to build!")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume Session" })).toBeTruthy();
    expect(screen.getByTestId("compose-dock").className).toContain("top-1/2");
    expect(screen.getByTestId("unassigned-native-compose-bar").className).toContain("rounded-2xl");
  });

  test("drops the previous platform's effort when one click also switches platform", async () => {
    // The picker calls onPlatformChange and onModelChange from a single event,
    // so the render closure is still holding the pre-switch draft. Reading the
    // effort from that closure would carry it onto the new provider even though
    // the platform switch just cleared it.
    const reasoning = [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "xhigh", label: "Extra high" },
    ];
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        platform: "claude", id: "claude-m", label: "Claude M",
        reasoning, defaultReasoningId: "medium",
      },
      {
        platform: "codex", id: "codex-m", label: "Codex M",
        reasoning, defaultReasoningId: "medium",
      },
    ] as never);
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1", projectId: "project-1", name: "Effort switch", order: 0,
      } as never],
    });
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex"],
      favoriteModels: [{ platform: "codex", modelId: "codex-m" }],
    } as never);
    const sessionKey = createSessionKey("env-1", "tab-effort-platform-switch");
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      platform: "claude",
      modelId: "claude-m",
      reasoningId: "xhigh",
    });

    render(
      <AgentNativeTab
        tabId="tab-effort-platform-switch"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    // The favorites view lists models across platforms without switching the
    // platform itself, which is what makes the single-click path reachable.
    fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Codex M/ }));

    await waitFor(() => expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.modelId,
    ).toBe("codex-m"));
    // "xhigh" is a supported effort on the new model, so only a stale read
    // could produce it here.
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.reasoningId)
      .toBe("medium");
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.platform).toBe("codex");
  });

  test("keeps a still-supported effort when the model switch stays on one platform", async () => {
    const reasoning = [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "xhigh", label: "Extra high" },
    ];
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        platform: "claude", id: "claude-m", label: "Claude M",
        reasoning, defaultReasoningId: "medium",
      },
      {
        platform: "claude", id: "claude-n", label: "Claude N",
        reasoning, defaultReasoningId: "medium",
      },
    ] as never);
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1", projectId: "project-1", name: "Effort same platform", order: 0,
      } as never],
    });
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude"],
      favoriteModels: [],
    } as never);
    const sessionKey = createSessionKey("env-1", "tab-same-platform-switch");
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      platform: "claude",
      modelId: "claude-m",
      reasoningId: "xhigh",
    });

    render(
      <AgentNativeTab
        tabId="tab-same-platform-switch"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    fireEvent.click(await screen.findByRole("button", { name: "claude models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Claude N/ }));

    await waitFor(() => expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.modelId,
    ).toBe("claude-n"));
    // No platform change, so an explicit choice the new model still supports
    // must survive rather than resetting to the advertised default.
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.reasoningId)
      .toBe("xhigh");
  });

  test("asks for a platform before opening that provider's normal resume flow", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: [...AGENT_PLATFORMS],
    });
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{
              id: "tab-resume",
              type: "agent-native",
              nativeAgentData: { environmentId: "env-1" },
            }],
            activeTabId: "tab-resume",
          },
          activePaneId: "default",
          containerId: null,
        }],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });

    render(<PaneBackedAgentNativeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Resume a session")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Claude/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Codex/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Cursor Agent/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Grok Build/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /OpenCode/ })).toBeTruthy();

    expect((within(dialog).getByRole("button", { name: /Cursor Agent/ }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((within(dialog).getByRole("button", { name: /Grok Build/ }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: /Cursor Agent/ }));

    expect(await screen.findByRole("dialog", { name: "Resume Session" })).toBeTruthy();
    await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
  });

  test("renders the backend-normalized OpenCode catalogue in a new tab", async () => {
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1",
        projectId: "project-1",
        name: "Cached models",
        order: 0,
      } as never],
    });
    useNativeComposeStore.getState().updateDraft(
      createSessionKey("env-1", "tab-cached-models"),
      { platform: "opencode" },
    );
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "opencode/model-a",
        platform: "opencode",
        label: "OpenCode A",
        providerLabel: "OpenCode/opencode",
      },
      {
        id: "opencode-go/model-b",
        platform: "opencode",
        label: "OpenCode Go B",
        providerLabel: "OpenCode/opencode-go",
      },
    ]);

    render(
      <AgentNativeTab
        tabId="tab-cached-models"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1"));
    const picker = await screen.findByTitle(/Choose model/);
    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "opencode models" }));

    expect(screen.getByRole("menuitemradio", { name: /OpenCode A/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /OpenCode Go B/ })).toBeTruthy();
    expect(screen.getByText("OpenCode/opencode")).toBeTruthy();
    expect(screen.getByText("OpenCode/opencode-go")).toBeTruthy();
  });

  test("renders the cached Cursor catalogue without starting its ACP bridge", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["cursor"],
    });
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1",
        projectId: "project-1",
        name: "Cursor models",
        order: 0,
      } as never],
    });
    useNativeComposeStore.getState().updateDraft(
      createSessionKey("env-1", "tab-cursor-models"),
      { platform: "cursor" },
    );
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "composer-2.5",
        platform: "cursor",
        label: "Composer 2.5",
        providerLabel: "Cursor",
        reasoning: [{ id: "medium", label: "Medium" }],
        defaultReasoningId: "medium",
        supportsSpeed: true,
        supportsMode: true,
      },
    ]);

    render(
      <AgentNativeTab
        tabId="tab-cursor-models"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1"));
    expect(awaitBridgeReadyMock).not.toHaveBeenCalled();
    const picker = await screen.findByTitle(/Choose model/);
    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "cursor models" }));
    expect(screen.getByRole("menuitemradio", { name: /Composer 2.5/ })).toBeTruthy();
    expect(useAgentModelCatalogStore.getState().cursorModels.map((model) => model.id))
      .toEqual(["composer-2.5"]);
  });

  // The catalogue is environment-scoped and already holds every platform, so a
  // platform switch must filter what is loaded rather than clearing the list and
  // re-issuing a command that probes both ACP bridges.
  test("does not refetch the catalogue when the composer platform changes", async () => {
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1",
        projectId: "project-1",
        name: "Model catalogue",
        order: 0,
      } as never],
    });
    const sessionKey = createSessionKey("env-1", "tab-platform-switch");
    useNativeComposeStore.getState().updateDraft(sessionKey, { platform: "cursor" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "composer-2.5",
        platform: "cursor",
        label: "Composer 2.5",
        providerLabel: "Cursor",
        supportsSpeed: true,
        supportsMode: true,
      },
      {
        id: "grok-build",
        platform: "grok",
        label: "Grok Build",
        providerLabel: "Grok",
        supportsSpeed: false,
        supportsMode: true,
      },
    ]);

    render(
      <AgentNativeTab
        tabId="tab-platform-switch"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(screen.getByTitle(/Choose model/).textContent)
      .toContain("Composer 2.5"));
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);

    useNativeComposeStore.getState().updateDraft(sessionKey, { platform: "grok" });

    // The grok half of the same catalogue resolves immediately: no refetch, and
    // no transient "No models available".
    await waitFor(() => expect(screen.getByTitle(/Choose model/).textContent)
      .toContain("Grok Build"));
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No models available") === null).toBe(true);
  });

  test("drops attachments the newly selected platform cannot receive", async () => {
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1",
        projectId: "project-1",
        name: "Attachment reconcile",
        order: 0,
      } as never],
    });
    const sessionKey = createSessionKey("env-1", "tab-attachment-switch");
    const file = {
      id: "attachment-file",
      type: "file" as const,
      path: "/workspace/docs/notes.md",
      name: "notes.md",
    };
    const image = {
      id: "attachment-image",
      type: "image" as const,
      path: "/workspace/docs/shot.png",
      previewUrl: "blob:preview",
      name: "shot.png",
    };
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      platform: "claude",
      text: "review these",
      attachments: [file, image],
    });

    render(
      <AgentNativeTab
        tabId="tab-attachment-switch"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );
    // Claude takes both, so nothing is reconciled away.
    await waitFor(() => expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.attachments,
    ).toEqual([file, image]));

    useNativeComposeStore.getState().updateDraft(sessionKey, { platform: "codex" });

    /*
     * Codex accepts images and refuses files, and its bridge rejects the whole
     * prompt rather than dropping the entry it cannot use. Keeping the file
     * here would fail the next send with an error naming an attachment the
     * composer had stopped offering.
     */
    await waitFor(() => expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.attachments,
    ).toEqual([image]));
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.text)
      .toBe("review these");

    // Cursor reads inline images over ACP but takes no files, so the same
    // reconcile applies: back to a provider that accepts both, then across.
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      platform: "claude",
      attachments: [file, image],
    });
    await waitFor(() => expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.attachments,
    ).toEqual([file, image]));

    useNativeComposeStore.getState().updateDraft(sessionKey, { platform: "cursor" });
    await waitFor(() => expect(
      useNativeComposeStore.getState().drafts.get(sessionKey)?.attachments,
    ).toEqual([image]));
  });

  test("carries first-prompt mentions and pasted images through the provider lock", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{
              id: "tab-first-prompt",
              type: "agent-native",
              nativeAgentData: { environmentId: "env-1" },
            }],
            activeTabId: "tab-first-prompt",
          },
          activePaneId: "default",
          containerId: null,
        }],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });
    useNativeComposeStore.getState().updateDraft(
      createSessionKey("env-1", "tab-first-prompt"),
      {
        text: "Review @widget.ts",
        mentions: [{
          id: "mention-1",
          filename: "widget.ts",
          relativePath: "src/widget.ts",
        }],
        attachments: [{
          id: "image-1",
          type: "image",
          name: "layout.png",
          path: "/workspace/.orkestrator/clipboard/layout.png",
          previewUrl: "data:image/png;base64,abc",
        }],
      },
    );

    render(<PaneBackedAgentNativeTab tabId="tab-first-prompt" />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
    const root = usePaneLayoutStore.getState().environments.get("env-1")?.root;
    expect(root?.kind).toBe("leaf");
    if (!root || root.kind !== "leaf") throw new Error("Expected leaf pane");
    const tab = root.tabs.find((candidate) => candidate.id === "tab-first-prompt");
    expect(getNativeAgentData(tab!)?.platform).toBe("claude");
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: expect.stringMatching(/\[@widget\.ts\]\(src\/widget\.ts\)[\s\S]*layout\.png: \/workspace\/\.orkestrator\/clipboard\/layout\.png/),
      attachments: [{
        type: "image",
        path: "/workspace/.orkestrator/clipboard/layout.png",
        filename: "layout.png",
      }],
    });
  });

  test("retries a failed first-prompt provider-lock save without losing the draft", async () => {
    const tabId = "tab-retry-send";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    useNativeComposeStore.getState().updateDraft(sessionKey, {
      text: "Keep this prompt",
      platform: "claude",
    });
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      throw new Error("temporary save failure");
    });

    render(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(await screen.findByText("The agent choice is locked, but could not be saved."))
      .toBeTruthy();
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.text).toBe("Keep this prompt");
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
    expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(2);
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toBeUndefined();
  });

  test("keeps a first prompt durable and non-reentrant while environment rename is pending", async () => {
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    renameEnvironmentFromPromptMock.mockImplementationOnce(async () => renameGate);
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1",
        projectId: "project-1",
        name: "20260415-123456",
        order: 0,
        setupPhase: "ready",
      } as never],
    });
    const tabId = "tab-rename-durable";
    const sessionKey = createSessionKey("env-1", tabId);
    const view = render(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Keep this first prompt" } });
    const sendButton = await screen.findByTitle("Send");
    fireEvent.click(sendButton);

    await waitFor(() => expect(renameEnvironmentFromPromptMock).toHaveBeenCalledTimes(1));
    const pendingDraft = useNativeComposeStore.getState().drafts.get(sessionKey);
    expect(pendingDraft?.text).toBe("Keep this first prompt");
    expect(pendingDraft?.requestId).toMatch(/\S/);
    await waitFor(() => expect(screen.queryByTitle("Send") === null).toBe(true));
    expect(input.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    view.unmount();
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.text)
      .toBe("Keep this first prompt");
    const remounted = render(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    expect((await screen.findByRole("textbox")).textContent).toBe("Keep this first prompt");
    remounted.unmount();

    const stableRequestId = pendingDraft!.requestId;
    releaseRename();
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Keep this first prompt",
      requestId: stableRequestId,
    });
    await waitFor(() => expect(useNativeComposeStore.getState().drafts.get(sessionKey))
      .toBeUndefined());
  });

  test("retries a failed resume provider-lock save before opening the provider dialog", async () => {
    const tabId = "tab-retry-resume";
    seedUnassignedPane(tabId);
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      throw new Error("temporary save failure");
    });

    render(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Codex/ }));

    expect(await screen.findByRole("button", { name: "Retry save" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    expect(await screen.findByRole("dialog", { name: "Resume Session" })).toBeTruthy();
    expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(2);
  });

  for (const platform of AGENT_PLATFORMS) {
    test(`routes ${platform} through the shared authoritative projection`, async () => {
      render(
        <AgentNativeTab
          tabId={`tab-${platform}`}
          data={identity(platform)}
          isActive
        />,
      );

      expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
      expect(adoptNativeAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        agent: platform,
        environmentId: "env-1",
        logicalSessionKey: `env-env-1:tab-${platform}`,
        providerSessionId: `${platform}-session`,
      }));
      expect(getNativeAgentProjectionMock).toHaveBeenCalledWith(expect.objectContaining({
        agent: platform,
        environmentId: "env-1",
      }));
    });
  }

  test("carries one-shot launch options into the adoption of a resumed session", async () => {
    // Multi Review hands its consolidation session over as a Build-mode tab, so
    // the mode has to reach adoption; adopting without it would leave the fix
    // agent in whatever mode consolidation left behind (plan).
    render(
      <AgentNativeTab
        tabId="tab-resume-controls"
        data={identity("claude")}
        isActive
        initialAgentModel="opus"
        initialReasoningEffort="high"
        initialConversationMode="build"
        initialFastMode={false}
      />,
    );

    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      providerSessionId: "claude-session",
      model: "opus",
      reasoningEffort: "high",
      sessionMode: "build",
      fastMode: false,
    });
  });

  test("does not overwrite a resumed session with configured defaults", async () => {
    useConfigStore.getState().updateGlobalConfig({
      claudeModel: "configured-default",
      claudeNativeFastModeDefault: true,
    });

    render(
      <AgentNativeTab
        tabId="tab-resume-preserve-controls"
        data={identity("claude")}
        isActive
      />,
    );

    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    const adopted = adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(adopted).not.toHaveProperty("model");
    expect(adopted).not.toHaveProperty("reasoningEffort");
    expect(adopted).not.toHaveProperty("sessionMode");
    expect(adopted).not.toHaveProperty("fastMode");

    useConfigStore.getState().updateGlobalConfig({
      claudeModel: "claude-sonnet-5",
      claudeNativeFastModeDefault: false,
    });
  });

  test("consumes a mode-only launch option before a resumed tab remounts", async () => {
    const tabId = "tab-mode-only";
    seedAssignedPane(tabId, { initialConversationMode: "build" });
    const first = render(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs("env-1")
        .find((candidate) => candidate.id === tabId);
      expect(tab?.initialConversationMode).toBeUndefined();
    });
    expect(adoptNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      sessionMode: "build",
    });

    first.unmount();
    adoptNativeAgentSessionMock.mockClear();
    render(<PaneBackedAgentNativeTab tabId={tabId} />);
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0])
      .not.toHaveProperty("sessionMode");
  });

  test("consumes an explicit false fast-mode option", async () => {
    const tabId = "tab-fast-only";
    seedAssignedPane(tabId, { initialFastMode: false });
    render(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs("env-1")
        .find((candidate) => candidate.id === tabId);
      expect(tab?.initialFastMode).toBeUndefined();
    });
    expect(adoptNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      fastMode: false,
    });
  });

  test("sends a resumed tab's opening prompt once it is in the session it asked for", async () => {
    render(
      <AgentNativeTab
        tabId="tab-resume-prompt"
        data={identity("claude")}
        isActive
        initialPrompt={ADDRESS_ALL_REVIEW_PROMPT}
      />,
    );

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
    expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      prompt: ADDRESS_ALL_REVIEW_PROMPT,
    });
  });

  test("withholds a resumed tab's opening prompt when the session was substituted", async () => {
    // Adoption falls back to creating a fresh session when the provider has
    // forgotten the rollout. "Address every finding" carries no findings of its
    // own, so firing it into an empty conversation asks the agent to act on a
    // review it cannot see.
    getNativeAgentProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as Parameters<typeof defaultProjection>[0])),
      sessionId: "a-replacement-session",
    }));

    render(
      <AgentNativeTab
        tabId="tab-resume-substituted"
        data={identity("claude")}
        isActive
        initialPrompt={ADDRESS_ALL_REVIEW_PROMPT}
      />,
    );

    expect(await screen.findByText(/opening message was not sent/)).toBeTruthy();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("waits for environment setup before starting the shared provider", async () => {
    useEnvironmentStore.setState({
      environments: [{
        id: "env-1",
        projectId: "project-1",
        name: "Setting up",
        order: 0,
        setupPhase: "running",
      } as never],
    });
    render(
      <AgentNativeTab
        tabId="tab-setup"
        data={identity("claude")}
        isActive
      />,
    );
    expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    expect(adoptNativeAgentSessionMock).not.toHaveBeenCalled();

    useEnvironmentStore.setState((state) => ({
      environments: state.environments.map((environment) => ({
        ...environment,
        setupPhase: "ready" as const,
      })),
    }));
    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalledTimes(1));
  });

  test.each([...AGENT_PLATFORMS])("loads a transferred conversation for a %s tab", async (platform) => {
    // The destination side used to gate on the three legacy providers, so a
    // Cursor or Grok tab silently dropped the transfer it was opened to carry
    // and never even asked for it.
    render(
      <AgentNativeTab
        tabId={`tab-handoff-${platform}`}
        data={identity(platform)}
        isActive
        agentHandoffId={`handoff-into-${platform}`}
      />,
    );

    await waitFor(() =>
      expect(getAgentHandoffMock).toHaveBeenCalledWith(`handoff-into-${platform}`),
    );
  });

  test("renders a mismatch notice instead of throwing on an unknown platform", async () => {
    // A persisted record can name a platform this build does not ship. Failing
    // here would throw out of the pane and take its sibling tabs down with it.
    render(
      <AgentNativeTab
        tabId="tab-unknown"
        data={{
          platform: "gemini" as NativeAgentTabData["platform"],
          environmentId: "env-1",
        }}
        isActive
      />,
    );

    expect(await screen.findByText(/unsupported agent/i)).toBeTruthy();
  });

  test("does not resolve a platform through the prototype chain", async () => {
    render(
      <AgentNativeTab
        tabId="tab-proto"
        data={{
          platform: "constructor" as NativeAgentTabData["platform"],
          environmentId: "env-1",
        }}
        isActive
      />,
    );

    expect(await screen.findByText(/unsupported agent/i)).toBeTruthy();
  });

  test("reconnects the shared controller when a tab's platform changes", async () => {
    const { rerender } = render(
      <AgentNativeTab tabId="tab-swap" data={identity("codex")} isActive />,
    );
    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();

    rerender(
      <AgentNativeTab tabId="tab-swap" data={identity("opencode")} isActive />,
    );

    await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "opencode" }),
    ));
  });

  test("does not read or touch a provider projection while its tab is inactive", async () => {
    render(<AgentNativeTab tabId="tab-inactive" data={identity("codex")} isActive={false} />);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getNativeAgentProjectionMock).not.toHaveBeenCalled();
    expect(adoptNativeAgentSessionMock).not.toHaveBeenCalled();
  });

  test("does not let a stale projection refresh undo a resumed session", async () => {
    let resolveStale!: (projection: NativeAgentSessionProjection<NativeMessage>) => void;
    const staleProjection = new Promise<NativeAgentSessionProjection<NativeMessage>>(
      (resolve) => { resolveStale = resolve; },
    );
    getNativeAgentProjectionMock
      .mockImplementationOnce(defaultProjection)
      .mockImplementationOnce(async () => staleProjection)
      .mockImplementation(defaultProjection);

    render(<NativeSessionHarness />);
    await waitFor(() => expect(screen.getByTestId("hook-session-id").textContent)
      .toBe("claude-session"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Resume B" }));
    await waitFor(() => expect(screen.getByTestId("hook-session-id").textContent)
      .toBe("session-b"));

    resolveStale({
      ...(await defaultProjection({ agent: "claude", environmentId: "env-1" })),
      sessionId: "session-a",
      generation: "stale-session-a",
      revision: 999,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId("hook-session-id").textContent).toBe("session-b");
  });

  test("hydrates a cached session while its remount adoption probe is still pending", async () => {
    const sessionKey = createSessionKey("env-1", "tab-hook-race");
    useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
      ...(await defaultProjection({ agent: "claude", environmentId: "env-1" })),
      sessionId: "session-a",
      messages: [{
        id: "assistant-stale",
        role: "assistant",
        content: "stale transcript",
        parts: [],
        createdAt: "2026-08-14T10:00:00.000Z",
      }],
    });
    let releaseAdoption!: () => void;
    adoptNativeAgentSessionMock.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => { releaseAdoption = resolve; });
      return {
        providerSessionId: input.providerSessionId,
        logicalSessionKey: input.logicalSessionKey,
        environmentId: input.environmentId,
        agent: input.agent,
      };
    });
    getNativeAgentProjectionMock.mockImplementationOnce(async (input) => ({
      ...(await defaultProjection(input as never)),
      sessionId: "session-a",
      messages: [{
        id: "assistant-latest",
        role: "assistant",
        content: "latest transcript",
        parts: [],
        createdAt: "2026-08-14T10:00:01.000Z",
      }],
      revision: 2,
    }));

    render(<NativeSessionHarness />);
    expect(screen.getByTestId("hook-message").textContent).toBe("stale transcript");
    await waitFor(() => expect(screen.getByTestId("hook-message").textContent)
      .toBe("latest transcript"));
    expect(adoptNativeAgentSessionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseAdoption();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  /**
   * Park the very first projection read so the invalidation below is
   * guaranteed to land while a read is genuinely in flight. Gating a later
   * read instead races the mount's own reads, and a dispatch that arrives with
   * nothing in flight takes the ordinary path and proves nothing.
   */
  async function parkFirstProjectionRead(): Promise<() => void> {
    let releaseRefresh!: () => void;
    const parked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    getNativeAgentProjectionMock.mockImplementationOnce(async (input) => {
      await parked;
      return {
        ...(await defaultProjection(input as never)),
        messages: [{
          id: "assistant-stale",
          role: "assistant",
          content: "stale transcript",
          parts: [],
          createdAt: "2026-08-14T10:00:00.000Z",
        }],
      };
    });
    getNativeAgentProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [{
        id: "assistant-latest",
        role: "assistant",
        content: "latest transcript",
        parts: [],
        createdAt: "2026-08-14T10:00:01.000Z",
      }],
      revision: 2,
    }));
    return releaseRefresh;
  }

  test("coalesces a resource invalidation into one trailing projection read", async () => {
    const releaseRefresh = await parkFirstProjectionRead();
    render(<NativeSessionHarness />);
    await waitFor(() => expect(getNativeAgentProjectionMock.mock.calls.length)
      .toBeGreaterThan(0));
    const callsWhileParked = getNativeAgentProjectionMock.mock.calls.length;

    await act(async () => {
      dispatchResourceChange({
        resource: "native-agent-session",
        id: "env-1",
        revision: 1,
      });
      // The dispatcher coalesces for 50ms, so the invalidation has to be given
      // time to actually reach the hook while the read above is still parked.
      await new Promise<void>((resolve) => { setTimeout(resolve, 80); });
    });
    // Coalesced, not executed: proof the read below is the trailing
    // reconciliation rather than the invalidation's own read.
    expect(getNativeAgentProjectionMock.mock.calls.length).toBe(callsWhileParked);

    await act(async () => {
      releaseRefresh();
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    });
    expect(getNativeAgentProjectionMock.mock.calls.length).toBe(callsWhileParked + 1);
    await waitFor(() => expect(screen.getByTestId("hook-message").textContent)
      .toBe("latest transcript"));
  });

  test("drops the queued reconciliation read when the tab stops being active", async () => {
    const releaseRefresh = await parkFirstProjectionRead();
    const { rerender } = render(<NativeSessionHarness />);
    await waitFor(() => expect(getNativeAgentProjectionMock.mock.calls.length)
      .toBeGreaterThan(0));
    const callsWhileParked = getNativeAgentProjectionMock.mock.calls.length;

    await act(async () => {
      dispatchResourceChange({
        resource: "native-agent-session",
        id: "env-1",
        revision: 1,
      });
      await new Promise<void>((resolve) => { setTimeout(resolve, 80); });
    });
    expect(getNativeAgentProjectionMock.mock.calls.length).toBe(callsWhileParked);
    // The tab stops being visible before the in-flight read drains. A tab the
    // user cannot see must not keep reading; the next activation reconnects
    // and reads authoritatively anyway.
    rerender(<NativeSessionHarness isActive={false} />);

    await act(async () => {
      releaseRefresh();
      // A full macrotask turn drains every queued microtask, so a trailing
      // read would already have been recorded by the time this resolves.
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    });
    expect(getNativeAgentProjectionMock.mock.calls.length).toBe(callsWhileParked);
  });

  test("drops the queued reconciliation read when the tab unmounts", async () => {
    const releaseRefresh = await parkFirstProjectionRead();
    const { unmount } = render(<NativeSessionHarness />);
    await waitFor(() => expect(getNativeAgentProjectionMock.mock.calls.length)
      .toBeGreaterThan(0));
    const callsWhileParked = getNativeAgentProjectionMock.mock.calls.length;

    await act(async () => {
      dispatchResourceChange({
        resource: "native-agent-session",
        id: "env-1",
        revision: 1,
      });
      await new Promise<void>((resolve) => { setTimeout(resolve, 80); });
    });
    expect(getNativeAgentProjectionMock.mock.calls.length).toBe(callsWhileParked);
    unmount();

    await act(async () => {
      releaseRefresh();
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    });
    expect(getNativeAgentProjectionMock.mock.calls.length).toBe(callsWhileParked);
  });

  test("polls an active tab faster while a turn runs and stops entirely when inactive", async () => {
    /*
     * The backend no longer refreshes projections on a timer, so this interval
     * is the only thing that advances a visible transcript. Assert the cadence
     * it registers rather than waiting on wall-clock ticks.
     */
    const registered: number[] = [];
    const realSetInterval = window.setInterval.bind(window);
    const intervalSpy = spyOn(window, "setInterval").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...rest: unknown[]
    ) => {
      registered.push(timeout ?? 0);
      return realSetInterval(handler, timeout, ...rest);
    }) as typeof window.setInterval);
    try {
      const view = render(<NativeSessionHarness />);
      await waitFor(() => expect(screen.getByTestId("hook-session-id").textContent)
        .toBe("claude-session"));
      expect(registered).toContain(1_500);
      expect(registered).not.toContain(500);

      registered.length = 0;
      getNativeAgentProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        turn: { phase: "running" as const },
      }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(registered).toContain(500));

      // Unmounting is the inactive path: no timer may outlive the tree.
      registered.length = 0;
      const before = getNativeAgentProjectionMock.mock.calls.length;
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(registered).toEqual([]);
      expect(getNativeAgentProjectionMock.mock.calls.length).toBe(before);
    } finally {
      intervalSpy.mockRestore();
    }
  });

  test("restores review follow-up, manual refresh, notices, and Escape stop in the shared tab", async () => {
    getNativeAgentProjectionMock.mockImplementation(async (input) => ({
      platform: input.agent,
      environmentId: input.environmentId,
      sessionId: "claude-session",
      connection: "connected" as const,
      turn: { phase: "idle" as const },
      messages: [{
        id: "assistant-1",
        role: "assistant" as const,
        content: "Review",
        parts: [],
        createdAt: "2026-08-14T10:00:00.000Z",
      }],
      interactions: [],
      composerControls: [],
      composer: {
        models: [], fastModeEnabled: false, fastModeAvailable: false,
        selectedModeId: "build" as const, modes: [{ id: "build" as const, label: "Build" }],
      },
      capabilities: {
        attachments: { files: true, images: true }, queue: true, resume: true,
        fork: true, slashCommands: true, backgroundTasks: true,
        composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      },
      notices: [{ kind: "warning" as const, message: "Recovered provider notice" }],
      revision: 1,
      generation: "test-generation",
    }));
    const view = render(
      <AgentNativeTab
        tabId="tab-review"
        data={identity("claude")}
        isActive
        ownsGlobalShortcuts
        isReviewTab
        refreshRequestId={0}
      />,
    );
    expect(await screen.findByText("Recovered provider notice")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Address all" }));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
    expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      prompt: ADDRESS_ALL_REVIEW_PROMPT,
    });

    const readsBeforeRefresh = getNativeAgentProjectionMock.mock.calls.length;
    view.rerender(
      <AgentNativeTab
        tabId="tab-review"
        data={identity("claude")}
        isActive
        ownsGlobalShortcuts
        isReviewTab
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(getNativeAgentProjectionMock.mock.calls.length)
      .toBeGreaterThan(readsBeforeRefresh));

    getNativeAgentProjectionMock.mockImplementation(async (input) => ({
      platform: input.agent,
      environmentId: input.environmentId,
      sessionId: "claude-session",
      connection: "connected" as const,
      turn: { phase: "running" as const },
      messages: [], interactions: [], composerControls: [],
      composer: { models: [], fastModeEnabled: false, fastModeAvailable: false, modes: [] },
      capabilities: {
        attachments: { files: true, images: true }, queue: true, resume: true,
        fork: true, slashCommands: true, backgroundTasks: true,
        composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      },
      revision: 2, generation: "test-generation",
    }));
    view.rerender(
      <AgentNativeTab tabId="tab-review-running" data={identity("claude")} isActive ownsGlobalShortcuts />,
    );
    await waitFor(() => expect(screen.getByTitle("Stop current query")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(stopNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(useNativeAgentProjectionStore.getState().turnStopMarkers.get(
      createSessionKey("env-1", "tab-review-running"),
    )?.sessionId).toBe("claude-session");
  });

  describe("capability-driven parity", () => {
    /** A running turn on a provider that reports the given capabilities. */
    function seedProjection(overrides: {
      phase?: NativeAgentSessionProjection["turn"]["phase"];
      actions?: NativeAgentSessionProjection["capabilities"]["actions"];
      messageWindow?: NativeAgentSessionProjection["messageWindow"];
      queue?: NativeAgentSessionProjection["queue"];
      suggestedPrompt?: string;
      promptSuggestions?: boolean;
      messages?: NativeMessage[];
      recoverableDispatch?: NativeAgentSessionProjection["recoverableDispatch"];
      notices?: NativeAgentSessionProjection["notices"];
      composer?: Partial<NonNullable<NativeAgentSessionProjection["composer"]>>;
      contextUsage?: NativeAgentSessionProjection["contextUsage"];
    } = {}) {
      getNativeAgentProjectionMock.mockImplementation(async (input) => ({
        platform: input.agent,
        environmentId: input.environmentId,
        sessionId: `${input.agent}-session`,
        connection: "connected" as const,
        turn: { phase: overrides.phase ?? "idle" },
        messages: overrides.messages ?? [{
          id: "assistant-1",
          role: "assistant" as const,
          content: "Working",
          parts: [],
          createdAt: "2026-08-14T10:00:00.000Z",
        }],
        ...(overrides.messageWindow ? { messageWindow: overrides.messageWindow } : {}),
        ...(overrides.queue ? { queue: overrides.queue } : {}),
        ...(overrides.recoverableDispatch
          ? { recoverableDispatch: overrides.recoverableDispatch }
          : {}),
        ...(overrides.suggestedPrompt
          ? { suggestedPrompt: overrides.suggestedPrompt }
          : {}),
        ...(overrides.contextUsage ? { contextUsage: overrides.contextUsage } : {}),
        ...(overrides.notices ? { notices: overrides.notices } : {}),
        interactions: [],
        composerControls: [],
        composer: {
          models: [{
            platform: input.agent,
            id: "model-a",
            label: "Model A",
            reasoning: [{ id: "high", label: "High" }],
          }],
          selectedModelId: "model-a",
          fastModeEnabled: false,
          fastModeAvailable: false,
          selectedModeId: "build" as const,
          modes: [
            { id: "build" as const, label: "Build" },
            { id: "plan" as const, label: "Plan" },
          ],
          ...(overrides.promptSuggestions === undefined
            ? {}
            : { promptSuggestionsEnabled: overrides.promptSuggestions }),
          ...overrides.composer,
        },
        capabilities: {
          attachments: { files: true, images: true },
          queue: true,
          resume: true,
          fork: true,
          slashCommands: true,
          backgroundTasks: false,
          composer: {
            provider: true,
            model: true,
            reasoning: true,
            speed: true,
            mode: true,
            ...(overrides.promptSuggestions === undefined
              ? {}
              : { promptSuggestions: true }),
          },
          ...(overrides.actions ? { actions: overrides.actions } : {}),
        },
        revision: 1,
        generation: "test-generation",
      }));
    }

    test("announces an active Cursor Task pinned to the transcript", async () => {
      seedProjection({
        messages: [{
          id: "assistant-cursor-subagent",
          role: "assistant",
          content: "Parent response complete",
          createdAt: "2026-08-15T10:00:00.000Z",
          parts: [{
            type: "tool-invocation",
            content: "Task: Validate the implementation",
            toolName: "task",
            toolTitle: "Task: Validate the implementation",
            toolUseId: "cursor-subagent-1",
            toolState: "success",
            agentState: "active",
            toolArgs: { description: "Validate the implementation" },
          }],
        }],
      });

      render(<AgentNativeTab tabId="tab-cursor-subagent" data={identity("cursor")} isActive />);

      await screen.findByRole("textbox");
      expect(await screen.findByRole("status", {
        name: "1 sub-agent working: Validate the implementation.",
      })).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      expect(screen.getByTestId("transcript-bottom-spacer").className).toContain("h-32");
    });

    test("announces and rehydrates an active Grok Build sub-agent", async () => {
      seedProjection({
        messages: [{
          id: "assistant-grok-subagent",
          role: "assistant",
          content: "Parent response complete",
          createdAt: "2026-08-15T10:00:00.000Z",
          parts: [{
            type: "tool-invocation",
            content: "Launch validation agent",
            toolName: "spawn_subagent",
            toolTitle: "Launch validation agent",
            toolUseId: "grok-subagent-1",
            toolState: "success",
            agentState: "active",
            toolArgs: {
              variant: "Task",
              run_in_background: true,
              description: "Validate the implementation",
              subagent_type: "explore",
            },
          }],
        }],
      });

      const view = render(
        <AgentNativeTab tabId="tab-grok-subagent" data={identity("grok")} isActive={false} />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(screen.queryByRole("button", { name: /Validate the implementation/i }) === null)
        .toBe(true);

      await act(async () => {
        view.rerender(<AgentNativeTab tabId="tab-grok-subagent" data={identity("grok")} isActive />);
      });

      await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
      expect(await screen.findByRole("status", {
        name: "1 sub-agent working: Validate the implementation.",
      })).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      expect(screen.getByTestId("transcript-bottom-spacer").className).toContain("h-32");

      // Simulate leaving the environment and then reloading the renderer: the
      // in-memory projection is gone, so the transcript row must rehydrate from
      // the next authoritative snapshot rather than a live event the old tree observed.
      view.unmount();
      useNativeAgentProjectionStore.getState().reset();
      getNativeAgentProjectionMock.mockClear();
      render(<AgentNativeTab tabId="tab-grok-subagent" data={identity("grok")} isActive />);

      await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
      expect(await screen.findByRole("status", {
        name: "1 sub-agent working: Validate the implementation.",
      })).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      expect(getNativeAgentProjectionMock).toHaveBeenCalledWith(expect.objectContaining({
        agent: "grok",
        logicalSessionKey: createSessionKey("env-1", "tab-grok-subagent"),
      }));
    });

    test.each([
      ["finished", "finished"],
      ["failed", "failed"],
    ] as const)("announces a Cursor Task lifecycle that becomes %s", async (
      agentState,
      announcementState,
    ) => {
      const tabId = `tab-cursor-subagent-${agentState}`;
      seedProjection({
        messages: [{
          id: "assistant-cursor-subagent-transition",
          role: "assistant",
          content: "",
          createdAt: "2026-08-15T10:00:00.000Z",
          parts: [{
            type: "tool-invocation",
            content: "Task: Validate the implementation",
            toolName: "task",
            toolUseId: "cursor-subagent-1",
            toolState: "success",
            agentState: "active",
            toolArgs: { description: "Validate the implementation" },
          }],
        }],
      });

      const view = render(
        <AgentNativeTab
          tabId={tabId}
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );
      await screen.findByRole("textbox");
      expect(await screen.findByRole("status", {
        name: "1 sub-agent working: Validate the implementation.",
      })).toBeTruthy();

      seedProjection({
        messages: [{
          id: "assistant-cursor-subagent-transition",
          role: "assistant",
          content: "",
          createdAt: "2026-08-15T10:00:00.000Z",
          parts: [{
            type: "tool-invocation",
            content: "Task: Validate the implementation",
            toolName: "task",
            toolUseId: "cursor-subagent-1",
            toolState: "success",
            agentState,
            toolArgs: { description: "Validate the implementation" },
          }],
        }],
      });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={identity("cursor")}
          isActive
          refreshRequestId={1}
        />,
      );

      await waitFor(() => expect(
        useNativeAgentProjectionStore.getState().projections.get(
          createSessionKey("env-1", tabId),
        )?.messages[0],
      ).toMatchObject({
        parts: [expect.objectContaining({ agentState })],
      }));
      expect(await screen.findByRole("status", {
        name: `Validate the implementation ${announcementState}.`,
      })).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
    });

    /** One assistant row carrying `count` identically-labelled active children. */
    function subagentMessage(
      count: number,
      state: (index: number) => "active" | "finished" | "failed",
    ): NativeMessage {
      return {
        id: "assistant-many-subagents",
        role: "assistant",
        content: "Parent response complete",
        createdAt: "2026-08-15T10:00:00.000Z",
        parts: Array.from({ length: count }, (_unused, index) => ({
          type: "tool-invocation" as const,
          content: "Task",
          toolName: "task",
          toolUseId: `shared-label-task-${index}`,
          toolState: "success" as const,
          agentState: state(index),
          toolArgs: { description: "Sub-agent" },
        })),
      };
    }

    test("announces the plural active summary and a simultaneous finish and start", async () => {
      seedProjection({
        messages: [subagentMessage(2, () => "active")],
      });

      const view = render(
        <AgentNativeTab
          tabId="tab-plural-subagents"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );

      expect(await screen.findByRole("status", {
        name: "2 sub-agents working: Sub-agent, Sub-agent.",
      })).toBeTruthy();

      // The first child finishes in the same update that starts a third one, so
      // the lifecycle line and the refreshed summary must both be announced.
      seedProjection({
        messages: [subagentMessage(3, (index) => index === 0 ? "finished" : "active")],
      });
      view.rerender(
        <AgentNativeTab
          tabId="tab-plural-subagents"
          data={identity("cursor")}
          isActive
          refreshRequestId={1}
        />,
      );

      expect(await screen.findByRole("status", {
        name: "Sub-agent finished. 2 sub-agents working: Sub-agent, Sub-agent.",
      })).toBeTruthy();
    });

    test("re-announces an identical lifecycle message for a second child", async () => {
      // Both children resolve to the same label, so the second "finished" line is
      // byte-identical to the first. It still has to reach the live region.
      seedProjection({ messages: [subagentMessage(2, () => "active")] });

      const view = render(
        <AgentNativeTab
          tabId="tab-repeat-announcement"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );
      await screen.findByRole("status", {
        name: "2 sub-agents working: Sub-agent, Sub-agent.",
      });

      const liveRegionText = () => screen
        .getByRole("status", { name: /Sub-agent/ })
        .firstElementChild;

      seedProjection({
        messages: [subagentMessage(2, (index) => index === 0 ? "finished" : "active")],
      });
      view.rerender(
        <AgentNativeTab
          tabId="tab-repeat-announcement"
          data={identity("cursor")}
          isActive
          refreshRequestId={1}
        />,
      );
      const firstFinish = await screen.findByRole("status", {
        name: "Sub-agent finished.",
      });
      const firstNode = liveRegionText();

      seedProjection({ messages: [subagentMessage(2, () => "finished")] });
      view.rerender(
        <AgentNativeTab
          tabId="tab-repeat-announcement"
          data={identity("cursor")}
          isActive
          refreshRequestId={2}
        />,
      );

      await waitFor(() => expect(liveRegionText() === firstNode).toBe(false));
      expect(screen.getByRole("status", { name: "Sub-agent finished." })).toBe(firstFinish);
      expect(liveRegionText()?.textContent).toBe("Sub-agent finished.");
    });

    test("keeps pinned cards rendered and reserves their clearance", async () => {
      // The guard that stops an empty pinned wrapper reserving dock height must
      // not also hide real cards; it is derived from the same list that renders.
      seedProjection({
        notices: [{ kind: "warning", message: "Recovered provider notice" }],
      });

      render(
        <AgentNativeTab
          tabId="tab-pinned-notice"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );

      const notice = await screen.findByText("Recovered provider notice");
      expect(screen.getByTestId("compose-dock").contains(notice)).toBe(true);
      expect(screen.getByTestId("transcript-bottom-spacer").className)
        .not.toContain("h-32");
    });

    test("renders an unavailable context wheel when the provider reports no maximum", async () => {
      seedProjection({
        contextUsage: {
          usedTokens: 222,
          inputTokens: 200,
          outputTokens: 22,
          source: "provider",
        },
      });
      render(<AgentNativeTab tabId="tab-unbounded-usage" data={identity("grok")} isActive />);

      expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /Context window/ }) === null).toBe(true);
      });
    });

    test("renders the context wheel from the percentage the provider reported", async () => {
      seedProjection({
        contextUsage: {
          usedTokens: 15_675,
          maximumTokens: 500_000,
          // Deliberately not 3%: the provider's own figure must win over the
          // ratio this component could derive from the two token counts.
          percentage: 42,
          source: "provider",
        },
      });
      render(<AgentNativeTab tabId="tab-bounded-usage" data={identity("grok")} isActive />);

      expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Context window 42% used" })).toBeTruthy();
    });

    test("renders the context wheel before the stop button during a running turn", async () => {
      seedProjection({
        phase: "running",
        contextUsage: {
          usedTokens: 210_000,
          maximumTokens: 500_000,
          percentage: 42,
          source: "provider",
        },
      });
      render(<AgentNativeTab tabId="tab-running-usage" data={identity("grok")} isActive />);

      const contextWheel = await screen.findByRole("button", {
        name: "Context window 42% used",
      });
      const stopButton = screen.getByTitle("Stop current query");
      expect(
        contextWheel.compareDocumentPosition(stopButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    test("derives the context wheel percentage when the provider reports only a maximum", async () => {
      seedProjection({
        contextUsage: {
          usedTokens: 15_675,
          maximumTokens: 500_000,
          source: "provider",
        },
      });
      render(<AgentNativeTab tabId="tab-derived-usage" data={identity("grok")} isActive />);

      expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Context window 3% used" })).toBeTruthy();
    });

    test("routes a running-turn /steer to the session action instead of the queue", async () => {
      seedProjection({ phase: "running", actions: { steer: true } });
      render(<AgentNativeTab tabId="tab-steer" data={identity("codex")} isActive />);

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "/steer keep the diff small" } });
      await waitFor(() => expect(
        useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", "tab-steer"))?.text,
      ).toBe("/steer keep the diff small"));

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalled());
      expect(performNativeAgentSessionActionMock.mock.calls.at(-1)?.[0]).toMatchObject({
        agent: "codex",
        action: { kind: "steer", text: "keep the diff small" },
      });
      // The steering text must not also be queued as a follow-up prompt.
      expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    });

    test("reuses the request id when a steer could not be confirmed", async () => {
      seedProjection({ phase: "running", actions: { steer: true } });
      performNativeAgentSessionActionMock.mockImplementation(
        async () => ({ outcome: "unknown" as const }) as never,
      );
      render(<AgentNativeTab tabId="tab-steer-retry" data={identity("codex")} isActive />);

      const input = await screen.findByRole("textbox");
      const steer = async () => {
        fireEvent.input(input, { target: { textContent: "/steer narrow the scope" } });
        await waitFor(() => expect(
          useNativeComposeStore.getState().drafts
            .get(createSessionKey("env-1", "tab-steer-retry"))?.text,
        ).toBe("/steer narrow the scope"));
        fireEvent.keyDown(input, { key: "Enter" });
      };

      await steer();
      await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
      await screen.findByText(/reuses the same request id/);
      await steer();
      await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(2));

      const [first, second] = performNativeAgentSessionActionMock.mock.calls;
      // An unconfirmed action may already have reached the provider; resending
      // the same text must deduplicate rather than steer the turn twice.
      expect((second?.[0].action as { requestId?: string }).requestId)
        .toBe((first?.[0].action as { requestId?: string }).requestId);
      performNativeAgentSessionActionMock.mockImplementation(
        async () => ({ outcome: "applied" as const }),
      );
    });

    test("keeps /steer an ordinary prompt for a provider that cannot steer", async () => {
      seedProjection({ phase: "running" });
      render(<AgentNativeTab tabId="tab-no-steer" data={identity("claude")} isActive />);

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "/steer nope" } });
      await waitFor(() => expect(
        useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", "tab-no-steer"))?.text,
      ).toBe("/steer nope"));
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalled());
      expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
    });

    test("offers both attach and mention for a provider that accepts files", async () => {
      seedProjection();
      render(<AgentNativeTab tabId="tab-attach" data={identity("claude")} isActive />);

      fireEvent.pointerDown(await screen.findByRole("button", { name: "Add attachment" }));
      expect(await screen.findByRole("menuitem", { name: "Attach file from workspace" }))
        .toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Mention file from workspace" }))
        .toBeTruthy();
    });

    test("cycles conversation mode with Shift+Tab", async () => {
      seedProjection();
      render(<AgentNativeTab tabId="tab-mode" data={identity("codex")} isActive />);

      const input = await screen.findByRole("textbox");
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { mode: "plan" },
      });
    });

    test("keeps advanced session settings out of the input bar", async () => {
      seedProjection({
        composer: {
          executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      });
      render(<AgentNativeTab tabId="tab-settings" data={identity("claude")} isActive />);

      await screen.findByRole("textbox");
      expect(screen.queryByRole("combobox", { name: "Execution profile" }) === null).toBe(true);
      expect(screen.queryByText("Provider default") === null).toBe(true);
      expect(screen.queryByText("Local settings") === null).toBe(true);
      expect(screen.queryByText("Suggestions") === null).toBe(true);
    });

    test("uses a projection updated by the separate settings surface for the next prompt", async () => {
      seedProjection({
        composer: {
          executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
          includeLocalSettings: false,
          promptSuggestionsEnabled: false,
        },
      });
      const tabId = "tab-external-settings";
      const sessionKey = createSessionKey("env-1", tabId);
      render(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
      const input = await screen.findByRole("textbox");
      const initial = useNativeAgentProjectionStore.getState().projections.get(sessionKey)!;

      act(() => {
        useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
          ...initial,
          revision: initial.revision + 1,
          composer: {
            ...initial.composer!,
            selectedExecutionProfileId: "reviewer",
            includeLocalSettings: true,
            promptSuggestionsEnabled: true,
          },
        });
      });
      fireEvent.input(input, { target: { textContent: "use the new settings" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prompt: "use the new settings",
        subAgent: "reviewer",
        includeLocalSettings: true,
        promptSuggestions: true,
      });
    });

    test("offers to load earlier messages when the transcript is windowed", async () => {
      seedProjection({ messageWindow: { limit: 512, truncated: true } });
      render(<AgentNativeTab tabId="tab-window" data={identity("opencode")} isActive />);

      fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
      await waitFor(() => expect(
        getNativeAgentProjectionMock.mock.calls.some(
          (call) => call[0].messageLimit === 1024,
        ),
      ).toBe(true));
    });

    test("refuses to load a queued prompt over an occupied composer", async () => {
      seedProjection({
        queue: { items: [{ id: "queued-1", text: "second prompt" }] },
      });
      render(<AgentNativeTab tabId="tab-queue" data={identity("claude")} isActive />);

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "half-written message" } });
      await waitFor(() => expect(
        useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", "tab-queue"))?.text,
      ).toBe("half-written message"));

      fireEvent.click(await screen.findByTitle("View queued prompts"));
      fireEvent.click(await screen.findByTitle("Click to edit this message"));

      await waitFor(() => expect(removePromptQueueMessageMock).not.toHaveBeenCalled());
      expect(
        useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", "tab-queue"))?.text,
      ).toBe("half-written message");
    });

    test("shows provider status and detail in the shared resume picker", async () => {
      // An empty transcript centers the composer, where the picker's entry
      // point is the visible one.
      seedProjection({ messages: [] });
      listNativeAgentResumableSessionsMock.mockImplementation(async () => [
        {
          sessionId: "older-session",
          title: "Earlier work",
          updatedAt: "2026-08-01T00:00:00.000Z",
          status: "running" as const,
          detail: "12 messages",
        },
      ] as never);
      render(<AgentNativeTab tabId="tab-resume-detail" data={identity("claude")} isActive />);

      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      expect(within(dialog).getByText("Earlier work")).toBeTruthy();
      expect(within(dialog).getByText("12 messages")).toBeTruthy();
      expect(within(dialog).getByText(/Running/)).toBeTruthy();
    });

    test("passes the complete composer control set when resuming", async () => {
      seedProjection({
        messages: [],
        composer: {
          selectedModelId: "model-a",
          selectedReasoningId: "high",
          selectedModeId: "plan",
          fastModeEnabled: true,
          selectedExecutionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      });
      listNativeAgentResumableSessionsMock.mockImplementation(async () => [{
        sessionId: "older-session",
        title: "Earlier work",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }] as never);
      render(<AgentNativeTab tabId="tab-resume-controls" data={identity("claude")} isActive />);

      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      fireEvent.click(within(dialog).getByRole("button", { name: /Earlier work/ }));
      await waitFor(() => expect(resumeNativeAgentSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: "older-session",
          controls: {
            modelId: "model-a",
            reasoningId: "high",
            mode: "plan",
            fastMode: true,
            executionProfileId: "reviewer",
            includeLocalSettings: true,
            promptSuggestions: true,
          },
        }),
      ));
    });

    test("dismisses an accepted suggestion for any provider that tracks them", async () => {
      seedProjection({ suggestedPrompt: "Run the tests", promptSuggestions: true });
      render(<AgentNativeTab tabId="tab-suggest" data={identity("claude")} isActive />);

      fireEvent.click(await screen.findByRole("button", { name: /Suggested: Run the tests/ }));
      await waitFor(() => expect(dismissNativeAgentSuggestedPromptMock).toHaveBeenCalledTimes(1));
      expect(
        useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", "tab-suggest"))?.text,
      ).toBe("Run the tests");
    });

    test("retries an ambiguous dispatch through the backend-owned replay", async () => {
      seedProjection({
        recoverableDispatch: {
          requestId: "recoverable-1",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      });
      render(<AgentNativeTab tabId="tab-recoverable" data={identity("codex")} isActive />);

      fireEvent.click(await screen.findByRole("button", { name: "Retry send" }));
      await waitFor(() => expect(retryNativeAgentDispatchMock).toHaveBeenCalledWith({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: createSessionKey("env-1", "tab-recoverable"),
        requestId: "recoverable-1",
      }));
    });
  });
});
