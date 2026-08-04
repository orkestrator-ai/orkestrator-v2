import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createSessionKey } from "@/lib/utils";
import { useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { ClaudeEvent } from "@/lib/claude-client";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realClaudeClient from "@/lib/claude-client";
import * as realClaudeComposeBar from "./ClaudeComposeBar";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realClaudeClientSnapshot = { ...realClaudeClient };
const realClaudeComposeBarSnapshot = { ...realClaudeComposeBar };

/**
 * Claude's `subscribeToEvents` is synchronous — it hands back an async iterable
 * rather than a promise — so a failing subscription throws here instead of
 * rejecting, and the drop is modelled by an iterable that simply ends.
 */
const mockSubscribeToEvents = mock<
  (_client: unknown, _signal?: AbortSignal) => AsyncIterable<ClaudeEvent>
>(() => emptyEventStream());
const mockGetSessionMessages = mock(async () => []);
const mockGetSession = mock(async (): Promise<unknown> => null);
const mockGetPendingQuestions = mock(async () => []);
const mockGetPendingPlanApprovals = mock(async () => []);
const mockGetSlashCommands = mock(async (): Promise<string[]> => []);
const mockCheckHealth = mock(async () => true);
const mockGetModels = mock(async () => []);

mock.module("@/lib/claude-client", () => ({
  ...realClaudeClientSnapshot,
  subscribeToEvents: mockSubscribeToEvents,
  getSessionMessages: mockGetSessionMessages,
  getSession: mockGetSession,
  getPendingQuestions: mockGetPendingQuestions,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  getSlashCommands: mockGetSlashCommands,
  checkHealth: mockCheckHealth,
  getModels: mockGetModels,
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: mock(() => ({
    isAtBottom: true,
    isAtBottomRef: { current: true },
    scrollToBottom: mock(() => {}),
    virtuosoRef: { current: null },
    scrollProps: {},
  })),
}));

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: () => <div data-testid="messages" />,
}));

mock.module("./ClaudeComposeBar", () => ({
  ClaudeComposeBar: () => <div data-testid="compose" />,
}));

import { ClaudeChatTab } from "./ClaudeChatTab";

const ENVIRONMENT_ID = "env-claude-reconnect";
const TAB_ID = "tab-claude-reconnect";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const SESSION_ID = "session-claude-reconnect";
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" };
const REPLACEMENT_CLIENT = { baseUrl: "http://127.0.0.1:10000" };
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
const ORIGINAL_CONSOLE_DEBUG = console.debug;
const ORIGINAL_CONSOLE_LOG = console.log;

interface CapturedTimer {
  delay: number;
  run: () => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptyEventStream(): AsyncIterable<ClaudeEvent> {
  return (async function* () {})();
}

function eventChannel() {
  let closed = false;
  let wake = deferred<void>();
  const queue: ClaudeEvent[] = [];
  const stream = (async function* () {
    while (!closed) {
      if (queue.length === 0) await wake.promise;
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
  })() as AsyncGenerator<ClaudeEvent>;
  return {
    stream,
    push(event: ClaudeEvent) {
      queue.push(event);
      wake.resolve();
      wake = deferred<void>();
    },
    close() {
      closed = true;
      wake.resolve();
    },
  };
}

/**
 * Capture only the reconnect timers. The tab schedules plenty of short timers
 * (debounced reloads, elapsed-time ticks) that must keep running for real.
 */
function captureReconnectTimers(): CapturedTimer[] {
  const timers: CapturedTimer[] = [];
  globalThis.setTimeout = ((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === "function" && (delay ?? 0) >= 3_000) {
      timers.push({ delay: delay ?? 0, run: () => handler(...args) });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }
    return ORIGINAL_SET_TIMEOUT(handler, delay, ...args);
  }) as unknown as typeof setTimeout;
  return timers;
}

function seedStores() {
  useClaudeStore.setState({
    serverStatus: new Map(),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as never]]),
    eventSubscriptions: new Map(),
    sessions: new Map([
      [SESSION_KEY, { sessionId: SESSION_ID, messages: [], isLoading: false }],
    ]),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    isComposing: new Map(),
    effort: new Map(),
    planMode: new Map(),
    selectedModel: new Map(),
    messageQueue: new Map(),
    sessionInitData: new Map(),
    contextUsage: new Map(),
    rateLimits: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
    models: [],
    modelCatalogs: new Map(),
    fastMode: new Map(),
    promptSuggestions: new Map(),
    dismissedPromptSuggestions: new Map(),
    promptSuggestionOptIn: new Map(),
    includeLocalSettings: new Map(),
    selectedAgent: new Map(),
    backgroundTasks: new Map(),
    completionBlockedByBackgroundTasks: new Map(),
    backgroundTaskRevisions: new Map(),
    completionHoldRevisions: new Map(),
  });

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-claude-reconnect",
        name: "Claude reconnect environment",
        branch: "main",
        containerId: "container-claude-reconnect",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-07-27T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
        setupPhase: "ready",
      },
    ],
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
  });

  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: TAB_ID,
                type: "claude-native",
                claudeNativeData: {
                  environmentId: ENVIRONMENT_ID,
                  containerId: "container-claude-reconnect",
                  isLocal: false,
                },
              },
            ],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: "container-claude-reconnect",
        },
      ],
    ]),
    hydration: new Map([[ENVIRONMENT_ID, "done"]]),
    activeEnvironmentId: ENVIRONMENT_ID,
  });
}

function renderChat() {
  return render(
    <ClaudeChatTab
      tabId={TAB_ID}
      data={{
        environmentId: ENVIRONMENT_ID,
        containerId: "container-claude-reconnect",
        isLocal: false,
      }}
      isActive
    />,
  );
}

async function runTimer(timer: CapturedTimer) {
  await act(async () => {
    timer.run();
    await Promise.resolve();
  });
}

/**
 * Render with the first subscription held open, install the timer capture, then
 * drop it.
 *
 * Claude's `subscribeToEvents` is synchronous, so an already-finished iterable
 * would reconnect through the *real* `setTimeout` before the capture could be
 * installed — the drop has to be triggered on our terms.
 */
async function renderAndHoldFirstStream(
  held: ReturnType<typeof eventChannel>,
): Promise<CapturedTimer[]> {
  renderChat();
  await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
  const timers = captureReconnectTimers();

  await act(async () => {
    held.close();
    await Promise.resolve();
  });
  await waitFor(() => expect(timers.length).toBeGreaterThan(0));
  return timers;
}

afterAll(() => {
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module(
    "@/components/chat/VirtualizedMessageList",
    () => realVirtualizedMessageListSnapshot,
  );
  mock.module("./ClaudeComposeBar", () => realClaudeComposeBarSnapshot);
});

describe("ClaudeChatTab SSE reconnect", () => {
  beforeEach(() => {
    cleanup();
    console.debug = mock(() => {}) as typeof console.debug;
    console.log = mock(() => {}) as typeof console.log;
    mockSubscribeToEvents.mockReset();
    mockSubscribeToEvents.mockImplementation(() => emptyEventStream());
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockResolvedValue([]);
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ id: SESSION_ID, status: "idle" });
    mockGetPendingQuestions.mockReset();
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPlanApprovals.mockReset();
    mockGetPendingPlanApprovals.mockResolvedValue([]);
    mockGetSlashCommands.mockReset();
    mockGetSlashCommands.mockResolvedValue([]);
    mockCheckHealth.mockReset();
    mockCheckHealth.mockResolvedValue(true);
    mockGetModels.mockReset();
    mockGetModels.mockResolvedValue([]);
    seedStores();
  });

  afterEach(async () => {
    await act(async () => {
      useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      await Promise.resolve();
    });
    globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
    console.debug = ORIGINAL_CONSOLE_DEBUG;
    console.log = ORIGINAL_CONSOLE_LOG;
    cleanup();
    mock.restore();
  });

  test("reconnects after the base delay when the stream ends unexpectedly", async () => {
    const held = eventChannel();
    const replacement = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementationOnce(() => replacement.stream);

    try {
      const timers = await renderAndHoldFirstStream(held);

      expect(timers.map((timer) => timer.delay)).toEqual([3_000]);

      await runTimer(timers[0]!);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2));
    } finally {
      await act(async () => {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        replacement.close();
        await Promise.resolve();
      });
    }
  });

  test("logs a throwing subscription and still schedules a reconnect", async () => {
    const held = eventChannel();
    const consoleError = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleError as typeof console.error;
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementationOnce(() => {
        throw new Error("SSE unavailable");
      });

    try {
      const timers = await renderAndHoldFirstStream(held);
      await runTimer(timers[0]!);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[ClaudeChatTab] Event subscription error:",
          expect.objectContaining({ message: "SSE unavailable" }),
        );
      });
      // A throw is a drop like any other: the backoff keeps advancing rather
      // than restarting, so the tab cannot spin on an endpoint that is refusing.
      await waitFor(() =>
        expect(timers.map((timer) => timer.delay)).toEqual([3_000, 6_000]),
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("uses capped exponential delays and stops after ten reconnect attempts", async () => {
    const held = eventChannel();
    const consoleWarn = mock(() => {});
    const originalConsoleWarn = console.warn;
    console.warn = consoleWarn as typeof console.warn;
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementation(() => emptyEventStream());

    try {
      const timers = await renderAndHoldFirstStream(held);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await runTimer(timers[attempt]!);
        await waitFor(() => {
          expect(mockSubscribeToEvents).toHaveBeenCalledTimes(attempt + 2);
          if (attempt < 9) expect(timers).toHaveLength(attempt + 2);
        });
      }

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[ClaudeChatTab] SSE reconnect limit reached for",
          ENVIRONMENT_ID,
        );
      });
      expect(timers.map((timer) => timer.delay)).toEqual([
        3_000,
        6_000,
        12_000,
        24_000,
        48_000,
        60_000,
        60_000,
        60_000,
        60_000,
        60_000,
      ]);
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(11);
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  test("does not let a stale reconnect timer replace an explicitly closed subscription", async () => {
    /*
     * `closeEventSubscription` deletes the map entry, so a guard that only asks
     * "is anything active?" reads the deletion as "nothing is listening" and
     * restarts a stream the app deliberately stopped.
     */
    const held = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementation(() => emptyEventStream());
    const timers = await renderAndHoldFirstStream(held);

    act(() => {
      useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
    });
    await runTimer(timers[0]!);

    expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
    expect(
      useClaudeStore.getState().eventSubscriptions.has(ENVIRONMENT_ID),
    ).toBe(false);
  });

  test("does not reconnect when the timer finds no client or a replacement subscription", async () => {
    const held = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementation(() => emptyEventStream());
    const timers = await renderAndHoldFirstStream(held);

    act(() => {
      useClaudeStore.getState().setClient(ENVIRONMENT_ID, null);
    });
    await runTimer(timers[0]!);
    expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);

    // A replacement subscription owns the environment now: reconnecting would
    // run two loops against one bridge and double every event.
    act(() => {
      useClaudeStore.getState().setClient(ENVIRONMENT_ID, MOCK_CLIENT as never);
      useClaudeStore.getState().getOrCreateEventSubscription(ENVIRONMENT_ID);
    });
    await runTimer(timers[0]!);
    expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
  });

  test("reconnects with the current replacement client instead of the dropped stream client", async () => {
    const held = eventChannel();
    const replacement = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementationOnce(() => replacement.stream);
    const timers = await renderAndHoldFirstStream(held);

    act(() => {
      useClaudeStore.getState().setClient(ENVIRONMENT_ID, REPLACEMENT_CLIENT as never);
    });
    await runTimer(timers[0]!);

    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2));
    expect(mockSubscribeToEvents.mock.calls[1]?.[0]).toBe(REPLACEMENT_CLIENT);
    await act(async () => {
      useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      replacement.close();
      await Promise.resolve();
    });
  });

  test("a received event resets the reconnect backoff before the next drop", async () => {
    const held = eventChannel();
    const replacement = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => held.stream)
      .mockImplementationOnce(() => replacement.stream)
      .mockImplementation(() => emptyEventStream());

    const timers = await renderAndHoldFirstStream(held);
    expect(timers.map((timer) => timer.delay)).toEqual([3_000]);

    await runTimer(timers[0]!);
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2));

    // One delivered frame proves the connection worked, so the next drop starts
    // the backoff over rather than continuing at 6s.
    await act(async () => {
      replacement.push({
        type: "message.updated",
        sessionId: SESSION_ID,
      } as ClaudeEvent);
      await Promise.resolve();
    });
    await act(async () => {
      replacement.close();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(timers.map((timer) => timer.delay)).toEqual([3_000, 3_000]),
    );
  });
});
