import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useConfigStore } from "@/stores/configStore";
import type { TabInfo } from "@/types/paneLayout";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  createAgentHandoffSnapshot,
  loadAgentHandoff,
  rememberAgentHandoff,
  resetAgentHandoffCache,
} from "@/lib/agent-handoff";
import {
  mockToastError,
  mockToastSuccess,
  mockToastWarning,
} from "../../../../../tests/mocks/sonner";

/*
 * Only the network-facing helpers are replaced; everything else in each client
 * module stays real (snapshot-and-restore, per AGENTS.md) so the suites that
 * import those modules for real are unaffected once this file finishes.
 */
import * as realClaudeClient from "@/lib/claude-client";
import * as realOpenCodeClient from "@/lib/opencode-client";
import * as realCodexClient from "@/lib/codex-client";
import { createSessionKey } from "@/lib/utils";

const realClaudeClientSnapshot = { ...realClaudeClient };
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };
const realCodexClientSnapshot = { ...realCodexClient };

const mockForkClaudeSession = mock<
  (_client: unknown, _sessionId: string) => Promise<{ sessionId: string; title?: string }>
>(async () => ({ sessionId: "claude-fork", title: "Claude fork title" }));
const mockCompactClaudeSession = mock(async () => true);
const mockGetClaudeSession = mock<
  (
    _client: unknown,
    _sessionId: string,
  ) => Promise<{
    id: string;
    status: "idle" | "running" | "error";
    createdAt: string;
    lastActivity: string;
  } | null>
>(async () => ({
  id: "claude-session-1",
  status: "idle" as const,
  createdAt: "2026-07-27T10:00:00.000Z",
  lastActivity: "2026-07-27T10:01:00.000Z",
}));
const mockGetClaudeSessionMessages = mock(async () => [{
  id: "m1",
  role: "user" as const,
  content: "continue this",
  parts: [{ type: "text" as const, content: "continue this" }],
  createdAt: "2026-07-27T10:00:00.000Z",
}]);
const mockRewindClaudeFiles = mock<
  (
    _client: unknown,
    _sessionId: string,
    _messageId: string,
    _dryRun?: boolean,
  ) => Promise<unknown>
>(async () => ({ files: [] }));
const mockStopClaudeBackgroundTask = mock(async () => true);

const mockCompactOpenCodeSession = mock(async () => undefined);
const mockForkOpenCodeSession = mock<
  (_client: unknown, _sessionId: string) => Promise<{ id: string; title?: string }>
>(async () => ({ id: "opencode-fork", title: "OpenCode fork title" }));
const mockGetOpenCodeSessionMessages = mock<
  (_client: unknown, _sessionId: string) => Promise<NativeMessage[]>
>(async () => [{
  id: "opencode-message-1",
  role: "user" as const,
  content: "continue from OpenCode",
  parts: [{ type: "text" as const, content: "continue from OpenCode" }],
  createdAt: "2026-07-27T10:00:00.000Z",
}]);
const mockGetOpenCodeSessionStatus = mock<
  (
    _client: unknown,
    _sessionId: string,
    _options?: { throwOnError?: boolean },
  ) => Promise<"idle" | "busy" | "retry" | null>
>(async () => "idle");
const mockRevertOpenCodeSession = mock(async () => undefined);
const mockUnrevertOpenCodeSession = mock(async () => undefined);
const mockShareOpenCodeSession = mock<
  (_client: unknown, _sessionId: string) => Promise<string | undefined>
>(async () => "https://share.opencode.test/abc");
const mockUnshareOpenCodeSession = mock(async () => undefined);

const mockCompactCodexSession = mock(async () => true);
// `forkCodexSession` throws a `CodexForkError` carrying the bridge's status and
// message rather than collapsing every refusal to null.
const mockForkCodexSession = mock<
  (
    _client: unknown,
    _sessionId: string,
    _messageId?: string,
  ) => Promise<{ sessionId: string; title?: string }>
>(async () => ({ sessionId: "codex-fork", title: "Codex fork title" }));
const mockGetCodexSessionMessages = mock<
  (_client: unknown, _sessionId: string) => Promise<NativeMessage[]>
>(async () => [{
  id: "codex-message-1",
  role: "user" as const,
  content: "continue from Codex",
  parts: [{ type: "text" as const, content: "continue from Codex" }],
  createdAt: "2026-07-27T10:00:00.000Z",
}]);
const mockGetCodexSessionStatus = mock<
  (
    _client: unknown,
    _sessionId: string,
    _options?: { throwOnError?: boolean },
  ) => Promise<{
    status: "idle" | "running" | "error";
    title?: string;
    messageRevision?: number;
  } | null>
>(async () => ({ status: "idle" }));
const mockGetCodexRuntimeHealth = mock<
  (_client: unknown, _sessionId: string) => Promise<unknown>
>(async () => null);
const mockStartCodexNativeReview = mock(async () => true);
const mockSteerCodexSession = mock<
  (
    _client: unknown,
    _sessionId: string,
    _text: string,
    _requestId: string,
  ) => Promise<realCodexClient.CodexSteerOutcome>
>(async () => ({ outcome: "accepted" }));

mock.module("@/lib/claude-client", () => ({
  ...realClaudeClientSnapshot,
  compactClaudeSession: mockCompactClaudeSession,
  forkClaudeSession: mockForkClaudeSession,
  getSession: mockGetClaudeSession,
  getSessionMessages: mockGetClaudeSessionMessages,
  rewindClaudeFiles: mockRewindClaudeFiles,
  stopClaudeBackgroundTask: mockStopClaudeBackgroundTask,
}));

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  compactOpenCodeSession: mockCompactOpenCodeSession,
  forkOpenCodeSession: mockForkOpenCodeSession,
  getSessionMessages: mockGetOpenCodeSessionMessages,
  getSessionStatus: mockGetOpenCodeSessionStatus,
  revertOpenCodeSession: mockRevertOpenCodeSession,
  shareOpenCodeSession: mockShareOpenCodeSession,
  unrevertOpenCodeSession: mockUnrevertOpenCodeSession,
  unshareOpenCodeSession: mockUnshareOpenCodeSession,
}));

mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  compactCodexSession: mockCompactCodexSession,
  forkCodexSession: mockForkCodexSession,
  getSessionMessages: mockGetCodexSessionMessages,
  getSessionStatus: mockGetCodexSessionStatus,
  getCodexRuntimeHealth: mockGetCodexRuntimeHealth,
  startCodexNativeReview: mockStartCodexNativeReview,
  steerCodexSession: mockSteerCodexSession,
}));

const {
  AgentInfoButton,
  describeRewindTarget,
  formatResetDateTime,
  summarizeRewindPreview,
  weeklyWindowPosition,
} =
  await import("./AgentInfoButton");

afterAll(() => {
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
});

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const CLAUDE_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const CODEX_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const OPENCODE_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const CLAUDE_CLIENT = { baseUrl: "http://127.0.0.1:1111" } as never;
const CODEX_CLIENT = { baseUrl: "http://127.0.0.1:2222" } as never;
const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

let openCodeSessionGet = mock(
  async (_parameters: { sessionID: string }): Promise<unknown> => ({
    data: { id: "opencode-session-1" },
  }),
);
let openCodeClient: unknown;

function claudeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: TAB_ID,
    type: "agent-native",
    nativeAgentData: { platform: "claude", environmentId: ENVIRONMENT_ID, sessionId: "claude-session-1" },
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
  return screen.getByText(label).parentElement?.querySelector("div.font-mono")?.textContent
    ?? undefined;
}

let confirmResult = true;
let confirmMessages: string[] = [];
let clipboardWrites: string[] = [];
let clipboardRejection: Error | null = null;
const originalConfirm = window.confirm;

beforeEach(() => {
  useNativeAgentProjectionStore.getState().reset();
  confirmResult = true;
  confirmMessages = [];
  clipboardWrites = [];
  clipboardRejection = null;
  nativeInvokeMock.mockClear();
  nativeInvokeMock.mockImplementation(() => Promise.resolve());

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

  openCodeSessionGet = mock(async (_parameters: { sessionID: string }): Promise<unknown> => ({
    data: { id: "opencode-session-1" },
  }));
  openCodeClient = { session: { get: openCodeSessionGet } };

  mockForkClaudeSession.mockClear();
  mockCompactClaudeSession.mockClear();
  mockGetClaudeSession.mockClear();
  mockGetClaudeSessionMessages.mockClear();
  mockRewindClaudeFiles.mockClear();
  mockStopClaudeBackgroundTask.mockClear();
  mockCompactOpenCodeSession.mockClear();
  mockForkOpenCodeSession.mockClear();
  mockGetOpenCodeSessionMessages.mockClear();
  mockGetOpenCodeSessionStatus.mockClear();
  mockRevertOpenCodeSession.mockClear();
  mockUnrevertOpenCodeSession.mockClear();
  mockShareOpenCodeSession.mockClear();
  mockUnshareOpenCodeSession.mockClear();
  mockCompactCodexSession.mockClear();
  mockForkCodexSession.mockClear();
  mockGetCodexSessionMessages.mockClear();
  mockGetCodexSessionStatus.mockClear();
  mockGetCodexRuntimeHealth.mockClear();
  mockStartCodexNativeReview.mockClear();
  mockSteerCodexSession.mockClear();

  mockForkClaudeSession.mockImplementation(async () => ({
    sessionId: "claude-fork",
    title: "Claude fork title",
  }));
  mockCompactClaudeSession.mockImplementation(async () => true);
  mockGetClaudeSession.mockImplementation(async () => ({
    id: "claude-session-1",
    status: "idle",
    createdAt: "2026-07-27T10:00:00.000Z",
    lastActivity: "2026-07-27T10:01:00.000Z",
  }));
  mockGetClaudeSessionMessages.mockImplementation(async () => [{
    id: "m1",
    role: "user",
    content: "continue this",
    parts: [{ type: "text", content: "continue this" }],
    createdAt: "2026-07-27T10:00:00.000Z",
  }]);
  mockRewindClaudeFiles.mockImplementation(async () => ({ files: [] }));
  mockStopClaudeBackgroundTask.mockImplementation(async () => true);
  mockCompactOpenCodeSession.mockImplementation(async () => undefined);
  mockForkOpenCodeSession.mockImplementation(async () => ({
    id: "opencode-fork",
    title: "OpenCode fork title",
  }));
  mockGetOpenCodeSessionMessages.mockImplementation(async () => [{
    id: "opencode-message-1",
    role: "user",
    content: "continue from OpenCode",
    parts: [{ type: "text", content: "continue from OpenCode" }],
    createdAt: "2026-07-27T10:00:00.000Z",
  }]);
  mockGetOpenCodeSessionStatus.mockImplementation(async () => "idle");
  mockRevertOpenCodeSession.mockImplementation(async () => undefined);
  mockUnrevertOpenCodeSession.mockImplementation(async () => undefined);
  mockShareOpenCodeSession.mockImplementation(async () => "https://share.opencode.test/abc");
  mockUnshareOpenCodeSession.mockImplementation(async () => undefined);
  mockCompactCodexSession.mockImplementation(async () => true);
  mockForkCodexSession.mockImplementation(async () => ({
    sessionId: "codex-fork",
    title: "Codex fork title",
  }));
  mockGetCodexSessionMessages.mockImplementation(async () => [{
    id: "codex-message-1",
    role: "user",
    content: "continue from Codex",
    parts: [{ type: "text", content: "continue from Codex" }],
    createdAt: "2026-07-27T10:00:00.000Z",
  }]);
  mockGetCodexSessionStatus.mockImplementation(async () => ({ status: "idle" }));
  mockGetCodexRuntimeHealth.mockImplementation(async () => null);
  mockStartCodexNativeReview.mockImplementation(async () => true);
  mockSteerCodexSession.mockImplementation(async () => ({ outcome: "accepted" }));
  resetAgentHandoffCache();

  seedPaneLayout();
});

/*
 * Every store map this component reads is reset, not just the two the original
 * test cleared: a dirty `clients`/`sessions`/`sessionInitData` map leaks into
 * whatever file the worker picks up next.
 */
afterEach(() => {
  cleanup();
  window.confirm = originalConfirm;
  useClaudeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    contextUsage: new Map(),
    rateLimits: new Map(),
    selectedModel: new Map(),
    sessionInitData: new Map(),
    selectedAgent: new Map(),
    includeLocalSettings: new Map(),
    promptSuggestionOptIn: new Map(),
    backgroundTasks: new Map(),
    completionBlockedByBackgroundTasks: new Map(),
  });
  useCodexStore.setState({
    clients: new Map(),
    sessions: new Map(),
    contextUsage: new Map(),
    selectedModel: new Map(),
  });
  useOpenCodeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    contextUsage: new Map(),
    selectedModel: new Map(),
    selectedAgent: new Map(),
    runtimeHealth: new Map(),
  });
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  } as never);
});

describe("AgentInfoButton popover lifecycle", () => {
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
    expect(screen.queryByRole("dialog", { name: "Agent information" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open agent information" }).getAttribute("aria-expanded"),
    ).toBe("false");

    open();
    expect(isPopoverOpen()).toBe(true);
    expect(popover().className).toContain("visible");
    expect(screen.getByRole("dialog", { name: "Agent information" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Close agent information" })[0]!
        .getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);
    expect(isPopoverOpen()).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Agent information" })).toBeNull();
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
    expect(screen.queryByText("Session actions")).toBeNull();
  });

  test("a tab whose native data is missing is treated as no session", () => {
    render(<AgentInfoButton activeTab={{ id: TAB_ID, type: "agent-native" } as TabInfo} />);
    open();
    expect(screen.getByText("No native agent")).toBeTruthy();
  });

  test("labels an OpenCode session and reads its environment-scoped model", () => {
    useOpenCodeStore.setState({
      contextUsage: new Map([[OPENCODE_KEY, usage({ source: "opencode" })]]),
      selectedModel: new Map([[ENVIRONMENT_ID, "anthropic/claude-sonnet"]]),
    } as never);
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    expect(screen.getByText("OpenCode")).toBeTruthy();
    expect(screen.getByText("anthropic/claude-sonnet")).toBeTruthy();
  });

  test("labels a Codex session and reads its session-scoped model", () => {
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
      selectedModel: new Map([[CODEX_KEY, "gpt-5.3-codex"]]),
    } as never);
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    expect(screen.getByText("Codex Native")).toBeTruthy();
    expect(screen.getByText("gpt-5.3-codex")).toBeTruthy();
  });
});

describe("AgentInfoButton usage panel", () => {
  test("positions the current-week marker relative to the reset boundary", () => {
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    const halfwayMs = resetMs - 3.5 * 24 * 60 * 60 * 1_000;

    expect(
      weeklyWindowPosition({
        label: "Secondary",
        resetsAt: new Date(resetMs).toISOString(),
        windowMinutes: 10_080,
      }, halfwayMs),
    ).toBe(50);
    // Claude names the period but does not currently report its duration.
    expect(
      weeklyWindowPosition({
        label: "Weekly (Sonnet)",
        resetsAt: new Date(resetMs).toISOString(),
      }, halfwayMs),
    ).toBe(50);
  });

  test("does not place a weekly marker on other or stale limit periods", () => {
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    expect(
      weeklyWindowPosition({
        label: "Five Hour",
        resetsAt: new Date(resetMs).toISOString(),
        windowMinutes: 300,
      }, resetMs - 60_000),
    ).toBeNull();
    expect(
      weeklyWindowPosition({
        label: "Weekly",
        resetsAt: new Date(resetMs).toISOString(),
      }, resetMs + 1),
    ).toBeNull();
    expect(
      weeklyWindowPosition({ label: "Weekly", resetsAt: "not-a-date" }, resetMs),
    ).toBeNull();
  });

  test("handles missing, non-finite, and exact weekly period boundaries", () => {
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    const reset = new Date(resetMs).toISOString();
    const periodStartMs = resetMs - 7 * 24 * 60 * 60 * 1_000;
    const weeklyLimit = { label: "Weekly", resetsAt: reset };

    expect(weeklyWindowPosition({ label: "Weekly" }, resetMs)).toBeNull();
    expect(weeklyWindowPosition(weeklyLimit, Number.POSITIVE_INFINITY)).toBeNull();
    expect(weeklyWindowPosition(weeklyLimit, periodStartMs - 1)).toBeNull();
    expect(weeklyWindowPosition(weeklyLimit, periodStartMs)).toBe(0);
    expect(weeklyWindowPosition(weeklyLimit, resetMs)).toBe(100);
  });

  test("prompts for a first snapshot when usage is unavailable", () => {
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(
      screen.getByText(/Usage will appear after this session reports its first token snapshot/),
    ).toBeTruthy();
  });

  test("renders Claude rate limits before the first context snapshot", () => {
    useClaudeStore.setState({
      rateLimits: new Map([[
        CLAUDE_KEY,
        [
          { label: "5h window", usedPercent: 31 },
          { label: "Weekly", resetsAt: "2026-07-30T09:00:00.000Z" },
        ],
      ]]),
      selectedModel: new Map([[CLAUDE_KEY, "claude-sonnet"]]),
    } as never);

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Limits")).toBeTruthy();
    expect(screen.getByText("31% used")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("claude-sonnet")).toBeTruthy();
    expect(screen.getByText("Provider reported")).toBeTruthy();
    expect(screen.queryByText(/first token snapshot/)).toBeNull();
    expect(screen.queryByText("Context")).toBeNull();
  });

  test("renders context, token split, cache, reasoning, elapsed and denial rows", () => {
    useClaudeStore.setState({
      contextUsage: new Map([[
        CLAUDE_KEY,
        usage({
          inputTokens: 20_000,
          outputTokens: 5_000,
          cacheReadTokens: 12_000,
          reasoningTokens: 900,
          sessionTokens: 30_000,
          costUsd: 1.25,
          durationMs: 95_000,
          permissionDenials: 2,
        }),
      ]]),
      selectedModel: new Map([[CLAUDE_KEY, "claude-opus"]]),
    } as never);
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
    expect(metricValue("Reasoning")).toBe("900");
    expect(metricValue("Session")).toBe("30k");
    expect(metricValue("Cost")).toBe("$1.25");
    expect(metricValue("Elapsed")).toBe("1m 35s");
    expect(metricValue("Denied")).toBe("2");
    expect(screen.getByText("tool permissions")).toBeTruthy();
    expect(screen.getByText("Provider reported")).toBeTruthy();
    expect(screen.getByText("claude-opus")).toBeTruthy();
  });

  test.each([
    [-5, -10, "0 / 0", "0 available"],
    [120_000, 100_000, "120k / 100k", "0 available"],
  ])(
    "clamps token boundaries for %p used of %p total",
    (usedTokens, totalTokens, expectedTotal, expectedRemaining) => {
      useClaudeStore.setState({
        contextUsage: new Map([[
          CLAUDE_KEY,
          usage({ usedTokens, totalTokens }),
        ]]),
      } as never);
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
      useClaudeStore.setState({
        contextUsage: new Map([[CLAUDE_KEY, usage({ percentUsed })]]),
      } as never);
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(screen.getByText(expectedText)).toBeTruthy();
      expect(screen.getByRole("progressbar", { name: expectedLabel })).toBeTruthy();
    },
  );

  test("omits every optional metric the snapshot does not carry", () => {
    useClaudeStore.setState({ contextUsage: new Map([[CLAUDE_KEY, usage()]]) } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    for (const label of ["Input", "Output", "Cache read", "Reasoning", "Cost", "Elapsed", "Denied", "Credits"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  test("labels an estimated snapshot as estimated", () => {
    useClaudeStore.setState({
      contextUsage: new Map([[CLAUDE_KEY, usage({ estimated: true })]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByText("Estimated")).toBeTruthy();
    expect(screen.queryByText("Provider reported")).toBeNull();
  });

  test("prefers the model named by the snapshot over the store's selection", () => {
    useClaudeStore.setState({
      contextUsage: new Map([[CLAUDE_KEY, usage({ modelId: "snapshot-model" })]]),
      selectedModel: new Map([[CLAUDE_KEY, "store-model"]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByText("snapshot-model")).toBeTruthy();
    expect(screen.queryByText("store-model")).toBeNull();
  });

  test("shows 'Model unavailable' when neither source names one", () => {
    useClaudeStore.setState({ contextUsage: new Map([[CLAUDE_KEY, usage()]]) } as never);
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
    useClaudeStore.setState({
      contextUsage: new Map([[CLAUDE_KEY, usage({ costUsd })]]),
    } as never);
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
    useClaudeStore.setState({
      contextUsage: new Map([[CLAUDE_KEY, usage({ durationMs })]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(metricValue("Elapsed")).toBe(expected);
  });

  test.each([
    [{ unlimited: true, balance: "$5.00" }, "Unlimited"],
    [{ balance: "$12.34" }, "$12.34"],
    [{ hasCredits: true }, "Available"],
    [{ hasCredits: false }, "Unavailable"],
  ])("renders credits %p as %p", (credits, expected) => {
    useClaudeStore.setState({
      contextUsage: new Map([[CLAUDE_KEY, usage({ credits })]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(metricValue("Credits")).toBe(expected);
  });

  test("renders rate limits, including a window with no percentage and a reset time", () => {
    const resetValue = "2026-07-27T09:00:00.000Z";
    useClaudeStore.setState({
      contextUsage: new Map([[
        CLAUDE_KEY,
        usage({
          rateLimits: [
            { label: "5h window", usedPercent: 42.4 },
            { label: "Weekly", resetsAt: resetValue },
          ],
        }),
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Limits")).toBeTruthy();
    expect(screen.getByText("42% used")).toBeTruthy();
    // No percentage is not "0% used" — it means the window was not reported.
    expect(screen.getByText("Available")).toBeTruthy();
    expect(
      screen.getByText(
        `Resets ${formatResetDateTime(resetValue)}`,
      ),
    ).toBeTruthy();
  });

  test("renders a red current-week marker over a weekly usage bar", () => {
    const originalDateNow = Date.now;
    const resetMs = Date.parse("2026-08-06T12:00:00.000Z");
    Date.now = () => resetMs - 3.5 * 24 * 60 * 60 * 1_000;
    try {
      useClaudeStore.setState({
        contextUsage: new Map([[
          CLAUDE_KEY,
          usage({
            rateLimits: [{
              label: "Weekly",
              usedPercent: 42,
              resetsAt: new Date(resetMs).toISOString(),
            }],
          }),
        ]]),
      } as never);
      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      const marker = screen.getByRole("img", {
        name: "Current point in weekly period: 50%",
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
      useClaudeStore.setState({
        contextUsage: new Map([[
          CLAUDE_KEY,
          usage({
            rateLimits: [{
              label: "Weekly",
              usedPercent: 42,
              resetsAt: new Date(resetMs).toISOString(),
            }],
          }),
        ]]),
      } as never);
      const view = render(<AgentInfoButton activeTab={claudeTab()} />);
      open();
      expect(screen.getByRole("img", {
        name: "Current point in weekly period: 25%",
      })).toBeTruthy();

      nowMs = periodStartMs + 5.25 * 24 * 60 * 60 * 1_000;
      act(() => intervalCallback?.());
      expect(screen.getByRole("img", {
        name: "Current point in weekly period: 75%",
      })).toBeTruthy();

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
      useClaudeStore.setState({
        contextUsage: new Map([[
          CLAUDE_KEY,
          usage({ rateLimits: [{ label: "5h window", usedPercent: 20 }] }),
        ]]),
      } as never);
      const view = render(<AgentInfoButton activeTab={claudeTab()} />);
      open();
      expect(screen.queryByRole("img")).toBeNull();
      expect(setIntervalCalls).toBe(0);

      nowMs = resetMs - 3.5 * 24 * 60 * 60 * 1_000;
      act(() => {
        useClaudeStore.setState({
          contextUsage: new Map([[
            CLAUDE_KEY,
            usage({
              rateLimits: [{
                label: "Weekly",
                usedPercent: 40,
                resetsAt: new Date(resetMs).toISOString(),
              }],
            }),
          ]]),
        } as never);
      });
      expect(screen.getByRole("img", {
        name: "Current point in weekly period: 50%",
      })).toBeTruthy();
      expect(setIntervalCalls).toBe(1);

      act(() => {
        useClaudeStore.setState({
          contextUsage: new Map([[
            CLAUDE_KEY,
            usage({
              rateLimits: [{
                label: "Weekly",
                usedPercent: 41,
                resetsAt: new Date(resetMs).toISOString(),
              }],
            }),
          ]]),
        } as never);
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
      weekday: "long",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    } satisfies Intl.DateTimeFormatOptions;

    for (const locale of ["en-US", "en-GB", "ja-JP", "zh-CN", "ar-EG"]) {
      expect(formatResetDateTime(resetValue, locale)).toBe(
        new Intl.DateTimeFormat(locale, options).format(resetDate),
      );
    }

    const japaneseLegacyConcatenation = `${
      resetDate.toLocaleDateString("ja-JP", { weekday: "long" })
    }, ${resetDate.toLocaleString("ja-JP")}`;
    expect(formatResetDateTime(resetValue, "ja-JP")).not.toBe(japaneseLegacyConcatenation);
  });

  test("omits an invalid reset timestamp instead of rendering Invalid Date", () => {
    expect(formatResetDateTime("not-a-date")).toBeNull();
    useClaudeStore.setState({
      contextUsage: new Map([[
        CLAUDE_KEY,
        usage({ rateLimits: [{ label: "Weekly", resetsAt: "not-a-date" }] }),
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.queryByText(/Resets/)).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  test("omits the limits section entirely when there are none", () => {
    useClaudeStore.setState({
      contextUsage: new Map([[CLAUDE_KEY, usage({ rateLimits: [] })]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.queryByText("Limits")).toBeNull();
  });

  test("an authoritative empty Claude limit snapshot hides stale nested limits", () => {
    useClaudeStore.setState({
      contextUsage: new Map([[
        CLAUDE_KEY,
        usage({ rateLimits: [{ label: "Stale 5h", usedPercent: 90 }] }),
      ]]),
      rateLimits: new Map([[CLAUDE_KEY, []]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.queryByText("Limits")).toBeNull();
    expect(screen.queryByText("Stale 5h")).toBeNull();
    expect(screen.getByText("Context")).toBeTruthy();
  });
});

describe("AgentInfoButton Codex runtime panel", () => {
  function seedCodex(options: { isLoading?: boolean } = {}) {
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CODEX_CLIENT]]),
      sessions: new Map([[
        CODEX_KEY,
        {
          sessionId: "codex-session-1",
          messages: [],
          isLoading: options.isLoading ?? false,
          title: "Codex session",
        },
      ]]),
    } as never);
  }

  test("shows a loading line until the health request resolves", async () => {
    seedCodex();
    let release: (value: unknown) => void = () => {};
    mockGetCodexRuntimeHealth.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    expect(screen.getByText("Loading Codex runtime…")).toBeTruthy();
    await act(async () => {
      release({ engine: { state: "ready", codexVersion: "0.144.1" } });
    });
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(screen.getByText("Codex 0.144.1")).toBeTruthy();
  });

  test("counts MCP servers, skills and hooks from the shapes the bridge reports", async () => {
    seedCodex();
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      engine: {},
      mcp: [{ name: "a" }, { name: "b" }],
      skills: { data: [{ skills: [1, 2, 3] }] },
      // `error` is a diagnostic key, not an inventory entry.
      hooks: { alpha: {}, error: "unavailable" },
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(metricValue("MCP")).toBe("2"));
    expect(metricValue("Skills")).toBe("3");
    expect(metricValue("Hooks")).toBe("1");
    expect(screen.getByText("state unavailable")).toBeTruthy();
    expect(screen.getByText("version unavailable")).toBeTruthy();
  });

  test("renders at most the five most recent notices and ignores malformed ones", async () => {
    seedCodex();
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      engine: { state: "ready" },
      notices: [
        { method: "m1", message: "notice one" },
        { method: "m2", message: "notice two" },
        { method: "m3", message: "notice three" },
        { method: "m4", message: "notice four" },
        { method: "m5", message: "notice five" },
        { method: "m6", message: "notice six" },
        { method: "m7" },
      ],
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("notice six")).toBeTruthy());
    expect(screen.queryByText("notice one")).toBeNull();
    expect(screen.getByText("notice two")).toBeTruthy();
  });

  test("groups repeated notices and shows their total count", async () => {
    seedCodex();
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      engine: { state: "ready" },
      notices: [
        ...Array.from({ length: 8 }, () => ({
          method: "mcpServer/startupStatus/updated",
          message: "Codex reported mcpServer startupStatus updated",
        })),
        { method: "warning", message: "Codex reported warning" },
      ],
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(
        screen.getByText("Codex reported mcpServer startupStatus updated (8)"),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText("Codex reported mcpServer startupStatus updated"),
    ).toBeNull();
    expect(screen.getByText("Codex reported warning")).toBeTruthy();
  });

  test("uses the latest occurrence when limiting distinct notices", async () => {
    seedCodex();
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      engine: { state: "ready" },
      notices: [
        { method: "m1", message: "notice one" },
        { method: "m2", message: "notice two" },
        { method: "m3", message: "notice three" },
        { method: "m4", message: "notice four" },
        { method: "m5", message: "notice five" },
        { method: "m6", message: "notice six" },
        { method: "m1", message: "notice one" },
      ],
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(screen.getByText("notice one (2)")).toBeTruthy());
    expect(screen.queryByText("notice two")).toBeNull();
    expect(screen.getByText("notice three")).toBeTruthy();
    expect(screen.getByText("notice six")).toBeTruthy();
  });

  test("falls back to an error snapshot when the health request rejects", async () => {
    seedCodex();
    mockGetCodexRuntimeHealth.mockImplementation(async () => {
      throw new Error("bridge down");
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    // The panel must leave the loading state even on failure.
    await waitFor(
      () => expect(screen.queryByText("Loading Codex runtime…")).toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.getByText("state unavailable")).toBeTruthy();
  }, 20_000);

  test("does not request health while closed and drops a response that lands after close", async () => {
    seedCodex();
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
    } as never);
    let release: (value: unknown) => void = () => {};
    mockGetCodexRuntimeHealth.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<AgentInfoButton activeTab={codexTab()} />);
    expect(mockGetCodexRuntimeHealth).not.toHaveBeenCalled();

    open();
    expect(mockGetCodexRuntimeHealth).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Close agent information" })[0]!);

    // The `cancelled` teardown must swallow the resolution rather than write
    // limits for a panel nobody is looking at.
    await act(async () => {
      release({
        engine: { state: "ready" },
        rateLimits: { rateLimits: { primary: { usedPercent: 10 } } },
      });
    });
    expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toBeUndefined();
  });

  test("drops stale health after the same tab resumes another session", async () => {
    seedCodex();
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
    } as never);
    let releaseOld: (value: unknown) => void = () => {};
    mockGetCodexRuntimeHealth.mockImplementation((_client, sessionId) => {
      if (sessionId === "codex-session-1") {
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      return Promise.resolve({
        engine: { state: "replacement-ready" },
        rateLimits: { rateLimits: { primary: { usedPercent: 20 } } },
      });
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(mockGetCodexRuntimeHealth).toHaveBeenCalledWith(
        CODEX_CLIENT,
        "codex-session-1",
      )
    );
    act(() => {
      useCodexStore.setState({
        sessions: new Map([[
          CODEX_KEY,
          {
            sessionId: "codex-session-2",
            messages: [],
            isLoading: false,
            title: "Replacement session",
          },
        ]]),
      } as never);
    });

    expect(isPopoverOpen()).toBe(false);
    open();
    await waitFor(() => expect(screen.getByText("replacement-ready")).toBeTruthy());
    expect(mockGetCodexRuntimeHealth).toHaveBeenCalledWith(
      CODEX_CLIENT,
      "codex-session-2",
    );
    await act(async () => {
      releaseOld({
        engine: { state: "stale-session" },
        rateLimits: { rateLimits: { primary: { usedPercent: 90 } } },
      });
    });

    expect(screen.queryByText("stale-session")).toBeNull();
    expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toEqual([
      { label: "Primary", usedPercent: 20 },
    ]);
  });

  test("refreshes health when switching between tabs for the same Codex session", async () => {
    const nextTabId = "tab-2";
    const nextKey = createSessionKey(ENVIRONMENT_ID, nextTabId);
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CODEX_CLIENT]]),
      sessions: new Map([
        [CODEX_KEY, {
          sessionId: "shared-codex-session",
          messages: [],
          isLoading: false,
          title: "First tab",
        }],
        [nextKey, {
          sessionId: "shared-codex-session",
          messages: [],
          isLoading: false,
          title: "Second tab",
        }],
      ]),
      contextUsage: new Map([
        [CODEX_KEY, usage({ source: "codex" })],
        [nextKey, usage({ source: "codex" })],
      ]),
    } as never);
    let releaseOld: (value: unknown) => void = () => {};
    let requestCount = 0;
    mockGetCodexRuntimeHealth.mockImplementation(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      return Promise.resolve({
        engine: { state: "second-tab-ready" },
        rateLimits: { rateLimits: { primary: { usedPercent: 30 } } },
      });
    });
    const { rerender } = render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(mockGetCodexRuntimeHealth).toHaveBeenCalledTimes(1));
    rerender(<AgentInfoButton activeTab={codexTab({ id: nextTabId })} />);
    expect(isPopoverOpen()).toBe(false);
    open();
    await waitFor(() => expect(screen.getByText("second-tab-ready")).toBeTruthy());
    expect(mockGetCodexRuntimeHealth).toHaveBeenCalledTimes(2);
    await act(async () => {
      releaseOld({
        engine: { state: "stale-first-tab" },
        rateLimits: { rateLimits: { primary: { usedPercent: 90 } } },
      });
    });

    expect(screen.queryByText("stale-first-tab")).toBeNull();
    expect(useCodexStore.getState().contextUsage.get(nextKey)?.rateLimits).toEqual([
      { label: "Primary", usedPercent: 30 },
    ]);
    expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toBeUndefined();
  });

  test("folds Codex rate limits and credits into the stored usage snapshot", async () => {
    seedCodex();
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
    } as never);
    const resetsAtSeconds = 1_800_000_000;
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      engine: { state: "ready" },
      rateLimits: {
        rateLimits: {
          limitName: "Codex weekly",
          primary: {
            usedPercent: 12.5,
            resetsAt: resetsAtSeconds,
            windowDurationMins: 10_080,
          },
          secondary: { usedPercent: 80 },
          credits: { balance: "$20.00", hasCredits: true, unlimited: false },
        },
      },
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toBeTruthy(),
    );
    const stored = useCodexStore.getState().contextUsage.get(CODEX_KEY)!;
    /*
     * Codex reports epoch *seconds*. A units bug here silently corrupts the
     * snapshot this effect writes straight back into the store.
     */
    expect(stored.rateLimits).toEqual([
      {
        label: "Codex weekly",
        usedPercent: 12.5,
        resetsAt: new Date(resetsAtSeconds * 1_000).toISOString(),
        windowMinutes: 10_080,
      },
      { label: "Secondary", usedPercent: 80 },
    ]);
    expect(stored.credits).toEqual({
      balance: "$20.00",
      hasCredits: true,
      unlimited: false,
    });
    const resetValue = new Date(resetsAtSeconds * 1_000).toISOString();
    expect(
      screen.getByText(
        `Resets ${formatResetDateTime(resetValue)}`,
      ),
    ).toBeTruthy();
    // The rest of the snapshot survives the merge.
    expect(stored.usedTokens).toBe(25_000);
  });

  test("drops malformed rate-limit numbers without discarding valid fields", async () => {
    seedCodex();
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
    } as never);
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      engine: { state: "ready" },
      rateLimits: {
        rateLimits: {
          primary: {
            usedPercent: 125,
            resetsAt: Number.MAX_SAFE_INTEGER,
            windowDurationMins: Number.NaN,
          },
          secondary: {
            usedPercent: Number.POSITIVE_INFINITY,
            resetsAt: Number.NEGATIVE_INFINITY,
            windowDurationMins: -1,
          },
        },
      },
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toEqual([
        { label: "Primary", usedPercent: 100 },
      ])
    );
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.queryByText(/Runtime health unavailable/)).toBeNull();
  });

  test("skips a window the health payload does not report at all", async () => {
    seedCodex();
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
    } as never);
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      rateLimits: { rateLimits: { primary: {} , secondary: { usedPercent: 3 } } },
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toEqual([
        { label: "Secondary", usedPercent: 3 },
      ]),
    );
  });

  test("skips a non-empty window when every recognized field is absent or invalid", async () => {
    seedCodex();
    useCodexStore.setState({
      contextUsage: new Map([[CODEX_KEY, usage({ source: "codex" })]]),
    } as never);
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      rateLimits: {
        rateLimits: {
          primary: {
            usedPercent: "unknown",
            resetsAt: Number.POSITIVE_INFINITY,
            windowDurationMins: -1,
            unrecognizedButPresent: true,
          },
          secondary: { windowDurationMins: 60 },
        },
      },
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() =>
      expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)?.rateLimits).toEqual([
        { label: "Secondary", windowMinutes: 60 },
      ]),
    );
  });

  test("does not invent a usage snapshot when the session has none yet", async () => {
    seedCodex();
    mockGetCodexRuntimeHealth.mockImplementation(async () => ({
      rateLimits: { rateLimits: { primary: { usedPercent: 5 } } },
    }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    await waitFor(() => expect(mockGetCodexRuntimeHealth).toHaveBeenCalled());
    expect(useCodexStore.getState().contextUsage.get(CODEX_KEY)).toBeUndefined();
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

  function seedClaude(extra: Record<string, unknown> = {}) {
    useClaudeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CLAUDE_CLIENT]]),
      sessions: new Map([[
        CLAUDE_KEY,
        { sessionId: "claude-session-1", messages: [], isLoading: false },
      ]]),
      ...extra,
    } as never);
  }

  test("renders both checkboxes even when the init payload reported no agents", () => {
    /*
     * `sessionInitData.agents` defaults to `[]` at both merge sites, so nesting
     * these under a non-empty agent list hid the prompt-suggestion opt-in — the
     * switch that enables the feature — for most Claude sessions.
     */
    seedClaude({
      sessionInitData: new Map([[
        ENVIRONMENT_ID,
        { mcpServers: [], plugins: [], slashCommands: [], agents: [] },
      ]]),
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.queryByLabelText("Execution profile")).toBeNull();
    expect(screen.getByText("Include .claude/settings.local.json")).toBeTruthy();
    expect(screen.getByText("Suggest a follow-up after each turn")).toBeTruthy();
  });

  test("renders both checkboxes when no init payload arrived at all", () => {
    seedClaude();
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  test("checkbox state comes from the store and writes back per session", () => {
    seedClaude();
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const [localSettings, suggestions] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(localSettings!.checked).toBe(false);
    expect(suggestions!.checked).toBe(false);

    fireEvent.click(localSettings!);
    fireEvent.click(suggestions!);

    expect(useClaudeStore.getState().includeLocalSettings.get(CLAUDE_KEY)).toBe(true);
    expect(useClaudeStore.getState().promptSuggestionOptIn.get(CLAUDE_KEY)).toBe(true);
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  test("applies a provider-neutral execution profile and locks controls while pending", async () => {
    const initial = neutralClaudeProjection();
    const updated = neutralClaudeProjection({ selectedExecutionProfileId: "reviewer" });
    let releaseUpdate!: (projection: NativeAgentSessionProjection) => void;
    const pendingUpdate = new Promise<NativeAgentSessionProjection>((resolve) => {
      releaseUpdate = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "update_native_agent_controls" ? pendingUpdate : undefined);
    useNativeAgentProjectionStore.getState().setProjection(CLAUDE_KEY, initial);

    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    const select = screen.getByLabelText("Execution profile") as HTMLSelectElement;
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];

    fireEvent.change(select, { target: { value: "reviewer" } });

    expect(select.disabled).toBe(true);
    expect(checkboxes.every((checkbox) => checkbox.disabled)).toBe(true);
    expect(nativeInvokeMock).toHaveBeenCalledWith(
      "update_native_agent_controls",
      {
        environmentId: ENVIRONMENT_ID,
        agent: "claude",
        logicalSessionKey: CLAUDE_KEY,
        update: { executionProfileId: "reviewer" },
      },
    );

    releaseUpdate(updated);
    await waitFor(() => expect(
      useNativeAgentProjectionStore.getState().projections.get(CLAUDE_KEY),
    ).toBe(updated));
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
      command === "update_native_agent_controls" ? pendingUpdate : undefined);
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
    expect(useNativeAgentProjectionStore.getState().projections.get(CLAUDE_KEY))
      .toBe(newerProjection);
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
            ? {} : { includeLocalSettings: update.includeLocalSettings }),
          ...(update.promptSuggestions === undefined
            ? {} : { promptSuggestionsEnabled: update.promptSuggestions }),
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

    expect(nativeInvokeMock).toHaveBeenNthCalledWith(
      1,
      "update_native_agent_controls",
      expect.objectContaining({ update: { includeLocalSettings: true } }),
    );
    expect(nativeInvokeMock).toHaveBeenNthCalledWith(
      2,
      "update_native_agent_controls",
      expect.objectContaining({ update: { promptSuggestions: true } }),
    );
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
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CODEX_CLIENT]]),
      sessions: new Map([[
        CODEX_KEY,
        { sessionId: "codex-session-1", messages: [], isLoading: false },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  test("offers a Claude execution profile per reported agent and stores the choice", () => {
    seedClaude({
      sessionInitData: new Map([[
        ENVIRONMENT_ID,
        {
          mcpServers: [],
          plugins: [],
          slashCommands: [],
          agents: [
            { name: "reviewer", model: "claude-opus" },
            { name: "explorer" },
          ],
        },
      ]]),
    });
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const select = screen.getByLabelText("Execution profile") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Provider default",
      "reviewer · claude-opus",
      "explorer",
    ]);

    fireEvent.change(select, { target: { value: "reviewer" } });
    expect(useClaudeStore.getState().selectedAgent.get(CLAUDE_KEY)).toBe("reviewer");

    fireEvent.change(select, { target: { value: "" } });
    expect(useClaudeStore.getState().selectedAgent.get(CLAUDE_KEY)).toBeUndefined();
  });

  test("offers only primary/all OpenCode agents and stores the choice", () => {
    useOpenCodeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, openCodeClient]]),
      sessions: new Map([[
        OPENCODE_KEY,
        { sessionId: "opencode-session-1", messages: [], isLoading: false },
      ]]),
      runtimeHealth: new Map([[
        ENVIRONMENT_ID,
        {
          agents: [
            { name: "build", mode: "primary", modelId: "sonnet" },
            { name: "helper", mode: "subagent" },
            { name: "general", mode: "all" },
          ],
          skills: [],
          mcpServers: [],
          lspServers: [],
          formatters: [],
          fetchedAt: "2026-07-26T00:00:00.000Z",
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    const select = screen.getByLabelText("Execution profile") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Provider default",
      "build · sonnet",
      "general",
    ]);

    fireEvent.change(select, { target: { value: "general" } });
    expect(useOpenCodeStore.getState().selectedAgent.get(OPENCODE_KEY)).toBe("general");
  });
});

describe("AgentInfoButton session actions", () => {
  function seedClaudeSession(
    messages: Array<{ id: string; role: string; content: string }> = [],
  ) {
    useClaudeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CLAUDE_CLIENT]]),
      sessions: new Map([[
        CLAUDE_KEY,
        { sessionId: "claude-session-1", messages, isLoading: false },
      ]]),
    } as never);
  }

  function seedOpenCodeSession() {
    useOpenCodeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, openCodeClient]]),
      sessions: new Map([[
        OPENCODE_KEY,
        {
          sessionId: "opencode-session-1",
          messages: [{ id: "m1", role: "user", content: "hi", parts: [], createdAt: "" }],
          isLoading: false,
        },
      ]]),
    } as never);
  }

  function seedCodexSession(isLoading = false) {
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CODEX_CLIENT]]),
      sessions: new Map([[
        CODEX_KEY,
        { sessionId: "codex-session-1", messages: [], isLoading },
      ]]),
    } as never);
  }

  function startHandoff(tab: TabInfo, destination: "Claude" | "Codex" | "OpenCode") {
    render(<AgentInfoButton activeTab={tab} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: destination }));
  }

  function expectNoHandoffCreated() {
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    expect(nativeInvokeMock).not.toHaveBeenCalledWith(
      "save_agent_handoff",
      expect.anything(),
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
  }

  test("fork and compact are disabled until a session id exists", () => {
    render(<AgentInfoButton activeTab={claudeTab({
      nativeAgentData: { platform: "claude", environmentId: ENVIRONMENT_ID },
    })} />);
    open();
    expect(screen.getByRole("button", { name: /Fork session/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Compact/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Continue in/ }).hasAttribute("disabled")).toBe(true);
  });

  test("reveals only the two other providers and explains the copy boundary", () => {
    seedClaudeSession([{ id: "m1", role: "user", content: "continue this" }]);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    const continueButton = screen.getByRole("button", { name: /Continue in/ });
    expect(continueButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(continueButton);

    expect(continueButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "OpenCode" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
    expect(screen.getByText(/source session stays intact/)).toBeTruthy();
  });

  test("persists an authoritative Claude handoff and opens a Codex native tab", async () => {
    seedClaudeSession([{ id: "optimistic", role: "user", content: "stale renderer copy" }]);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    expect(mockGetClaudeSession).toHaveBeenCalledWith(
      CLAUDE_CLIENT,
      "claude-session-1",
    );
    expect(mockGetClaudeSessionMessages).toHaveBeenCalledWith(
      CLAUDE_CLIENT,
      "claude-session-1",
      { throwOnError: true },
    );
    expect(mockGetClaudeSession).toHaveBeenCalledTimes(2);
    const handoffTab = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((tab) => tab.id !== TAB_ID)!;
    expect(handoffTab.type).toBe("agent-native");
    expect(handoffTab.agentHandoffId).toBeTruthy();
    expect(handoffTab.nativeAgentData).toMatchObject({
      environmentId: ENVIRONMENT_ID,
    });
    expect(handoffTab.initialPrompt).toBeUndefined();
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Continuing in Codex with 1 message and 0 tool calls",
    );
  });

  test("deletes a persisted handoff if its source session changes before the destination opens", async () => {
    seedClaudeSession([{ id: "m1", role: "user", content: "continue this" }]);
    let releaseSave!: () => void;
    let reportSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    nativeInvokeMock.mockImplementation(async (command: string) => {
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
    seedOpenCodeSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    expect(mockGetOpenCodeSessionStatus).toHaveBeenCalledTimes(3);
    expect(mockGetOpenCodeSessionStatus).toHaveBeenNthCalledWith(
      1,
      openCodeClient,
      "opencode-session-1",
      { throwOnError: true },
    );
    expect(mockGetOpenCodeSessionMessages).toHaveBeenCalledWith(
      openCodeClient,
      "opencode-session-1",
      { throwOnError: true },
    );
    expect(mockGetOpenCodeSessionMessages).toHaveBeenCalledTimes(2);
    const handoffTab = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((tab) => tab.id !== TAB_ID)!;
    expect(handoffTab.type).toBe("agent-native");
    expect(handoffTab.nativeAgentData?.environmentId).toBe(ENVIRONMENT_ID);
  });

  test("reads and revalidates an authoritative Codex handoff before opening OpenCode", async () => {
    seedCodexSession();
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    expect(mockGetCodexSessionStatus).toHaveBeenCalledTimes(2);
    expect(mockGetCodexSessionMessages).toHaveBeenCalledWith(
      CODEX_CLIENT,
      "codex-session-1",
      { throwOnError: true },
    );
    const handoffTab = usePaneLayoutStore
      .getState()
      .getAllTabs(ENVIRONMENT_ID)
      .find((tab) => tab.id !== TAB_ID)!;
    expect(handoffTab.type).toBe("agent-native");
    expect(handoffTab.nativeAgentData?.environmentId).toBe(ENVIRONMENT_ID);
  });

  test.each([
    ["Claude", "Codex", () => {
      seedClaudeSession();
      mockGetClaudeSession
        .mockResolvedValueOnce({
          id: "claude-session-1",
          status: "idle",
          createdAt: "2026-07-27T10:00:00.000Z",
          lastActivity: "2026-07-27T10:01:00.000Z",
        })
        .mockResolvedValueOnce({
          id: "claude-session-1",
          status: "running",
          createdAt: "2026-07-27T10:00:00.000Z",
          lastActivity: "2026-07-27T10:02:00.000Z",
        });
      return claudeTab();
    }],
    ["OpenCode", "Claude", () => {
      seedOpenCodeSession();
      mockGetOpenCodeSessionStatus
        .mockResolvedValueOnce("idle")
        .mockResolvedValueOnce("busy");
      return openCodeTab();
    }],
    ["Codex", "OpenCode", () => {
      seedCodexSession();
      mockGetCodexSessionStatus
        .mockResolvedValueOnce({ status: "idle" })
        .mockResolvedValueOnce({ status: "running" });
      return codexTab();
    }],
  ] as const)(
    "rejects a %s transfer when the provider starts working during the message read",
    async (provider, destination, setup) => {
      const tab = setup();
      render(<AgentInfoButton activeTab={tab} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
      fireEvent.click(screen.getByRole("button", { name: destination }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          `${provider} started working while its conversation was being transferred`,
        ),
      );
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    },
  );

  test.each([
    ["Claude", "Codex", () => {
      seedClaudeSession();
      mockGetClaudeSession.mockResolvedValueOnce(null);
      return claudeTab();
    }],
    ["OpenCode", "Claude", () => {
      seedOpenCodeSession();
      mockGetOpenCodeSessionStatus.mockResolvedValueOnce(null);
      return openCodeTab();
    }],
    ["Codex", "OpenCode", () => {
      seedCodexSession();
      mockGetCodexSessionStatus.mockResolvedValueOnce(null);
      return codexTab();
    }],
  ] as const)(
    "rejects a %s transfer when its authoritative session is unavailable",
    async (provider, destination, setup) => {
      startHandoff(setup(), destination);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(`${provider} session is unavailable`),
      );
      expect(mockGetClaudeSessionMessages).not.toHaveBeenCalled();
      expect(mockGetOpenCodeSessionMessages).not.toHaveBeenCalled();
      expect(mockGetCodexSessionMessages).not.toHaveBeenCalled();
      expectNoHandoffCreated();
    },
  );

  test.each([
    ["Claude running", "Claude", "Codex", () => {
      seedClaudeSession();
      mockGetClaudeSession.mockResolvedValueOnce({
        id: "claude-session-1",
        status: "running",
        createdAt: "2026-07-27T10:00:00.000Z",
        lastActivity: "2026-07-27T10:01:00.000Z",
      });
      return claudeTab();
    }],
    ["OpenCode busy", "OpenCode", "Claude", () => {
      seedOpenCodeSession();
      mockGetOpenCodeSessionStatus.mockResolvedValueOnce("busy");
      return openCodeTab();
    }],
    ["OpenCode retry", "OpenCode", "Claude", () => {
      seedOpenCodeSession();
      mockGetOpenCodeSessionStatus.mockResolvedValueOnce("retry");
      return openCodeTab();
    }],
    ["Codex running", "Codex", "OpenCode", () => {
      seedCodexSession();
      mockGetCodexSessionStatus.mockResolvedValueOnce({ status: "running" });
      return codexTab();
    }],
  ] as const)(
    "rejects an initially non-idle %s transfer",
    async (_caseName, provider, destination, setup) => {
      startHandoff(setup(), destination);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          `Wait for ${provider} to finish before continuing in another agent`,
        ),
      );
      expect(mockGetClaudeSessionMessages).not.toHaveBeenCalled();
      expect(mockGetOpenCodeSessionMessages).not.toHaveBeenCalled();
      expect(mockGetCodexSessionMessages).not.toHaveBeenCalled();
      expectNoHandoffCreated();
    },
  );

  test.each([
    ["Claude", "Codex", () => {
      seedClaudeSession();
      mockGetClaudeSession
        .mockResolvedValueOnce({
          id: "claude-session-1",
          status: "idle",
          createdAt: "2026-07-27T10:00:00.000Z",
          lastActivity: "2026-07-27T10:01:00.000Z",
        })
        .mockResolvedValueOnce(null);
      return claudeTab();
    }],
    ["OpenCode", "Claude", () => {
      seedOpenCodeSession();
      mockGetOpenCodeSessionStatus
        .mockResolvedValueOnce("idle")
        .mockResolvedValueOnce(null);
      return openCodeTab();
    }],
    ["Codex", "OpenCode", () => {
      seedCodexSession();
      mockGetCodexSessionStatus
        .mockResolvedValueOnce({ status: "idle" })
        .mockResolvedValueOnce(null);
      return codexTab();
    }],
  ] as const)(
    "rejects a %s transfer when the session disappears after its message read",
    async (provider, destination, setup) => {
      startHandoff(setup(), destination);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(`${provider} session is unavailable`),
      );
      expectNoHandoffCreated();
    },
  );

  test("treats OpenCode retry after the first message read as active work", async () => {
    seedOpenCodeSession();
    mockGetOpenCodeSessionStatus
      .mockResolvedValueOnce("idle")
      .mockResolvedValueOnce("retry");
    startHandoff(openCodeTab(), "Claude");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "OpenCode started working while its conversation was being transferred",
      ),
    );
    expect(mockGetOpenCodeSessionMessages).toHaveBeenCalledTimes(1);
    expectNoHandoffCreated();
  });

  test.each([
    [null, "OpenCode session is unavailable"],
    ["busy", "OpenCode started working while its conversation was being transferred"],
    ["retry", "OpenCode started working while its conversation was being transferred"],
  ] as const)(
    "rejects an OpenCode transfer when its final status is %p",
    async (finalStatus, expectedError) => {
      seedOpenCodeSession();
      mockGetOpenCodeSessionStatus
        .mockResolvedValueOnce("idle")
        .mockResolvedValueOnce("idle")
        .mockResolvedValueOnce(finalStatus);
      startHandoff(openCodeTab(), "Claude");

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(expectedError),
      );
      expect(mockGetOpenCodeSessionMessages).toHaveBeenCalledTimes(2);
      expect(mockGetOpenCodeSessionStatus).toHaveBeenCalledTimes(3);
      expectNoHandoffCreated();
    },
  );

  test.each([
    ["Claude", "Codex", () => {
      seedClaudeSession();
      mockGetClaudeSession
        .mockResolvedValueOnce({
          id: "claude-session-1",
          status: "idle",
          createdAt: "2026-07-27T10:00:00.000Z",
          lastActivity: "2026-07-27T10:01:00.000Z",
        })
        .mockResolvedValueOnce({
          id: "claude-session-1",
          status: "idle",
          createdAt: "2026-07-27T10:00:00.000Z",
          lastActivity: "2026-07-27T10:02:00.000Z",
        });
      return claudeTab();
    }],
    ["Codex", "OpenCode", () => {
      seedCodexSession();
      mockGetCodexSessionStatus
        .mockResolvedValueOnce({ status: "idle", messageRevision: 1 })
        .mockResolvedValueOnce({ status: "idle", messageRevision: 2 });
      return codexTab();
    }],
  ] as const)(
    "rejects a fast %s turn that finishes during the message read",
    async (provider, destination, setup) => {
      render(<AgentInfoButton activeTab={setup()} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
      fireEvent.click(screen.getByRole("button", { name: destination }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          `${provider} conversation changed while it was being transferred`,
        ),
      );
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    },
  );

  test("rejects a fast OpenCode turn when two idle reads return different messages", async () => {
    seedOpenCodeSession();
    mockGetOpenCodeSessionMessages
      .mockResolvedValueOnce([{
        id: "m1",
        role: "user",
        content: "before",
        parts: [{ type: "text", content: "before" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      }])
      .mockResolvedValueOnce([{
        id: "m1",
        role: "user",
        content: "after",
        parts: [{ type: "text", content: "after" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      }]);
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "OpenCode conversation changed while it was being transferred",
      ),
    );
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
  });

  test("rejects a Codex transfer that changed while no revision was reported", async () => {
    /*
     * `messageRevision` is optional: an older bridge or a malformed status
     * payload drops it. Requiring both sides to be defined before comparing
     * fails open — the snapshot is taken on trust and a torn transcript is
     * transferred silently. Re-read and compare instead.
     */
    seedCodexSession();
    mockGetCodexSessionStatus.mockResolvedValue({ status: "idle" });
    mockGetCodexSessionMessages
      .mockResolvedValueOnce([{
        id: "m1",
        role: "user",
        content: "before",
        parts: [{ type: "text", content: "before" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      }])
      .mockResolvedValueOnce([{
        id: "m1",
        role: "user",
        content: "after the turn",
        parts: [{ type: "text", content: "after the turn" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      }]);

    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Codex conversation changed while it was being transferred",
      ),
    );
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    expect(mockGetCodexSessionMessages).toHaveBeenCalledTimes(2);
  });

  test("transfers a Codex conversation with no revision when both reads agree", async () => {
    seedCodexSession();
    mockGetCodexSessionStatus.mockResolvedValue({ status: "idle" });

    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    // The fallback re-reads rather than trusting the missing revision, so an
    // older bridge stays usable instead of being permanently rejected.
    expect(mockGetCodexSessionMessages).toHaveBeenCalledTimes(2);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("skips the second read when Codex reports a matching revision", async () => {
    seedCodexSession();
    mockGetCodexSessionStatus.mockResolvedValue({ status: "idle", messageRevision: 4 });

    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Continue in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() =>
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
    );
    expect(mockGetCodexSessionMessages).toHaveBeenCalledTimes(1);
  });

  test("does not open a destination tab when the source tab carries no native data", async () => {
    seedCodexSession();

    render(<AgentInfoButton activeTab={{ id: TAB_ID, type: "agent-native" } as TabInfo} />);
    open();

    // Without native data there is no container or locality to copy onto the
    // destination tab, so the panel offers no session controls at all.
    expect(screen.queryByRole("button", { name: /Continue in/ })).toBeNull();
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
  });

  test("preserves the prior imported transcript when a transferred tab is handed off again", async () => {
    const prior = createAgentHandoffSnapshot({
      id: "prior-handoff",
      environmentId: ENVIRONMENT_ID,
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "claude-session-1",
      messages: [{
        id: "prior-message",
        role: "user",
        content: "original request",
        parts: [{ type: "text", content: "original request" }],
        createdAt: "2026-07-27T09:00:00.000Z",
      }],
    });
    rememberAgentHandoff(prior);
    seedCodexSession();
    mockGetCodexSessionMessages.mockImplementation(async () => [
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
    ]);

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
    expect(saved?.messages.map((message) => message.id)).toEqual([
      "prior-message",
      "codex-answer",
    ]);
  });

  test("rejects a handoff when its referenced prior transfer cannot be loaded", async () => {
    seedCodexSession();
    startHandoff(codexTab({ agentHandoffId: "missing-handoff" }), "OpenCode");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "The previous conversation transfer could not be loaded",
      ),
    );
    expect(nativeInvokeMock).toHaveBeenCalledWith(
      "get_agent_handoff",
      { handoffId: "missing-handoff" },
    );
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
        messages: [{
          id: "prior-message",
          role: "user",
          content: "original request",
          parts: [{ type: "text", content: "original request" }],
          createdAt: "2026-07-27T09:00:00.000Z",
        }],
      });
      rememberAgentHandoff(prior);
      seedCodexSession();
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
    seedClaudeSession();
    mockGetClaudeSessionMessages.mockResolvedValueOnce([]);
    startHandoff(claudeTab(), "Codex");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "This conversation has no history to transfer",
      ),
    );
    expectNoHandoffCreated();
  });

  test("does not allow a handoff while the source turn is running", () => {
    useClaudeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CLAUDE_CLIENT]]),
      sessions: new Map([[
        CLAUDE_KEY,
        {
          sessionId: "claude-session-1",
          messages: [{ id: "m1", role: "user", content: "working" }],
          isLoading: true,
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.getByRole("button", { name: /Continue in/ }).hasAttribute("disabled"))
      .toBe(true);
  });

  test.each([["claude"], ["opencode"], ["codex"]])(
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

      let tab: TabInfo;
      let expectedSessionId: string;
      if (provider === "claude") {
        seedClaudeSession();
        tab = claudeTab(bootstrap);
        expectedSessionId = "claude-fork";
      } else if (provider === "opencode") {
        seedOpenCodeSession();
        tab = openCodeTab(bootstrap);
        expectedSessionId = "opencode-fork";
      } else {
        seedCodexSession();
        tab = codexTab(bootstrap);
        expectedSessionId = "codex-fork";
      }

      render(<AgentInfoButton activeTab={tab} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

      await waitFor(() =>
        expect(
          usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID).length,
        ).toBe(2),
      );
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
      expect(nativeData?.sessionId).toBe(expectedSessionId);
      expect(nativeData?.environmentId).toBe(ENVIRONMENT_ID);
      // A successful action closes the panel.
      expect(isPopoverOpen()).toBe(false);
    },
  );

  test("names the fork tab after the provider when the fork has no title", async () => {
    seedClaudeSession();
    mockForkClaudeSession.mockImplementation(async () => ({ sessionId: "claude-fork" }));
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

  test.each([
    [409, "Codex session cannot be forked while it is running"],
    [422, "That message is not a usable fork point"],
    [404, "Codex session or fork point was not found"],
    [0, "network request failed"],
  ])(
    "surfaces the bridge's own %s fork refusal and opens no tab",
    async (status, message) => {
      /*
       * These four mean different things — wait for the turn, pick another
       * message, the session is gone, the bridge is unreachable — and the old
       * single line blamed "an active or empty session" for all of them.
       */
      seedCodexSession();
      mockForkCodexSession.mockImplementation(async () => {
        throw new realCodexClientSnapshot.CodexForkError(status, message);
      });
      render(<AgentInfoButton activeTab={codexTab()} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(message));
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
      // A failed action leaves the panel open so the user can retry.
      expect(isPopoverOpen()).toBe(true);
    },
  );

  test("reports an unexpected Codex fork error with generic copy", async () => {
    // Not a bridge answer: presenting a programming error as Codex's own reason
    // would send the user looking for a session problem that does not exist.
    seedCodexSession();
    mockForkCodexSession.mockImplementation(async () => {
      throw new TypeError("client.fetch is not a function");
    });
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Fork session/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to fork Codex session"),
    );
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
  });

  test("disables every action while one is running and re-enables afterwards", async () => {
    seedClaudeSession();
    let release: (value: { sessionId: string }) => void = () => {};
    mockForkClaudeSession.mockImplementation(
      () => new Promise((resolve) => {
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

  test.each([["claude"], ["opencode"], ["codex"]])(
    "compacts a %s session",
    async (provider) => {
      let tab: TabInfo;
      if (provider === "claude") {
        seedClaudeSession();
        tab = claudeTab();
      } else if (provider === "opencode") {
        seedOpenCodeSession();
        tab = openCodeTab();
      } else {
        seedCodexSession();
        tab = codexTab();
      }
      render(<AgentInfoButton activeTab={tab} />);
      open();
      fireEvent.click(screen.getByRole("button", { name: /Compact/ }));

      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith("Context compaction started"),
      );
    },
  );

  test("reports a provider that refuses to compact", async () => {
    seedClaudeSession();
    mockCompactClaudeSession.mockImplementation(async () => false);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Compact/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("The provider could not compact this session"),
    );
  });

  test("starts a Codex review, and blocks the button during an active turn", async () => {
    seedCodexSession(true);
    const { rerender } = render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    expect(screen.getByRole("button", { name: /Review changes/ }).hasAttribute("disabled"))
      .toBe(true);

    act(() => {
      seedCodexSession(false);
    });
    rerender(<AgentInfoButton activeTab={codexTab()} />);
    fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Reviewing uncommitted changes"),
    );
    expect(mockStartCodexNativeReview).toHaveBeenCalledWith(CODEX_CLIENT, "codex-session-1");
  });

  test("reports a Codex review that could not start", async () => {
    seedCodexSession(false);
    mockStartCodexNativeReview.mockImplementation(async () => false);
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
      expect(mockRevertOpenCodeSession).toHaveBeenCalledWith(
        openCodeClient,
        "opencode-session-1",
        "m1",
      ),
    );

    reopen();
    fireEvent.click(screen.getByRole("button", { name: /Redo turn/ }));
    await waitFor(() =>
      expect(mockUnrevertOpenCodeSession).toHaveBeenCalledWith(
        openCodeClient,
        "opencode-session-1",
      ),
    );
  });

  test("passes no message id when undoing without a user message", async () => {
    seedOpenCodeSession();
    useOpenCodeStore.setState({
      sessions: new Map([[
        OPENCODE_KEY,
        {
          sessionId: "opencode-session-1",
          messages: [{
            id: "a1",
            role: "assistant",
            content: "hello",
            parts: [],
            createdAt: "",
          }],
          isLoading: false,
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));
    await waitFor(() =>
      expect(mockRevertOpenCodeSession).toHaveBeenCalledWith(
        openCodeClient,
        "opencode-session-1",
        undefined,
      )
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("OpenCode session reverted");
  });

  test("reports an OpenCode undo rejection and re-enables actions", async () => {
    seedOpenCodeSession();
    mockRevertOpenCodeSession.mockImplementation(async () => {
      throw new Error("OpenCode undo endpoint unavailable");
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("OpenCode undo endpoint unavailable"),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("OpenCode session reverted");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Undo turn/ }).hasAttribute("disabled"))
        .toBe(false),
    );
  });

  test("reports an OpenCode redo rejection and re-enables actions", async () => {
    seedOpenCodeSession();
    mockUnrevertOpenCodeSession.mockImplementation(async () => {
      throw new Error("OpenCode redo endpoint unavailable");
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    fireEvent.click(screen.getByRole("button", { name: /Redo turn/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("OpenCode redo endpoint unavailable"),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("OpenCode revert undone");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Redo turn/ }).hasAttribute("disabled"))
        .toBe(false),
    );
  });

  test("normalizes a non-Error OpenCode action rejection", async () => {
    seedOpenCodeSession();
    mockRevertOpenCodeSession.mockImplementation(async () => {
      throw "transport closed";
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("undo failed"));
    expect(mockToastSuccess).not.toHaveBeenCalledWith("OpenCode session reverted");
  });

  test("stops a running background task and reports a refusal", async () => {
    seedClaudeSession();
    useClaudeStore.setState({
      backgroundTasks: new Map([[
        CLAUDE_KEY,
        {
          "task-1": { id: "task-1", description: "Run the suite", status: "running" },
          "task-2": { id: "task-2", description: "Finished", status: "completed" },
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(screen.getByText("Run the suite")).toBeTruthy();
    // Completed tasks are not offered a stop control.
    expect(screen.queryByText("Finished")).toBeNull();

    mockStopClaudeBackgroundTask.mockImplementation(async () => false);
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Claude could not stop this task"),
    );
    expect(mockStopClaudeBackgroundTask).toHaveBeenCalledWith(
      CLAUDE_CLIENT,
      "claude-session-1",
      "task-1",
    );
  });

  test("hides the background-task section when nothing is running", () => {
    seedClaudeSession();
    useClaudeStore.setState({
      backgroundTasks: new Map([[
        CLAUDE_KEY,
        { "task-2": { id: "task-2", status: "completed" } },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    expect(screen.queryByText("Background tasks")).toBeNull();
  });

  test.each(["pending", "paused"] as const)(
    "keeps %s background tasks visible and stoppable",
    async (status) => {
      seedClaudeSession();
      const taskId = `task-${status}`;
      const description = `${status[0]!.toUpperCase()}${status.slice(1)} review`;
      useClaudeStore.setState({
        backgroundTasks: new Map([[
          CLAUDE_KEY,
          {
            [taskId]: {
              id: taskId,
              description,
              status,
            },
          },
        ]]),
      } as never);

      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(screen.getByText(description)).toBeTruthy();

      mockStopClaudeBackgroundTask.mockImplementation(async () => true);
      fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
      await waitFor(() =>
        expect(mockStopClaudeBackgroundTask).toHaveBeenCalledWith(
          CLAUDE_CLIENT,
          "claude-session-1",
          taskId,
        ),
      );
    },
  );

  test.each(["completed", "failed", "killed"] as const)(
    "hides the background-task section when every task is %s",
    (status) => {
      seedClaudeSession();
      useClaudeStore.setState({
        backgroundTasks: new Map([[
          CLAUDE_KEY,
          { "task-2": { id: "task-2", description: "Settled", status } },
        ]]),
      } as never);

      render(<AgentInfoButton activeTab={claudeTab()} />);
      open();

      expect(screen.queryByText("Background tasks")).toBeNull();
      expect(screen.queryByText("Settled")).toBeNull();
    },
  );
});

describe("AgentInfoButton rewind confirmation", () => {
  function seedClaudeWithMessages() {
    useClaudeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CLAUDE_CLIENT]]),
      sessions: new Map([[
        CLAUDE_KEY,
        {
          sessionId: "claude-session-1",
          isLoading: false,
          messages: [
            { id: "u1", role: "user", content: "first request" },
            { id: "a1", role: "assistant", content: "done" },
            {
              id: "u2",
              role: "user",
              content: "  Please   rewrite the authentication middleware  ",
            },
          ],
        },
      ]]),
    } as never);
  }

  test("names the target message and lists the files instead of dumping JSON", async () => {
    seedClaudeWithMessages();
    mockRewindClaudeFiles.mockImplementation(async () => ({
      files: [
        "src/auth/middleware.ts",
        { path: "src/auth/session.ts" },
        { file: "src/auth/index.ts" },
      ],
    }));
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

    await waitFor(() => expect(mockRewindClaudeFiles).toHaveBeenCalledTimes(2));
    expect(mockRewindClaudeFiles.mock.calls[0]).toEqual([
      CLAUDE_CLIENT,
      "claude-session-1",
      "u2",
      true,
    ]);
    expect(mockRewindClaudeFiles.mock.calls[1]).toEqual([
      CLAUDE_CLIENT,
      "claude-session-1",
      "u2",
    ]);
    expect(mockToastSuccess).toHaveBeenCalledWith("Claude restored 3 files");
  });

  test("cancelling the confirm issues no second call", async () => {
    seedClaudeWithMessages();
    confirmResult = false;
    mockRewindClaudeFiles.mockImplementation(async () => ({ files: ["a.ts"] }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(confirmMessages[0]).toContain("1 file will be restored:");
    // Exactly one call — the dry run. The destructive call must not happen.
    await waitFor(() => expect(mockRewindClaudeFiles).toHaveBeenCalledTimes(1));
    expect(mockRewindClaudeFiles.mock.calls[0]?.[3]).toBe(true);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("says so when the dry run reports no files", async () => {
    seedClaudeWithMessages();
    mockRewindClaudeFiles.mockImplementation(async () => ({ unexpected: "shape" }));
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() => expect(confirmMessages).toHaveLength(1));
    expect(confirmMessages[0]).toContain("Claude reported no file changes for this checkpoint.");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Claude files rewound"));
  });

  test("refuses when the transcript holds no user message", async () => {
    useClaudeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CLAUDE_CLIENT]]),
      sessions: new Map([[
        CLAUDE_KEY,
        {
          sessionId: "claude-session-1",
          isLoading: false,
          messages: [{ id: "a1", role: "assistant", content: "hello" }],
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Rewind files/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("No file checkpoint is available"),
    );
    expect(mockRewindClaudeFiles).not.toHaveBeenCalled();
  });

  test("lists at most ten files and counts the rest", async () => {
    seedClaudeWithMessages();
    mockRewindClaudeFiles.mockImplementation(async () => ({
      files: Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`),
    }));
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
    expect(summarizeRewindPreview({
      files: [],
      changedFiles: ["later.ts"],
      fileCount: 7,
    })).toEqual({
      files: ["later.ts"],
      fileCount: 1,
    });
    expect(summarizeRewindPreview({
      files: ["listed.ts"],
      fileCount: 7,
    })).toEqual({
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

describe("AgentInfoButton OpenCode sharing", () => {
  function seedShareableSession(sessionId = "opencode-session-1") {
    useOpenCodeStore.setState({
      clients: new Map([[ENVIRONMENT_ID, openCodeClient]]),
      sessions: new Map([[
        OPENCODE_KEY,
        { sessionId, messages: [], isLoading: false },
      ]]),
    } as never);
  }

  test("rehydrates sharing from the provider-neutral projection without a legacy client", () => {
    useNativeAgentProjectionStore.getState().setProjection(OPENCODE_KEY, {
      platform: "opencode",
      environmentId: ENVIRONMENT_ID,
      sessionId: "opencode-session-1",
      shareUrl: "https://share.opencode.test/projected",
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
        actions: { share: true },
      },
      revision: 1,
      generation: "test",
    });

    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
    expect(openCodeSessionGet).not.toHaveBeenCalled();
  });

  test("copies the link and offers revocation", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Share link copied"));
    expect(confirmMessages[0]).toContain("leave this machine");
    expect(clipboardWrites).toEqual(["https://share.opencode.test/abc"]);
    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("a clipboard rejection still leaves the session revocable and surfaces the URL", async () => {
    /*
     * The conversation is public the moment `share()` resolves. The flag used
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
    mockShareOpenCodeSession.mockImplementation(async () => undefined);
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
    expect(mockShareOpenCodeSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });

  test("a share failure reports and offers no revocation", async () => {
    seedShareableSession();
    mockShareOpenCodeSession.mockImplementation(async () => {
      throw new Error("OpenCode share endpoint unavailable");
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("OpenCode share endpoint unavailable"),
    );
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });

  test("rehydrates the shared state from the server when the panel opens", async () => {
    /*
     * Component state is lost on every tab switch and app restart, but the link
     * stays live — the server's session record is the authoritative snapshot.
     */
    openCodeSessionGet = mock(async (_parameters: { sessionID: string }): Promise<unknown> => ({
      data: { id: "opencode-session-1", share: { url: "https://share.opencode.test/live" } },
    }));
    openCodeClient = { session: { get: openCodeSessionGet } };
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    await waitFor(() => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy());
    expect(openCodeSessionGet).toHaveBeenCalledWith({ sessionID: "opencode-session-1" });
  });

  test("a failed share lookup does not hide an already-known share", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy());

    openCodeSessionGet.mockImplementation(async () => {
      throw new Error("server unreachable");
    });
    reopen();
    await waitFor(() => expect(openCodeSessionGet).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy();
  });

  test("an authoritative unshared snapshot clears a formerly shared session", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(
      () => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy(),
      { timeout: 10_000 },
    );

    // A share can be revoked from another client. A successful provider read
    // with no URL is authoritative and must remove the stale local action.
    openCodeSessionGet.mockImplementation(async () => ({
      data: { id: "opencode-session-1" },
    }));
    reopen();

    await waitFor(
      () => expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull(),
      { timeout: 10_000 },
    );
  }, 20_000);

  test("a client without a session.get surface reports not shared rather than throwing", async () => {
    openCodeClient = {};
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await waitFor(() => expect(screen.getByText("Session actions")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });

  test("stop sharing revokes and hides the control", async () => {
    seedShareableSession();
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Stop sharing/ }));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("OpenCode share link disabled"),
    );
    expect(mockUnshareOpenCodeSession).toHaveBeenCalledWith(
      openCodeClient,
      "opencode-session-1",
    );
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });

  test("a failed unshare remains visible and can be retried", async () => {
    openCodeSessionGet = mock(
      async (_parameters: { sessionID: string }): Promise<unknown> => ({
        data: {
          id: "opencode-session-1",
          share: { url: "https://share.opencode.test/live" },
        },
      }),
    );
    openCodeClient = { session: { get: openCodeSessionGet } };
    seedShareableSession();
    mockUnshareOpenCodeSession.mockImplementation(async () => {
      throw new Error("OpenCode unshare endpoint unavailable");
    });
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Stop sharing/ }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("OpenCode unshare endpoint unavailable"),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("OpenCode share link disabled");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Stop sharing/ }).hasAttribute("disabled"))
        .toBe(false),
    );

    mockUnshareOpenCodeSession.mockImplementation(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: /Stop sharing/ }));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("OpenCode share link disabled"),
    );
    expect(mockUnshareOpenCodeSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });

  test("switching tabs clears the optimistic shared flag", async () => {
    seedShareableSession();
    const { rerender } = render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stop sharing/ })).toBeTruthy());

    rerender(<AgentInfoButton activeTab={openCodeTab({ id: "tab-9" })} />);
    reopen();
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });

  test("a delayed share cannot mark a resumed session as shared", async () => {
    seedShareableSession("opencode-session-a");
    let releaseShare: (url: string) => void = () => {};
    mockShareOpenCodeSession.mockImplementation(
      () => new Promise((resolve) => {
        releaseShare = resolve;
      }),
    );
    const { rerender } = render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Share…/ }));
    await waitFor(() =>
      expect(mockShareOpenCodeSession).toHaveBeenCalledWith(
        openCodeClient,
        "opencode-session-a",
      ),
    );

    act(() => {
      seedShareableSession("opencode-session-b");
    });
    rerender(<AgentInfoButton activeTab={openCodeTab()} />);
    reopen();

    await act(async () => {
      releaseShare("https://share.opencode.test/session-a");
    });
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
    expect(clipboardWrites).toEqual([]);
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Share link copied");
  });

  test("an old action finishing cannot clear the new session's busy latch", async () => {
    seedShareableSession("opencode-session-a");
    let releaseShare: (url: string) => void = () => {};
    let releaseCompact: (value?: undefined) => void = () => {};
    mockShareOpenCodeSession.mockImplementation(
      () => new Promise((resolve) => {
        releaseShare = resolve;
      }),
    );
    mockCompactOpenCodeSession.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        releaseCompact = resolve;
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

describe("AgentInfoButton Codex steering", () => {
  function seedRunningCodex(tabId = TAB_ID) {
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CODEX_CLIENT]]),
      sessions: new Map([
        [
          createSessionKey(ENVIRONMENT_ID, TAB_ID),
          { sessionId: `codex-${TAB_ID}`, messages: [], isLoading: true },
        ],
        [
          createSessionKey(ENVIRONMENT_ID, tabId),
          { sessionId: `codex-${tabId}`, messages: [], isLoading: true },
        ],
      ]),
    } as never);
  }

  test("only offers the steer panel while a turn is running", () => {
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CODEX_CLIENT]]),
      sessions: new Map([[
        CODEX_KEY,
        { sessionId: "codex-session-1", messages: [], isLoading: false },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    expect(screen.queryByPlaceholderText("Correct or redirect Codex")).toBeNull();
  });

  test("sends the trimmed text to the active turn and clears the field", async () => {
    seedRunningCodex();
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();

    const input = screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement;
    expect(screen.getByRole("button", { name: "Send now" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "   stop and summarise   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(1));
    const [client, sessionId, text, requestId] = mockSteerCodexSession.mock.calls[0]!;
    expect(client).toBe(CODEX_CLIENT);
    expect(sessionId).toBe(`codex-${TAB_ID}`);
    expect(text).toBe("stop and summarise");
    expect(typeof requestId).toBe("string");
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
      ).toBe(""),
    );
  });

  test("reports a turn that moved on and keeps the text for a retry", async () => {
    seedRunningCodex();
    mockSteerCodexSession.mockImplementation(async () => ({ outcome: "mismatch" }));
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "wait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "The active turn changed; your steering message was not sent.",
      ),
    );
    expect(
      (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
    ).toBe("wait");
  });

  test.each([
    [
      { outcome: "idle" } as const,
      "There is no active Codex turn to steer. Start a turn, then use /steer while it is running.",
    ],
    [
      { outcome: "not-found" } as const,
      "The Codex session is no longer available.",
    ],
    [
      { outcome: "rejected", httpStatus: 503 } as const,
      "Codex rejected the steering message (HTTP 503).",
    ],
  ])("reports the %j steer outcome and preserves the text", async (outcome, message) => {
    seedRunningCodex();
    mockSteerCodexSession.mockImplementation(async () => outcome);
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "wait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(message));
    expect(
      (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
    ).toBe("wait");
  });

  test("reuses an ambiguous request id without clearing the text", async () => {
    seedRunningCodex();
    mockSteerCodexSession.mockImplementation(
      async (_client, _sessionId, _text, requestId) => ({
        outcome: "unknown",
        requestId,
      }),
    );
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "wait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Could not confirm whether Codex received your steering message. Retry the unchanged steering message to check safely.",
      ),
    );
    expect(
      (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
    ).toBe("wait");

    const firstRequestId = mockSteerCodexSession.mock.calls[0]![3];
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(2));
    expect(mockSteerCodexSession.mock.calls[1]![3]).toBe(firstRequestId);
  });

  test("reuses one pending request id until a definitive outcome clears it", async () => {
    seedRunningCodex();
    let attempt = 0;
    mockSteerCodexSession.mockImplementation(
      async (_client, _sessionId, _text, requestId) => {
        attempt += 1;
        return attempt <= 2
          ? { outcome: "unknown" as const, requestId }
          : { outcome: "accepted" as const };
      },
    );
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "wait" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(1));
    const firstRequestId = mockSteerCodexSession.mock.calls[0]![3];

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(2));
    expect(mockSteerCodexSession.mock.calls[1]![3]).toBe(firstRequestId);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(3));
    expect(mockSteerCodexSession.mock.calls[2]![3]).toBe(firstRequestId);
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
      ).toBe(""),
    );

    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "wait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(4));
    expect(mockSteerCodexSession.mock.calls[3]![3]).not.toBe(firstRequestId);
  });

  test("does not reuse an ambiguous request id after the steering text changes", async () => {
    seedRunningCodex();
    mockSteerCodexSession.mockImplementation(
      async (_client, _sessionId, _text, requestId) => ({
        outcome: "unknown",
        requestId,
      }),
    );
    render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    const input = screen.getByPlaceholderText("Correct or redirect Codex");
    fireEvent.change(input, { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(1));
    const firstRequestId = mockSteerCodexSession.mock.calls[0]![3];

    fireEvent.change(input, { target: { value: "stop instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mockSteerCodexSession).toHaveBeenCalledTimes(2));
    expect(mockSteerCodexSession.mock.calls[1]![3]).not.toBe(firstRequestId);
  });

  test("text typed for one session is not carried into another", async () => {
    /*
     * A single app-level instance serves every tab, so unsent steer text used
     * to survive a tab switch and get posted to the new session's active turn.
     */
    seedRunningCodex("tab-2");

    const { rerender } = render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "meant for session A" },
    });

    rerender(<AgentInfoButton activeTab={codexTab({ id: "tab-2" })} />);
    reopen();

    const input = screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Send now" }).hasAttribute("disabled")).toBe(true);
    expect(mockSteerCodexSession).not.toHaveBeenCalled();
  });

  test("same-tab resume clears unsent steering text", () => {
    seedRunningCodex();
    const { rerender } = render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "belongs to the old rollout" },
    });

    act(() => {
      useCodexStore.setState({
        sessions: new Map([[
          CODEX_KEY,
          { sessionId: "codex-resumed", messages: [], isLoading: true },
        ]]),
      } as never);
    });
    rerender(<AgentInfoButton activeTab={codexTab()} />);
    reopen();

    expect(
      (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
    ).toBe("");
  });

  test("a delayed steer completion cannot clear the resumed session's draft", async () => {
    seedRunningCodex();
    let releaseSteer: (outcome: realCodexClient.CodexSteerOutcome) => void = () => {};
    mockSteerCodexSession.mockImplementation(
      () => new Promise((resolve) => {
        releaseSteer = resolve;
      }),
    );
    const { rerender } = render(<AgentInfoButton activeTab={codexTab()} />);
    open();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "old session text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    act(() => {
      useCodexStore.setState({
        sessions: new Map([[
          CODEX_KEY,
          { sessionId: "codex-resumed", messages: [], isLoading: true },
        ]]),
      } as never);
    });
    rerender(<AgentInfoButton activeTab={codexTab()} />);
    reopen();
    fireEvent.change(screen.getByPlaceholderText("Correct or redirect Codex"), {
      target: { value: "new session text" },
    });

    await act(async () => {
      releaseSteer({ outcome: "accepted" });
    });
    expect(
      (screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement).value,
    ).toBe("new session text");
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Sent to the active turn");
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

  test("counts Claude MCP servers, plugins and commands", () => {
    useClaudeStore.setState({
      sessionInitData: new Map([[
        ENVIRONMENT_ID,
        {
          mcpServers: [{ name: "a" }, { name: "b" }],
          plugins: [{ name: "p" }],
          slashCommands: ["/one", "/two", "/three"],
          agents: [],
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={claudeTab()} />);
    open();

    expect(metricValue("MCP")).toBe("2");
    expect(metricValue("Plugins")).toBe("1");
    expect(metricValue("Commands")).toBe("3");
  });

  test("prefers the session-scoped OpenCode snapshot for todos and files", () => {
    /*
     * Every OpenCode tab writes runtime health under the environment key, so
     * the environment entry can describe a sibling session. The session-keyed
     * mirror is the one that belongs to the tab the user is looking at.
     */
    useOpenCodeStore.setState({
      sessions: new Map([[
        OPENCODE_KEY,
        { sessionId: "opencode-session-1", messages: [], isLoading: false },
      ]]),
      runtimeHealth: new Map([
        [
          ENVIRONMENT_ID,
          {
            agents: [],
            skills: [{ name: "s1" }],
            mcpServers: [{ name: "m1", status: "connected" }],
            lspServers: [],
            formatters: [],
            todos: [{ content: "sibling todo", status: "pending", priority: "high" }],
            diffs: [
              { file: "sibling.ts", additions: 1, deletions: 0 },
              { file: "sibling2.ts", additions: 1, deletions: 0 },
            ],
            fetchedAt: "2026-07-26T00:00:00.000Z",
          },
        ],
        [
          OPENCODE_KEY,
          {
            agents: [],
            skills: [],
            mcpServers: [],
            lspServers: [],
            formatters: [],
            todos: [
              { content: "mine", status: "pending", priority: "high" },
              { content: "mine too", status: "pending", priority: "low" },
              { content: "third", status: "completed", priority: "low" },
            ],
            diffs: [{ file: "mine.ts", additions: 3, deletions: 1 }],
            fetchedAt: "2026-07-26T01:00:00.000Z",
          },
        ],
      ]),
    } as never);
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    // Environment-wide inventory still comes from the environment entry.
    expect(metricValue("MCP")).toBe("1");
    expect(metricValue("Skills")).toBe("1");
    expect(metricValue("LSP")).toBe("0");
    expect(metricValue("Todos")).toBe("3");
    expect(metricValue("Files")).toBe("1");
  });

  test("falls back to the environment snapshot before the first session-scoped write", () => {
    useOpenCodeStore.setState({
      sessions: new Map([[
        OPENCODE_KEY,
        { sessionId: "opencode-session-1", messages: [], isLoading: false },
      ]]),
      runtimeHealth: new Map([[
        ENVIRONMENT_ID,
        {
          agents: [],
          skills: [],
          mcpServers: [],
          lspServers: [],
          formatters: [],
          todos: [{ content: "only", status: "pending", priority: "high" }],
          diffs: [],
          fetchedAt: "2026-07-26T00:00:00.000Z",
        },
      ]]),
    } as never);
    render(<AgentInfoButton activeTab={openCodeTab()} />);
    open();

    expect(metricValue("Todos")).toBe("1");
  });
});

describe("AgentInfoButton ACP agents", () => {
  const ACP_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);

  // The config store is module-global. Restore the shipped default so a test
  // that enables Cursor and Grok cannot change what a later file expects the
  // transfer list to contain.
  const enabledPlatformsBeforeSuite =
    useConfigStore.getState().config.global.enabledAgentPlatforms;
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

  test("names a Grok session and renders the usage its bridge reported", () => {
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("grok", {
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
    }));

    render(<AgentInfoButton activeTab={acpTab("grok")} />);
    open();

    expect(screen.getByRole("heading", { name: "Grok Build" })).toBeTruthy();
    expect(metricValue("Input")).toBe("16k");
    expect(metricValue("Output")).toBe("36");
    expect(metricValue("Cache read")).toBe("5.9k");
    expect(metricValue("Reasoning")).toBe("31");
    expect(metricValue("MCP")).toBe("2");
    expect(metricValue("Commands")).toBe("3");
    expect(popover().textContent).toContain("Grok Build 1.0.3");
  });

  test("shows Cursor's runtime and says nothing about tokens it never reports", () => {
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor", {
      runtime: { commands: 7, state: "idle" },
    }));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.getByRole("heading", { name: "Cursor Agent" })).toBeTruthy();
    expect(metricValue("Commands")).toBe("7");
    // No context meter, rather than one reading zero out of zero.
    expect(popover().textContent).toContain(
      "Usage will appear after this session reports its first token snapshot.",
    );
    expect(screen.queryByText("Context")).toBeNull();
    // Cursor advertises no MCP inventory, so the panel must not claim it has none.
    expect(screen.queryByText("MCP")).toBeNull();
  });

  test("shows token metrics without inventing a context window", () => {
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("grok", {
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
    }));

    render(<AgentInfoButton activeTab={acpTab("grok")} />);
    open();

    expect(metricValue("Input")).toBe("200");
    expect(metricValue("Output")).toBe("22");
    expect(screen.queryByText("Context")).toBeNull();
    expect(popover().textContent).not.toContain("available");
    expect(popover().textContent).toContain("Provider reported");
  });

  test("hides the provider actions an ACP agent cannot perform, but offers the transfer", () => {
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.queryByRole("button", { name: /Fork session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Compact/ })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Cursor" })).toBeNull();
  });

  test("hides the transfer when no other agent is enabled", () => {
    useConfigStore.getState().updateGlobalConfig({ enabledAgentPlatforms: ["cursor"] });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, acpProjection("cursor"));

    render(<AgentInfoButton activeTab={acpTab("cursor")} />);
    open();

    expect(screen.queryByRole("button", { name: /Continue in/ })).toBeNull();
    // Nothing else is available for an ACP session, so the heading goes too.
    expect(screen.queryByText("Session actions")).toBeNull();
  });

  test("transfers an ACP conversation read from its authoritative projection", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
    });
    const projection = acpProjection("cursor", {
      title: "Cursor investigated the flake",
      messages: [{
        id: "cursor-message-1",
        role: "user",
        content: "why is this test flaky",
        parts: [{ type: "text", content: "why is this test flaky" }],
        createdAt: "2026-08-14T10:00:00.000Z",
      }],
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, projection);
    const saved: Array<Record<string, unknown>> = [];
    // An ACP session has no legacy client, so the transfer reads the backend
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
      messages: [{
        id: "grok-message-1",
        role: "user",
        content: "keep going",
        parts: [{ type: "text", content: "keep going" }],
        createdAt: "2026-08-14T10:00:00.000Z",
      }],
    });
    useNativeAgentProjectionStore.getState().setProjection(ACP_KEY, projection);
    let reads = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_native_agent_projection") return undefined;
      reads += 1;
      // The second read lands after the agent advanced a revision.
      return reads === 1 ? projection : { ...projection, revision: projection.revision + 1 };
    });

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
