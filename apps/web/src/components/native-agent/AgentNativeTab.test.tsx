/**
 * Contract suite for the single pane-level native agent tab.
 *
 * Every provider exercises the shared authoritative-projection path.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentSessionProjection, NativeAgentTabData } from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { getNativeAgentData } from "@/types/paneLayout";
import { createSessionKey } from "@/lib/utils";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";

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
const dispatchNativeAgentIntentMock = mock(async (input: { requestId: string }) => ({
  outcome: "accepted" as const,
  requestId: input.requestId,
}));
const stopNativeAgentSessionMock = mock(async () => getNativeAgentProjectionMock({
  agent: "claude",
  environmentId: "env-1",
}));
const getNativeAgentProjectionMock = mock(async (input: {
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  environmentId: string;
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
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentModelCatalog: getNativeAgentModelCatalogMock,
  awaitBridgeReady: awaitBridgeReadyMock,
  adoptNativeAgentSession: adoptNativeAgentSessionMock,
  ensureNativeAgentSession: ensureNativeAgentSessionMock,
  listNativeAgentResumableSessions: listNativeAgentResumableSessionsMock,
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  stopNativeAgentSession: stopNativeAgentSessionMock,
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
  getNativeAgentProjection: getNativeAgentProjectionMock,
}));
mock.module("@/lib/pane-layout-persistence", () => ({
  ...realPaneLayoutPersistenceSnapshot,
  flushPaneLayoutNow: flushPaneLayoutNowMock,
}));

const { AgentNativeTab } = await import("./AgentNativeTab");

beforeEach(() => {
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
  dispatchNativeAgentIntentMock.mockClear();
  stopNativeAgentSessionMock.mockClear();
  getNativeAgentProjectionMock.mockClear();
  useEnvironmentStore.setState({ environments: [] });
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

describe("AgentNativeTab", () => {
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

  test("asks for a platform before opening that provider's normal resume flow", async () => {
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
    expect(within(dialog).getByRole("button", { name: /OpenCode/ })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /Codex/ }));

    expect(await screen.findByRole("dialog", { name: "Resume session" })).toBeTruthy();
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

    expect(screen.getByRole("menuitemradio", { name: /OpenCode A/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /OpenCode Go B/ })).toBeTruthy();
    expect(screen.getByText("OpenCode/opencode")).toBeTruthy();
    expect(screen.getByText("OpenCode/opencode-go")).toBeTruthy();
  });

  test("renders the cached Cursor catalogue without starting its ACP bridge", async () => {
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
    expect(screen.getByRole("menuitemradio", { name: /Composer 2.5/ })).toBeTruthy();
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
    expect(screen.queryByText("No models available")).toBeNull();
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

    expect(await screen.findByRole("dialog", { name: "Resume session" })).toBeTruthy();
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
});
