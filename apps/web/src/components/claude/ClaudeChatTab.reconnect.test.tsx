import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createSessionKey } from "@/lib/utils";
import { useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { ClaudeEvent } from "@/lib/claude-client";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realClaudeClient from "@/lib/claude-client";
import * as realClaudeNativeComposer from "./useClaudeNativeComposer";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realClaudeClientSnapshot = { ...realClaudeClient };
const realClaudeNativeComposerSnapshot = { ...realClaudeNativeComposer };

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

mock.module("./useClaudeNativeComposer", () => ({
  useClaudeNativeComposer: () => {
    useState(null);
    return <div data-testid="compose" />;
  },
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
                type: "agent-native",
                nativeAgentData: {
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
  mock.module("./useClaudeNativeComposer", () => realClaudeNativeComposerSnapshot);
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

  test("mounts the hook-owning composer after setup becomes ready", async () => {
    useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
      setupPhase: "running",
    });
    renderChat();

    await waitFor(() => expect(document.querySelector('[data-testid="compose"]')).toBeNull());
    act(() => {
      useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
        setupPhase: "ready",
      });
    });

    await waitFor(() => expect(document.querySelector('[data-testid="compose"]')).toBeTruthy());
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

  test("uses capped exponential delays then keeps probing while desynced", async () => {
    const held = eventChannel();
    const consoleWarn = mock(() => {});
    const consoleError = mock(() => {});
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    console.warn = consoleWarn as typeof console.warn;
    console.error = consoleError as typeof console.error;
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
          "[ClaudeChatTab] SSE reconnect limit reached; continuing desynced probes for",
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
        60_000,
      ]);
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(11);

      // A probe that still cannot reach the bridge leaves the tab desynced and
      // queues the next one at the cap, rather than stranding it forever.
      mockSubscribeToEvents.mockImplementationOnce(() => {
        throw new Error("bridge still unreachable");
      });
      await runTimer(timers[10]!);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(12));
      await waitFor(() => expect(timers).toHaveLength(12));
      expect(timers[11]!.delay).toBe(60_000);
      expect(
        useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced,
      ).toBe(true);
    } finally {
      console.warn = originalConsoleWarn;
      console.error = originalConsoleError;
    }
  });

  test("a successful probe restores the backoff ladder even with no events", async () => {
    /*
     * `markEventSubscriptionHealthy` only fires on an inbound frame, and
     * `getOrCreateEventSubscription` carries the attempt count forward. A quiet
     * session that resynced was therefore still pinned at the ceiling, so its
     * next transient drop skipped the whole ladder and went straight back to
     * the 60s desynced state.
     */
    const held = eventChannel();
    const probe = eventChannel();
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
        await waitFor(() =>
          expect(mockSubscribeToEvents).toHaveBeenCalledTimes(attempt + 2),
        );
      }
      await waitFor(() =>
        expect(
          useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
        ).toMatchObject({ desynced: true, reconnectAttempts: 10 }),
      );

      // The probe reconnects and rehydrates, but the session is idle so not a
      // single event arrives over it.
      mockSubscribeToEvents.mockImplementationOnce(() => probe.stream);
      await runTimer(timers[10]!);
      await waitFor(() =>
        expect(
          useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
        ).toMatchObject({ desynced: false, reconnectAttempts: 0 }),
      );

      await act(async () => {
        probe.close();
        await Promise.resolve();
      });

      await waitFor(() => expect(timers).toHaveLength(12));
      expect(timers[11]!.delay).toBe(3_000);
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  test("stops probing once the environment has been deleted", async () => {
    /*
     * The probe self-reschedules: every failure re-enters the exhausted branch
     * and queues another 60s timer. A deleted environment has no bridge left to
     * reach, so without this gate the chain probes a dead port for the life of
     * the process and pins the whole component closure in memory.
     */
    const held = eventChannel();
    const consoleWarn = mock(() => {});
    const originalConsoleWarn = console.warn;
    console.warn = consoleWarn as typeof console.warn;
    act(() => {
      useClaudeStore.setState({
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: new AbortController(),
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: false,
        }]]),
      });
    });
    mockSubscribeToEvents.mockImplementationOnce(() => held.stream);

    try {
      renderChat();
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
      const timers = captureReconnectTimers();

      act(() => {
        useEnvironmentStore.setState({ environments: [] });
      });
      await act(async () => {
        held.close();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[ClaudeChatTab] SSE reconnect limit reached; environment is gone, stopping probes for",
          ENVIRONMENT_ID,
        );
      });
      // The budget was already spent, so this drop lands in the probe branch —
      // which now declines to arm a successor. The chain has genuinely ended.
      expect(timers).toHaveLength(0);
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
      expect(
        useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
      ).toMatchObject({ desynced: true, reconnectTimer: null });
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

  test("a desynced reconnect rehydrates every projected session and pending prompt", async () => {
    const channel = eventChannel();
    const secondKey = createSessionKey(ENVIRONMENT_ID, "tab-claude-second");
    const previous = new AbortController();
    act(() => {
      useClaudeStore.setState((state) => ({
        sessions: new Map(state.sessions).set(secondKey, {
          sessionId: "session-claude-second",
          messages: [],
          isLoading: false,
        }),
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: previous,
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: true,
        }]]),
      }));
    });
    mockSubscribeToEvents.mockImplementationOnce(() => channel.stream);

    renderChat();

    await waitFor(() => {
      expect((mockGetSessionMessages.mock.calls as unknown[][])
        .some((call) => call[1] === "session-claude-second"))
        .toBe(true);
      expect((mockGetPendingQuestions.mock.calls as unknown[][])
        .some((call) => call[1] === "session-claude-second"))
        .toBe(true);
      expect((mockGetPendingPlanApprovals.mock.calls as unknown[][])
        .some((call) => call[1] === "session-claude-second"))
        .toBe(true);
      expect(
        useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced,
      ).toBe(false);
    });

    await act(async () => {
      useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
      await Promise.resolve();
    });
  });

  test("one unreachable session does not abandon the rest of the resync", async () => {
    /*
     * `getSessionMessages` throws unconditionally on a 404, so a single stale
     * projection used to skip every remaining session *and* the event loop
     * underneath it — leaving the tab consuming no live events at all and
     * repeating the identical failure on the sixty-second probe.
     */
    const channel = eventChannel();
    const staleKey = createSessionKey(ENVIRONMENT_ID, "tab-claude-stale");
    const laterKey = createSessionKey(ENVIRONMENT_ID, "tab-claude-later");
    const consoleWarn = mock(() => {});
    const originalConsoleWarn = console.warn;
    console.warn = consoleWarn as typeof console.warn;
    const previous = new AbortController();
    act(() => {
      useClaudeStore.setState((state) => ({
        sessions: new Map(state.sessions)
          .set(staleKey, {
            sessionId: "session-claude-stale",
            messages: [],
            isLoading: false,
          })
          .set(laterKey, {
            sessionId: "session-claude-later",
            messages: [],
            isLoading: false,
          }),
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: previous,
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: true,
        }]]),
      }));
    });
    mockGetSessionMessages.mockImplementation(
      async (..._args: unknown[]) => {
        if (_args[1] === "session-claude-stale") {
          throw new realClaudeClientSnapshot.SessionNotFoundError(
            "session-claude-stale",
          );
        }
        return [];
      },
    );
    mockSubscribeToEvents.mockImplementationOnce(() => channel.stream);

    try {
      renderChat();

      await waitFor(() => {
        // The session ordered after the failing one still rehydrated.
        expect((mockGetSessionMessages.mock.calls as unknown[][])
          .some((call) => call[1] === "session-claude-later"))
          .toBe(true);
        expect(
          useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced,
        ).toBe(false);
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        "[ClaudeChatTab] Failed to rehydrate session during resync:",
        "session-claude-stale",
        expect.objectContaining({ message: "Session not found: session-claude-stale" }),
      );

      // Live events are being consumed, which the abandoned loop never reached.
      const callsBefore = mockGetSessionMessages.mock.calls.length;
      await act(async () => {
        channel.push({
          type: "message.updated",
          sessionId: SESSION_ID,
        } as ClaudeEvent);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          (mockGetSessionMessages.mock.calls as unknown[][])
            .slice(callsBefore)
            .some((call) => call[1] === SESSION_ID),
        ).toBe(true),
      );
    } finally {
      console.warn = originalConsoleWarn;
      await act(async () => {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
        await Promise.resolve();
      });
    }
  });

  test("retries a transient full-resync failure while a quiet stream stays live", async () => {
    const channel = eventChannel();
    const retryKey = createSessionKey(ENVIRONMENT_ID, "tab-claude-resync-retry");
    const previous = new AbortController();
    let snapshotAttempts = 0;
    act(() => {
      useClaudeStore.setState((state) => ({
        sessions: new Map(state.sessions).set(retryKey, {
          sessionId: "session-claude-resync-retry",
          messages: [],
          isLoading: false,
        }),
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: previous,
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: true,
        }]]),
      }));
    });
    mockGetSessionMessages.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "session-claude-resync-retry") {
        snapshotAttempts += 1;
        if (snapshotAttempts === 1) throw new Error("transient transcript outage");
      }
      return [];
    });
    mockSubscribeToEvents.mockImplementationOnce(() => channel.stream);
    const timers = captureReconnectTimers();

    try {
      renderChat();
      await waitFor(() => {
        expect(
          useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
        ).toMatchObject({ desynced: true, isActive: true });
        expect(timers.map((timer) => timer.delay)).toContain(60_000);
      });

      await runTimer(timers.find((timer) => timer.delay === 60_000)!);

      await waitFor(() => {
        expect(snapshotAttempts).toBeGreaterThanOrEqual(2);
        expect(
          useClaudeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
        ).toMatchObject({ desynced: false, reconnectTimer: null });
      });
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
        await Promise.resolve();
      });
    }
  });
});
