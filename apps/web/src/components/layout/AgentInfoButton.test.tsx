import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useConfigStore } from "@/stores/configStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import type { TabInfo } from "@/types/paneLayout";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeAgentCapabilities,
  type NativeAgentAccountUsageWindow,
  type NativeAgentControlUpdate,
  type NativeAgentForkOutcome,
  type NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  createAgentHandoffSnapshot,
  loadAgentHandoff,
  rememberAgentHandoff,
  resetAgentHandoffCache,
} from "@/lib/agent-handoff";
import {
  mockToastError,
  mockToastInfo,
  mockToastDismiss,
  mockToastSuccess,
  mockToastWarning,
} from "../../../../../tests/mocks/sonner";
import { createSessionKey } from "@/lib/utils";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";

/*
 * No provider has a renderer-side client: every control on a native tab goes
 * through the backend's native-agent session actions and projection.
 */
const mockNativeAction = mock<
  (action: { kind: string; messageId?: string; dryRun?: boolean; modelId?: string }) => Promise<{
    outcome: "applied";
    shareUrl?: string;
    preview?: unknown;
  }>
>(async () => ({ outcome: "applied" }));
const mockNativeFork = mock<() => Promise<NativeAgentForkOutcome>>(async () => ({
  sessionId: "opencode-fork",
  title: "OpenCode fork title",
}));
const mockNativeControls = mock<
  (update: NativeAgentControlUpdate) => Promise<NativeAgentSessionProjection | null>
>(async () => null);
const mockStopBackgroundTask = mock<(taskId: string) => Promise<void>>(async () => undefined);
/** By default the backend answers whatever projection the store holds. */
const readStoredProjection = async () =>
  useNativeAgentProjectionStore.getState().projections.get(SESSION_KEY) ?? null;
const mockNativeProjectionRead =
  mock<(args?: { refreshUsage?: boolean }) => Promise<NativeAgentSessionProjection | null>>(
    readStoredProjection,
  );

const { SYSTEM_USAGE_STALE_AFTER_MS } = await import("@/hooks/useSystemUsage");
const {
  AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS,
  AgentInfoButton,
  describeRewindTarget,
  formatResetDateTime,
  labelWindowMinutes,
  limitWindowPosition,
  summarizeRewindPreview,
  windowDurationMinutes,
} = await import("./AgentInfoButton");

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
/** Every provider's tab in this suite shares one environment and tab id. */
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const CLAUDE_KEY = SESSION_KEY;
const CODEX_KEY = SESSION_KEY;
const OPENCODE_KEY = SESSION_KEY;
const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

function nativeProjection(
  platform: AgentPlatform,
  sessionId: string,
  overrides: Partial<NativeAgentSessionProjection> = {},
): NativeAgentSessionProjection {
  return {
    platform,
    environmentId: ENVIRONMENT_ID,
    sessionId,
    connection: "connected",
    turn: { phase: "idle" },
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hi",
        parts: [{ type: "text", content: "hi" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      },
    ],
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities(platform),
    revision: 1,
    generation: `${platform}-generation`,
    ...overrides,
  };
}

function openCodeProjection(
  sessionId = "opencode-session-1",
  overrides: Partial<NativeAgentSessionProjection> = {},
): NativeAgentSessionProjection {
  return nativeProjection("opencode", sessionId, overrides);
}

/** Routes the backend commands a native tab issues to this suite's mocks. */
function routeNativeCommands() {
  nativeInvokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "perform_native_agent_session_action") {
      return mockNativeAction((args as { action: { kind: string; messageId?: string } }).action);
    }
    if (command === "fork_native_agent_session") return mockNativeFork();
    if (command === "get_native_agent_projection") {
      return mockNativeProjectionRead(args as { refreshUsage?: boolean } | undefined);
    }
    if (command === "update_native_agent_controls") {
      return mockNativeControls((args as { update: NativeAgentControlUpdate }).update);
    }
    if (command === "stop_native_agent_background_task") {
      return mockStopBackgroundTask((args as { taskId: string }).taskId);
    }
    if (command === "get_cursor_account_usage") return new Promise(() => undefined);
    return undefined;
  });
}

/**
 * Publishes a provider's projection and routes the backend commands its tab
 * issues. Projection reads answer whatever the store currently holds, so a test
 * that swaps the session sees the panel's refresh agree with it.
 */
function seedNativeProjection(
  platform: AgentPlatform,
  sessionId: string,
  overrides: Partial<NativeAgentSessionProjection> = {},
) {
  useNativeAgentProjectionStore
    .getState()
    .setProjection(SESSION_KEY, nativeProjection(platform, sessionId, overrides));
  routeNativeCommands();
}

function seedOpenCodeProjection(
  sessionId = "opencode-session-1",
  overrides: Partial<NativeAgentSessionProjection> = {},
) {
  seedNativeProjection("opencode", sessionId, overrides);
}

function seedClaudeProjection(overrides: Partial<NativeAgentSessionProjection> = {}) {
  seedNativeProjection("claude", "claude-session-1", overrides);
}

function seedCodexProjection(overrides: Partial<NativeAgentSessionProjection> = {}) {
  seedNativeProjection("codex", "codex-session-1", overrides);
}

/**
 * The projection's usage reading for a renderer snapshot: the backend reports
 * the window as `maximumTokens`/`percentage`, and the panel derives the rest.
 */
function projectionUsage(
  snapshot: ContextUsageSnapshot,
): NonNullable<NativeAgentSessionProjection["contextUsage"]> {
  return {
    ...snapshot,
    ...(snapshot.totalTokens !== undefined ? { maximumTokens: snapshot.totalTokens } : {}),
    ...(snapshot.percentUsed !== undefined ? { percentage: snapshot.percentUsed } : {}),
  } as NonNullable<NativeAgentSessionProjection["contextUsage"]>;
}

/** Publish a usage snapshot on the active tab's projection. */
function seedUsage(
  snapshot: ContextUsageSnapshot,
  platform: AgentPlatform = "claude",
  overrides: Partial<NativeAgentSessionProjection> = {},
) {
  seedNativeProjection(platform, `${platform}-session-1`, {
    contextUsage: projectionUsage(snapshot),
    ...overrides,
  });
}

function composerState(
  overrides: Partial<NonNullable<NativeAgentSessionProjection["composer"]>> = {},
): NonNullable<NativeAgentSessionProjection["composer"]> {
  return {
    models: [],
    fastModeEnabled: false,
    fastModeAvailable: false,
    modes: [],
    includeLocalSettings: false,
    promptSuggestionsEnabled: false,
    ...overrides,
  };
}

function nativeActionKinds(): string[] {
  return mockNativeAction.mock.calls.map(([action]) => action.kind);
}

function claudeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: TAB_ID,
    type: "agent-native",
    nativeAgentData: {
      platform: "claude",
      environmentId: ENVIRONMENT_ID,
      sessionId: "claude-session-1",
    },
    ...overrides,
  } as TabInfo;
}

function codexTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: TAB_ID,
    type: "agent-native",
    nativeAgentData: {
      platform: "codex",
      environmentId: ENVIRONMENT_ID,
      containerId: "container-1",
      isLocal: false,
    },
    ...overrides,
  } as TabInfo;
}

function openCodeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: TAB_ID,
    type: "agent-native",
    nativeAgentData: {
      platform: "opencode",
      environmentId: ENVIRONMENT_ID,
      containerId: "container-1",
      isLocal: false,
    },
    ...overrides,
  } as TabInfo;
}

function cursorTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: TAB_ID,
    type: "agent-native",
    nativeAgentData: {
      platform: "cursor",
      environmentId: ENVIRONMENT_ID,
      containerId: "container-1",
      isLocal: false,
    },
    ...overrides,
  } as TabInfo;
}

function buildTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: "build-tab",
    type: "claude-build",
    buildTabData: {
      environmentId: ENVIRONMENT_ID,
      pipelineId: "pipeline-1",
      taskId: "task-1",
      isLocal: true,
    },
    ...overrides,
  } as TabInfo;
}

function usage(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    usedTokens: 25_000,
    totalTokens: 100_000,
    percentUsed: 25,
    estimated: false,
    source: "claude",
    updatedAt: "2026-07-26T12:00:00.000Z",
    ...overrides,
  };
}

function buildStageProjection(
  platform: "claude" | "codex" | "opencode",
  sessionId: string,
): NativeAgentSessionProjection {
  return {
    platform,
    environmentId: ENVIRONMENT_ID,
    sessionId,
    connection: "connected",
    turn: { phase: "running" },
    messages: [
      {
        id: "build-user-message",
        role: "user",
        content: "Build the feature",
        parts: [{ type: "text", content: "Build the feature" }],
        createdAt: "2026-09-08T10:00:00.000Z",
      },
    ],
    interactions: [],
    composerControls: [],
    composer: {
      models: [],
      fastModeEnabled: false,
      fastModeAvailable: false,
      modes: [],
      executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
      includeLocalSettings: false,
      promptSuggestionsEnabled: false,
    },
    capabilities: nativeAgentCapabilities(platform),
    revision: 1,
    generation: `${platform}-build-generation`,
  };
}

function seedPaneLayout() {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [claudeTab()],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    activeEnvironmentId: ENVIRONMENT_ID,
  } as never);
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
}

/** Publish one account window list as the active Claude tab's usage snapshot. */
function seedDailyUsage(account: NativeAgentAccountUsageWindow[]) {
  seedUsage(usage({ account }));
}

/** `count` consecutive UTC days from 2026-08-01, newest last, as the provider reports them. */
function dailyBuckets(
  count: number,
  tokensFor: (index: number) => number,
): NativeAgentAccountUsageWindow[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 1 + index)).toISOString().slice(0, 10);
    return { window: `daily:${date}`, label: date, tokens: tokensFor(index) };
  });
}

/** Open the panel from either state — several actions deliberately leave it open. */
function reopen() {
  const trigger = screen.queryByRole("button", { name: "Open agent information" });
  if (trigger) {
    fireEvent.click(trigger);
    return;
  }
  // Already open: close via the trigger, then open again.
  fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
  open();
}

/**
 * The section is always mounted — visibility is `aria-hidden` plus classes —
 * so it is fetched by id rather than by role. `aria-hidden` also removes it
 * from the accessibility tree, which is asserted separately.
 */
function popover(): HTMLElement {
  const element = document.getElementById("agent-information-popover");
  expect(element).toBeTruthy();
  return element!;
}

function isPopoverOpen(): boolean {
  return popover().getAttribute("aria-hidden") === "false";
}

function metricValue(label: string): string | undefined {
  return (
    screen.getByText(label).parentElement?.querySelector("div.font-mono")?.textContent ?? undefined
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

let confirmResult = true;
let confirmMessages: string[] = [];
let clipboardWrites: string[] = [];
let clipboardRejection: Error | null = null;
const originalConfirm = window.confirm;

beforeEach(() => {
  useNativeAgentProjectionStore.getState().reset();
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
    viewedSessionIds: new Map(),
  });
  confirmResult = true;
  confirmMessages = [];
  clipboardWrites = [];
  clipboardRejection = null;
  nativeInvokeMock.mockClear();
  nativeInvokeMock.mockImplementation((command: string) =>
    command === "get_cursor_account_usage" ? new Promise(() => undefined) : Promise.resolve(),
  );

  window.confirm = ((message?: string) => {
    confirmMessages.push(message ?? "");
    return confirmResult;
  }) as typeof window.confirm;

  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        if (clipboardRejection) throw clipboardRejection;
        clipboardWrites.push(value);
      },
    },
  });

  mockNativeAction.mockClear();
  mockNativeFork.mockClear();
  mockNativeControls.mockClear();
  mockStopBackgroundTask.mockClear();
  mockNativeProjectionRead.mockClear();
  mockNativeProjectionRead.mockImplementation(readStoredProjection);
  mockNativeAction.mockImplementation(async (action) =>
    action.kind === "share"
      ? { outcome: "applied", shareUrl: "https://share.opencode.test/abc" }
      : { outcome: "applied" },
  );
  mockNativeFork.mockImplementation(async () => ({
    sessionId: "opencode-fork",
    title: "OpenCode fork title",
  }));
  mockNativeControls.mockImplementation(async () => null);
  mockStopBackgroundTask.mockImplementation(async () => undefined);
  resetAgentHandoffCache();

  seedPaneLayout();
});

afterEach(() => {
  cleanup();
  // The host-meter read is shared through the read coordinator; a retained
  // sample must not leak into the next test.
  resetReadCoordinatorForTests();
  window.confirm = originalConfirm;
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  } as never);
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
    viewedSessionIds: new Map(),
  });
});

describe("AgentInfoButton popover lifecycle", () => {
  test("remote mode applies initial and subsequent requests and reports user dismissals", () => {
    const onOpenChange = mock(() => undefined);
    const onDismiss = mock(() => undefined);
    const remote = (seq: number, open: boolean) => ({
      request: { seq, open, inset: 6 },
      onOpenChange,
      onDismiss,
    });
    const { rerender } = render(<AgentInfoButton activeTab={null} remote={remote(1, true)} />);
    const dialog = screen.getByRole("dialog", { name: "Agent information" });
    expect(screen.getByTestId("realm-agent-info-panel")).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("button", { name: "Open agent information" }) === null).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close agent information" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    rerender(<AgentInfoButton activeTab={null} remote={remote(2, true)} />);
    expect(
      screen.getByRole("dialog", { name: "Agent information" }).contains(document.activeElement),
    ).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    rerender(<AgentInfoButton activeTab={null} remote={remote(3, true)} />);
    rerender(<AgentInfoButton activeTab={null} remote={remote(4, false)} />);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  test("shows the tab messages action only while agent messaging is enabled", () => {
    const original = structuredClone(useConfigStore.getState().config);
    const disabled = structuredClone(original);
    disabled.global.agentMessaging = { ...disabled.global.agentMessaging!, enabled: false };
    useConfigStore.setState({ config: disabled });
    try {
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();
      expect(screen.queryByRole("button", { name: "Messages…" }) === null).toBe(true);

      const enabled = structuredClone(disabled);
      enabled.global.agentMessaging = { ...enabled.global.agentMessaging!, enabled: true };
      act(() => useConfigStore.setState({ config: enabled }));
      expect(screen.getByRole("button", { name: "Messages…" })).toBeTruthy();
    } finally {
      act(() => useConfigStore.setState({ config: original }));
    }
  });

  test("the panel is hidden until the trigger is clicked and closes again on a second click", () => {
    render(<AgentInfoButton activeTab={claudeTab()} />);

    /*
     * The section is always in the DOM — `aria-hidden` plus the visibility
     * classes are the state. Closed, it is also absent from the accessibility
     * tree, so both facts are asserted.
     */
    expect(isPopoverOpen()).toBe(false);
    expect(popover().className).toContain("invisible");
    expect(popover().className).toContain("pointer-events-none");
    expect(screen.queryByRole("dialog", { name: "Agent information" }) === null).toBe(true);
    expect(
      screen.getByRole("button", { name: "Open agent information" }).getAttribute("aria-expanded"),
    ).toBe("false");

    open();
    expect(isPopoverOpen()).toBe(true);
    expect(popover().className).toContain("visible");
    expect(screen.getByRole("dialog", { name: "Agent information" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("button", { name: "Close agent information" })[0]!
        .getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
    expect(isPopoverOpen()).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Agent information" }) === null).toBe(true);
  });

  test("the X button closes the panel and returns focus to the trigger", async () => {
    render(<AgentInfoButton activeTab={claudeTab()} />);
    const trigger = screen.getByRole("button", { name: "Open agent information" });
    open();

    // Three controls share the close label once open: the trigger, the
    // backdrop and the X in the header.
    const xButton = screen
      .getAllByRole("button", { name: "Close agent information" })
      .find((button) => button.classList.contains("-mr-1"));
    expect(xButton).toBeTruthy();
    fireEvent.click(xButton!);

    expect(isPopoverOpen()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("the backdrop closes the panel and returns focus to the trigger", async () => {
    const { container } = render(<AgentInfoButton activeTab={claudeTab()} />);
    const trigger = screen.getByRole("button", { name: "Open agent information" });
    open();

    const backdrop = container.querySelector("button.fixed.inset-0");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(isPopoverOpen()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("Escape closes the panel, and a key a nested control consumed does not", () => {
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const consumed = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    consumed.preventDefault();
    act(() => {
      window.dispatchEvent(consumed);
    });
    expect(isPopoverOpen()).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(isPopoverOpen()).toBe(false);
  });

  test("dismissing with Escape consumes the key so the chat tab does not abort the turn", () => {
    /*
     * All three chat tabs bind a window-level Escape handler that aborts the
     * running turn, guarded only by `event.defaultPrevented`. This popover used
     * to close without claiming the key, so dismissing it mid-turn killed the
     * turn. The listener below mimics that guard exactly, and is registered
     * *before* the popover's own so the fix cannot depend on mount order.
     */
    const abortsTurn = mock(() => {});
    const chatTabHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      abortsTurn();
    };
    window.addEventListener("keydown", chatTabHandler);

    try {
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      act(() => {
        window.dispatchEvent(escape);
      });

      expect(isPopoverOpen()).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(abortsTurn).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", chatTabHandler);
    }
  });

  test("a closed panel leaves Escape to the chat tab", () => {
    // The turn-abort shortcut must keep working when nothing is open to dismiss.
    const abortsTurn = mock(() => {});
    const chatTabHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      abortsTurn();
    };
    window.addEventListener("keydown", chatTabHandler);

    try {
      render(<AgentInfoButton activeTab={claudeTab()} />);
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      });
      expect(abortsTurn).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", chatTabHandler);
    }
  });

  test("the Escape listener is torn down when the panel closes", () => {
    const { unmount } = render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(isPopoverOpen()).toBe(false);
    unmount();
  });

  test("switching tabs closes the panel", () => {
    const { rerender } = render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(isPopoverOpen()).toBe(true);

    rerender(<AgentInfoButton activeTab={claudeTab({ id: "tab-2" })} />);
    expect(isPopoverOpen()).toBe(false);
  });

  test("the mobile variant sizes the trigger for touch and stops title-bar drags", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let parentSawMouseDown = false;
    host.addEventListener("mousedown", () => {
      parentSawMouseDown = true;
    });

    const { container } = render(<AgentInfoButton activeTab={null} mobile />, {
      container: host.appendChild(document.createElement("div")),
    });
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("h-9");

    /*
     * Mounted inside a title bar that starts a window drag on every mouse-down,
     * the wrapper has to swallow the event or the button drags the window
     * instead of opening.
     */
    fireEvent.mouseDown(screen.getByRole("button", { name: "Open agent information" }));
    expect(parentSawMouseDown).toBe(false);

    host.remove();
  });
});

describe("AgentInfoButton provider resolution", () => {
  test("shows the empty state when no native tab is active", () => {
    render(<AgentInfoButton activeTab={null} />);
    open();

    expect(screen.getByText("No native agent")).toBeTruthy();
    expect(screen.getByText("Select a native agent tab.")).toBeTruthy();
    expect(screen.queryByText("Session actions") === null).toBe(true);
  });

  test("a tab whose native data is missing is treated as no session", () => {
    render(<AgentInfoButton activeTab={{ id: TAB_ID, type: "agent-native" } as TabInfo} />);
    open();
    expect(screen.getByText("No native agent")).toBeTruthy();
  });

  test("labels an OpenCode session and reads its model from the projection", () => {
    seedOpenCodeProjection("opencode-session-1", {
      contextUsage: {
        usedTokens: 25_000,
        maximumTokens: 100_000,
        percentage: 25,
        source: "opencode",
        estimated: false,
      },
      composer: {
        models: [],
        selectedModelId: "anthropic/claude-sonnet",
        fastModeEnabled: false,
        fastModeAvailable: false,
        modes: [],
        includeLocalSettings: false,
        promptSuggestionsEnabled: false,
      },
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    expect(screen.getByText("OpenCode")).toBeTruthy();
    expect(screen.getByText("anthropic/claude-sonnet")).toBeTruthy();
  });

  test("labels a Codex session and reads its projected model", () => {
    seedUsage(usage({ source: "codex" }), "codex", {
      composer: composerState({ selectedModelId: "gpt-5.3-codex" }),
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    expect(screen.getByText("Codex Native")).toBeTruthy();
    expect(screen.getByText("gpt-5.3-codex")).toBeTruthy();
  });

  test("uses the build tab's selected stage as the active native session", async () => {
    const sessions = [
      {
        phase: "build" as const,
        agent: "codex" as const,
        iteration: 0,
        sessionKey: "pipeline-build-key",
        sdkSessionId: "pipeline-build-session",
        status: "idle" as const,
        startedAt: "2026-09-08T10:00:00.000Z",
        label: "Build Session",
      },
      {
        phase: "verify" as const,
        agent: "opencode" as const,
        iteration: 0,
        sessionKey: "pipeline-verify-key",
        sdkSessionId: "pipeline-verify-session",
        status: "running" as const,
        startedAt: "2026-09-08T10:01:00.000Z",
        label: "Verification Session",
      },
    ];
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          "pipeline-1",
          buildPipelineFixture({
            environmentId: ENVIRONMENT_ID,
            sessions,
            currentSessionIndex: 1,
          }),
        ],
      ]),
      buildEnvironmentIds: new Set([ENVIRONMENT_ID]),
      viewedSessionIds: new Map([["pipeline-1", "pipeline-build-session"]]),
    });
    useNativeAgentProjectionStore.getState().setProjection(
      "pipeline-build-key",
      nativeProjection("codex", "pipeline-build-session", {
        contextUsage: projectionUsage(usage({ source: "codex" })),
        composer: composerState({ selectedModelId: "gpt-5.3-codex" }),
      }),
    );

    render(<AgentInfoButton activeTab={buildTab()} />);
    open();

    expect(screen.getByText("Codex Native")).toBeTruthy();
    expect(screen.getByText("gpt-5.3-codex")).toBeTruthy();
    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith("get_build_pipeline_session_projection", {
        pipelineId: "pipeline-1",
        sessionKey: "pipeline-build-key",
        refreshUsage: true,
      }),
    );
    expect(screen.queryByRole("button", { name: "Messages…" }) === null).toBe(true);
  });

  test("falls back to the current agent session while Tests is selected", async () => {
    const sessions = [
      {
        phase: "build" as const,
        agent: "codex" as const,
        iteration: 0,
        sessionKey: "pipeline-build-key",
        sdkSessionId: "pipeline-build-session",
        status: "idle" as const,
        startedAt: "2026-09-08T10:00:00.000Z",
        label: "Build Session",
      },
      {
        phase: "verify" as const,
        agent: "codex" as const,
        iteration: 0,
        sessionKey: "pipeline-verify-key",
        sdkSessionId: "pipeline-verify-session",
        status: "running" as const,
        startedAt: "2026-09-08T10:01:00.000Z",
        label: "Verification Session",
      },
    ];
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          "pipeline-1",
          buildPipelineFixture({
            environmentId: ENVIRONMENT_ID,
            sessions,
            currentSessionIndex: 1,
            validationRun: {
              id: "validation-1",
              status: "completed",
              startedAt: "2026-09-08T10:00:30.000Z",
              plan: {
                headRef: "a".repeat(40),
                commands: [
                  {
                    id: "test",
                    command: "mise run test",
                    cwd: ".",
                    dependsOn: [],
                    resources: ["turbo"],
                    weight: 2,
                    timeoutMs: 1_200_000,
                  },
                ],
                limitations: [],
              },
              results: [],
            },
          }),
        ],
      ]),
      buildEnvironmentIds: new Set([ENVIRONMENT_ID]),
      viewedSessionIds: new Map([["pipeline-1", "validation:validation-1"]]),
    });
    render(<AgentInfoButton activeTab={buildTab()} />);
    open();

    expect(screen.getByText("Codex Native")).toBeTruthy();
    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith("get_build_pipeline_session_projection", {
        pipelineId: "pipeline-1",
        sessionKey: "pipeline-verify-key",
        refreshUsage: true,
      }),
    );
  });

  test.each([
    ["claude", ["Fork session", "Compact", "Rewind files"]],
    ["codex", ["Fork session", "Compact", "Review changes"]],
    ["opencode", ["Fork session", "Compact", "Undo turn", "Share…", "Redo turn"]],
  ] as const)("keeps %s build-stage mutations hidden after projection", async (agent, actions) => {
    const sessionId = `${agent}-build-session`;
    const sessionKey = `${agent}-build-key`;
    const snapshot = buildPipelineFixture({
      environmentId: ENVIRONMENT_ID,
      agentType: agent,
      sessions: [
        {
          phase: "build",
          agent,
          iteration: 0,
          sessionKey,
          sdkSessionId: sessionId,
          status: "running",
          startedAt: "2026-09-08T10:00:00.000Z",
          label: "Build Session",
        },
      ],
      currentSessionIndex: 0,
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", snapshot]]),
      buildEnvironmentIds: new Set([ENVIRONMENT_ID]),
      viewedSessionIds: new Map(),
    });
    nativeInvokeMock.mockImplementation((command: string) =>
      command === "get_build_pipeline_session_projection"
        ? Promise.resolve(buildStageProjection(agent, sessionId))
        : command === "get_cursor_account_usage"
          ? new Promise(() => undefined)
          : Promise.resolve(),
    );

    render(<AgentInfoButton activeTab={buildTab()} />);
    open();

    await waitFor(() =>
      expect(useNativeAgentProjectionStore.getState().projections.get(sessionKey)?.sessionId).toBe(
        sessionId,
      ),
    );
    for (const action of actions) {
      expect(screen.queryByRole("button", { name: action }) === null).toBe(true);
    }
    expect(screen.queryByText("Execution profile") === null).toBe(true);
    expect(screen.queryByText("Session options") === null).toBe(true);
    expect(screen.queryByText("Active turn") === null).toBe(true);
  });

  test("does not reinspect an unchanged selected stage on pipeline revisions", async () => {
    const session = {
      phase: "build" as const,
      agent: "codex" as const,
      iteration: 0,
      sessionKey: "stable-build-key",
      sdkSessionId: "stable-build-session",
      status: "running" as const,
      startedAt: "2026-09-08T10:00:00.000Z",
      label: "Build Session",
    };
    const snapshot = buildPipelineFixture({
      environmentId: ENVIRONMENT_ID,
      sessions: [session],
      currentSessionIndex: 0,
      backendRevision: 1,
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", snapshot]]),
      buildEnvironmentIds: new Set([ENVIRONMENT_ID]),
      viewedSessionIds: new Map(),
    });
    nativeInvokeMock.mockImplementation((command: string) =>
      command === "get_build_pipeline_session_projection"
        ? Promise.resolve(buildStageProjection("codex", session.sdkSessionId))
        : command === "get_cursor_account_usage"
          ? new Promise(() => undefined)
          : Promise.resolve(),
    );

    render(<AgentInfoButton activeTab={buildTab()} />);
    open();
    await waitFor(() =>
      expect(
        nativeInvokeMock.mock.calls.filter(
          ([command]) => command === "get_build_pipeline_session_projection",
        ),
      ).toHaveLength(1),
    );

    act(() => {
      useBuildPipelineStore
        .getState()
        .replacePipeline({ ...snapshot, backendRevision: 2, taskTitle: "Revision 2" });
      useBuildPipelineStore
        .getState()
        .replacePipeline({ ...snapshot, backendRevision: 3, taskTitle: "Revision 3" });
    });
    await act(async () => Promise.resolve());

    expect(
      nativeInvokeMock.mock.calls.filter(
        ([command]) => command === "get_build_pipeline_session_projection",
      ),
    ).toHaveLength(1);
  });
});

describe("AgentInfoButton usage panel", () => {
  test("shows live system percentages in one row and reveals full names on tap", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_system_usage"
        ? {
            cpuPercent: 12.4,
            ramPercent: 47.8,
            gpuPercent: null,
            diskPercent: 63.2,
            sampledAt: new Date(Date.now()).toISOString(),
          }
        : undefined,
    );

    render(<AgentInfoButton activeTab={claudeTab()} mobile />);
    expect(nativeInvokeMock).not.toHaveBeenCalledWith("get_system_usage");
    open();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Central processing unit (CPU) usage: 12%" }),
      ).toBeTruthy(),
    );
    const system = screen.getByRole("region", { name: "System usage" });
    const metrics = Array.from(system.querySelectorAll("button"));
    expect(metrics.map((metric) => metric.textContent)).toEqual(["12%", "48%", "—", "63%"]);

    fireEvent.mouseEnter(metrics[0]!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Central processing unit (CPU) usage",
    );
    fireEvent.mouseLeave(metrics[0]!);

    fireEvent.click(
      screen.getByRole("button", { name: "Graphics processing unit (GPU) usage: —" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toContain(
        "Graphics processing unit (GPU) usage",
      ),
    );
  });

  test("polls while open, marks an aged sample unavailable, and recovers", async () => {
    const reads = installFakeReadCoordinator();
    const advance = async (ms: number) => {
      await act(async () => {
        await reads.clock.advance(ms);
      });
    };
    let cpuPercent = 12;
    let rejectUsage = false;
    let usageCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_system_usage") return undefined;
      usageCalls += 1;
      if (rejectUsage) throw new Error("backend unavailable");
      return {
        cpuPercent,
        ramPercent: 48,
        gpuPercent: null,
        diskPercent: 63,
        sampledAt: new Date().toISOString(),
      };
    });

    render(<AgentInfoButton activeTab={claudeTab()} />);
    expect(usageCalls).toBe(0);
    open();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Central processing unit (CPU) usage: 12%" }),
      ).toBeTruthy(),
    );
    expect(usageCalls).toBe(1);

    cpuPercent = 27;
    await advance(AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS);
    expect(usageCalls).toBe(2);
    expect(
      screen.getByRole("button", { name: "Central processing unit (CPU) usage: 27%" }),
    ).toBeTruthy();

    // Failures keep the last sample until it ages past the freshness window.
    rejectUsage = true;
    await advance(AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS);
    expect(screen.queryByRole("status") === null).toBe(true);
    await advance(SYSTEM_USAGE_STALE_AFTER_MS);
    expect(screen.getByRole("status").textContent).toBe("Data unavailable");
    expect(
      screen.getByRole("button", { name: "Central processing unit (CPU) usage: —" }),
    ).toBeTruthy();

    rejectUsage = false;
    cpuPercent = 39;
    await advance(30_000);
    expect(screen.queryByRole("status") === null).toBe(true);
    expect(
      screen.getByRole("button", { name: "Central processing unit (CPU) usage: 39%" }),
    ).toBeTruthy();
  });

  test("closing stops its demand, and a read from before closing never overwrites a newer one", async () => {
    const reads = installFakeReadCoordinator();
    const firstUsage = deferred<Record<string, unknown>>();
    let usageCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_system_usage") return undefined;
      usageCalls += 1;
      if (usageCalls === 1) return firstUsage.promise;
      return {
        cpuPercent: 44,
        ramPercent: 48,
        gpuPercent: null,
        diskPercent: 63,
        sampledAt: new Date().toISOString(),
      };
    });

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    await waitFor(() => expect(usageCalls).toBe(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
    // No subscriber is left, so the key schedules nothing.
    await act(async () => {
      await reads.clock.advance(AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS * 3);
    });
    expect(usageCalls).toBe(1);

    firstUsage.resolve({
      cpuPercent: 11,
      ramPercent: 22,
      gpuPercent: null,
      diskPercent: 33,
      sampledAt: new Date().toISOString(),
    });
    await act(async () => {
      await firstUsage.promise;
    });
    open();
    // The retained sample is older than the popover's cadence: one fresh read.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Central processing unit (CPU) usage: 44%" }),
      ).toBeTruthy(),
    );
    expect(usageCalls).toBe(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
    await act(async () => {
      await reads.clock.advance(AGENT_INFO_SYSTEM_USAGE_INTERVAL_MS * 3);
    });
    expect(usageCalls).toBe(2);
  });

  test.skip("legacy Cursor quota panel was removed after generic usage migration", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_cursor_account_usage") return undefined;
      return {
        ok: true,
        data: {
          provider: "cursor",
          plan: "Ultra",
          cycle: { endsAt: "2026-09-01T00:00:00.000Z" },
          included: {
            usedCents: 23_222,
            remainingCents: 16_778,
            limitCents: 40_000,
          },
          buckets: [
            {
              id: "cursor-internal-auto",
              label: "Cursor Models",
              window: "billing_cycle",
              usedPercent: 0,
              remainingPercent: 100,
            },
            {
              id: "cursor-internal-api",
              label: "Other Models",
              window: "billing_cycle",
              usedPercent: 46.444,
              remainingPercent: 53.556,
            },
          ],
          onDemand: {
            usedCents: 0,
            individualLimitCents: 10_000,
            individualRemainingCents: 10_000,
            limitType: "user",
          },
          internalPercentages: {
            autoPercentUsed: 0,
            apiPercentUsed: 46.444,
            totalPercentUsed: 15.48,
          },
          source: {
            kind: "internal-dashboard-api",
            retrievedAt: "2026-08-26T16:00:00.000Z",
          },
        },
      };
    });

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    expect(screen.getByText("Loading Cursor account usage…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Cursor account")).toBeTruthy());
    expect(screen.getByText("Ultra")).toBeTruthy();
    expect(metricValue("Included used")).toBe("$232.22");
    expect(screen.queryByText("Included left") === null).toBe(true);
    expect(screen.queryByText("Included limit") === null).toBe(true);
    expect(metricValue("On-demand")).toBe("$0.00");
    expect(screen.queryByText("Cursor quota") === null).toBe(true);
    expect(screen.queryByText("Included allowance") === null).toBe(true);
    expect(screen.getByText("Cursor Models")).toBeTruthy();
    expect(screen.getByText("Other Models")).toBeTruthy();
    expect(screen.getByText("0% used")).toBeTruthy();
    expect(screen.getByText("46% used")).toBeTruthy();
    expect(nativeInvokeMock).toHaveBeenCalledWith("get_cursor_account_usage");
  });

  test.skip("legacy Cursor quota errors were removed with the legacy endpoint", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage"
        ? {
            ok: false,
            code: "MISSING_PLAN_USAGE",
            message: "Cursor did not expose plan quota for this account.",
            retryable: false,
          }
        : undefined,
    );

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("Account usage unavailable")).toBeTruthy());
    expect(screen.getByText("Cursor did not expose plan quota for this account.")).toBeTruthy();
    expect(screen.queryByText("0% used") === null).toBe(true);
  });

  test.skip("legacy Cursor sparse quota shape was removed", async () => {
    // The shape a live individual account actually returned: an included limit
    // and used amount, but no `remaining`, and no percentage buckets.
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage"
        ? {
            ok: true,
            data: {
              provider: "cursor",
              cycle: { endsAt: "2026-09-01T00:00:00.000Z" },
              included: { usedCents: 23_222, limitCents: 40_000 },
              buckets: [],
              onDemand: { pooledLimitCents: 50_000, limitType: "team" },
              source: {
                kind: "internal-dashboard-api",
                retrievedAt: "2026-08-26T16:00:00.000Z",
              },
            },
          }
        : undefined,
    );

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("Cursor account")).toBeTruthy());
    // No plan name: the panel falls back to naming the period.
    expect(screen.getByText("Current billing cycle")).toBeTruthy();
    expect(metricValue("Included used")).toBe("$232.22");
    expect(screen.queryByText("Included left") === null).toBe(true);
    expect(screen.queryByText("Included limit") === null).toBe(true);
    // `individualLimitCents` is absent, so the pooled limit is shown instead.
    expect(metricValue("Pooled limit")).toBe("$500.00");
    expect(screen.getByText("team")).toBeTruthy();
    expect(screen.queryByText("Included allowance") === null).toBe(true);
    expect(screen.queryByText("Cursor quota") === null).toBe(true);
    expect(screen.queryByText("Cursor Models") === null).toBe(true);
  });

  test.skip("legacy Cursor normalized quota shape was removed", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage"
        ? {
            ok: true,
            data: {
              provider: "cursor",
              plan: "Pro",
              cycle: {},
              included: { remainingCents: -1_000, limitCents: 40_000 },
              buckets: [],
              source: {
                kind: "internal-dashboard-api",
                retrievedAt: "2026-08-26T16:00:00.000Z",
              },
            },
          }
        : undefined,
    );

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("Pro")).toBeTruthy());
    expect(screen.getByText("No usage figures reported.")).toBeTruthy();
    expect(screen.queryByText("Included left") === null).toBe(true);
    expect(screen.queryByText("Included limit") === null).toBe(true);
    expect(screen.queryByText("over allowance") === null).toBe(true);
  });

  test.skip("legacy Cursor aggregate quota was removed", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage"
        ? {
            ok: true,
            data: {
              provider: "cursor",
              plan: "Pro",
              cycle: {},
              included: {},
              buckets: [],
              internalPercentages: { totalPercentUsed: 42 },
              source: {
                kind: "internal-dashboard-api",
                retrievedAt: "2026-08-26T16:00:00.000Z",
              },
            },
          }
        : undefined,
    );

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("Pro")).toBeTruthy());
    expect(screen.queryByText("Included used") === null).toBe(true);
    expect(screen.queryByText("Included limit") === null).toBe(true);
    expect(screen.queryByText("On-demand") === null).toBe(true);
    expect(screen.getByText("Cursor quota")).toBeTruthy();
    expect(screen.queryByText("Included allowance") === null).toBe(true);
    expect(screen.getByText("42% used")).toBeTruthy();
  });

  test.skip("legacy Cursor quota buckets were removed", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage"
        ? {
            ok: true,
            data: {
              provider: "cursor",
              plan: "Pro",
              cycle: { endsAt: "2026-09-01T00:00:00.000Z" },
              included: {
                usedCents: 46_000,
                remainingCents: -6_000,
                limitCents: 40_000,
              },
              buckets: [
                {
                  id: "cursor-internal-auto",
                  label: "Cursor Models",
                  window: "billing_cycle",
                  usedPercent: 112.5,
                  remainingPercent: 0,
                },
              ],
              internalPercentages: {
                autoPercentUsed: 112.5,
                totalPercentUsed: 50,
              },
              source: {
                kind: "internal-dashboard-api",
                retrievedAt: "2026-08-26T16:00:00.000Z",
              },
            },
          }
        : undefined,
    );

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("Cursor account")).toBeTruthy());
    expect(metricValue("Included used")).toBe("$460.00");
    expect(screen.queryByText("Included left") === null).toBe(true);
    expect(screen.queryByText("Included limit") === null).toBe(true);
    expect(screen.queryByText("over allowance") === null).toBe(true);
    expect(screen.queryByText("Cursor quota") === null).toBe(true);
    expect(screen.queryByText("Included allowance") === null).toBe(true);
    // The label stays truthful while the bar saturates: `Progress` positions its
    // fill with translateX, so an unclamped value would leave an empty track.
    expect(screen.getByText("113% used")).toBeTruthy();
    const bars = popover().querySelectorAll('[role="progressbar"] > div');
    const transforms = Array.from(bars).map((bar) => (bar as HTMLElement).style.transform);
    // Unclamped, `100 - 112.5` produced `translateX(--12.5%)`, which the browser
    // drops as invalid and leaves the track empty.
    expect(transforms.filter((transform) => transform === "translateX(-0%)")).toHaveLength(1);
    expect(transforms.some((transform) => transform === "")).toBe(false);
  });

  test.skip("legacy Cursor account invoke was removed", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_cursor_account_usage") throw new Error("backend unreachable");
      return undefined;
    });

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("Account usage unavailable")).toBeTruthy());
    expect(screen.getByText("Could not load Cursor account usage.")).toBeTruthy();
  });

  test.skip("legacy Cursor panel was removed", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage"
        ? {
            ok: true,
            data: {
              provider: "cursor",
              plan: "Ultra",
              cycle: {},
              included: {},
              buckets: [],
              internalPercentages: { totalPercentUsed: 12 },
              source: {
                kind: "internal-dashboard-api",
                retrievedAt: "2026-08-26T16:00:00.000Z",
              },
            },
          }
        : undefined,
    );

    const { rerender } = render(<AgentInfoButton activeTab={cursorTab()} />);
    open();
    await waitFor(() => expect(screen.getByText("Cursor account")).toBeTruthy());

    rerender(<AgentInfoButton activeTab={claudeTab({ id: "tab-claude" })} />);

    // One provider's quota must not linger over another provider's session.
    await waitFor(() => expect(screen.queryByText("Cursor account") === null).toBe(true));
    expect(screen.queryByText("Ultra") === null).toBe(true);
  });

  test.skip("legacy Cursor account response was removed", async () => {
    let settle: ((result: unknown) => void) | undefined;
    let calls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_cursor_account_usage") return undefined;
      calls += 1;
      if (calls > 1) return new Promise(() => undefined);
      return new Promise((resolve) => {
        settle = resolve;
      });
    });

    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();
    expect(screen.getByText("Loading Cursor account usage…")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
    await act(async () => {
      settle?.({
        ok: true,
        data: {
          provider: "cursor",
          plan: "Stale plan",
          cycle: {},
          included: {},
          buckets: [],
          source: { kind: "internal-dashboard-api", retrievedAt: "2026-08-26T16:00:00.000Z" },
        },
      });
      await Promise.resolve();
    });

    open();
    // The in-flight result belonged to a closed panel; reopening waits for its
    // own read rather than showing what the abandoned one returned.
    expect(screen.getByText("Loading Cursor account usage…")).toBeTruthy();
    expect(screen.queryByText("Stale plan") === null).toBe(true);
  });

  test.skip("legacy Cursor account command was removed", async () => {
    render(<AgentInfoButton activeTab={cursorTab()} />);
    open();

    await waitFor(() => expect(nativeInvokeMock).toHaveBeenCalledWith("get_cursor_account_usage"));
    // Account quota is billing-cycle scoped, not session scoped.
    const call = nativeInvokeMock.mock.calls.find((args) => args[0] === "get_cursor_account_usage");
    expect(call).toHaveLength(1);
  });

  test("positions the marker relative to the reset boundary of any period", () => {
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    const halfwayMs = resetMs - 3.5 * 24 * 60 * 60 * 1_000;

    expect(
      limitWindowPosition(
        {
          label: "Secondary",
          resetsAt: new Date(resetMs).toISOString(),
          windowMinutes: 10_080,
        },
        halfwayMs,
      ),
    ).toBe(50);
    // Claude names the period but does not currently report its duration.
    expect(
      limitWindowPosition(
        {
          label: "Weekly (Sonnet)",
          resetsAt: new Date(resetMs).toISOString(),
        },
        halfwayMs,
      ),
    ).toBe(50);
    // A short window is placed on the same terms as a weekly one.
    expect(
      limitWindowPosition(
        {
          label: "Five Hour",
          resetsAt: new Date(resetMs).toISOString(),
          windowMinutes: 300,
        },
        resetMs - 150 * 60_000,
      ),
    ).toBe(50);
  });

  test("reads a window duration from its name when the provider omits one", () => {
    expect(labelWindowMinutes("Weekly (Fable)")).toBe(10_080);
    expect(labelWindowMinutes("Codex · Daily limit")).toBe(1_440);
    expect(labelWindowMinutes("5-hour limit")).toBe(300);
    expect(labelWindowMinutes("5h window")).toBe(300);
    expect(labelWindowMinutes("Five Hour")).toBe(300);
    expect(labelWindowMinutes("Usage limit")).toBeNull();
    // A reported duration outranks the name, and a nonsensical one is refused.
    expect(windowDurationMinutes({ label: "Weekly", windowMinutes: 60 })).toBe(60);
    expect(windowDurationMinutes({ label: "Weekly", windowMinutes: 0 })).toBeNull();
  });

  test("measures a calendar-month window from its real reset boundary", () => {
    // OpenCode Zen names a monthly window without reporting its duration, so
    // the marker must be placed on the calendar month rather than a fixed 30
    // days or it drifts by a day on 31-day months.
    const resetMs = Date.parse("2026-09-01T00:00:00.000Z");
    const halfwayMs = resetMs - 15.5 * 24 * 60 * 60 * 1_000;

    expect(
      limitWindowPosition(
        { label: "Monthly", resetsAt: new Date(resetMs).toISOString() },
        halfwayMs,
      ),
    ).toBe(50);
    // A 28-day month is measured as 28 days, not the 30-day fallback.
    expect(windowDurationMinutes({ label: "Monthly", resetsAt: "2026-03-01T00:00:00.000Z" })).toBe(
      28 * 24 * 60,
    );
    // Without a reset instant there is nothing to measure, so the name's
    // approximate span governs whether the row is treated as timed at all.
    expect(labelWindowMinutes("Monthly")).toBe(30 * 24 * 60);
  });

  test("does not place a marker on an unmeasurable or stale limit period", () => {
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    // Neither the payload nor the label says how long the period is.
    expect(
      limitWindowPosition(
        { label: "Usage limit", resetsAt: new Date(resetMs).toISOString() },
        resetMs - 60_000,
      ),
    ).toBeNull();
    expect(
      limitWindowPosition(
        {
          label: "Weekly",
          resetsAt: new Date(resetMs).toISOString(),
        },
        resetMs + 1,
      ),
    ).toBeNull();
    expect(limitWindowPosition({ label: "Weekly", resetsAt: "not-a-date" }, resetMs)).toBeNull();
  });

  test("handles missing, non-finite, and exact weekly period boundaries", () => {
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    const reset = new Date(resetMs).toISOString();
    const periodStartMs = resetMs - 7 * 24 * 60 * 60 * 1_000;
    const weeklyLimit = { label: "Weekly", resetsAt: reset };

    expect(limitWindowPosition({ label: "Weekly" }, resetMs)).toBeNull();
    expect(limitWindowPosition(weeklyLimit, Number.POSITIVE_INFINITY)).toBeNull();
    expect(limitWindowPosition(weeklyLimit, periodStartMs - 1)).toBeNull();
    expect(limitWindowPosition(weeklyLimit, periodStartMs)).toBe(0);
    expect(limitWindowPosition(weeklyLimit, resetMs)).toBe(100);
  });

  test("prompts for a first snapshot when usage is unavailable", () => {
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(
      screen.getByText(/Usage will appear after this session reports its first token snapshot/),
    ).toBeTruthy();
  });

  test("renders Claude rate limits before the first context snapshot", () => {
    seedClaudeProjection({
      rateLimits: [
        { label: "5h window", usedPercent: 31 },
        { label: "Weekly", resetsAt: "2026-07-30T09:00:00.000Z" },
      ],
      composer: composerState({ selectedModelId: "claude-sonnet" }),
    });

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.getByText("31% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("claude-sonnet")).toBeTruthy();
    expect(screen.getByText("Provider reported")).toBeTruthy();
    expect(screen.queryByText(/first token snapshot/) === null).toBe(true);
    expect(screen.queryByText("Context") === null).toBe(true);
  });

  test("renders context, token split, cache read/write, reasoning, elapsed and denial rows", () => {
    seedUsage(
      usage({
        inputTokens: 20_000,
        outputTokens: 5_000,
        cacheReadTokens: 12_000,
        cacheWriteTokens: 3_000,
        reasoningTokens: 900,
        sessionTokens: 30_000,
        costUsd: 1.25,
        durationMs: 95_000,
        permissionDenials: 2,
        account: [
          {
            window: "weekly",
            label: "Weekly quota",
            usedPercent: 40,
            spendUsd: 12.5,
            resetsAt: "2026-09-14T00:00:00.000Z",
          },
        ],
        turns: [
          {
            turnId: "turn-1",
            inputTokens: 500,
            outputTokens: 100,
            costUsd: 0.25,
            modelId: "claude-opus",
          },
        ],
      }),
      "claude",
      { composer: composerState({ selectedModelId: "claude-opus" }) },
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("25%")).toBeTruthy();
    expect(
      screen.getByText((_content, element) => element?.textContent === "25k / 100k"),
    ).toBeTruthy();
    expect(
      screen.getByText((_content, element) => element?.textContent === "75k available"),
    ).toBeTruthy();
    expect(metricValue("Input")).toBe("20k");
    expect(metricValue("Output")).toBe("5.0k");
    expect(metricValue("Cache read")).toBe("12k");
    expect(metricValue("Cache write")).toBe("3.0k");
    expect(metricValue("Reasoning")).toBe("900");
    expect(metricValue("Session")).toBe("30k");
    expect(metricValue("Cost")).toBe("$1.25");
    expect(metricValue("Elapsed")).toBe("1m 35s");
    expect(metricValue("Denied")).toBe("2");
    expect(screen.getByText("tool permissions")).toBeTruthy();
    expect(screen.getByText("Provider reported")).toBeTruthy();
    expect(screen.getAllByText("claude-opus").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("region", { name: "Account usage" })).toBeTruthy();
    expect(screen.getByText("Weekly quota")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Turn usage" })).toBe(null);
    expect(screen.queryByText("Recent turns")).toBe(null);
    expect(screen.queryByText("600 · $0.25")).toBe(null);
  });

  test("charts daily token buckets instead of one card per day", () => {
    seedUsage(
      usage({
        account: [
          { window: "lifetime", label: "Lifetime", tokens: 1_200_000_000 },
          { window: "daily:2026-08-24", label: "2026-08-24", tokens: 60_000_000 },
          { window: "daily:2026-08-25", label: "2026-08-25", tokens: 417_000_000 },
          { window: "daily:2026-08-26", label: "2026-08-26", tokens: 375_000_000 },
        ],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const chart = screen.getByRole("region", { name: "Daily tokens" });
    expect(chart).toBeTruthy();
    expect(within(chart).getAllByRole("img").length).toBe(3);
    expect(within(chart).getByLabelText("Aug 25: 417M tokens")).toBeTruthy();
    // The peak is scoped to the plotted range so it cannot be read as the
    // account-lifetime "Peak day" window rendered as a card beside it.
    expect(within(chart).getByText("Peak 3d 417M")).toBeTruthy();
    // The newest day is the standing readout before anything is hovered.
    expect(within(chart).getByText("375M")).toBeTruthy();
    // Non-daily windows keep their cards; the days no longer get one each.
    expect(
      within(screen.getByRole("region", { name: "Account usage" })).getByText("Lifetime"),
    ).toBeTruthy();
    expect(screen.queryByText("2026-08-24")).toBe(null);
  });

  test("hovering a column reads that day out and releasing restores the newest", () => {
    seedDailyUsage([
      { window: "daily:2026-08-24", label: "2026-08-24", tokens: 60_000_000 },
      { window: "daily:2026-08-25", label: "2026-08-25", tokens: 417_000_000 },
      { window: "daily:2026-08-26", label: "2026-08-26", tokens: 375_000_000 },
    ]);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const chart = screen.getByRole("region", { name: "Daily tokens" });
    const bars = within(chart).getAllByRole("img");
    expect(within(chart).getByText("375M")).toBeTruthy();

    fireEvent.mouseEnter(bars[0]!);
    expect(within(chart).getByText("60M")).toBeTruthy();
    expect(within(chart).queryByText("375M")).toBe(null);

    fireEvent.mouseEnter(bars[1]!);
    expect(within(chart).getByText("417M")).toBeTruthy();

    fireEvent.mouseLeave(bars[1]!.parentElement!);
    expect(within(chart).getByText("375M")).toBeTruthy();
    expect(within(chart).queryByText("417M")).toBe(null);
  });

  test("plots only the trailing thirty days and scopes the peak to them", () => {
    // Day zero is both the largest bucket and the one truncation must drop, so
    // a slice that kept the wrong end would show up in the bars and the peak.
    seedDailyUsage(
      dailyBuckets(35, (index) => (index === 0 ? 999_000_000 : (index + 1) * 1_000_000)),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const chart = screen.getByRole("region", { name: "Daily tokens" });
    expect(within(chart).getAllByRole("img").length).toBe(30);
    expect(within(chart).queryByLabelText("Aug 1: 999M tokens")).toBe(null);
    expect(within(chart).getByLabelText("Aug 6: 6.0M tokens")).toBeTruthy();
    // The footer brackets the plotted range, not the full reported history.
    const footer = within(chart).getByText("Peak 30d 35M").parentElement!;
    expect(within(footer).getByText("Aug 6")).toBeTruthy();
    expect(within(footer).getByText("Sep 4")).toBeTruthy();
  });

  test("keeps a daily bucket as a card when the chart cannot show all of it", () => {
    seedDailyUsage([
      // No token count: nothing to plot.
      { window: "daily:2026-08-24", label: "2026-08-24", resetsAt: "2026-08-25T00:00:00.000Z" },
      // A token count the chart could plot, but spend the chart would swallow.
      { window: "daily:2026-08-25", label: "2026-08-25", tokens: 417_000_000, spendUsd: 12.5 },
      { window: "daily:2026-08-26", label: "2026-08-26", tokens: 375_000_000 },
    ]);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const cards = screen.getByRole("region", { name: "Account usage" });
    expect(within(cards).getByText("2026-08-24")).toBeTruthy();
    expect(within(cards).getByText("2026-08-25")).toBeTruthy();
    expect(within(cards).getByText("$12.50")).toBeTruthy();
    // Only the bucket the chart can represent in full becomes a bar.
    const chart = screen.getByRole("region", { name: "Daily tokens" });
    expect(within(chart).getAllByRole("img").length).toBe(1);
    expect(within(chart).getByLabelText("Aug 26: 375M tokens")).toBeTruthy();
  });

  test("drops the account card list when every window is a plottable day", () => {
    seedDailyUsage(dailyBuckets(3, (index) => (index + 1) * 1_000_000));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.queryByRole("region", { name: "Account usage" })).toBe(null);
    expect(
      within(screen.getByRole("region", { name: "Daily tokens" })).getAllByRole("img").length,
    ).toBe(3);
  });

  test("renders flat bars rather than NaN heights when every day is zero", () => {
    seedDailyUsage(dailyBuckets(3, () => 0));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const chart = screen.getByRole("region", { name: "Daily tokens" });
    const bars = within(chart).getAllByRole("img");
    expect(bars.length).toBe(3);
    for (const bar of bars) {
      expect((bar.firstElementChild as HTMLElement).style.height).toBe("2%");
    }
    expect(within(chart).getByText("Peak 3d 0")).toBeTruthy();
  });

  test.each([
    [-5, -10, "0 / 0", "0 available"],
    [120_000, 100_000, "120k / 100k", "0 available"],
  ])(
    "clamps token boundaries for %p used of %p total",
    (usedTokens, totalTokens, expectedTotal, expectedRemaining) => {
      seedUsage(usage({ usedTokens, totalTokens }));
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(
        screen.getByText((_content, element) => element?.textContent === expectedTotal),
      ).toBeTruthy();
      expect(
        screen.getByText((_content, element) => element?.textContent === expectedRemaining),
      ).toBeTruthy();
    },
  );

  test.each([
    [9.4, "9.4%", "9 percent of context used"],
    [10, "10%", "10 percent of context used"],
  ])(
    "formats the context percentage boundary at %p",
    (percentUsed, expectedText, expectedLabel) => {
      seedUsage(usage({ percentUsed }));
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(screen.getByText(expectedText)).toBeTruthy();
      expect(screen.getByRole("progressbar", { name: expectedLabel })).toBeTruthy();
    },
  );

  test("omits every optional metric the snapshot does not carry", () => {
    seedUsage(usage());
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    for (const label of [
      "Input",
      "Output",
      "Cache read",
      "Cache write",
      "Reasoning",
      "Cost",
      "Elapsed",
      "Denied",
      "Credits",
    ]) {
      expect(screen.queryByText(label) === null).toBe(true);
    }
  });

  test("labels an estimated snapshot as estimated", () => {
    seedUsage(usage({ estimated: true }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByText("Estimated")).toBeTruthy();
    expect(screen.queryByText("Provider reported") === null).toBe(true);
  });

  test("prefers the model named by the snapshot over the composer's selection", () => {
    seedUsage(usage({ modelId: "snapshot-model" }), "claude", {
      composer: composerState({ selectedModelId: "composer-model" }),
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByText("snapshot-model")).toBeTruthy();
    expect(screen.queryByText("composer-model") === null).toBe(true);
  });

  test("shows 'Model unavailable' when neither source names one", () => {
    seedUsage(usage());
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByText("Model unavailable")).toBeTruthy();
  });

  test.each([
    [0, "$0.00"],
    [0.0004, "$0.0004"],
    [0.0099, "$0.0099"],
    [1.5, "$1.50"],
    [1234.567, "$1234.57"],
  ])("formats a cost of %p as %p", (costUsd, expected) => {
    seedUsage(usage({ costUsd }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(metricValue("Cost")).toBe(expected);
  });

  test.each([
    [420, "420ms"],
    [999.4, "999ms"],
    [1_500, "1.5s"],
    [42_000, "42s"],
    [65_000, "1m 5s"],
    [3_600_000, "60m 0s"],
  ])("formats a duration of %p as %p", (durationMs, expected) => {
    seedUsage(usage({ durationMs }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(metricValue("Elapsed")).toBe(expected);
  });

  test.each([
    [{ unlimited: true, balance: "$5.00" }, "Unlimited"],
    [{ balance: "$12.34" }, "$12.34"],
    [{ hasCredits: true }, "Available"],
    [{ hasCredits: false }, "Unavailable"],
  ])("renders credits %p as %p in the account section", (credits, expected) => {
    seedUsage(usage({ credits }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    const account = screen.getByRole("region", { name: "Account usage" });
    expect(within(account).getByText("Credits")).toBeTruthy();
    expect(within(account).getByText(expected)).toBeTruthy();
  });

  test("preserves every fact on a mixed credits window", () => {
    const resetsAt = "2026-09-14T10:12:23.000Z";
    seedUsage(
      usage({
        credits: { balance: "$12.34" },
        account: [
          {
            window: "credits",
            label: "Credit allowance",
            creditBalance: "$9.99",
            usedPercent: 42.4,
            resetsAt,
            tokens: 1_200,
            spendUsd: 1.25,
            limitUsd: 5,
          },
        ],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const account = screen.getByRole("region", { name: "Account usage" });
    expect(within(account).getByText("Credit allowance")).toBeTruthy();
    expect(within(account).getByText("42% used")).toBeTruthy();
    expect(
      within(account).getByRole("progressbar", { name: "Credit allowance: 42% used" }),
    ).toBeTruthy();
    expect(within(account).getByText(`Resets ${formatResetDateTime(resetsAt)}`)).toBeTruthy();
    expect(within(account).getByText("1.2k")).toBeTruthy();
    expect(within(account).getByText("$1.25")).toBeTruthy();
    expect(within(account).getByText("$5.00")).toBeTruthy();
    expect(within(account).getByText("$12.34")).toBeTruthy();
    expect(within(account).queryByText("$9.99")).toBe(null);
  });

  test("merges complementary account facts into one matching limit row", () => {
    seedUsage(
      usage({
        rateLimits: [{ label: "Weekly quota", usedPercent: 25 }],
        account: [
          {
            window: "weekly",
            label: "Weekly quota",
            tokens: 1_200,
            spendUsd: 1.25,
            limitUsd: 5,
            creditsRemaining: 4,
          },
        ],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const account = screen.getByRole("region", { name: "Account usage" });
    expect(within(account).getAllByText("Weekly quota")).toHaveLength(1);
    expect(
      within(account).getByRole("progressbar", { name: "Weekly quota: 25% used" }),
    ).toBeTruthy();
    expect(within(account).getByText("1.2k")).toBeTruthy();
    expect(within(account).getByText("$1.25")).toBeTruthy();
    expect(within(account).getByText("$5.00")).toBeTruthy();
    expect(within(account).getByText("4")).toBeTruthy();
  });

  test("takes a period length from the account window a limit row absorbs", () => {
    // The limit read says when the period ends, the account window naming the
    // same period says how long it is, and the elapsed marker needs both. The
    // label carries no duration of its own, so a merge that dropped
    // `windowMinutes` would leave the bar unplaceable in time.
    const windowMinutes = 31 * 24 * 60;
    const resetsAt = new Date(Date.now() + (windowMinutes / 4) * 60_000).toISOString();
    seedUsage(
      usage({
        rateLimits: [{ label: "Plan quota", usedPercent: 25, resetsAt }],
        account: [{ window: "billing_cycle", label: "Plan quota", windowMinutes }],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const account = screen.getByRole("region", { name: "Account usage" });
    expect(within(account).getAllByText("Plan quota")).toHaveLength(1);
    expect(
      within(account).getByRole("img", { name: "Current point in the Plan quota period: 75%" }),
    ).toBeTruthy();
  });

  test("names each account progress bar with its window and displayed percentage", () => {
    seedUsage(
      usage({
        rateLimits: [
          { label: "5h window", usedPercent: 9.4 },
          { label: "Weekly", usedPercent: 42 },
        ],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const account = screen.getByRole("region", { name: "Account usage" });
    expect(within(account).getByRole("progressbar", { name: "5h window: 9.4% used" })).toBeTruthy();
    expect(within(account).getByRole("progressbar", { name: "Weekly: 42% used" })).toBeTruthy();
  });

  test("renders rate limits, including a window with no percentage and a reset time", () => {
    const resetValue = "2026-07-27T09:00:00.000Z";
    seedUsage(
      usage({
        rateLimits: [
          { label: "5h window", usedPercent: 42.4 },
          { label: "Weekly", resetsAt: resetValue },
        ],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(
      within(screen.getByRole("region", { name: "Account usage" })).getByText("Account"),
    ).toBeTruthy();
    expect(screen.getByText("42% used")).toBeTruthy();
    // No percentage is not "0% used" — it means the window was not reported.
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText(`Resets ${formatResetDateTime(resetValue)}`)).toBeTruthy();
  });

  test("renders a red current-week marker over a weekly usage bar", () => {
    const originalDateNow = Date.now;
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    Date.now = () => resetMs - 3.5 * 24 * 60 * 60 * 1_000;
    try {
      seedUsage(
        usage({
          rateLimits: [
            {
              label: "Weekly",
              usedPercent: 42,
              resetsAt: new Date(resetMs).toISOString(),
            },
          ],
        }),
      );
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      const marker = screen.getByRole("img", {
        name: "Current point in the Weekly period: 50%",
      });
      expect(marker.className).toContain("bg-red-500");
      expect((marker as HTMLElement).style.left).toBe("50%");
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("advances the weekly marker on the minute interval and clears it on unmount", () => {
    const originalDateNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    const periodStartMs = resetMs - 7 * 24 * 60 * 60 * 1_000;
    let nowMs = periodStartMs + 1.75 * 24 * 60 * 60 * 1_000;
    let intervalCallback: (() => void) | undefined;
    const clearIntervalMock = mock((_handle: number) => undefined);
    Date.now = () => nowMs;
    window.setInterval = ((callback: TimerHandler, delay?: number) => {
      expect(delay).toBe(60_000);
      intervalCallback = callback as () => void;
      return 71;
    }) as typeof window.setInterval;
    window.clearInterval = clearIntervalMock as typeof window.clearInterval;

    try {
      seedUsage(
        usage({
          rateLimits: [
            {
              label: "Weekly",
              usedPercent: 42,
              resetsAt: new Date(resetMs).toISOString(),
            },
          ],
        }),
      );
      const view = render(<AgentInfoButton activeTab={claudeTab()} />);
      open();
      expect(
        screen.getByRole("img", {
          name: "Current point in the Weekly period: 25%",
        }),
      ).toBeTruthy();

      nowMs = periodStartMs + 5.25 * 24 * 60 * 60 * 1_000;
      act(() => intervalCallback?.());
      expect(
        screen.getByRole("img", {
          name: "Current point in the Weekly period: 75%",
        }),
      ).toBeTruthy();

      view.unmount();
      expect(clearIntervalMock).toHaveBeenCalledWith(71);
    } finally {
      Date.now = originalDateNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("refreshes immediately when a weekly limit appears without restarting for usage updates", () => {
    const originalDateNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    let nowMs = resetMs - 8 * 24 * 60 * 60 * 1_000;
    let setIntervalCalls = 0;
    const clearIntervalMock = mock((_handle: number) => undefined);
    Date.now = () => nowMs;
    window.setInterval = ((_callback: TimerHandler, delay?: number) => {
      expect(delay).toBe(60_000);
      setIntervalCalls += 1;
      return 80 + setIntervalCalls;
    }) as typeof window.setInterval;
    window.clearInterval = clearIntervalMock as typeof window.clearInterval;

    try {
      seedUsage(usage({ rateLimits: [{ label: "5h window", usedPercent: 20 }] }));
      const view = render(<AgentInfoButton activeTab={claudeTab()} />);
      open();
      expect(screen.queryByRole("img") === null).toBe(true);
      expect(setIntervalCalls).toBe(0);

      nowMs = resetMs - 3.5 * 24 * 60 * 60 * 1_000;
      act(() => {
        seedUsage(
          usage({
            rateLimits: [
              {
                label: "Weekly",
                usedPercent: 40,
                resetsAt: new Date(resetMs).toISOString(),
              },
            ],
          }),
        );
      });
      expect(
        screen.getByRole("img", {
          name: "Current point in the Weekly period: 50%",
        }),
      ).toBeTruthy();
      expect(setIntervalCalls).toBe(1);

      act(() => {
        seedUsage(
          usage({
            rateLimits: [
              {
                label: "Weekly",
                usedPercent: 41,
                resetsAt: new Date(resetMs).toISOString(),
              },
            ],
          }),
        );
      });
      expect(screen.getByText("41% used")).toBeTruthy();
      expect(setIntervalCalls).toBe(1);
      expect(clearIntervalMock).not.toHaveBeenCalled();

      view.unmount();
      expect(clearIntervalMock).toHaveBeenCalledWith(81);
    } finally {
      Date.now = originalDateNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("formats reset timestamps with one locale-native formatter", () => {
    const resetValue = "2026-07-27T09:00:00.000Z";
    const resetDate = new Date(resetValue);
    const options = {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    } satisfies Intl.DateTimeFormatOptions;

    for (const locale of ["en-US", "en-GB", "ja-JP", "zh-CN", "ar-EG"]) {
      expect(formatResetDateTime(resetValue, locale)).toBe(
        new Intl.DateTimeFormat(locale, options).format(resetDate),
      );
    }

    const japaneseLegacyConcatenation = `${resetDate.toLocaleDateString("ja-JP", {
      weekday: "long",
    })}, ${resetDate.toLocaleString("ja-JP")}`;
    expect(formatResetDateTime(resetValue, "ja-JP")).not.toBe(japaneseLegacyConcatenation);
  });

  test("omits an invalid reset timestamp instead of rendering Invalid Date", () => {
    expect(formatResetDateTime("not-a-date")).toBeNull();
    seedUsage(usage({ rateLimits: [{ label: "Weekly", resetsAt: "not-a-date" }] }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.queryByText(/Resets/) === null).toBe(true);
    expect(screen.queryByText(/Invalid Date/) === null).toBe(true);
  });

  test("places the account section below the session's own context readout", () => {
    seedUsage(usage({ rateLimits: [{ label: "Weekly", usedPercent: 4 }] }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const context = screen.getByText("Context");
    const account = screen.getByRole("region", { name: "Account usage" });
    // The context window is what this session is spending; the account is the
    // ceiling it is spent against, so it reads second.
    expect(context.compareDocumentPosition(account) & 4).toBe(4);
  });

  test("marks a window whose duration only its label gives up", () => {
    const originalDateNow = Date.now;
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    Date.now = () => resetMs - 60 * 60_000;
    try {
      seedUsage(
        usage({
          rateLimits: [
            {
              label: "Five Hour",
              usedPercent: 30,
              resetsAt: new Date(resetMs).toISOString(),
            },
          ],
        }),
      );
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(
        screen.getByRole("img", { name: "Current point in the Five Hour period: 80%" }),
      ).toBeTruthy();
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("omits the account section entirely when nothing account-scoped is reported", () => {
    seedUsage(usage({ rateLimits: [] }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.queryByRole("region", { name: "Account usage" })).toBe(null);
  });

  test("an authoritative empty Claude limit snapshot hides stale nested limits", () => {
    seedUsage(usage({ rateLimits: [{ label: "Stale 5h", usedPercent: 90 }] }), "claude", {
      rateLimits: [],
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.queryByRole("region", { name: "Account usage" })).toBe(null);
    expect(screen.queryByText("Stale 5h") === null).toBe(true);
    expect(screen.getByText("Context")).toBeTruthy();
  });
});

describe("AgentInfoButton Codex runtime panel", () => {
  function seedCodexRuntime(runtime: NativeAgentSessionProjection["runtime"]) {
    useNativeAgentProjectionStore.getState().setProjection(CODEX_KEY, {
      platform: "codex",
      environmentId: ENVIRONMENT_ID,
      sessionId: "codex-session-1",
      connection: "connected",
      turn: { phase: "idle" },
      messages: [],
      interactions: [],
      composerControls: [],
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
        },
      },
      runtime,
      revision: 1,
      generation: "test",
    } satisfies NativeAgentSessionProjection);
  }

  test("says so plainly while the projection carries no runtime yet", async () => {
    // Codex reads the same panel as every other platform now, so a session with
    // no projected runtime gets the same "nothing to report" line rather than a
    // Codex-shaped loading state fed by a second, renderer-owned health fetch.
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    expect(screen.getByText("Codex Native does not report runtime details.")).toBeTruthy();
  });

  test("renders the state and version the projection carries", async () => {
    seedCodexRuntime({ state: "ready", version: "0.144.1" });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(screen.getByText("Codex Native 0.144.1")).toBeTruthy();
  });

  test("renders the inventory counts the projection carries", async () => {
    // Counting the bridge's inventory shapes is the backend's job — see
    // `bridgeRuntimeSummary`. The panel renders the numbers it is given.
    seedCodexRuntime({ mcpServers: 2, skills: 3, hooks: 1 });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(metricValue("MCP")).toBe("2"));
    expect(metricValue("Skills")).toBe("3");
    expect(metricValue("Hooks")).toBe("1");
  });

  test("shows drift as a count and the names of the kinds behind it", async () => {
    seedCodexRuntime({
      state: "ready",
      drift: { unknownEvents: 7, unknownKinds: ["codex/brand/new", "codex/other"] },
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(screen.getByText("7 events this bridge did not recognise")).toBeTruthy(),
    );
    expect(screen.getByText("codex/brand/new, codex/other")).toBeTruthy();
  });

  test("counts a single unrecognised event in the singular", async () => {
    seedCodexRuntime({ drift: { unknownEvents: 1, unknownKinds: [] } });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(screen.getByText("1 event this bridge did not recognise")).toBeTruthy(),
    );
  });

  test("renders at most the five most recent notices the projection carries", async () => {
    seedCodexRuntime({
      state: "ready",
      notices: [
        { method: "m1", message: "notice one" },
        { method: "m2", message: "notice two" },
        { method: "m3", message: "notice three" },
        { method: "m4", message: "notice four" },
        { method: "m5", message: "notice five" },
        { method: "m6", message: "notice six" },
      ],
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("notice six")).toBeTruthy());
    expect(screen.queryByText("notice one") === null).toBe(true);
    expect(screen.getByText("notice two")).toBeTruthy();
  });

  test("styles errors as errors without hiding provider diagnostics", async () => {
    seedCodexRuntime({
      notices: [
        { method: "inventory", message: "MCP inventory refreshed", severity: "info" },
        {
          id: "mcp:t1:github",
          method: "mcpServer/startupStatus/updated",
          message: "github MCP failed to start",
          severity: "error",
        },
      ],
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("github MCP failed to start")).toBeTruthy());
    expect(screen.getByText("MCP inventory refreshed")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show details for github MCP failed to start" }).className,
    ).toContain("border-destructive");
  });

  test("opens the selected notice when legacy messages share a method", async () => {
    seedCodexRuntime({
      notices: [
        {
          method: "same/method",
          message: "same message",
          severity: "warning",
          occurrences: [{ detail: "warning detail" }],
        },
        {
          method: "same/method",
          message: "same message",
          severity: "error",
          occurrences: [{ detail: "error detail" }],
        },
      ],
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    const triggers = await screen.findAllByRole("button", {
      name: "Show details for same message",
    });
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[1]!);
    expect(screen.getByRole("dialog", { name: "Codex Native runtime error" })).toBeTruthy();
    expect(screen.getByText("error detail")).toBeTruthy();
    expect(screen.queryByText("warning detail") === null).toBe(true);
  });

  test("shows a repeated notice's total count and its retained occurrences", async () => {
    // Grouping happens in the bridge recorder and again in the backend; the
    // panel renders the group it is handed.
    seedCodexRuntime({
      state: "ready",
      notices: [
        {
          method: "mcpServer/startupStatus/updated",
          message: "Codex reported mcpServer startupStatus updated",
          count: 8,
          occurrences: Array.from({ length: 5 }, (_, index) => ({
            detail: `context7: ${index === 4 ? "failed\nConnection timed out" : "starting"}`,
            receivedAt: `2026-08-26T20:0${index}:00.000Z`,
          })),
        },
        { method: "warning", message: "Codex reported warning" },
      ],
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(screen.getByText("Codex reported mcpServer startupStatus updated (8)")).toBeTruthy(),
    );
    expect(screen.queryByText("Codex reported mcpServer startupStatus updated") === null).toBe(
      true,
    );
    expect(screen.getByText("Codex reported warning")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show details for Codex reported mcpServer startupStatus updated",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Codex Native runtime notice" })).toBeTruthy();
    expect(screen.getByText("mcpServer/startupStatus/updated")).toBeTruthy();
    expect(
      screen.getByText(
        (_content, element) => element?.textContent === "context7: failed\nConnection timed out",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Showing the 5 most recent occurrences.")).toBeTruthy();
  });

  test("opens projected notice details and dismisses only the nested dialog", async () => {
    seedCodexRuntime({
      state: "ready",
      notices: [
        {
          method: "configWarning",
          message: "Codex reported configWarning",
          count: 2,
          occurrences: [
            {
              detail: "The /compact command is deprecated",
              receivedAt: "2026-08-26T20:00:00.000Z",
            },
            { detail: "Use /new instead", receivedAt: "not-a-date" },
          ],
        },
      ],
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    const noticeTrigger = screen.getByRole("button", {
      name: "Show details for Codex reported configWarning",
    });
    fireEvent.click(noticeTrigger);
    expect(screen.getByRole("dialog", { name: "Codex Native runtime notice" })).toBeTruthy();
    expect(screen.getByText("The /compact command is deprecated")).toBeTruthy();
    expect(screen.getByText("Use /new instead")).toBeTruthy();
    expect(screen.queryByText("Invalid Date") === null).toBe(true);

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => document.dispatchEvent(escape));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Codex Native runtime notice" }) === null).toBe(
        true,
      ),
    );
    expect(isPopoverOpen()).toBe(true);

    fireEvent.click(noticeTrigger);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Codex Native runtime notice" }) === null).toBe(
        true,
      ),
    );
    expect(isPopoverOpen()).toBe(true);

    fireEvent.click(noticeTrigger);
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    expect(overlay).toBeTruthy();
    // Radix deliberately installs its outside-pointer listener on the next
    // task so the click that mounted a dialog cannot immediately dismiss it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Codex Native runtime notice" }) === null).toBe(
        true,
      ),
    );
    expect(isPopoverOpen()).toBe(true);
  });

  test("shows a repeat count beside a grouped notice", async () => {
    seedCodexRuntime({
      state: "ready",
      notices: [{ method: "m1", message: "notice one", count: 2 }],
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("notice one (2)")).toBeTruthy());
  });
});

describe("AgentInfoButton Claude session options", () => {
  function neutralClaudeProjection(
    composer: Partial<NonNullable<NativeAgentSessionProjection["composer"]>> = {},
  ): NativeAgentSessionProjection {
    return {
      platform: "claude",
      environmentId: ENVIRONMENT_ID,
      sessionId: "claude-session-1",
      connection: "connected",
      turn: { phase: "idle" },
      messages: [],
      interactions: [],
      composerControls: [],
      composer: {
        models: [],
        fastModeEnabled: false,
        fastModeAvailable: false,
        modes: [],
        executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
        includeLocalSettings: false,
        promptSuggestionsEnabled: false,
        ...composer,
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
          speed: false,
          mode: true,
          executionProfile: true,
          localSettings: true,
          promptSuggestions: true,
        },
      },
      revision: 1,
      generation: "test-generation",
    };
  }

  test("offers Claude's in-app account sign-in instead of a terminal", async () => {
    nativeInvokeMock.mockImplementation(async (command: string, input?: unknown) => {
      if (command === "get_native_agent_auth_status") {
        return {
          state: "needs-auth",
          signIn: {
            kind: "terminal",
            hint: "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
          },
          signOut: false,
        };
      }
      if (command === "get_agent_account_login") return { state: "idle" };
      if (command === "start_agent_account_login") {
        expect(input).toEqual({ platform: "claude", reauthenticate: true });
        return {
          state: "pending",
          operationId: "reauth-1",
          accountId: "default",
          platform: "claude",
          mode: "reauthenticate",
          url: "https://claude.example.test/authorize",
          needsCode: true,
        };
      }
      return {};
    });
    useNativeAgentProjectionStore
      .getState()
      .setProjection(CLAUDE_KEY, neutralClaudeProjection({ executionProfiles: [] }));
    render(<AgentInfoButton activeTab={claudeTab()} />);

    open();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
    await waitFor(() =>
      expect(
        nativeInvokeMock.mock.calls.some(([command]) => command === "start_agent_account_login"),
      ).toBe(true),
    );
    expect(
      screen.getByText(
        "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
      ),
    ).toBeTruthy();
  });

  test("keeps Claude informational diagnostics in the runtime panel", () => {
    useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, {
      ...neutralClaudeProjection(),
      runtime: {
        notices: [
          {
            method: "system/auth_status",
            message: "Claude authentication refreshed",
            severity: "info",
            source: "provider",
          },
        ],
      },
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Claude authentication refreshed")).toBeTruthy();
  });

  test("renders both checkboxes even when the session reports no execution profiles", () => {
    /*
     * Nesting these under a non-empty profile list hid the prompt-suggestion
     * opt-in — the switch that enables the feature — for most Claude sessions.
     */
    useNativeAgentProjectionStore
      .getState()
      .setProjection(CLAUDE_KEY, neutralClaudeProjection({ executionProfiles: [] }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.queryByLabelText("Execution profile") === null).toBe(true);
    expect(screen.getByText("Include .claude/settings.local.json")).toBeTruthy();
    expect(screen.getByText("Suggest a follow-up after each turn")).toBeTruthy();
  });

  test("renders both checkboxes before the projection arrives", () => {
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  test("holds the session toggles until the projection arrives", () => {
    // The backend owns these settings and there is no session to update yet,
    // so the boxes stay disabled rather than sending an update it must refuse.
    routeNativeCommands();
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const [localSettings, suggestions] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(localSettings!.checked).toBe(false);
    expect(suggestions!.checked).toBe(false);
    expect(localSettings!.disabled).toBe(true);
    expect(suggestions!.disabled).toBe(true);

    fireEvent.click(localSettings!);

    expect(mockNativeControls).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(localSettings!.checked).toBe(false);
  });

  test("applies a provider-neutral execution profile and locks controls while pending", async () => {
    const initial = neutralClaudeProjection();
    const updated = neutralClaudeProjection({ selectedExecutionProfileId: "reviewer" });
    let releaseUpdate!: (projection: NativeAgentSessionProjection) => void;
    const pendingUpdate = new Promise<NativeAgentSessionProjection>((resolve) => {
      releaseUpdate = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "update_native_agent_controls" ? pendingUpdate : undefined,
    );
    useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, initial);

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    const select = screen.getByLabelText("Execution profile") as HTMLSelectElement;
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];

    fireEvent.change(select, { target: { value: "reviewer" } });

    expect(select.disabled).toBe(true);
    expect(checkboxes.every((checkbox) => checkbox.disabled)).toBe(true);
    expect(nativeInvokeMock).toHaveBeenCalledWith("update_native_agent_controls", {
      environmentId: ENVIRONMENT_ID,
      agent: "claude",
      logicalSessionKey: CLAUDE_KEY,
      update: { executionProfileId: "reviewer" },
    });

    releaseUpdate(updated);
    await waitFor(() =>
      expect(useNativeAgentProjectionStore.getState().projections.get(CLAUDE_KEY)).toBe(updated),
    );
    expect(select.value).toBe("reviewer");
    expect(select.disabled).toBe(false);
    expect(checkboxes.every((checkbox) => !checkbox.disabled)).toBe(true);
  });

  test("does not replace a newer projection with a stale control response", async () => {
    const initial = neutralClaudeProjection();
    const staleResponse = {
      ...neutralClaudeProjection({ selectedExecutionProfileId: "reviewer" }),
      revision: 2,
    };
    const newerProjection = {
      ...neutralClaudeProjection({
        includeLocalSettings: true,
        promptSuggestionsEnabled: true,
      }),
      revision: 3,
    };
    let releaseUpdate!: (projection: NativeAgentSessionProjection) => void;
    const pendingUpdate = new Promise<NativeAgentSessionProjection>((resolve) => {
      releaseUpdate = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "update_native_agent_controls" ? pendingUpdate : undefined,
    );
    useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, initial);

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    const select = screen.getByLabelText("Execution profile") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "reviewer" } });

    act(() => {
      useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, newerProjection);
    });
    releaseUpdate(staleResponse);

    await waitFor(() => expect(select.disabled).toBe(false));
    expect(useNativeAgentProjectionStore.getState().projections.get(CLAUDE_KEY)).toBe(
      newerProjection,
    );
  });

  test("applies both provider-neutral Claude session toggles", async () => {
    const initial = neutralClaudeProjection();
    useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, initial);
    nativeInvokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "update_native_agent_controls") return undefined;
      const current = useNativeAgentProjectionStore.getState().projections.get(CLAUDE_KEY)!;
      const update = args?.update as {
        includeLocalSettings?: boolean;
        promptSuggestions?: boolean;
      };
      return {
        ...current,
        revision: current.revision + 1,
        composer: {
          ...current.composer!,
          ...(update.includeLocalSettings === undefined
            ? {}
            : { includeLocalSettings: update.includeLocalSettings }),
          ...(update.promptSuggestions === undefined
            ? {}
            : { promptSuggestionsEnabled: update.promptSuggestions }),
        },
      };
    });

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    const [localSettings, suggestions] = screen.getAllByRole("checkbox") as HTMLInputElement[];

    fireEvent.click(localSettings!);
    await waitFor(() => expect(localSettings!.checked).toBe(true));
    fireEvent.click(suggestions!);
    await waitFor(() => expect(suggestions!.checked).toBe(true));

    const controlCalls = nativeInvokeMock.mock.calls.filter(
      ([command]) => command === "update_native_agent_controls",
    );
    expect(controlCalls[0]).toEqual([
      "update_native_agent_controls",
      expect.objectContaining({ update: { includeLocalSettings: true } }),
    ]);
    expect(controlCalls[1]).toEqual([
      "update_native_agent_controls",
      expect.objectContaining({ update: { promptSuggestions: true } }),
    ]);
  });

  test("reports a provider-neutral control failure and keeps canonical state", async () => {
    const initial = neutralClaudeProjection();
    useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, initial);
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "update_native_agent_controls") {
        throw new Error("settings unavailable");
      }
      return undefined;
    });

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    const localSettings = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    fireEvent.click(localSettings);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("settings unavailable"));
    expect(useNativeAgentProjectionStore.getState().projections.get(CLAUDE_KEY)).toBe(initial);
    expect(localSettings.checked).toBe(false);
    expect(localSettings.disabled).toBe(false);
  });

  test("neither checkbox is offered for a non-Claude provider", () => {
    seedCodexProjection();
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  test("offers each projected execution profile and sends the choice to the backend", async () => {
    seedNativeProjection(
      "claude",
      "claude-session-1",
      neutralClaudeProjection({
        executionProfiles: [
          { id: "reviewer", label: "Reviewer", modelId: "claude-opus" },
          { id: "explorer", label: "Explorer" },
        ],
      }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const select = screen.getByLabelText("Execution profile") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Provider default",
      "reviewer · claude-opus",
      "explorer",
    ]);

    fireEvent.change(select, { target: { value: "reviewer" } });
    await waitFor(() =>
      expect(mockNativeControls).toHaveBeenCalledWith({ executionProfileId: "reviewer" }),
    );
    await waitFor(() => expect(select.disabled).toBe(false));

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(mockNativeControls).toHaveBeenCalledWith({ executionProfileId: null }),
    );
  });
});

describe("AgentInfoButton session actions", () => {
  function seedOpenCodeSession() {
    seedOpenCodeProjection();
  }

  /**
   * Answers a handoff's two consistency reads in order. The panel's own usage
   * refresh (`refreshUsage`) keeps reading whatever the store holds.
   */
  function handoffReads(...reads: Array<NativeAgentSessionProjection | null>) {
    mockNativeProjectionRead.mockImplementation(async (args) =>
      args?.refreshUsage ? readStoredProjection() : (reads.shift() ?? null),
    );
  }

  function startHandoff(tab: TabInfo, destination: "Claude" | "Codex" | "OpenCode") {
    render(<AgentInfoButton activeTab={tab} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: destination }));
  }

  function expectNoHandoffCreated() {
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    expect(nativeInvokeMock).not.toHaveBeenCalledWith("save_agent_handoff", expect.anything());
    expect(mockToastSuccess).not.toHaveBeenCalled();
  }

  test("fork and compact are disabled until a session id exists", () => {
    render(
      <AgentInfoButton
        activeTab={claudeTab({
          nativeAgentData: { platform: "claude", environmentId: ENVIRONMENT_ID },
        })}
      />,
    );
    open();
    expect(screen.getByRole("button", { name: /Fork session/ }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: /Compact/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Continue in/ }).hasAttribute("disabled")).toBe(true);
  });

  test("reveals only the two other providers and explains the copy boundary", () => {
    seedClaudeProjection();
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const continueButton = screen.getByRole("button", { name: /Continue in/ });
    expect(continueButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(continueButton);

    expect(continueButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "OpenCode" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claude" }) === null).toBe(true);
    expect(screen.getByText(/source session stays intact/)).toBeTruthy();
  });

  test.each([
    ["claude", "Codex", "codex"],
    ["codex", "OpenCode", "opencode"],
  ] as const)(
    "persists an authoritative %s handoff from two projection reads",
    async (source, destination, destinationProvider) => {
      seedNativeProjection(source, `${source}-session-1`);
      const saved: Array<Record<string, unknown>> = [];
      const route = nativeInvokeMock.getMockImplementation()!;
      nativeInvokeMock.mockImplementation(
        async (command: string, args: Record<string, unknown>) => {
          if (command === "save_agent_handoff") {
            saved.push(args.snapshot as Record<string, unknown>);
            return {
              id: args.handoffId,
              environmentId: args.environmentId,
              version: args.version,
              snapshot: args.snapshot,
              createdAt: "2026-07-27T10:00:00.000Z",
            };
          }
          return route(command, args);
        },
      );
      startHandoff(source === "claude" ? claudeTab() : codexTab(), destination);

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
      );
      expect(
        nativeInvokeMock.mock.calls.filter(
          ([command, args]) =>
            command === "get_native_agent_projection" &&
            !(args as { refreshUsage?: boolean } | undefined)?.refreshUsage,
        ),
      ).toEqual([
        [
          "get_native_agent_projection",
          { environmentId: ENVIRONMENT_ID, agent: source, logicalSessionKey: SESSION_KEY },
        ],
        [
          "get_native_agent_projection",
          { environmentId: ENVIRONMENT_ID, agent: source, logicalSessionKey: SESSION_KEY },
        ],
      ]);
      expect(saved.at(-1)).toMatchObject({
        sourceProvider: source,
        destinationProvider,
        sourceSessionId: `${source}-session-1`,
      });
      const handoffTab = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      expect(handoffTab.type).toBe("agent-native");
      expect(handoffTab.agentHandoffId).toBeTruthy();
      expect(handoffTab.nativeAgentData).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        platform: destinationProvider,
      });
      expect(handoffTab.initialPrompt).toBeUndefined();
      expect(mockToastSuccess).toHaveBeenCalledWith(
        `Continuing in ${destination} with 1 message and 0 tool calls`,
      );
    },
  );

  test("deletes a persisted handoff if its source session changes before the destination opens", async () => {
    seedClaudeProjection();
    let releaseSave!: () => void;
    let reportSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_projection") return readStoredProjection();
      if (command === "save_agent_handoff") {
        reportSaveStarted();
        await saveReleased;
      }
      return command === "delete_agent_handoff" ? true : undefined;
    });

    const view = render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await saveStarted;

    view.rerender(<AgentInfoButton activeTab={claudeTab({ id: "another-tab" })} />);
    releaseSave();

    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith(
        "delete_agent_handoff",
        expect.objectContaining({ environmentId: ENVIRONMENT_ID }),
      ),
    );
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("reads and revalidates an authoritative OpenCode handoff before opening Claude", async () => {
    const projection = openCodeProjection();
    useNativeAgentProjectionStore.getState().setProjection(OPENCODE_KEY, projection);
    const saved: Array<Record<string, unknown>> = [];
    nativeInvokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_native_agent_projection") return projection;
      if (command === "save_agent_handoff") {
        saved.push(args.snapshot as Record<string, unknown>);
        return {
          id: args.handoffId,
          environmentId: args.environmentId,
          version: args.version,
          snapshot: args.snapshot,
          createdAt: "2026-07-27T10:00:00.000Z",
        };
      }
      return undefined;
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    // Two consistency reads of the backend projection, apart from the panel's
    // own usage refresh.
    expect(
      nativeInvokeMock.mock.calls.filter(
        ([command, args]) =>
          command === "get_native_agent_projection" &&
          !(args as { refreshUsage?: boolean } | undefined)?.refreshUsage,
      ),
    ).toHaveLength(2);
    expect(saved.at(-1)).toMatchObject({
      sourceProvider: "opencode",
      destinationProvider: "claude",
    });
    const handoffTab = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((tab) => tab.id !== TAB_ID)!;
    expect(handoffTab.type).toBe("agent-native");
    expect(handoffTab.nativeAgentData?.environmentId).toBe(ENVIRONMENT_ID);
  });

  test.each([
    ["Claude Native", "claude", "Codex"],
    ["Codex Native", "codex", "OpenCode"],
  ] as const)(
    "rejects a %s transfer when its authoritative session is unavailable",
    async (label, source, destination) => {
      seedNativeProjection(source, `${source}-session-1`);
      handoffReads(null);
      startHandoff(source === "claude" ? claudeTab() : codexTab(), destination);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(`${label} session is unavailable`),
      );
      expectNoHandoffCreated();
    },
  );

  test.each([
    ["Claude Native", "claude", "Codex"],
    ["Codex Native", "codex", "OpenCode"],
  ] as const)("rejects an initially non-idle %s transfer", async (label, source, destination) => {
    seedNativeProjection(source, `${source}-session-1`);
    handoffReads(nativeProjection(source, `${source}-session-1`, { turn: { phase: "running" } }));
    startHandoff(source === "claude" ? claudeTab() : codexTab(), destination);

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        `Wait for ${label} to finish before continuing in another agent`,
      ),
    );
    expectNoHandoffCreated();
  });

  test.each([
    ["Claude Native", "claude", "Codex"],
    ["Codex Native", "codex", "OpenCode"],
  ] as const)(
    "rejects a %s transfer when the session disappears after its message read",
    async (label, source, destination) => {
      seedNativeProjection(source, `${source}-session-1`);
      handoffReads(nativeProjection(source, `${source}-session-1`), null);
      startHandoff(source === "claude" ? claudeTab() : codexTab(), destination);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          `${label} conversation changed while it was being transferred`,
        ),
      );
      expectNoHandoffCreated();
    },
  );

  test.each([
    ["Claude Native", "claude", "Codex", "a new revision", { revision: 2 }],
    ["Codex Native", "codex", "OpenCode", "a running turn", { turn: { phase: "running" } }],
    ["Codex Native", "codex", "OpenCode", "a new generation", { generation: "replacement" }],
  ] as const)(
    "rejects a %s transfer whose second read reports %s",
    async (label, source, destination, _change, after) => {
      seedNativeProjection(source, `${source}-session-1`);
      handoffReads(
        nativeProjection(source, `${source}-session-1`),
        nativeProjection(source, `${source}-session-1`, after),
      );
      startHandoff(source === "claude" ? claudeTab() : codexTab(), destination);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          `${label} conversation changed while it was being transferred`,
        ),
      );
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    },
  );

  test("does not open a destination tab when the source tab carries no native data", async () => {
    seedCodexProjection();

    render(<AgentInfoButton activeTab={{ id: TAB_ID, type: "agent-native" } as TabInfo} />);
    open();

    // Without native data there is no container or locality to copy onto the
    // destination tab, so the panel offers no session controls at all.
    expect(screen.queryByRole("button", { name: /Continue in/ }) === null).toBe(true);
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
  });

  test("preserves the prior imported transcript when a transferred tab is handed off again", async () => {
    const prior = createAgentHandoffSnapshot({
      id: "prior-handoff",
      environmentId: ENVIRONMENT_ID,
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "claude-session-1",
      messages: [
        {
          id: "prior-message",
          role: "user",
          content: "original request",
          parts: [{ type: "text", content: "original request" }],
          createdAt: "2026-07-27T09:00:00.000Z",
        },
      ],
    });
    rememberAgentHandoff(prior);
    seedCodexProjection({
      messages: [
        {
          id: "bootstrap",
          role: "user",
          content: prior.bootstrapPrompt,
          parts: [{ type: "text", content: prior.bootstrapPrompt }],
          createdAt: "2026-07-27T10:00:00.000Z",
        },
        {
          id: "codex-answer",
          role: "assistant",
          content: "current provider answer",
          parts: [{ type: "text", content: "current provider answer" }],
          createdAt: "2026-07-27T10:01:00.000Z",
        },
      ],
    });

    render(<AgentInfoButton activeTab={codexTab({ agentHandoffId: prior.id })} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    const handoffTab = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((tab) => tab.id !== TAB_ID)!;
    const saved = await loadAgentHandoff(handoffTab.agentHandoffId!);
    expect(saved?.messages.map((message) => message.id)).toEqual(["prior-message", "codex-answer"]);
  });

  test("rejects a handoff when its referenced prior transfer cannot be loaded", async () => {
    seedCodexProjection();
    startHandoff(codexTab({ agentHandoffId: "missing-handoff" }), "OpenCode");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "The previous conversation transfer could not be loaded",
      ),
    );
    expect(nativeInvokeMock).toHaveBeenCalledWith("get_agent_handoff", {
      handoffId: "missing-handoff",
    });
    expectNoHandoffCreated();
  });

  test.each([
    ["environment", "other-env", "codex"],
    ["destination provider", ENVIRONMENT_ID, "opencode"],
  ] as const)(
    "rejects a prior handoff with mismatched %s metadata",
    async (_field, environmentId, destinationProvider) => {
      const prior = createAgentHandoffSnapshot({
        id: `mismatched-${_field.replace(" ", "-")}`,
        environmentId,
        sourceProvider: "claude",
        destinationProvider,
        sourceSessionId: "claude-session-1",
        messages: [
          {
            id: "prior-message",
            role: "user",
            content: "original request",
            parts: [{ type: "text", content: "original request" }],
            createdAt: "2026-07-27T09:00:00.000Z",
          },
        ],
      });
      rememberAgentHandoff(prior);
      seedCodexProjection();
      startHandoff(codexTab({ agentHandoffId: prior.id }), "OpenCode");

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "The previous conversation transfer does not belong to this session",
        ),
      );
      expectNoHandoffCreated();
    },
  );

  test("rejects a handoff whose authoritative transcript is empty", async () => {
    seedClaudeProjection({ messages: [] });
    startHandoff(claudeTab(), "Codex");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("This conversation has no history to transfer"),
    );
    expectNoHandoffCreated();
  });

  test("does not allow a handoff while the source turn is running", () => {
    seedClaudeProjection({ turn: { phase: "running" } });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByRole("button", { name: /Continue in/ }).hasAttribute("disabled")).toBe(true);
  });

  test.each([["claude"], ["opencode"], ["codex"]] as const)(
    "forks a %s session into a tab that carries no bootstrap fields",
    async (provider) => {
      /*
       * `TabInfo` carries one-shot bootstrap fields that are cleared only once
       * consumed. Spreading the source tab produced a fork that immediately
       * auto-submitted the prompt queued for the original.
       */
      const bootstrap = {
        initialPrompt: "do not replay me",
        initialAgentOptions: { model: "x" },
        initialCommands: ["/review"],
      } as Partial<TabInfo>;

      seedNativeProjection(provider, `${provider}-session-1`);
      mockNativeFork.mockImplementation(async () => ({
        sessionId: `${provider}-fork`,
        title: `${provider} fork title`,
      }));
      const tab =
        provider === "claude"
          ? claudeTab(bootstrap)
          : provider === "opencode"
            ? openCodeTab(bootstrap)
            : codexTab(bootstrap);

      render(<AgentInfoButton activeTab={tab} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID).length).toBe(2),
      );
      expect(nativeInvokeMock).toHaveBeenCalledWith("fork_native_agent_session", {
        environmentId: ENVIRONMENT_ID,
        agent: provider,
        logicalSessionKey: SESSION_KEY,
      });
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((entry) => entry.id !== TAB_ID)!;

      expect(forked.initialPrompt).toBeUndefined();
      expect(forked.initialCommands).toBeUndefined();
      expect(forked.initialAgentModel).toBeUndefined();
      expect(forked.initialReasoningEffort).toBeUndefined();
      expect(forked.type).toBe(tab.type);
      expect(forked.displayTitle).toMatch(/fork title$/);
      const nativeData = forked.nativeAgentData;
      expect(nativeData?.sessionId).toBe(`${provider}-fork`);
      expect(nativeData?.environmentId).toBe(ENVIRONMENT_ID);
      // A successful action closes the panel.
      expect(isPopoverOpen()).toBe(false);
    },
  );

  test("Agent Info adopts an OpenCode fork with the source model and reasoning controls", async () => {
    seedNativeProjection("opencode", "opencode-session-1");
    const controls = {
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "high",
      executionProfileId: "reviewer",
    };
    mockNativeFork.mockImplementation(async () => ({
      sessionId: "opencode-fork",
      title: "Fork",
      controls,
    }));
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));
    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    const forked = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((entry) => entry.id !== TAB_ID)!;
    expect(nativeInvokeMock).toHaveBeenCalledWith("adopt_native_agent_session", {
      environmentId: ENVIRONMENT_ID,
      agent: "opencode",
      logicalSessionKey: createSessionKey(ENVIRONMENT_ID, forked.id),
      providerSessionId: "opencode-fork",
      controls,
    });
    expect(forked.initialPrompt).toBeUndefined();
  });

  test("names the fork tab after the provider when the fork has no title", async () => {
    seedClaudeProjection();
    mockNativeFork.mockImplementation(async () => ({ sessionId: "claude-fork" }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

    await waitFor(() => {
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((entry) => entry.id !== TAB_ID);
      expect(forked?.displayTitle).toBe("Claude Native fork");
    });
  });

  test("surfaces the backend's fork refusal and opens no tab", async () => {
    seedCodexProjection();
    mockNativeFork.mockImplementation(async () => {
      throw new Error("Codex session cannot be forked while it is running");
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Codex session cannot be forked while it is running",
      ),
    );
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    // A failed action leaves the panel open so the user can retry.
    expect(isPopoverOpen()).toBe(true);
  });

  test("disables every action while one is running and re-enables afterwards", async () => {
    seedClaudeProjection();
    let release: (value: { sessionId: string }) => void = () => {};
    mockNativeFork.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Compact/ }).hasAttribute("disabled")).toBe(true),
    );
    await act(async () => {
      release({ sessionId: "claude-fork" });
    });
    // The panel closed on success, so reopen to observe the busy flag clearing.
    reopen();
    expect(screen.getByRole("button", { name: /Compact/ }).hasAttribute("disabled")).toBe(false);
  });

  test.each([["claude"], ["opencode"], ["codex"]] as const)(
    "compacts a %s session through the backend",
    async (provider) => {
      seedNativeProjection(provider, `${provider}-session-1`, {
        composer: composerState({ selectedModelId: `${provider}-model` }),
      });
      const tab =
        provider === "claude" ? claudeTab() : provider === "opencode" ? openCodeTab() : codexTab();
      render(<AgentInfoButton activeTab={tab} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Compact/ }));

      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith("Context compaction started"),
      );
      expect(mockNativeAction).toHaveBeenCalledWith({
        kind: "compact",
        modelId: `${provider}-model`,
      });
    },
  );

  test("reports a provider that refuses to compact", async () => {
    seedClaudeProjection();
    mockNativeAction.mockImplementation(async () => {
      throw new Error("The provider could not compact this session");
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Compact/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("The provider could not compact this session"),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Context compaction started");
  });

  test("starts a Codex review through the backend", async () => {
    seedCodexProjection();
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Reviewing uncommitted changes"),
    );
    expect(nativeActionKinds()).toEqual(["review"]);
    expect(nativeInvokeMock).toHaveBeenCalledWith(
      "perform_native_agent_session_action",
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        agent: "codex",
        logicalSessionKey: CODEX_KEY,
      }),
    );
  });

  test("reports a Codex review that could not start", async () => {
    seedCodexProjection();
    mockNativeAction.mockImplementation(async () => {
      throw new Error("Codex native review could not start");
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Codex native review could not start"),
    );
  });

  test("undo targets the latest user message and redo takes none", async () => {
    seedOpenCodeSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));
    await waitFor(() =>
      expect(mockNativeAction).toHaveBeenCalledWith({ kind: "undo", messageId: "m1" }),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Session reverted");

    reopen();
    fireEvent.click(screen.getByRole("button", { name: /Redo turn/ }));
    await waitFor(() => expect(mockNativeAction).toHaveBeenCalledWith({ kind: "redo" }));
    expect(nativeInvokeMock).toHaveBeenCalledWith(
      "perform_native_agent_session_action",
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        agent: "opencode",
        logicalSessionKey: OPENCODE_KEY,
      }),
    );
  });

  test("passes no message id when undoing without a user message", async () => {
    seedOpenCodeProjection("opencode-session-1", {
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "hello",
          parts: [{ type: "text", content: "hello" }],
          createdAt: "2026-07-27T10:00:00.000Z",
        },
      ],
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));
    await waitFor(() =>
      expect(mockNativeAction).toHaveBeenCalledWith({ kind: "undo", messageId: undefined }),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Session reverted");
  });

  test.each([
    ["undo", /Undo turn/, "Session reverted"],
    ["redo", /Redo turn/, "Revert undone"],
  ] as const)(
    "reports an OpenCode %s rejection and re-enables actions",
    async (kind, button, success) => {
      seedOpenCodeSession();
      mockNativeAction.mockImplementation(async () => {
        throw new Error(`OpenCode ${kind} endpoint unavailable`);
      });
      render(<AgentInfoButton activeTab={openCodeTab()} />);
      open();

      fireEvent.click(screen.getByRole("button", { name: button }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(`OpenCode ${kind} endpoint unavailable`),
      );
      expect(mockToastSuccess).not.toHaveBeenCalledWith(success);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: button }).hasAttribute("disabled")).toBe(false),
      );
    },
  );

  test("normalizes a non-Error OpenCode action rejection", async () => {
    seedOpenCodeSession();
    mockNativeAction.mockImplementation(async () => {
      throw "transport closed";
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("undo failed"));
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Session reverted");
  });

  test("forks and compacts OpenCode through the backend session actions", async () => {
    seedOpenCodeSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Compact/ }));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Context compaction started"),
    );
    expect(nativeActionKinds()).toEqual(["compact"]);

    reopen();
    fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));
    await waitFor(() => expect(mockNativeFork).toHaveBeenCalledTimes(1));
    expect(nativeInvokeMock).toHaveBeenCalledWith("fork_native_agent_session", {
      environmentId: ENVIRONMENT_ID,
      agent: "opencode",
      logicalSessionKey: OPENCODE_KEY,
    });
  });

  test("stops a running background task through the backend and reports a refusal", async () => {
    seedClaudeProjection({
      backgroundTasks: [
        { id: "task-1", description: "Run the suite", status: "running" },
        { id: "task-2", description: "Finished", status: "completed" },
      ],
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Run the suite")).toBeTruthy();
    // Completed tasks are not offered a stop control.
    expect(screen.queryByText("Finished") === null).toBe(true);

    mockStopBackgroundTask.mockImplementation(async () => {
      throw new Error("Claude could not stop this task");
    });
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Claude could not stop this task"),
    );
    expect(nativeInvokeMock).toHaveBeenCalledWith("stop_native_agent_background_task", {
      environmentId: ENVIRONMENT_ID,
      agent: "claude",
      logicalSessionKey: CLAUDE_KEY,
      taskId: "task-1",
    });
  });

  test("hides the background-task section when nothing is running", () => {
    seedClaudeProjection({ backgroundTasks: [{ id: "task-2", status: "completed" }] });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.queryByText("Background tasks") === null).toBe(true);
  });

  test.each(["pending", "paused"] as const)(
    "keeps %s background tasks visible and stoppable",
    async (status) => {
      const taskId = `task-${status}`;
      const description = `${status[0]!.toUpperCase()}${status.slice(1)} review`;
      seedClaudeProjection({ backgroundTasks: [{ id: taskId, description, status }] });

      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(screen.getByText(description)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
      await waitFor(() => expect(mockStopBackgroundTask).toHaveBeenCalledWith(taskId));
    },
  );

  test.each(["completed", "failed", "killed"] as const)(
    "hides the background-task section when every task is %s",
    (status) => {
      seedClaudeProjection({
        backgroundTasks: [{ id: "task-2", description: "Settled", status }],
      });

      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(screen.queryByText("Background tasks") === null).toBe(true);
      expect(screen.queryByText("Settled") === null).toBe(true);
    },
  );
});

describe("AgentInfoButton rewind confirmation", () => {
  function seedClaudeWithMessages() {
    const text = (id: string, role: "user" | "assistant", content: string) => ({
      id,
      role,
      content,
      parts: [{ type: "text" as const, content }],
      createdAt: "2026-07-27T10:00:00.000Z",
    });
    seedClaudeProjection({
      messages: [
        text("u1", "user", "first request"),
        text("a1", "assistant", "done"),
        text("u2", "user", "  Please   rewrite the authentication middleware  "),
      ],
    });
  }

  /** The backend's dry run answers with `preview`; the real rewind with none. */
  function rewindPreview(preview: unknown) {
    mockNativeAction.mockImplementation(async (action) =>
      action.dryRun ? { outcome: "applied", preview } : { outcome: "applied" },
    );
  }

  function rewindCalls() {
    return mockNativeAction.mock.calls
      .map(([action]) => action)
      .filter((action) => action.kind === "rewind-files");
  }

  test("names the target message and lists the files instead of dumping JSON", async () => {
    seedClaudeWithMessages();
    rewindPreview({
      files: [
        "src/auth/middleware.ts",
        { path: "src/auth/session.ts" },
        { file: "src/auth/index.ts" },
      ],
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    const message = confirmMessages[0]!;
    expect(message).toContain("“Please rewrite the authentication middleware”");
    expect(message).toContain("3 files will be restored:");
    expect(message).toContain("• src/auth/middleware.ts");
    expect(message).toContain("• src/auth/session.ts");
    expect(message).toContain("• src/auth/index.ts");
    expect(message).toContain("cannot be undone");
    // The old dialog pasted truncated JSON; nothing like it should survive.
    expect(message).not.toContain('{"');
    expect(message).not.toContain('"files"');

    await waitFor(() => expect(rewindCalls()).toHaveLength(2));
    expect(rewindCalls()).toEqual([
      { kind: "rewind-files", messageId: "u2", dryRun: true },
      { kind: "rewind-files", messageId: "u2" },
    ]);
    expect(mockToastSuccess).toHaveBeenCalledWith("Claude restored 3 files");
  });

  test("cancelling the confirm issues no second call", async () => {
    seedClaudeWithMessages();
    confirmResult = false;
    rewindPreview({ files: ["a.ts"] });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(confirmMessages[0]).toContain("1 file will be restored:");
    // Exactly one call — the dry run. The destructive call must not happen.
    await waitFor(() => expect(rewindCalls()).toHaveLength(1));
    expect(rewindCalls()[0]?.dryRun).toBe(true);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("says so when the dry run reports no files", async () => {
    seedClaudeWithMessages();
    rewindPreview({ unexpected: "shape" });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(confirmMessages[0]).toContain("Claude reported no file changes for this checkpoint.");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Claude files rewound"));
  });

  test("refuses when the transcript holds no user message", async () => {
    seedClaudeProjection({
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "hello",
          parts: [{ type: "text", content: "hello" }],
          createdAt: "2026-07-27T10:00:00.000Z",
        },
      ],
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("No file checkpoint is available"),
    );
    expect(rewindCalls()).toEqual([]);
  });

  test("lists at most ten files and counts the rest", async () => {
    seedClaudeWithMessages();
    rewindPreview({
      files: Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`),
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(confirmMessages[0]).toContain("13 files will be restored:");
    expect(confirmMessages[0]).toContain("• src/file-9.ts");
    expect(confirmMessages[0]).not.toContain("• src/file-10.ts");
    expect(confirmMessages[0]).toContain("…and 3 more");
  });

  test("summarizeRewindPreview reads the shapes the SDK might return", () => {
    expect(summarizeRewindPreview({ files: ["a.ts", "b.ts"] })).toEqual({
      files: ["a.ts", "b.ts"],
      fileCount: 2,
    });
    expect(summarizeRewindPreview({ restoredFiles: [{ filePath: "c.ts" }] })).toEqual({
      files: ["c.ts"],
      fileCount: 1,
    });
    expect(summarizeRewindPreview({ preview: { files: [{ name: "d.ts" }] } })).toEqual({
      files: ["d.ts"],
      fileCount: 1,
    });
    // A count with no list still tells the user how much is at stake.
    expect(summarizeRewindPreview({ fileCount: 7 })).toEqual({ files: [], fileCount: 7 });
    expect(summarizeRewindPreview(null)).toEqual({ files: [], fileCount: 0 });
    expect(summarizeRewindPreview("nope")).toEqual({ files: [], fileCount: 0 });
    expect(summarizeRewindPreview({ files: [1, true, {}] })).toEqual({
      files: [],
      fileCount: 0,
    });
  });

  test.each([
    ["changedFiles", { changedFiles: ["changed.ts"] }, ["changed.ts"]],
    ["filesRestored", { filesRestored: ["restored.ts"] }, ["restored.ts"]],
    ["filesChanged", { filesChanged: ["updated.ts"] }, ["updated.ts"]],
  ] as const)("summarizeRewindPreview reads the %s list alias", (_name, preview, files) => {
    expect(summarizeRewindPreview(preview)).toEqual({ files: [...files], fileCount: 1 });
  });

  test.each([
    [{ count: 3 }, 3],
    [{ totalFiles: 4 }, 4],
    [{ fileCount: Number.NaN, count: 5 }, 5],
    [{ fileCount: Number.POSITIVE_INFINITY, totalFiles: 6 }, 6],
    [{ fileCount: -1 }, 0],
  ])("summarizeRewindPreview validates reported counts in %p", (preview, fileCount) => {
    expect(summarizeRewindPreview(preview)).toEqual({ files: [], fileCount });
  });

  test("summarizeRewindPreview prefers real file lists and their exact length", () => {
    expect(
      summarizeRewindPreview({
        files: [],
        changedFiles: ["later.ts"],
        fileCount: 7,
      }),
    ).toEqual({
      files: ["later.ts"],
      fileCount: 1,
    });
    expect(
      summarizeRewindPreview({
        files: ["listed.ts"],
        fileCount: 7,
      }),
    ).toEqual({
      files: ["listed.ts"],
      fileCount: 1,
    });
  });

  test("describeRewindTarget collapses whitespace and truncates", () => {
    expect(describeRewindTarget("  hello   world ")).toBe("“hello world”");
    expect(describeRewindTarget("")).toBe("your most recent message");
    expect(describeRewindTarget(undefined)).toBe("your most recent message");
    expect(describeRewindTarget("x".repeat(120))).toBe(`“${"x".repeat(80)}…”`);
  });
});

describe("AgentInfoButton session sharing", () => {
  // No platform advertises `share` since OpenCode 1.19.1 discontinued it; the
  // control follows the capability, so a projection that advertises it shows it.
  function shareCapabilities() {
    const capabilities = nativeAgentCapabilities("opencode");
    return { ...capabilities, actions: { ...capabilities.actions, share: true } };
  }

  function shareCapableProjection(
    sessionId = "opencode-session-1",
    overrides: Partial<NativeAgentSessionProjection> = {},
  ) {
    return openCodeProjection(sessionId, { capabilities: shareCapabilities(), ...overrides });
  }

  function seedShareCapableProjection(
    sessionId = "opencode-session-1",
    overrides: Partial<NativeAgentSessionProjection> = {},
  ) {
    seedOpenCodeProjection(sessionId, { capabilities: shareCapabilities(), ...overrides });
  }

  function seedShareableSession(sessionId = "opencode-session-1") {
    seedShareCapableProjection(sessionId);
  }

  /** Holds the next share open until the test releases it with a URL. */
  function deferShare(): (url: string) => void {
    let release: (url: string) => void = () => {};
    mockNativeAction.mockImplementation((action) =>
      action.kind === "share"
        ? new Promise((resolve) => {
            release = (url) => resolve({ outcome: "applied", shareUrl: url });
          })
        : Promise.resolve({ outcome: "applied" }),
    );
    return (url) => release(url);
  }

  async function shareAndWaitForRevocation() {
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy());
  }

  test("OpenCode itself no longer offers sharing", () => {
    seedOpenCodeProjection("opencode-session-1");
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    expect(screen.getByRole("button", { name: /Undo turn/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Share…/ }) === null).toBe(true);
  });

  test("rehydrates sharing from the provider-neutral projection", () => {
    seedShareCapableProjection("opencode-session-1", {
      shareUrl: "https://share.opencode.test/projected",
    });

    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("copies the link and offers revocation", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Share link copied"));
    expect(confirmMessages[0]).toContain("leave this machine");
    expect(nativeActionKinds()).toEqual(["share"]);
    expect(clipboardWrites).toEqual(["https://share.opencode.test/abc"]);
    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("a clipboard rejection still leaves the session revocable and surfaces the URL", async () => {
    /*
     * The conversation is public the moment the share resolves. The flag used
     * to be set after the clipboard write, so a rejection (focus or permission)
     * produced an error toast beside a live link and no way to revoke it.
     */
    seedShareableSession();
    clipboardRejection = new Error("Document is not focused");
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(String(mockToastWarning.mock.calls[0]?.[0])).toContain(
      "https://share.opencode.test/abc",
    );
    expect(mockToastError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("a share with no returned URL is still revocable", async () => {
    seedShareableSession();
    mockNativeAction.mockImplementation(async () => ({ outcome: "applied" }));
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(String(mockToastWarning.mock.calls[0]?.[0])).toContain("did not return the link");
    expect(mockToastError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("declining the confirmation shares nothing", async () => {
    seedShareableSession();
    confirmResult = false;
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(nativeActionKinds()).toEqual([]);
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);
  });

  test("a share failure reports and offers no revocation", async () => {
    seedShareableSession();
    mockNativeAction.mockImplementation(async () => {
      throw new Error("OpenCode share endpoint unavailable");
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("OpenCode share endpoint unavailable"),
    );
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);
  });

  test("rehydrates the shared state from the backend when the panel opens", async () => {
    /*
     * Component state is lost on every tab switch and app restart, but the link
     * stays live — the backend projection is the authoritative snapshot.
     */
    seedShareableSession();
    mockNativeProjectionRead.mockImplementation(async () =>
      shareCapableProjection("opencode-session-1", {
        shareUrl: "https://share.opencode.test/live",
      }),
    );
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    await waitFor(() => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy());
  });

  test("a failed projection refresh does not hide an already-known share", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await shareAndWaitForRevocation();

    mockNativeProjectionRead.mockImplementation(async () => {
      throw new Error("server unreachable");
    });
    const readsBefore = mockNativeProjectionRead.mock.calls.length;
    reopen();
    await waitFor(() =>
      expect(mockNativeProjectionRead.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("an authoritative unshared snapshot clears a formerly shared session", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await shareAndWaitForRevocation();

    // A share can be revoked from another client. A projection that reports
    // no share URL is authoritative and must remove the stale local action.
    mockNativeProjectionRead.mockImplementation(async () =>
      shareCapableProjection("opencode-session-1", { shareUrl: null }),
    );
    reopen();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true),
    );
  });

  test("stop sharing revokes and hides the control", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await shareAndWaitForRevocation();

    fireEvent.click(screen.getByRole("button", { name: /Stop sharing/ }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Share link disabled"));
    expect(nativeActionKinds()).toEqual(["share", "unshare"]);
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);
  });

  test("a failed unshare remains visible and can be retried", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await shareAndWaitForRevocation();
    mockNativeAction.mockImplementation(async () => {
      throw new Error("OpenCode unshare endpoint unavailable");
    });

    fireEvent.click(screen.getByRole("button", { name: /Stop sharing/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("OpenCode unshare endpoint unavailable"),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Share link disabled");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Stop sharing/ }).hasAttribute("disabled")).toBe(
        false,
      ),
    );

    mockNativeAction.mockImplementation(async () => ({ outcome: "applied" }));
    fireEvent.click(screen.getByRole("button", { name: /Stop sharing/ }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Share link disabled"));
    expect(nativeActionKinds()).toEqual(["share", "unshare", "unshare"]);
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);
  });

  test("switching tabs clears the optimistic shared flag", async () => {
    seedShareableSession();
    const { rerender } = render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await shareAndWaitForRevocation();

    rerender(<AgentInfoButton activeTab={openCodeTab({ id: "tab-9" })} />);
    reopen();
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);
  });

  test("a delayed share cannot mark a resumed session as shared", async () => {
    seedShareableSession("opencode-session-a");
    const releaseShare = deferShare();
    const { rerender } = render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(nativeActionKinds()).toEqual(["share"]));

    act(() => {
      seedShareableSession("opencode-session-b");
    });
    rerender(<AgentInfoButton activeTab={openCodeTab()} />);
    reopen();

    await act(async () => {
      releaseShare("https://share.opencode.test/session-a");
    });
    expect(screen.queryByRole("button", { name: /Stop sharing/ }) === null).toBe(true);
    expect(clipboardWrites).toEqual([]);
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Share link copied");
  });

  test("an old action finishing cannot clear the new session's busy latch", async () => {
    seedShareableSession("opencode-session-a");
    let releaseShare: (url: string) => void = () => {};
    let releaseCompact: () => void = () => {};
    mockNativeAction.mockImplementation((action) =>
      action.kind === "share"
        ? new Promise((resolve) => {
            releaseShare = (url) => resolve({ outcome: "applied", shareUrl: url });
          })
        : new Promise((resolve) => {
            releaseCompact = () => resolve({ outcome: "applied" });
          }),
    );
    const { rerender } = render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));

    act(() => {
      seedShareableSession("opencode-session-b");
    });
    rerender(<AgentInfoButton activeTab={openCodeTab()} />);
    reopen();
    const compact = screen.getByRole("button", { name: /Compact/ });
    expect(compact.hasAttribute("disabled")).toBe(false);
    fireEvent.click(compact);
    await waitFor(() => expect(compact.hasAttribute("disabled")).toBe(true));

    await act(async () => {
      releaseShare("https://share.opencode.test/session-a");
    });
    expect(compact.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      releaseCompact();
    });
    await waitFor(() => expect(compact.hasAttribute("disabled")).toBe(false));
  });
});

describe("AgentInfoButton backend-owned steering", () => {
  function seedProjection(
    tabId = TAB_ID,
    phase: NativeAgentSessionProjection["turn"]["phase"] = "running",
    platform: "codex" | "pi" = "codex",
  ) {
    const key = createSessionKey(ENVIRONMENT_ID, tabId);
    useNativeAgentProjectionStore.getState().setProjection(key, {
      platform,
      environmentId: ENVIRONMENT_ID,
      sessionId: `${platform}-${tabId}`,
      connection: "connected",
      turn: { phase },
      messages: [],
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities(platform),
      revision: 1,
      generation: `${platform}-generation`,
    });
  }

  function seedRunningCodex(tabId = TAB_ID) {
    seedProjection(TAB_ID);
    seedProjection(tabId);
  }

  function steerOutcome(outcome: {
    outcome: "applied" | "idle" | "mismatch" | "unknown";
    requestId?: string;
  }) {
    nativeInvokeMock.mockImplementation((command: string) => {
      if (command === "perform_native_agent_session_action") return Promise.resolve(outcome);
      if (command === "get_cursor_account_usage") return new Promise(() => undefined);
      return Promise.resolve();
    });
  }

  test("only offers the steer panel when the backend projection enables a running turn", () => {
    seedProjection(TAB_ID, "idle");
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    expect(screen.queryByPlaceholderText("Correct or redirect Codex") === null).toBe(true);
  });

  test("hides the panel while backend-owned steer recovery is parked", () => {
    seedRunningCodex();
    const key = createSessionKey(ENVIRONMENT_ID, TAB_ID);
    useNativeAgentProjectionStore.getState().setProjection(key, {
      ...useNativeAgentProjectionStore.getState().projections.get(key)!,
      recoverableDispatch: {
        requestId: "backend-steer-recovery",
        kind: "steer",
        createdAt: "2026-08-28T10:00:00.000Z",
      },
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    expect(screen.queryByPlaceholderText("Correct or redirect Codex") === null).toBe(true);
  });

  test("routes trimmed intent through the backend without a renderer request id", async () => {
    seedRunningCodex();
    steerOutcome({ outcome: "applied" });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    const input = screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   stop and summarise   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() =>
      expect(
        nativeInvokeMock.mock.calls.some(
          ([command]) => command === "perform_native_agent_session_action",
        ),
      ).toBe(true),
    );
    const call = nativeInvokeMock.mock.calls.find(
      ([command]) => command === "perform_native_agent_session_action",
    );
    expect(call).toBeDefined();
    if (!call) throw new Error("Expected a native agent action call");
    expect(call[1]).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      agent: "codex",
      action: { kind: "steer", text: "stop and summarise" },
    });
    expect((call[1] as { action: object }).action).not.toHaveProperty("requestId");
    await waitFor(() => expect(input.value).toBe(""));
    expect(mockToastSuccess).toHaveBeenCalledWith("Sent to the active turn");
  });

  test("keeps the text while backend-owned recovery is unresolved", async () => {
    seedRunningCodex();
    steerOutcome({ outcome: "unknown", requestId: "opaque-backend-id" });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    const input = screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Delivery is unconfirmed. Resolve the backend recovery card in the chat tab before sending another instruction.",
      ),
    );
    expect(input.value).toBe("wait");
  });

  test("reports an authoritative run mismatch without clearing the text", async () => {
    seedRunningCodex();
    steerOutcome({ outcome: "mismatch" });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    const input = screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("The active turn changed before delivery."),
    );
    expect(input.value).toBe("wait");
  });

  test("uses the same capability-driven backend action for Pi", async () => {
    seedProjection(TAB_ID, "running", "pi");
    steerOutcome({ outcome: "applied" });
    const tab = {
      ...codexTab(),
      nativeAgentData: {
        platform: "pi",
        environmentId: ENVIRONMENT_ID,
        containerId: "container-1",
        isLocal: false,
      },
    } as TabInfo;
    render(<AgentInfoButton activeTab={tab} />);
    open();

    expect(screen.getByText(/Sends directly to the current Pi turn/) !== null).toBe(true);
    expect(screen.queryByText(/current Codex turn/) === null).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Pi"), {
      target: { value: "finish the current tool first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() =>
      expect(
        nativeInvokeMock.mock.calls.some(
          ([command, args]) =>
            command === "perform_native_agent_session_action" &&
            (args as { agent?: string })?.agent === "pi",
        ),
      ).toBe(true),
    );
  });

  test("does not carry unsent steering text into another session", () => {
    seedRunningCodex("tab-2");
    const { rerender } = render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "meant for session A" },
    });

    rerender(<AgentInfoButton activeTab={codexTab({ id: "tab-2" })} />);
    reopen();

    expect(
      (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("AgentInfoButton runtime inventory", () => {
  test("reads rich usage and runtime inventory from the shared projection", () => {
    useNativeAgentProjectionStore.getState().setProjection(OPENCODE_KEY, {
      platform: "opencode",
      environmentId: ENVIRONMENT_ID,
      sessionId: "opencode-session-1",
      connection: "connected",
      turn: { phase: "idle" },
      messages: [],
      interactions: [],
      composerControls: [],
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
          speed: false,
          mode: true,
        },
      },
      contextUsage: {
        usedTokens: 1_200,
        maximumTokens: 12_000,
        percentage: 10,
        inputTokens: 800,
        outputTokens: 300,
        cacheReadTokens: 100,
        costUsd: 0.25,
        durationMs: 1_500,
        source: "opencode",
        estimated: false,
      },
      runtime: {
        mcpServers: 2,
        skills: 3,
        lspServers: 4,
        todos: 5,
        files: 6,
      },
      revision: 1,
      generation: "test",
    } satisfies NativeAgentSessionProjection);

    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    expect(metricValue("Input")).toBe("800");
    expect(metricValue("Output")).toBe("300");
    expect(metricValue("Cost")).toBe("$0.25");
    expect(metricValue("MCP")).toBe("2");
    expect(metricValue("Skills")).toBe("3");
    expect(metricValue("LSP")).toBe("4");
    expect(metricValue("Todos")).toBe("5");
    expect(metricValue("Files")).toBe("6");
  });

  test("counts Claude MCP servers, plugins and commands from the projection", () => {
    seedClaudeProjection({ runtime: { mcpServers: 2, plugins: 1, commands: 3 } });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(metricValue("MCP")).toBe("2");
    expect(metricValue("Plugins")).toBe("1");
    expect(metricValue("Commands")).toBe("3");
  });
});

describe("AgentInfoButton ACP agents", () => {
  const ACP_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);

  // The config store is module-global. Restore the shipped default so a test
  // that enables Cursor and Grok cannot change what a later file expects the
  // transfer list to contain.
  const enabledPlatformsBeforeSuite = useConfigStore.getState().config.global.enabledAgentPlatforms;
  afterEach(() => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: enabledPlatformsBeforeSuite,
    });
  });

  function acpTab(platform: "cursor" | "grok"): TabInfo {
    return {
      id: TAB_ID,
      type: "agent-native",
      nativeAgentData: {
        platform,
        environmentId: ENVIRONMENT_ID,
        containerId: "container-1",
        isLocal: false,
      },
    } as TabInfo;
  }

  function acpProjection(
    platform: "cursor" | "grok",
    overrides: Partial<NativeAgentSessionProjection> = {},
  ): NativeAgentSessionProjection {
    return {
      platform,
      environmentId: ENVIRONMENT_ID,
      sessionId: `${platform}-session-1`,
      connection: "connected",
      turn: { phase: "idle" },
      messages: [],
      interactions: [],
      composerControls: [],
      // The backend's own capability set for ACP agents: no fork, no compact,
      // no provider-side session actions of any kind.
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
        actions: {},
      },
      revision: 1,
      generation: "test",
      ...overrides,
    } as NativeAgentSessionProjection;
  }

  /** Seed an ACP session whose runtime carries exactly this MCP inventory. */
  function seedMcp(servers: unknown[]): void {
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_cursor_account_usage" ? new Promise(() => undefined) : {},
    );
    useNativeAgentProjectionStore.getState().setProjection(
      ACP_KEY,
      acpProjection("cursor", {
        runtime: { state: "attached", mcp: servers },
      } as Partial<NativeAgentSessionProjection>),
    );
  }

  function mcpActionCalls(): Array<{ serverId?: string; action?: string }> {
    return nativeInvokeMock.mock.calls
      .filter(([command]) => command === "perform_native_agent_mcp_action")
      .map(([, input]) => input as { serverId?: string; action?: string });
  }

  test.each(["signed-in", "signed-out", "needs-auth", "expired", "unknown"] as const)(
    "shows the %s auth fixture in the session's account card",
    async (state) => {
      nativeInvokeMock.mockImplementation(async (command: string) => {
        if (command === "get_native_agent_auth_status") {
          return {
            state,
            account: { label: "fixture@example.test", plan: "pro" },
            signIn: { kind: "terminal", hint: "Open a terminal and run grok login." },
            signOut: false,
          };
        }
        return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
      });
      useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
      render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      expect(await screen.findByText("fixture@example.test")).toBeTruthy();
      expect(screen.getByText(`${state.replaceAll("-", " ")} · pro`)).toBeTruthy();
      expect(screen.queryByText("Open a terminal and run grok login.") !== null).toBe(
        state !== "signed-in",
      );
    },
  );

  test("reads the account when the panel opens and again after signing out", async () => {
    const accountReads = () =>
      nativeInvokeMock.mock.calls.filter(([command]) => command === "get_native_agent_auth_status")
        .length;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status") {
        return accountReads() === 1
          ? { state: "signed-in", account: { label: "dev@example.test" }, signOut: true }
          : { state: "signed-out", signIn: { kind: "browser-url" } };
      }
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    // Not part of the projection: nothing asks until the account is shown.
    expect(accountReads()).toBe(0);

    open();
    expect(await screen.findByText("dev@example.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(accountReads()).toBe(2);
  });

  test("a late pre-logout read cannot restore the signed-in account", async () => {
    let reads = 0;
    let resolveOld!: (value: unknown) => void;
    const oldRead = new Promise((resolve) => {
      resolveOld = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status") {
        reads++;
        if (reads === 2) return oldRead;
        return reads === 1
          ? { state: "signed-in", account: { label: "old@example.test" }, signOut: true }
          : { state: "signed-out", signIn: { kind: "browser-url" } };
      }
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();
    await screen.findByText("old@example.test");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    open();
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in" });
    await act(async () =>
      resolveOld({ state: "signed-in", account: { label: "old@example.test" }, signOut: true }),
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("old@example.test") === null).toBe(true);
  });

  test.each(["browser-url", "device-code"])(
    "refreshes an open account after %s sign-in",
    async (kind) => {
      let reads = 0;
      nativeInvokeMock.mockImplementation(async (command: string) => {
        if (command === "get_native_agent_auth_status") {
          return ++reads === 1
            ? { state: "signed-out", signIn: { kind } }
            : {
                state: "signed-in",
                account: { label: "new@example.test", plan: "Pro" },
                signOut: true,
              };
        }
        if (command === "begin_native_agent_sign_in")
          return kind === "device-code" ? { code: "TEST-CODE" } : {};
        return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
      });
      useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
      render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
      expect(await screen.findByText("new@example.test")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
      expect(screen.getByText("signed in · Pro")).toBeTruthy();
    },
  );

  test("forwards remote device-code login, keeps the scoped toast after browser opening fails, and dismisses it on its own completion", async () => {
    const previousGateway = window.orkestratorGateway;
    window.orkestratorGateway = { enabled: true, desktop: true };
    let signedIn = false;
    let started = false;
    const expiresAt = Date.now() + 60_000;
    const pendingSignIn = {
      url: "https://auth.example.test/device",
      code: "REMOTE-CODE",
      expiresAt,
    };
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status")
        return signedIn
          ? { state: "signed-in", signOut: true }
          : {
              state: "signed-out",
              signIn: { kind: "device-code" },
              ...(started ? { pendingSignIn } : {}),
            };
      if (command === "begin_native_agent_sign_in") {
        started = true;
        return pendingSignIn;
      }
      if (command === "open_in_browser") throw new Error("No browser");
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    try {
      useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
      render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Could not open the sign-in link"),
      );
      const loginCall = nativeInvokeMock.mock.calls.find(
        ([command]) => command === "begin_native_agent_sign_in",
      );
      expect(loginCall?.[1]).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        agent: "cursor",
        deviceCode: true,
      });
      const toastCall = mockToastInfo.mock.calls.find(
        ([message]) => message === "Device code: REMOTE-CODE",
      );
      expect(toastCall).toBeTruthy();
      const options = toastCall![1] as {
        id: string;
        duration: number;
        closeButton: boolean;
        action: { label: string };
      };
      expect(options.id).toContain(ENVIRONMENT_ID);
      expect(options.id).toContain("cursor");
      // Stable across reads and long-lived, but never outliving the bridge's login deadline.
      expect(options.duration).toBe(15 * 60_000);
      expect(options.closeButton).toBe(true);
      expect(options.action.label).toBe("Open sign-in link");
      expect(
        mockToastInfo.mock.calls.every(([, value]) => (value as { id: string }).id === options.id),
      ).toBe(true);
      expect(mockToastDismiss.mock.calls.some(([id]) => id === options.id)).toBe(false);
      signedIn = true;
      fireEvent.focus(window);
      await screen.findByRole("button", { name: "Sign out" });
      expect(mockToastDismiss).toHaveBeenCalledWith(options.id);
    } finally {
      window.orkestratorGateway = previousGateway;
    }
  });

  test("the device-code toast cancels the sign-in on the provider's side", async () => {
    const previousGateway = window.orkestratorGateway;
    window.orkestratorGateway = { enabled: true, desktop: true };
    const pendingSignIn = {
      url: "https://auth.example.test/device",
      code: "CANCEL-CODE",
      expiresAt: Date.now() + 60_000,
    };
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status")
        return { state: "signed-out", signIn: { kind: "device-code" } };
      if (command === "begin_native_agent_sign_in") return pendingSignIn;
      if (command === "cancel_native_agent_sign_in") return { cancelled: true };
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    try {
      useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
      render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
      await waitFor(() =>
        expect(
          mockToastInfo.mock.calls.some(([message]) => message === "Device code: CANCEL-CODE"),
        ).toBe(true),
      );
      const options = mockToastInfo.mock.calls.find(
        ([message]) => message === "Device code: CANCEL-CODE",
      )![1] as { id: string; cancel: { label: string; onClick: () => void } };
      expect(options.cancel.label).toBe("Cancel sign-in");
      options.cancel.onClick();
      expect(mockToastDismiss).toHaveBeenCalledWith(options.id);
      await waitFor(() =>
        expect(
          nativeInvokeMock.mock.calls.find(
            ([command]) => command === "cancel_native_agent_sign_in",
          )?.[1],
        ).toMatchObject({ environmentId: ENVIRONMENT_ID, agent: "cursor" }),
      );
    } finally {
      window.orkestratorGateway = previousGateway;
    }
  });

  test.each(["environment", "provider"])(
    "an authenticated unrelated %s cannot dismiss another login's toast",
    async (change) => {
      let started = false;
      const pendingSignIn = {
        url: "https://auth.example.test/device",
        code: "KEEP-CODE",
        expiresAt: Date.now() + 60_000,
      };
      nativeInvokeMock.mockImplementation(async (command: string, input: unknown) => {
        const scope = input as { environmentId?: string; agent?: string } | undefined;
        if (command === "get_native_agent_auth_status") {
          if (scope?.environmentId !== ENVIRONMENT_ID || scope.agent !== "cursor")
            return { state: "signed-in", signOut: true };
          return {
            state: "signed-out",
            signIn: { kind: "device-code" },
            ...(started ? { pendingSignIn } : {}),
          };
        }
        if (command === "begin_native_agent_sign_in") {
          started = true;
          return pendingSignIn;
        }
        return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
      });
      useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
      const view = render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
      await waitFor(() => expect(mockToastInfo).toHaveBeenCalled());
      const originalId = (mockToastInfo.mock.calls[0]![1] as { id: string }).id;
      const otherTab =
        change === "provider"
          ? acpTab("grok")
          : {
              ...acpTab("cursor"),
              nativeAgentData: { ...acpTab("cursor").nativeAgentData!, environmentId: "env-other" },
            };
      view.rerender(<AgentInfoButton activeTab={otherTab} />);
      open();
      await screen.findByRole("button", { name: "Sign out" });
      expect(mockToastDismiss.mock.calls.some(([id]) => id === originalId)).toBe(false);
      view.unmount();
      // Reopening the owning scope recovers the code and URL through an account read.
      render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      await waitFor(() => expect(mockToastInfo.mock.calls.length).toBeGreaterThan(1));
      expect(
        nativeInvokeMock.mock.calls.filter(([command]) => command === "begin_native_agent_sign_in"),
      ).toHaveLength(1);
      expect((mockToastInfo.mock.calls.at(-1)![1] as { id: string }).id).toBe(originalId);
    },
  );

  test("withdraws a code when its bridge confirms the login ended without signing in", async () => {
    let pendingSignIn: { url: string; code: string; expiresAt: number } | null = null;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status")
        return {
          state: "signed-out",
          signIn: { kind: "device-code" },
          pendingSignIn,
        };
      if (command === "begin_native_agent_sign_in") {
        pendingSignIn = {
          url: "https://auth.example.test/device",
          code: "CANCELLED-CODE",
          expiresAt: Date.now() + 60_000,
        };
        return pendingSignIn;
      }
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mockToastInfo).toHaveBeenCalled());
    const id = (mockToastInfo.mock.calls[0]![1] as { id: string }).id;
    mockToastDismiss.mockClear();
    pendingSignIn = null;
    fireEvent.focus(window);
    await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith(id));
  });

  test("polls until browser sign-in finishes while the panel stays open", async () => {
    let reads = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status") {
        return ++reads < 3
          ? { state: "signed-out", signIn: { kind: "browser-url" } }
          : { state: "signed-in", account: { label: "completed@example.test" }, signOut: true };
      }
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByText("completed@example.test", {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  test.each(["reject", "null"])(
    "retries a %s account read without closing the panel",
    async (failure) => {
      let reads = 0;
      nativeInvokeMock.mockImplementation(async (command: string) => {
        if (command === "get_native_agent_auth_status") {
          if (++reads === 1) {
            if (failure === "reject") throw new Error("Bridge unavailable");
            return null;
          }
          return { state: "signed-out", signIn: { kind: "browser-url" } };
        }
        return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
      });
      useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
      render(<AgentInfoButton activeTab={acpTab("cursor")} />);
      open();
      fireEvent.click(await screen.findByRole("button", { name: "Retry account status" }));
      expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
      expect(screen.queryByText("Could not read account status.") === null).toBe(true);
    },
  );

  test("closing the panel cancels imperative post-sign-out reads", async () => {
    let reads = 0;
    let resolveLogout!: (value: unknown) => void;
    const logoutRead = new Promise((resolve) => {
      resolveLogout = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_native_agent_auth_status") {
        reads++;
        if (reads === 2) return logoutRead;
        if (reads > 2) return new Promise(() => undefined);
        return { state: "signed-in", account: { label: "retained@example.test" }, signOut: true };
      }
      return command === "get_cursor_account_usage" ? new Promise(() => undefined) : {};
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await act(async () => resolveLogout({ state: "signed-out", signIn: { kind: "browser-url" } }));
    open();
    expect(await screen.findByText("retained@example.test")).toBeTruthy();
  });

  test("collapses the MCP inventory into a tool total that expands and reconnects on click", async () => {
    // A session with a dozen servers used to render a dozen cards; the popover
    // now leads with the tool total and only expands the dense list on demand,
    // where the row itself is the reconnect control.
    seedMcp([
      {
        id: "codex_apps",
        name: "codex_apps",
        status: "connected",
        toolCount: 256,
        actions: ["reconnect"],
      },
      {
        id: "github",
        name: "github",
        status: "failed",
        toolCount: 0,
        error: "spawn failed",
        actions: ["reconnect"],
      },
    ]);
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    const summary = await waitFor(() => screen.getByRole("button", { name: /Tools 256/ }));
    // Collapsed, but a server that is down still says so.
    expect(summary.textContent).toContain("2 servers");
    expect(summary.textContent).toContain("1 down");
    expect(screen.queryByRole("button", { name: /codex_apps/ }) === null).toBe(true);

    fireEvent.click(summary);
    const row = screen.getByRole("button", { name: /codex_apps/ });
    expect(screen.getByRole("button", { name: /github/ })).toBeTruthy();

    fireEvent.click(row);
    await waitFor(() =>
      expect(
        mcpActionCalls().some(
          (input) => input.serverId === "codex_apps" && input.action === "reconnect",
        ),
      ).toBe(true),
    );
  });

  test("shows a failed server's error as text rather than only a tooltip", async () => {
    // The popover is rendered on touch too, where a `title` never appears, so
    // the reason a server is down has to survive as readable content.
    seedMcp([
      {
        id: "github",
        name: "github",
        status: "failed",
        toolCount: 0,
        error: "spawn failed: ENOENT",
        actions: ["reconnect"],
      },
    ]);
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /Tools 0/ })));
    expect(screen.getByText("spawn failed: ENOENT")).toBeTruthy();
  });

  test("never makes disable the implicit row action for a connected OpenCode server", async () => {
    // OpenCode advertises `disable` as the only action on a healthy server. The
    // row is not labelled as destructive, so clicking it must do nothing and the
    // teardown must live behind its own labelled button.
    seedMcp([{ id: "context7", name: "context7", status: "connected", actions: ["disable"] }]);
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /Tools/ })));
    // The name region is inert: the only button carrying the server name is the
    // explicit `disable` control.
    const named = screen.getAllByRole("button", { name: /context7/ });
    expect(named.length).toBe(1);
    expect(named[0]?.textContent).toBe("disable");

    fireEvent.click(screen.getByText("context7"));
    await waitFor(() => expect(screen.getByText("context7")).toBeTruthy());
    expect(mcpActionCalls()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "disable context7" }));
    await waitFor(() =>
      expect(
        mcpActionCalls().some(
          (input) => input.serverId === "context7" && input.action === "disable",
        ),
      ).toBe(true),
    );
  });

  test("keeps every non-primary action reachable on a multi-action server", async () => {
    // Claude offers three actions on a signed-out server. Collapsing the card
    // must not silently drop the two the row click does not run.
    seedMcp([
      {
        id: "linear",
        name: "linear",
        status: "needs-auth",
        toolCount: 12,
        actions: ["reconnect", "disable", "sign-in"],
      },
    ]);
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /Tools 12/ })));
    expect(screen.getByRole("button", { name: "reconnect linear" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "disable linear" })).toBeTruthy();

    // `sign-in` unblocks a signed-out server, so it wins the row itself even
    // though the adapter listed it last.
    fireEvent.click(screen.getByRole("button", { name: /^linear/ }));
    await waitFor(() =>
      expect(
        mcpActionCalls().some((input) => input.serverId === "linear" && input.action === "sign-in"),
      ).toBe(true),
    );
  });

  test("reports an unknown tool inventory as unknown rather than zero", async () => {
    // OpenCode never sends `toolCount`. `Tools 0` would be a claim about a
    // connected server that the adapter never made.
    seedMcp([
      { id: "context7", name: "context7", status: "connected", actions: ["disable"] },
      { id: "sentry", name: "sentry", status: "connected", actions: ["disable"] },
    ]);
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    const summary = await waitFor(() => screen.getByRole("button", { name: /Tools/ }));
    expect(summary.textContent).toContain("Tools —");
    expect(summary.textContent).not.toContain("Tools 0");

    fireEvent.click(summary);
    // Scoped to the inventory: other panels in the popover use the same dash.
    const panel = screen.getByLabelText("MCP servers");
    expect(within(panel).getAllByText("—").length).toBe(2);
  });

  test("leaves a server with no advertised actions readable instead of disabled", async () => {
    // Cursor publishes `actions: []`. Rendering those rows as disabled buttons
    // greyed out servers that are perfectly healthy.
    seedMcp([
      { id: "orkestrator", name: "orkestrator", status: "connected", toolCount: 9, actions: [] },
    ]);
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /Tools 9/ })));
    expect(screen.getByText("orkestrator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /orkestrator/ }) === null).toBe(true);
  });

  test("renders drift and notices for a non-Codex platform through the same panel", async () => {
    // The point of the generalization: nothing in `AgentRuntimePanel` is
    // Codex-shaped, so a Cursor session gets the same drift block and the same
    // notice cards from the same projection fields.
    useNativeAgentProjectionStore.getState().setProjection(
      createSessionKey(ENVIRONMENT_ID, TAB_ID),
      acpProjection("cursor", {
        runtime: {
          state: "attached",
          drift: { unknownEvents: 3, unknownKinds: ["tool:webSearch"] },
          notices: [
            { message: "Cursor substituted a model", severity: "warning", source: "provider" },
          ],
        },
      }),
    );
    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    await waitFor(() =>
      expect(screen.getByText("3 events this bridge did not recognise")).toBeTruthy(),
    );
    expect(screen.getByText("tool:webSearch")).toBeTruthy();
    expect(screen.getByText("Cursor substituted a model")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Show details for Cursor substituted a model" }),
    );
    expect(screen.getByRole("dialog", { name: "Cursor Agent runtime notice" })).toBeTruthy();
    expect(
      screen.getByText("Cursor Agent did not provide additional detail for this notice."),
    ).toBeTruthy();
  });

  test("names a Grok session and renders the usage its bridge reported", () => {
    useNativeAgentProjectionStore.getState().setProjection(
      ACP_KEY,
      acpProjection("grok", {
        composer: {
          models: [],
          fastModeEnabled: null,
          fastModeAvailable: false,
          modes: [],
          selectedModelId: "grok-4.6",
        },
        contextUsage: {
          usedTokens: 15_675,
          maximumTokens: 500_000,
          percentage: 3.135,
          inputTokens: 15_639,
          outputTokens: 36,
          cacheReadTokens: 5_888,
          reasoningTokens: 31,
          durationMs: 3_200,
          source: "provider",
        },
        runtime: { mcpServers: 2, commands: 3, version: "1.0.3", state: "idle" },
      }),
    );

    render(<AgentInfoButton activeTab={acpTab("grok")} />);
    open();

    expect(screen.getByRole("heading", { name: "Grok Build" })).toBeTruthy();
    // The bridge reports no window of its own; the backend joins the selected
    // model's `contextWindow` onto the snapshot, so a Grok session that has one
    // must render the same meter the first-party providers do.
    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("3.1%")).toBeTruthy();
    expect(
      screen.getByText((_content, element) => element?.textContent === "16k / 500k"),
    ).toBeTruthy();
    expect(
      screen.getByText((_content, element) => element?.textContent === "484k available"),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "3 percent of context used" })).toBeTruthy();
    expect(metricValue("Input")).toBe("16k");
    expect(metricValue("Output")).toBe("36");
    expect(metricValue("Cache read")).toBe("5.9k");
    expect(metricValue("Reasoning")).toBe("31");
    expect(metricValue("MCP")).toBe("2");
    expect(metricValue("Commands")).toBe("3");
    expect(popover().textContent).toContain("Grok Build 1.0.3");
  });

  test("renders Cursor usage when the bridge reported a snapshot", () => {
    useNativeAgentProjectionStore.getState().setProjection(
      ACP_KEY,
      acpProjection("cursor", {
        composer: {
          models: [],
          fastModeEnabled: null,
          fastModeAvailable: false,
          modes: [],
          selectedModelId: "grok-4.6",
        },
        contextUsage: {
          usedTokens: 15_675,
          maximumTokens: 200_000,
          percentage: 7.8375,
          inputTokens: 10_000,
          outputTokens: 2_000,
          reasoningTokens: 300,
          costUsd: 0.042,
          source: "provider",
        },
        runtime: { commands: 7, state: "idle" },
      }),
    );

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.getByRole("heading", { name: "Cursor Agent" })).toBeTruthy();
    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("7.8%")).toBeTruthy();
    expect(metricValue("Input")).toBe("10k");
    expect(metricValue("Output")).toBe("2.0k");
    expect(metricValue("Reasoning")).toBe("300");
    expect(metricValue("Cost")).toBe("$0.04");
    expect(metricValue("Commands")).toBe("7");
    expect(screen.queryByText(/first token snapshot/) === null).toBe(true);
  });

  test("draws Cursor plan-quota windows with the shared account bars", () => {
    const windowMinutes = 31 * 24 * 60;
    const resetsAt = new Date(Date.now() + (windowMinutes / 2) * 60_000).toISOString();
    useNativeAgentProjectionStore.getState().setProjection(
      ACP_KEY,
      acpProjection("cursor", {
        contextUsage: {
          usedTokens: 15_675,
          source: "cursor",
          account: [
            {
              window: "cursor-internal-auto",
              label: "Cursor Models",
              usedPercent: 0,
              resetsAt,
              windowMinutes,
            },
            {
              window: "cursor-internal-api",
              label: "Other Models",
              usedPercent: 46.444,
              resetsAt,
              windowMinutes,
            },
            { window: "agent", label: "Agent total", tokens: 1_300_000, spendUsd: 1.25 },
          ],
        },
      }),
    );

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    const account = screen.getByRole("region", { name: "Account usage" });
    expect(within(account).getByText("Cursor Models")).toBeTruthy();
    expect(within(account).getByText("0.0% used")).toBeTruthy();
    expect(
      within(account).getByRole("progressbar", { name: "Cursor Models: 0.0% used" }),
    ).toBeTruthy();
    expect(within(account).getByText("Other Models")).toBeTruthy();
    expect(within(account).getByText("46% used")).toBeTruthy();
    expect(
      within(account).getByRole("progressbar", { name: "Other Models: 46% used" }),
    ).toBeTruthy();
    expect(
      within(account).getAllByRole("img", {
        name: /Current point in the (Cursor Models|Other Models) period: 50%/,
      }),
    ).toHaveLength(2);
    expect(within(account).getByText("Agent total")).toBeTruthy();
    expect(within(account).getByText("1.3M")).toBeTruthy();
    expect(within(account).getByText("$1.25")).toBeTruthy();
  });

  test("shows Cursor's runtime and says nothing about tokens it never reports", () => {
    useNativeAgentProjectionStore.getState().setProjection(
      ACP_KEY,
      acpProjection("cursor", {
        runtime: { commands: 7, state: "idle" },
      }),
    );

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.getByRole("heading", { name: "Cursor Agent" })).toBeTruthy();
    expect(metricValue("Commands")).toBe("7");
    // No context meter, rather than one reading zero out of zero.
    expect(popover().textContent).toContain(
      "Usage will appear after this session reports its first token snapshot.",
    );
    expect(screen.queryByText("Context") === null).toBe(true);
    // Cursor advertises no MCP inventory, so the panel must not claim it has none.
    expect(screen.queryByText("MCP") === null).toBe(true);
  });

  test("shows token metrics without inventing a context window", () => {
    useNativeAgentProjectionStore.getState().setProjection(
      ACP_KEY,
      acpProjection("grok", {
        composer: {
          models: [],
          fastModeEnabled: null,
          fastModeAvailable: false,
          modes: [],
          selectedModelId: "grok-4.6",
        },
        contextUsage: {
          usedTokens: 222,
          inputTokens: 200,
          outputTokens: 22,
          source: "provider",
        },
      }),
    );

    render(<AgentInfoButton activeTab={acpTab("grok")} />);
    open();

    expect(metricValue("Input")).toBe("200");
    expect(metricValue("Output")).toBe("22");
    // Assert the meter's own elements rather than the word "available": the
    // runtime panel below renders "state unavailable"/"version unavailable" for
    // an agent that reports neither, so a substring match there would pass or
    // fail for reasons that have nothing to do with the context window.
    expect(screen.queryByText("Context") === null).toBe(true);
    expect(screen.queryByRole("progressbar", { name: /percent of context used/ }) === null).toBe(
      true,
    );
    expect(
      screen.queryAllByText((_content, element) =>
        /^\S+ available$/.test(element?.textContent ?? ""),
      ),
    ).toHaveLength(0);
    expect(popover().textContent).toContain("Provider reported");
  });

  test("hides the provider actions an ACP agent cannot perform, but offers the transfer", () => {
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.queryByRole("button", { name: /Fork session/ }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: /Compact/ }) === null).toBe(true);
    // A transfer needs nothing from the provider beyond reading its own
    // transcript, so it survives a capability set that refuses everything else.
    expect(screen.getByRole("button", { name: /Continue in/ })).toBeTruthy();
    expect(screen.getByText("Session actions")).toBeTruthy();
  });

  test("offers every enabled agent except the source as a transfer destination", () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));

    for (const label of ["Claude", "Codex", "Grok", "OpenCode"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // The source is named as the origin chip, never offered as a destination.
    expect(screen.queryByRole("button", { name: "Cursor" }) === null).toBe(true);
  });

  test("hides the transfer when no other agent is enabled", () => {
    useConfigStore.getState().updateGlobalConfig({ enabledAgentPlatforms: ["cursor"] });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.queryByRole("button", { name: /Continue in/ }) === null).toBe(true);
    // Nothing else is available for an ACP session, so the heading goes too.
    expect(screen.queryByText("Session actions") === null).toBe(true);
  });

  test("transfers an ACP conversation read from its authoritative projection", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
    });
    const projection = acpProjection("cursor", {
      title: "Cursor investigated the flake",
      messages: [
        {
          id: "cursor-message-1",
          role: "user",
          content: "why is this test flaky",
          parts: [{ type: "text", content: "why is this test flaky" }],
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, projection);
    const saved: Array<Record<string, unknown>> = [];
    // Every transfer reads the backend
    // projection twice and refuses unless both reads agree. Both answer the
    // same snapshot; the revision guard is exercised by its own test below.
    nativeInvokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_native_agent_projection") return projection;
      if (command === "save_agent_handoff") {
        saved.push(args.snapshot as Record<string, unknown>);
        // Handoffs are immutable server-side, so the caller verifies the stored
        // record matches what it wrote before caching it.
        return {
          id: args.handoffId,
          environmentId: args.environmentId,
          version: args.version,
          snapshot: args.snapshot,
          createdAt: "2026-08-14T10:00:00.000Z",
        };
      }
      return undefined;
    });

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    expect(saved.at(-1)).toMatchObject({
      sourceProvider: "cursor",
      destinationProvider: "claude",
      sourceTitle: "Cursor investigated the flake",
    });
    const destinationTab = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((tab) => tab.id !== TAB_ID)!;
    expect(destinationTab.nativeAgentData?.platform).toBe("claude");
    expect(destinationTab.displayTitle).toBe("Claude · from Cursor");
    expect(destinationTab.agentHandoffId).toBeTruthy();
  });

  test("refuses an ACP transfer when the conversation moves between reads", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
    });
    const projection = acpProjection("grok", {
      messages: [
        {
          id: "grok-message-1",
          role: "user",
          content: "keep going",
          parts: [{ type: "text", content: "keep going" }],
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, projection);
    let reads = 0;
    nativeInvokeMock.mockImplementation(
      async (command: string, args?: { refreshUsage?: boolean }) => {
        if (command !== "get_native_agent_projection") return undefined;
        // Opening the information panel performs an independent detailed-usage
        // refresh. It is not one of the handoff's two consistency reads.
        if (args?.refreshUsage) return projection;
        reads += 1;
        // The second read lands after the agent advanced a revision.
        return reads === 1 ? projection : { ...projection, revision: projection.revision + 1 };
      },
    );

    render(<AgentInfoButton activeTab={acpTab("grok")} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Grok Build conversation changed while it was being transferred",
      ),
    );
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
  });

  test("reports an agent that volunteers no runtime facts as unknown", () => {
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(popover().textContent).toContain("Cursor Agent does not report runtime details.");
  });
});
