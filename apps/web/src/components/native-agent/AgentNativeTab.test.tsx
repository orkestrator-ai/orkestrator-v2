/**
 * Contract suite for the single pane-level native agent tab.
 *
 * `adapter.test.ts` only checks that every platform *has* a `loadController`.
 * This file actually invokes all five of them, because the wiring they perform
 * — which module is imported, and what identity shape the controller receives
 * — is not observable from the registry alone.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentTabData } from "@orkestrator/protocol/native-agent";
import * as realClaudeChatTab from "@/components/claude/ClaudeChatTab";
import * as realCodexChatTab from "@/components/codex/CodexChatTab";
import * as realOpenCode from "@/components/opencode";
import * as realAcp from "@/components/acp";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { getNativeAgentData } from "@/types/paneLayout";
import { createSessionKey } from "@/lib/utils";

// Snapshot before installing the stubs so the real modules are restored for
// any suite that runs after this file in the same module registry.
const realClaudeChatTabSnapshot = { ...realClaudeChatTab };
const realCodexChatTabSnapshot = { ...realCodexChatTab };
const realOpenCodeSnapshot = { ...realOpenCode };
const realAcpSnapshot = { ...realAcp };
const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const flushPaneLayoutNowMock = mock(async () => {});
const getNativeAgentModelCatalogMock = mock(
  async (_environmentId: string): ReturnType<typeof realBackend.getNativeAgentModelCatalog> => [],
);

/** Renders the identity it was handed so the projection can be asserted. */
function stubController(testId: string) {
  return ({
    tabId,
    data,
    initialResumeOpen,
  }: {
    tabId: string;
    data: Record<string, unknown>;
    initialResumeOpen?: boolean;
  }) => (
    <div
      data-testid={testId}
      data-tab-id={tabId}
      data-payload={JSON.stringify(data)}
      data-initial-resume-open={String(initialResumeOpen ?? false)}
    />
  );
}

mock.module("@/components/claude/ClaudeChatTab", () => ({
  ClaudeChatTab: stubController("claude-controller"),
}));
mock.module("@/components/codex/CodexChatTab", () => ({
  CodexChatTab: stubController("codex-controller"),
}));
mock.module("@/components/opencode", () => ({
  OpenCodeChatTab: stubController("opencode-controller"),
}));
mock.module("@/components/acp", () => ({
  AcpChatTab: stubController("acp-controller"),
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentModelCatalog: getNativeAgentModelCatalogMock,
}));
mock.module("@/lib/pane-layout-persistence", () => ({
  ...realPaneLayoutPersistenceSnapshot,
  flushPaneLayoutNow: flushPaneLayoutNowMock,
}));

const { AgentNativeTab } = await import("./AgentNativeTab");

afterEach(() => {
  cleanup();
  flushPaneLayoutNowMock.mockClear();
  getNativeAgentModelCatalogMock.mockReset();
  getNativeAgentModelCatalogMock.mockImplementation(async () => []);
  useEnvironmentStore.setState({ environments: [] });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeComposeStore.setState({ drafts: new Map() });
});

afterAll(() => {
  mock.module("@/components/claude/ClaudeChatTab", () => realClaudeChatTabSnapshot);
  mock.module("@/components/codex/CodexChatTab", () => realCodexChatTabSnapshot);
  mock.module("@/components/opencode", () => realOpenCodeSnapshot);
  mock.module("@/components/acp", () => realAcpSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/pane-layout-persistence", () => realPaneLayoutPersistenceSnapshot);
});

const controllerTestIds: Record<string, string> = {
  claude: "claude-controller",
  codex: "codex-controller",
  opencode: "opencode-controller",
  cursor: "acp-controller",
  grok: "acp-controller",
};

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
  const data = usePaneLayoutStore((state) => {
    const root = state.environments.get("env-1")?.root;
    if (!root || root.kind !== "leaf") return undefined;
    const tab = root.tabs.find((candidate) => candidate.id === tabId);
    return tab ? getNativeAgentData(tab) ?? undefined : undefined;
  });
  if (!data) return null;
  return <AgentNativeTab tabId={tabId} data={data} isActive />;
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
    for (const testId of Object.values(controllerTestIds)) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
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

    const controller = await screen.findByTestId("codex-controller");
    expect(controller.dataset.initialResumeOpen).toBe("true");
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

    render(
      <AgentNativeTab
        tabId="tab-first-prompt"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
    const root = usePaneLayoutStore.getState().environments.get("env-1")?.root;
    expect(root?.kind).toBe("leaf");
    if (!root || root.kind !== "leaf") throw new Error("Expected leaf pane");
    const tab = root.tabs.find((candidate) => candidate.id === "tab-first-prompt");
    expect(tab?.initialPrompt).toContain("[@widget.ts](src/widget.ts)");
    expect(tab?.initialPrompt).toContain("layout.png: /workspace/.orkestrator/clipboard/layout.png");
    expect(getNativeAgentData(tab!)?.platform).toBe("claude");
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

    expect(await screen.findByTestId("claude-controller")).toBeTruthy();
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

    const controller = await screen.findByTestId("codex-controller");
    expect(controller.dataset.initialResumeOpen).toBe("true");
    expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(2);
  });

  for (const platform of AGENT_PLATFORMS) {
    test(`loads the ${platform} controller and hands it the canonical identity`, async () => {
      render(
        <AgentNativeTab
          tabId={`tab-${platform}`}
          data={identity(platform)}
          isActive
        />,
      );

      const controller = await screen.findByTestId(controllerTestIds[platform]!);
      expect(controller.dataset.tabId).toBe(`tab-${platform}`);

      const payload = JSON.parse(controller.dataset.payload!);
      expect(payload).toMatchObject({
        platform,
        environmentId: "env-1",
        containerId: "container-1",
        sessionId: `${platform}-session`,
        isLocal: false,
      });
      expect(payload).not.toHaveProperty("provider");
    });
  }

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
    expect(screen.queryByTestId("claude-controller")).toBeNull();
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

  test("swaps controllers when a tab's platform changes", async () => {
    const { rerender } = render(
      <AgentNativeTab tabId="tab-swap" data={identity("codex")} isActive />,
    );
    expect(await screen.findByTestId("codex-controller")).toBeTruthy();

    rerender(
      <AgentNativeTab tabId="tab-swap" data={identity("opencode")} isActive />,
    );

    expect(await screen.findByTestId("opencode-controller")).toBeTruthy();
    expect(screen.queryByTestId("codex-controller")).toBeNull();
  });
});
